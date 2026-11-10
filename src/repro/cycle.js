import fs from 'node:fs/promises';
import { appError } from '../errors.js';
import { storage, name, readJson, writeJson, jsonHash, withLock, safeFile, fileHash } from './store.js';
import { loadTemplate } from './template-store.js';
import { emptyBudget, remainingBudget } from './budget.js';
import { validateEvidenceReport } from './evaluate.js';
import { validateReview } from './judge.js';

const invalid = message => appError('REPRO_INVALID', message);
const modelStages = new Set(['teacher', 'retry', 'repair', 'run', 'resume', 'trial', 'judge', 'extract']);

function nextExecutionAction(run) {
    const attempt = run.attempts.at(-1);
    if (attempt?.executionCompleted) {
        const managed = (run.workflow.policy.renderProvider || 'local') === 'local';
        const render = attempt.renders?.at(-1);
        const sourceIntact = !(run.technical?.checks || []).some(check => (check.id === 'source:checkpoint' || check.id.startsWith('frozen:')) && !check.passed);
        if (managed && (!render || render.status !== 'completed') && sourceIntact
            && ['running', 'rendering', 'failed', 'blocked', 'cancelled', 'needs-revision'].includes(run.status)) return 'render';
        return 'repair';
    }
    if (attempt?.checkpoint) return 'resume';
    return run.attempts.length ? 'retry' : run.kind === 'teacher' ? 'teacher' : 'run';
}

// Hash values and file contents in the host. Only hashes/bindings enter the
// ledger; held-out values never enter teacher or extractor project context.
async function freezeCase(config, spec, item) {
    name(item?.id); name(item?.as);
    if (typeof item.inputs !== 'string') throw invalid('测试输入需要工作区内 JSON 文件路径。');
    const values = await readJson(config.workspace, item.inputs);
    if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).some(key => !Object.hasOwn(spec.inputs, key))) throw invalid('测试输入必须符合冻结输入定义。');
    const entries = [];
    for (const [key, rule] of Object.entries(spec.inputs)) {
        const value = values[key];
        if (value === undefined && !rule.required) continue;
        if (typeof value !== 'string' || !value.trim()) throw invalid(`测试输入缺少 ${key}。`);
        if (rule.type === 'file') {
            const file = await safeFile(config.workspace, value);
            const info = await fs.stat(file);
            if (!info.isFile() || info.size > 1024 ** 3) throw invalid(`测试文件类型或大小不支持: ${key}`);
            entries.push([key, { type: 'file', sha256: await fileHash(file) }]);
        }
        else entries.push([key, { type: 'text', value }]);
    }
    return { id: item.id, as: item.as, inputs: item.inputs, inputsHash: jsonHash(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))) };
}

/** Bounded automatic transfer loop. Held-out cases are opened only for trial runs. */
export async function runCycle(config, teacherSlug, options, { executeRepro, loadRun, ...deps }) {
    const templateName = name(options.name);
    const firstVersion = Number(options.version || 1);
    const maxVersions = Number(options.maxVersions || 2);
    if (!Number.isSafeInteger(firstVersion) || firstVersion < 1 || !Number.isSafeInteger(maxVersions) || maxVersions < 1 || maxVersions > 5) throw appError('REPRO_INVALID', 'version 为正整数，max-versions 为 1–5。');
    const teacherAtStart = await loadRun(config, teacherSlug);
    if (teacherAtStart.kind !== 'teacher') throw invalid('自动提炼流程需要教师制作。');
    const raw = await readJson(config.workspace, options.cases);
    if (!Array.isArray(raw?.cases) || !raw.cases.length || raw.cases.length > 20) throw invalid('cases 文件需要 1–20 条 {id, inputs, as}。');
    const cases = [];
    for (const item of raw.cases) {
        const frozen = await freezeCase(config, teacherAtStart.spec, item);
        if (cases.some(entry => entry.id === frozen.id || entry.as === frozen.as || entry.inputsHash === frozen.inputsHash)) throw invalid('case ID、制作 slug 和测试输入内容不能重复。');
        cases.push(frozen);
    }
    const cycleId = `${name(teacherSlug)}-${templateName}-${firstVersion}`;
    return withLock(config, `cycle-${jsonHash(cycleId)}`, async () => {
        const stateFile = `cycles/${cycleId}.json`;
        const signature = jsonHash({ teacherSlug, templateName, firstVersion, maxVersions, cases });
        let cycle;
        try { cycle = await readJson(storage(config), stateFile); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (cycle && cycle.signature !== signature) throw invalid('恢复时不能改变测试集合、输入内容或版本范围。');
        cycle ||= { schema: 'video-remake.reproduction-cycle@1', id: cycleId, signature, status: 'running', teacher: teacherSlug, cases, trials: [], events: [], createdAt: new Date().toISOString() };
        if (['released', 'needs-revision'].includes(cycle.status)) return { command: 'repro:cycle', cycle };
        const persist = async () => { cycle.updatedAt = new Date().toISOString(); await fs.mkdir(storage(config), { recursive: true }); await writeJson(storage(config), stateFile, cycle); };
        const aggregateBudget = async () => {
            const teacher = await loadRun(config, teacherSlug);
            const states = [teacher];
            for (const trial of cycle.trials) {
                try { states.push(await loadRun(config, trial.production)); }
                catch (error) { if (!['ENOENT', 'NOT_FOUND'].includes(error.code)) throw error; }
            }
            const used = emptyBudget();
            for (const run of states) {
                for (const key of ['calls', 'elapsedMs', 'toolCalls', 'renderCalls', 'tokens', 'costUsd']) used[key] += run.budget[key] || 0;
                for (const key of ['usageComplete', 'costComplete', 'elapsedComplete', 'toolCallsComplete', 'renderCallsComplete']) used[key] &&= run.budget[key] !== false;
            }
            cycle.budget = used;
            return { teacher, used };
        };
        const stage = async (action, subject, params = {}) => {
            const { teacher, used } = await aggregateBudget();
            if (modelStages.has(action)) remainingBudget(teacher.workflow.policy, used);
            cycle.active = { action, subject, params }; await persist();
            const result = await executeRepro(config, action, subject, { ...options, ...params, aggregateBudget: { ...used },
                timeoutMs: Math.min(Number(options.timeoutMs) || teacher.workflow.policy.maxDurationMs, Math.max(1, teacher.workflow.policy.maxDurationMs - used.elapsedMs)) }, deps);
            cycle.events.push({ action, subject, ...(params.version === undefined ? {} : { version: params.version }), status: result.run?.status || result.status || 'completed', at: new Date().toISOString() });
            await aggregateBudget(); await persist(); return result;
        };
        try {
            let teacher = await loadRun(config, teacherSlug);
            while (teacher.status !== 'passed') {
                if (teacher.review?.checks.some(check => check.status === 'unobserved')) throw appError('REPRO_REVIEW_UNOBSERVED', '评审无法观察必需证据；先更换评审能力或完成人工评审，再恢复。');
                if (teacher.status === 'external-review') await stage('judge', teacherSlug, { target: undefined });
                else await stage(nextExecutionAction(teacher), teacherSlug);
                teacher = await loadRun(config, teacherSlug);
            }
            let feedback = cycle.feedback;
            for (let offset = cycle.versionOffset || 0; offset < maxVersions; offset++) {
                const version = firstVersion + offset, selector = `${templateName}@${version}`;
                cycle.versionOffset = offset;
                const item = cases[offset];
                if (!item) throw appError('REPRO_TEST_CASES_EXHAUSTED', '缺少未参与修订的新测试输入；补充测试集合并启动新流程。');
                if (item.inputsHash === teacher.inputsHash) throw invalid('保留测试输入不能与教师开发输入相同。');
                let frozenTemplate;
                try { frozenTemplate = await loadTemplate(config, selector); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (frozenTemplate) {
                    const provenance = frozenTemplate.provenance;
                    const feedbackRun = feedback ? await loadRun(config, feedback) : null;
                    if (provenance?.teacher?.runId !== teacher.id || jsonHash(frozenTemplate.spec) !== teacher.specHash
                        || (provenance.feedback?.runId || null) !== (feedbackRun?.id || null)) throw invalid('已存在的模板版本不属于当前教师和修订反馈。');
                    // Recover the window between atomic template creation and
                    // persisting the extraction event, without another model call.
                    if (!cycle.events.some(event => event.action === 'extract' && event.version === version)) {
                        cycle.events.push({ action: 'extract', subject: teacherSlug, version, status: 'recovered', at: new Date().toISOString() }); await persist();
                    }
                } else {
                    if (cycle.events.some(event => event.action === 'extract' && event.version === version)) throw invalid('已记录的冻结模板缺失，不能静默重建同一版本。');
                    await stage('extract', teacherSlug, { name: templateName, version, feedback, target: undefined });
                    frozenTemplate = await loadTemplate(config, selector);
                }
                if (jsonHash(await freezeCase(config, teacher.spec, item)) !== jsonHash(item)) throw invalid('测试输入在流程执行期间改变。');
                let trial = cycle.trials.find(t => t.caseId === item.id);
                if (!trial) { trial = { caseId: item.id, production: item.as, template: selector }; cycle.trials.push(trial); await persist(); }
                if (trial.template !== selector || trial.production !== item.as) throw invalid('测试运行与当前模板或输入不匹配。');
                let run;
                try { run = await loadRun(config, item.as); }
                catch (error) { if (!['ENOENT','NOT_FOUND'].includes(error.code)) throw error; }
                if (run && (run.kind !== 'trial' || run.template?.id !== selector || run.inputsHash !== item.inputsHash || run.specHash !== teacher.specHash)) throw invalid('已有制作不属于此保留测试。');
                if (!run) await stage('trial', selector, { as: item.as, inputs: item.inputs, target: undefined });
                else if (!['external-review','passed','needs-revision'].includes(run.status)) await stage(nextExecutionAction(run), item.as, { target: undefined });
                run = await loadRun(config, item.as);
                if (run.status === 'external-review') await stage('judge', item.as, { target: undefined });
                run = await loadRun(config, item.as);
                trial.status = run.status; await persist();
                if (run.review?.checks.some(check => check.status === 'unobserved')) throw appError('REPRO_REVIEW_UNOBSERVED', '评审无法观察必需证据；不能把能力缺失当作模板质量反馈。');
                if (run.status === 'passed') {
                    let release;
                    try { release = await readJson(config.workspace, `reproductions/releases/${templateName}/v${version}.json`); }
                    catch (error) { if (error.code !== 'ENOENT') throw error; }
                    if (release) {
                        // Recover the exclusive release write before the cycle
                        // was marked released. Revalidate every accepted binding.
                        await stage('check', item.as);
                        run = await loadRun(config, item.as);
                        await validateEvidenceReport(run.technical, { spec: run.spec });
                        const review = validateReview(run.review, run.spec, run.technical.artifact.sha256, run.technical);
                        if (release.schema !== 'video-remake.reproduction-release@1' || release.template !== selector
                            || release.treeHash !== frozenTemplate.treeHash || release.trial !== run.id || release.specHash !== run.specHash
                            || release.artifactSha256 !== run.technical.artifact.sha256 || release.evidenceManifestSha256 !== run.technical.evidenceManifestSha256
                            || jsonHash(release.review) !== jsonHash(review) || !review.passed) throw invalid('已有发布记录与当前已验证实例不匹配。');
                    } else release = (await stage('publish', selector, { production: item.as })).release;
                    cycle.status = 'released'; cycle.release = release; delete cycle.active; delete cycle.error;
                    await aggregateBudget(); await persist();
                    return { command: 'repro:cycle', cycle };
                }
                feedback = item.as; cycle.feedback = feedback;
            }
            cycle.status = 'needs-revision'; delete cycle.active; delete cycle.error; await aggregateBudget(); await persist();
            return { command: 'repro:cycle', cycle };
        } catch (error) {
            cycle.status = /BUDGET/.test(error.code) ? 'budget-exhausted' : deps.signal?.aborted ? 'cancelled' : 'blocked';
            cycle.error = { code: error.code || 'FAILED', message: error.message }; await persist();
            throw appError(error.code || 'REPRO_FAILED', error.message, { data: { command: 'repro:cycle', cycle } });
        }
    });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { readCatalog, findProduction, findReference, writeCatalog } from '../catalog.js';
import { startProduction } from '../start.js';
import { validateSpec } from './schema.js';
import { storage, name, safeFile, readJson, writeJson, withLock, copyFile, jsonHash, fileHash } from './store.js';
import { scaffoldProject, validateProject, snapshotProject, copyProject, syncSkills } from './project.js';
import { loadTemplate, instantiateTemplate, exportTemplate } from './template-store.js';
import { scaffoldMethodRecipe, freezeMethodRecipe, loadMethodRecipe, listMethodRecipes, instantiateMethodRecipe, freezeAssetPack, inspectMethodMigration, exportMethodRecipe, importMethodRecipe } from './method-store.js';
import { captureGenerationBaseline, auditGeneration, generationQualification } from './generation-audit.js';
import { loadWorkflow, createStagedWorkflow, resolveRole } from './config.js';
import { runProjectAgent, doctorWorkflow, projectAgentStatus, projectAgentLogs, projectAgentCancel } from './runner.js';
import { evaluateArtifacts, validateEvidenceReport } from './evaluate.js';
import { judgeArtifacts, validateReview } from './judge.js';
import { REVIEW_PROTOCOL, combineReviews, reviewProtocolFingerprint } from './review-protocol.js';
import { emptyBudget, remainingBudget, chargeBudget } from './budget.js';
import { initializeStagedRun, executeStaged, stagedSummary, stageOperation, checkerProfileFingerprint } from './stage-workflow.js';
import { finalReviewReserve } from './budget.js';
import { reconcileInterruptedRun } from './recovery.js';
import { loadCapabilityBindings, resolveCapabilities, doctorCapabilities, validateRequirements } from './capabilities.js';

const now = () => new Date().toISOString();
const notReady = message => appError('REPRO_NOT_READY', message);
const stateRel = id => `runs/${name(id)}/state.json`;
const templateSpec = template => validateSpec(template.spec || template.manifest?.spec || template.metadata?.spec);
const templateRoot = template => template.root || template.projectRoot || template.path;
const templateIdentity = template => `${template.name || template.manifest?.name}@${template.version || template.manifest?.version}`;
const templateHash = template => template.treeHash || template.inventory?.treeHash || template.manifest?.treeHash;

export function inputFingerprint(inputs) {
    return jsonHash(Object.fromEntries(Object.entries(inputs || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, input]) => [key,
        input.type === 'file' ? { type: 'file', sha256: input.sha256 } : { type: 'text', value: input.value },
    ])));
}
async function production(config, slug) {
    name(slug);
    const catalog = await readCatalog(config.catalogPath);
    const item = findProduction(catalog, slug);
    if (!item) throw appError('NOT_FOUND', `制作不存在: ${slug}。先用 start 创建制作。`);
    await safeFile(config.workspace, `${item.dir}/BRIEF.md`);
    return { item, catalog };
}
async function referencesFor(config, ids, bindings) {
    const catalog = await readCatalog(config.catalogPath);
    const result = [];
    for (const raw of ids) {
        const id = typeof raw === 'string' ? raw : raw.id;
        const ref = findReference(catalog, id);
        let source;
        if (bindings?.[id]) {
            const file = await safeFile(config.workspace, bindings[id]);
            source = { videoPath: file, assetRoot: config.workspace, relVideo: bindings[id] };
        } else if (ref) {
            source = await readJson(config.workspace, `${ref.dir}/SOURCE.json`);
            const root = await fs.realpath(source.provider?.kind === 'local-binding' ? config.workspace : config.assetRoot);
            source = { ...source, assetRoot: root, videoPath: await safeFile(root, source.relVideo) };
        } else throw notReady(`参考 ${id} 未绑定；用 --references FILE 提供 {参考ID: 本工作区相对文件路径}。`);
        if (!(await fs.stat(source.videoPath)).isFile()) throw appError('REPRO_INVALID', '参考必须是普通文件。');
        const sha256 = await fileHash(source.videoPath);
        if ((raw.sha256 && raw.sha256 !== sha256) || (source.sha256 && source.sha256 !== sha256)) throw appError('REPRO_INVALID', `参考内容已改变: ${id}`);
        result.push({ id, source: { ...source, sha256 } });
    }
    if (!result.length) throw notReady('至少需要一个可访问的对标视频。');
    return result;
}
async function assertReferences(state) {
    if (state.stageState && state.checkerProfileHash !== await checkerProfileFingerprint(state.workflow.policy.reviewProtocolHash)) throw notReady('冻结检查器实现已改变；请创建使用新检查器的运行。');
    for (const ref of state.references) {
        const file = await safeFile(ref.source.assetRoot, ref.source.relVideo);
        if (await fileHash(file) !== ref.source.sha256) throw appError('REPRO_INVALID', `冻结参考发生变化: ${ref.id}`);
    }
}
export async function resolveInputs(config, spec, inputFile, values) {
    const raw = values ?? (inputFile ? await readJson(config.workspace, inputFile) : {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw appError('REPRO_INVALID', '输入必须是对象。');
    for (const key of Object.keys(raw)) if (!Object.hasOwn(spec.inputs, key)) throw appError('REPRO_INVALID', `未知输入: ${key}`);
    const result = {};
    for (const [key, rule] of Object.entries(spec.inputs)) {
        const value = raw[key];
        if (value === undefined && !rule.required) continue;
        if (typeof value !== 'string' || !value.trim()) throw appError('REPRO_INVALID', `缺少输入: ${key}`);
        if (rule.type === 'file') {
            const file = await safeFile(config.workspace, value);
            const info = await fs.stat(file);
            if (!info.isFile() || info.size > 1024 ** 3) throw appError('REPRO_INVALID', `输入文件类型或大小不支持: ${key}`);
            result[key] = { type: 'file', from: value, sha256: await fileHash(file) };
        } else {
            if (Buffer.byteLength(value) > 256 * 1024) throw appError('REPRO_INVALID', `输入过大: ${key}`);
            result[key] = { type: 'text', value };
        }
    }
    return result;
}
async function save(config, state) {
    state.updatedAt = now();
    await fs.mkdir(storage(config), { recursive: true });
    await writeJson(storage(config), stateRel(state.id), state);
    return state;
}
export async function loadRun(config, slug) {
    const { item } = await production(config, slug);
    const pointer = await readJson(config.workspace, `${item.dir}/REPRO.json`);
    const state = await readJson(storage(config), stateRel(pointer.id));
    if (state.production !== slug || state.id !== pointer.id || state.specHash !== pointer.specHash || jsonHash(state.spec) !== state.specHash) throw appError('REPRO_INVALID', '冻结任务记录与制作指针不匹配。');
    validateSpec(state.spec);
    if (state.workflowHash !== jsonHash(state.workflow)) throw appError('REPRO_INVALID', '冻结工作流已被修改。');
    if (state.inputs && state.inputsHash !== inputFingerprint(state.inputs)) throw appError('REPRO_INVALID', '冻结输入记录已被修改。');
    const expectedWorkspace = state.method ? path.join(storage(config), 'projects', state.id) : path.join(config.workspace, item.dir, 'project');
    if (state.workspace !== expectedWorkspace) throw appError('REPRO_INVALID', '项目实例路径不匹配。');
    await safeFile(state.method ? storage(config) : config.workspace, state.method ? `projects/${state.id}` : `${item.dir}/project`);
    return state;
}
export function summarizeRun(state) {
    return { ...stagedSummary(state), schema: state.schema, id: state.id, production: state.production, kind: state.kind, status: state.status,
        template: state.template, method: state.method, methodApplied: state.methodApplied, generationMode: state.generationMode || (state.template ? 'project-replay' : 'teacher-generation'),
        generation: state.generation, generationAudit: state.generationAudit, qualification: generationQualification(state), spec: state.spec, specHash: state.specHash, inputsHash: state.inputsHash,
        workspace: state.workspace, attempts: state.attempts, budget: state.budget, policy: state.workflow.policy,
        activeRender: state.activeRender, activeAgentRunId: state.activeAgentRunId, activeRole: state.activeRole, interruptions: state.interruptions, agentRuns: state.agentRuns,
        technical: state.technical, review: state.review, reviewFailures: state.reviewFailures, reviewSource: state.reviewSource, extractions: state.extractions,
        assisted: state.assisted || false, createdAt: state.createdAt, updatedAt: state.updatedAt,
        continuation: state.continuation,
        isolation: state.generationAudit?.isolation || state.generation?.isolation || state.executionIsolation || { level: 'context-only', readIsolation: 'unverified', limitations: ['Native Harness permissions are not a verified read boundary.'] },
    };
}
async function init(config, slug, options) {
    const { item } = await production(config, slug);
    const spec = validateSpec(options.specValue ?? await readJson(config.workspace, options.spec));
    const references = await referencesFor(config, item.referenceIds);
    const workflow = await newWorkflow(config, options);
    const pointerPath = await safeFile(config.workspace, `${item.dir}/REPRO.json`, { missing: true });
    try { await fs.access(pointerPath); throw appError('ALREADY_EXISTS', '该制作已有冻结任务；修改目标请创建新制作。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const workspace = await safeFile(config.workspace, `${item.dir}/project`, { missing: true });
    const inputs = workflow.execution || options.inputs || options.inputValues ? await resolveInputs(config, spec, options.inputs, options.inputValues) : null;
    const capabilityRequirements = validateRequirements(options.capabilities ? await readJson(config.workspace, options.capabilities) : []);
    await scaffoldProject(workspace, { spec, name: slug, capabilities: capabilityRequirements });
    const state = { schema: 'video-remake.reproduction-run@2', id: `r_${randomUUID()}`, production: slug,
        kind: options.baseline ? 'baseline' : 'teacher', status: 'prepared', spec, specHash: jsonHash(spec), references,
        workspace, workflow, workflowHash: jsonHash(workflow), agentConfig: options.agentConfig, capabilityRequirements,
        inputs, inputsHash: inputs ? inputFingerprint(inputs) : null, attempts: [], budget: emptyBudget(), createdAt: now() };
    if (workflow.execution) await initializeStagedRun(config, state, stagedBridge);
    await save(config, state);
    await writeJson(config.workspace, `${item.dir}/REPRO.json`, { schema: 'video-remake.reproduction-pointer@2', id: state.id, specHash: state.specHash }, { exclusive: true });
    return { command: 'repro:init', run: summarizeRun(state) };
}
async function installInputs(config, state) {
    const values = {};
    const frozen = {};
    for (const [key, input] of Object.entries(state.inputs || {})) {
        if (input.type === 'text') values[key] = input.value;
        else {
            const rel = `inputs/files/${key}/${path.basename(input.from)}`;
            const destination = await safeFile(state.workspace, rel, { missing: true });
            await fs.mkdir(path.dirname(destination), { recursive: true });
            const source = await safeFile(config.workspace, input.from);
            if (await fileHash(source) !== input.sha256) throw appError('REPRO_INVALID', `输入 ${key} 已改变；请创建新运行。`);
            await fs.copyFile(source, destination);
            values[key] = rel; frozen[rel] = input.sha256;
        }
    }
    await writeJson(state.workspace, 'inputs/values.json', values);
    await writeJson(state.workspace, 'task/spec.json', state.spec);
    // A generation project sees only task-local bindings, never teacher/host paths.
    if (state.method) {
        const refs = [];
        for (const [index, ref] of state.references.entries()) {
            const rel = `reference/media/${index}${path.extname(ref.source.relVideo) || '.mp4'}`;
            const target = await safeFile(state.workspace, rel, { missing: true });
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(await safeFile(ref.source.assetRoot, ref.source.relVideo), target);
            frozen[rel] = ref.source.sha256;
            refs.push({ id: ref.id, sha256: ref.source.sha256, file: rel, purpose: 'observation-only; never render these pixels' });
        }
        await writeJson(state.workspace, 'reference/SOURCES.json', refs);
    } else await writeJson(state.workspace, 'reference/SOURCES.json', state.references);
    for (const rel of ['inputs/values.json', 'task/spec.json', 'task/acceptance.json', 'reference/SOURCES.json']) frozen[rel] = await fileHash(await safeFile(state.workspace, rel));
    return frozen;
}
async function frozenChecks(state) {
    const checks = [];
    for (const [rel, expected] of Object.entries(state.attempts.at(-1)?.frozenInputs || {})) {
        let passed = false;
        try { passed = await fileHash(await safeFile(state.workspace, rel)) === expected; } catch { /* fails closed */ }
        checks.push({ id: `frozen:${rel}`, passed, message: passed ? '冻结输入未变' : '冻结输入被改动' });
    }
    if (state.method && state.generation) {
        const audit = await auditGeneration(state.workspace, { baseline: state.generation });
        checks.push({ id: 'frozen:method-contract', passed: audit.lockedChanges.length === 0,
            message: audit.lockedChanges.length ? `方法、素材或工具被修改: ${audit.lockedChanges.join(', ')}` : '冻结方法、素材与工具未变' });
    }
    return checks;
}
async function sourceCheck(state) {
    const attempt = state.attempts.at(-1);
    try {
        const current = await snapshotProject(state.workspace);
        const passed = attempt.sourceSnapshot?.treeHash === current.treeHash;
        return { id: 'source:checkpoint', passed, message: passed ? '已执行工程源码未变' : '源码在执行后改变；需要新的修复或执行记录' };
    } catch (error) { return { id: 'source:checkpoint', passed: false, message: error.message }; }
}
async function newAttempt(config, state) {
    if (state.method && !state.attempts.length && state.preparedSnapshot && (await snapshotProject(state.workspace, { includeInputs: true })).treeHash !== state.preparedSnapshot.treeHash) throw notReady('空工程在模型开始前被改变；请创建新实验。');
    if (state.attempts.length) {
        const history = await safeFile(storage(config), `runs/${state.id}/attempt-${state.attempts.length}/project`, { missing: true });
        const next = `${state.workspace}.prepared-${randomUUID()}`;
        let assembled;
        try {
            if (state.method) {
                assembled = await instantiateMethodRecipe(config, state.method.id, next, { spec: state.spec, name: state.production, applyMethod: state.methodApplied !== false });
                if (assembled.scaffoldHash !== state.scaffoldHash) throw appError('REPRO_CHANGED', '空工程工具版本已改变；请创建新的实验。');
            } else if (state.template) await copyProject(templateRoot(await loadTemplate(config, state.template.id)), next);
            else await scaffoldProject(next, { spec: state.spec, name: state.production, capabilities: state.capabilityRequirements || [] });
            await fs.mkdir(path.dirname(history), { recursive: true });
            await fs.rename(state.workspace, history);
            try { await fs.rename(next, state.workspace); }
            catch (error) { await fs.rename(history, state.workspace); throw error; }
            if (assembled) state.methodAssembly = { lockedFiles: assembled.lockedFiles, assetLockHash: assembled.assetLockHash };
        } finally { await fs.rm(next, { recursive: true, force: true }); }
    }
    const frozenInputs = await installInputs(config, state);
    const attempt = { number: state.attempts.length + 1, startedAt: now(), frozenInputs, agents: [], executionCompleted: false };
    if (state.method && !state.continuation) {
        const lockedPaths = [...new Set([...Object.keys(state.methodAssembly?.lockedFiles || {}), ...Object.keys(frozenInputs), 'method', '.agents', '.claude', 'task', 'inputs', 'reference', 'toolkit', 'assets/packs', 'scripts'])];
        state.generation = await captureGenerationBaseline(state.workspace, {
            identity: { method: state.method, methodApplied: state.methodApplied !== false, scaffoldHash: state.scaffoldHash, assetLockHash: state.methodAssembly.assetLockHash, toolProfileHash: state.toolProfileHash, specHash: state.specHash, inputsHash: state.inputsHash },
            lockedPaths, isolation: state.executionIsolation || { level: 'context-only', readIsolation: 'unverified', limitations: ['The native Harness does not enforce read isolation.'] },
        });
        attempt.generation = state.generation;
    }
    if (state.method && state.continuation) attempt.generation = state.generation;
    state.attempts.push(attempt);
    delete state.review; delete state.reviewSource; delete state.technical;
    return attempt;
}
async function check(config, state, deps = {}, { evidence = false } = {}) {
    if (!state.attempts.length) throw notReady('尚未执行制作。');
    await assertReferences(state);
    const prior = state.technical;
    const report = await (deps.evaluateArtifacts || evaluateArtifacts)(state.workspace, state.spec, {
        ...deps, references: state.references,
        ...(evidence ? { evidenceRoot: path.join(storage(config), 'runs', state.id, 'evidence', randomUUID()) } : {}),
    });
    report.checks.push(...await frozenChecks(state));
    report.checks.push(await sourceCheck(state));
    if (state.method) {
        state.generationAudit = await auditGeneration(state.workspace, { baseline: state.generation, assisted: !!state.assisted,
            executionCompleted: state.attempts.at(-1).executionCompleted, executionRecords: state.stageState ? state.attempts.at(-1).agents || [] : state.attempts.flatMap(a => a.agents || []) });
        state.attempts.at(-1).generationAudit = state.generationAudit;
        report.checks.push({ id: 'generation:process', passed: state.generationAudit.processVerified, message: state.generationAudit.processVerified ? '空工程生成与冻结输入审计通过' : '生成来源或冻结输入审计未通过' });
    }
    if ((state.workflow.policy.renderProvider || 'local') === 'local') {
        const render = state.attempts.at(-1).renders?.at(-1);
        const passed = render?.status === 'completed' && render.artifact?.sha256 === report.artifact?.sha256;
        report.checks.push({ id: 'render:completed', passed, message: passed ? '当前尝试的托管渲染已完成且媒体一致' : '缺少当前尝试的成功渲染，或媒体与渲染记录不一致' });
    }
    const completed = state.attempts.at(-1).executionCompleted === true;
    report.checks.push({ id: 'execution:completed', passed: completed, message: completed ? '执行完成' : '执行未完成，残留成片不能放行' });
    report.passed = report.passed && report.checks.every(c => c.passed);
    if (!evidence && report.passed && prior?.artifact?.sha256 === report.artifact?.sha256 && prior.evidence) {
        try {
            await validateEvidenceReport(prior, { spec: state.spec });
            for (const key of ['evidence','evidenceRoot','evidenceManifestSha256']) report[key] = prior[key];
        } catch (error) {
            report.checks.push({ id: 'evidence:integrity', passed: false, message: error.message });
            report.passed = false;
        }
    }
    state.technical = report;
    if (!report.passed || state.review?.artifactSha256 !== report.artifact?.sha256
        || (state.review && state.review.evidenceManifestSha256 !== report.evidenceManifestSha256)) {
        delete state.review; delete state.reviewSource;
    }
    if (report.passed && state.review) {
        try { state.review = validateReview(state.review, state.spec, report.artifact.sha256, report); }
        catch { delete state.review; delete state.reviewSource; }
    }
    state.status = !report.passed ? 'needs-revision' : !state.review ? 'external-review' : state.review.checks.every(c => c.status === 'pass') ? 'passed' : 'needs-revision';
    state.attempts.at(-1).technical = { passed: report.passed, artifactSha256: report.artifact?.sha256 };
    await save(config, state);
    return report;
}
function agentInstruction(state, { resume = false, repair = false } = {}) {
    resume ||= Boolean(state.continuation);
    return [
        state.method ? '从当前空工程独立生成所有场景、构图、镜头与动画。方法目录提供制作方法而不是成品代码；不得读取其他项目、教师实现或历史试跑。先分析参考，再自行编写分镜和可编辑场景。' : state.kind === 'teacher' ? '完成 task/spec.json 描述的对标视频复刻，并留下完整可编辑的工程。先观察参考，记录分析和时间线，再实现和渲染。' : '使用本项目的源码、工作流和 Skill 完成输入内容的新一轮复刻。',
        '从 AGENTS.md 和 .agents/skills/reproduce/SKILL.md 进入。输入位于 inputs/values.json；对标绑定在 reference/SOURCES.json。',
        resume || repair ? '这是已有工程的续跑或修复。先读 RENDER.md、ANALYSIS.md 和 TIMELINE.md，只完成剩余工作；复用已安装的锁定依赖和有效检查，不重新做完整参考分析。' : '运行 npm ci、npm run doctor；按项目流程制作。保留锁定版本，不运行 latest 或升级依赖。',
        (state.workflow.policy.renderProvider || 'local') === 'local' ? '本次只需完成可渲染源码与必要预处理，然后正常结束调用。最终浏览器渲染和媒体检查由工作台执行；已记录浏览器受限时不要重复 npm run render，不因缺少新成片而继续循环。' : '运行 npm run render 与 npm run check。',
        (state.workflow.policy.renderProvider || 'local') === 'local' ? '工作台会在你完成源码后通过独立本地渲染服务生成最终媒体。若原生环境禁止浏览器或本地端口，不要绕过；完成素材和输入预处理后报告该限制，工作台仅执行固定 HyperFrames 渲染命令，不运行你的准备脚本。' : '',
        '只在当前项目和临时目录生成文件；不要安装或升级系统软件、修改全局配置或读取凭据。缺少系统工具应报告阻塞。',
        `最终成片路径: ${state.spec.acceptance.media.file}。必需源码/记录: ${JSON.stringify(state.spec.acceptance.requiredFiles)}。`,
        state.method ? '只允许复用 ASSET-LOCK.json 中的通用素材和 toolkit/ 中的通用运行库。场景装配、坐标、时间轴及相机路径必须由你生成。reference/ 和 overview 仅供观察，不得成为渲染图片、纹理或视频。不调用其他模型或子代理。' : '允许复用旧工程源码和声明素材。本次为工程回放，不作为独立生成证明。不得复制原片或教师完整成片作为输出。',
        '不要修改方法、技能、toolkit/、通用素材、package.json、锁文件、scripts/、task/、inputs/、reference/。自检结果仅帮助修复，外部评审决定是否通过。',
        '完成 src/ 实现后，在 reproduction.json 中将 status 设为 ready，并移除源码中的草稿标记；如无法完成，明确报告原因，不伪造产物或检查。',
        state.feedback ? '当前外部失败反馈优先于旧交接记录中的“已修复”或“只需检查”。逐项核对尚未通过的标准，针对实际差异修改实现；不要仅重跑静态检查后交接。只在当前源码和证据已证明某项问题消失时保留现状，并记录依据；未解决项如实列出。' : '',
        state.feedback ? `前次失败反馈（用于改进，不能更改验收标准）: ${JSON.stringify(state.feedback)}` : '',
    ].filter(Boolean).join('\n');
}
async function callAgent(config, state, options, deps, payload) {
    const consumed = { ...(options.aggregateBudget || state.budget) };
    const remaining = remainingBudget(state.workflow.policy, consumed);
    state.budget.calls += 1;
    state.executionOwner = { pid: process.pid, hostname: os.hostname() };
    state.activeRole = payload.role;
    await save(config, state);
    const started = Date.now();
    let result;
    try {
        result = await (deps.runProjectAgent || runProjectAgent)(config, {
            ...payload, workflow: state.workflow, agentConfig: options.agentConfig || state.agentConfig,
            capabilityRequirements: payload.role === 'reviewer' ? [] : state.capabilityRequirements || [],
            capabilityBindings: payload.role === 'reviewer' ? undefined : state.capabilityBindings,
            executionEnvironment: state.method && payload.role === 'executor' ? { mode: state.executionEnvironmentMode || 'context-only', lockedPaths: [...new Set([...(state.generation?.lockedPaths || []), ...(payload.readOnlyPaths || [])])] } : undefined,
            budget: consumed,
            timeoutMs: Math.min(Number(options.timeoutMs) || remaining.timeoutMs, remaining.timeoutMs), signal: deps.signal,
        }, { ...deps, onStart: async summary => { state.activeAgentRunId = summary.id || summary.runId; if (state.activeOperation) state.activeOperation.agentRunId = state.activeAgentRunId; await save(config, state); await deps.onStart?.(summary); }, onEvent: async event => {
            if (event.type === 'started') { state.activeAgentRunId = event.runId; if (state.activeOperation) state.activeOperation.agentRunId = event.runId; await save(config, state); }
            await deps.onEvent?.(event);
        } });
        return result;
    } catch (error) {
        result = error.data?.reproAgent || error.data?.agent;
        throw error;
    } finally {
        chargeBudget(state.budget, result, Date.now() - started);
        const chargedId = result?.runId || result?.id || state.activeAgentRunId;
        if (chargedId) state.chargedAgentRunIds = [...new Set([...(state.chargedAgentRunIds || []), chargedId])];
        if (result) state.agentRuns = [...(state.agentRuns || []).filter(agent => (agent.runId || agent.id) !== chargedId), result];
        delete state.activeAgentRunId; delete state.activeRole; delete state.executionOwner;
        await save(config, state);
    }
}
async function executeRun(config, state, options, deps, { resume = false, repair = false } = {}) {
    const recovered = await reconcileInterruptedRun(config, state, deps);
    if (recovered.changed) await save(config, state);
    if (state.activeAgentRunId || state.activeRender) throw notReady('该制作仍有活动执行；先等待完成或取消。');
    if (state.status === 'passed') throw notReady('此运行已经通过；新输入请创建新实例。');
    await assertReferences(state);
    if (state.method && (await loadMethodRecipe(config, state.method.id)).treeHash !== state.method.treeHash) throw appError('REPRO_CHANGED', '方法配方已改变。');
    if (state.template) {
        const template = await loadTemplate(config, state.template.id);
        if (state.template.treeHash !== templateHash(template)) throw appError('REPRO_INVALID', '模板已改变，不能继续此运行。');
    }
    if (!state.inputs) { state.inputs = await resolveInputs(config, state.spec, options.inputs, options.inputValues); state.inputsHash = inputFingerprint(state.inputs); }
    for (const input of Object.values(state.inputs)) if (input.type === 'file' && await fileHash(await safeFile(config.workspace, input.from)) !== input.sha256) throw appError('REPRO_INVALID', '冻结输入素材已改变；请创建新运行。');
    const manifest = await readJson(state.workspace, 'reproduction.json');
    const declared = validateRequirements(manifest.capabilities || []);
    if (jsonHash(declared) !== jsonHash(state.capabilityRequirements || [])) throw appError('REPRO_INVALID', '项目能力声明与冻结运行契约不一致；创建新运行以改变所需能力。');
    state.capabilityRequirements ||= [];
    if (state.capabilityRequirements.length) {
        const bindings = await loadCapabilityBindings(config, { workflow: state.workflow });
        const resolved = resolveCapabilities(state.capabilityRequirements, bindings);
        const capabilityHash = jsonHash(resolved);
        if (state.capabilityHash && state.capabilityHash !== capabilityHash) throw appError('REPRO_INVALID', '运行能力绑定已变化，请创建新实例。');
        const readiness = await doctorCapabilities(config, state.capabilityRequirements, { bindings, workflow: state.workflow, probe: true }, deps);
        if (!readiness.ok) throw appError('REPRO_CAPABILITY_UNAVAILABLE', '所需外部能力不可用。', { data: { readiness } });
        state.capabilityHash = capabilityHash;
        state.capabilityProviders = resolved.map(({ id, binding }) => ({ id, transport: binding?.transport || null }));
        state.capabilityBindings = bindings;
    }
    const role = state.kind === 'teacher' ? 'teacher' : 'executor';
    // Validate target and budget before consuming an attempt or moving project files.
    if (!deps.runProjectAgent) await resolveRole(config, state.workflow, role, { target: options.target, agentConfig: options.agentConfig || state.agentConfig });
    remainingBudget(state.workflow.policy, state.budget);
    if (options.aggregateBudget) remainingBudget(state.workflow.policy, options.aggregateBudget);
    if (state.method) {
        const consumed = options.aggregateBudget || state.budget;
        const reserve = state.workflow.policy.reviewSamples || 2;
        const reserveMs = Math.min(120000, Math.floor(state.workflow.policy.maxDurationMs / 3));
        if (state.workflow.policy.maxCalls - consumed.calls <= reserve || state.workflow.policy.maxDurationMs - consumed.elapsedMs <= reserveMs + 1000) throw appError('REPRO_BUDGET_EXHAUSTED', '剩余调用与时间预算须留给两份独立评审。');
        options = { ...options, timeoutMs: Math.min(Number(options.timeoutMs) || Infinity, state.workflow.policy.maxDurationMs - consumed.elapsedMs - reserveMs) };
    }
    if (options.target && state.target && options.target !== state.target) throw appError('REPRO_INVALID', '同一次独立运行不能换目标；创建新实例或单独记录协助。');
    state.target = options.target || state.target;
    let attempt;
    if (resume) {
        attempt = state.attempts.at(-1);
        if (!attempt?.checkpoint || attempt.executionCompleted) throw notReady('没有可恢复的中断检查点。');
        const current = await snapshotProject(state.workspace, { includeInputs: true, includeOutputs: true });
        if (current.treeHash !== attempt.checkpoint.treeHash || (await frozenChecks(state)).some(c => !c.passed)) throw notReady('项目已在检查点后改变，请使用 retry 创建新尝试。');
        attempt.resumptions = (attempt.resumptions || 0) + 1;
    } else if (repair) {
        if (!state.attempts.length || (!state.attempts.at(-1).executionCompleted && !state.attempts.at(-1).checkpoint)) throw notReady('修复需要已完成源码或已保存的中断检查点；先 recover 或 retry。');
        if (state.attempts.length >= Math.min(state.spec.maxAttempts, state.workflow.policy.maxAttempts)) throw appError('REPRO_BUDGET_EXHAUSTED', '尝试次数已用尽。');
        if ((await frozenChecks(state)).some(check => !check.passed)) throw notReady('冻结输入已改变，不能在此实例修复。');
        const previous = state.attempts.at(-1);
        const sourceUnchanged = (await sourceCheck(state)).passed;
        const preserved = path.join(storage(config), 'runs', state.id, `attempt-${previous.number}`, 'before-repair');
        await copyProject(state.workspace, preserved, { includeInputs: true, includeOutputs: true });
        state.feedback = { technical: state.technical?.checks ?? state.feedback?.technical, review: state.review ?? state.feedback?.review, executionError: previous.error || null, render: previous.renders?.at(-1) || null };
        attempt = { number: state.attempts.length + 1, mode: 'repair', parentAttempt: previous.number, externalEdits: !sourceUnchanged, startedAt: now(), frozenInputs: previous.frozenInputs, agents: [], executionCompleted: false };
        if (!sourceUnchanged) state.assisted = true;
        state.attempts.push(attempt); delete state.review; delete state.reviewSource; delete state.technical;
    } else {
        if (state.attempts.length >= Math.min(state.spec.maxAttempts, state.workflow.policy.maxAttempts)) throw appError('REPRO_BUDGET_EXHAUSTED', '尝试次数已用尽。');
        state.feedback = state.technical || state.review ? { technical: state.technical?.checks, review: state.review } : state.feedback || null;
        attempt = await newAttempt(config, state);
    }
    state.status = 'running'; await save(config, state);
    const beforeAgentBudget = { ...state.budget };
    try {
        const agent = await callAgent(config, state, options, deps, { workspace: state.workspace, role, target: state.target,
            instruction: agentInstruction(state, { resume, repair }), expectedTargetHash: state.targetHash, purpose: state.kind });
        attempt.agents.push(agent);
        if (agent.targetHash) state.targetHash = agent.targetHash;
        if (agent.status !== 'completed') throw notReady('Agent 未完成任务。');
        attempt.executionCompleted = true;
        attempt.sourceSnapshot = await snapshotProject(state.workspace);
        attempt.finishedAt = now();
        if ((state.workflow.policy.renderProvider || 'local') === 'local') {
            const renderOptions = { ...options };
            if (options.aggregateBudget) {
                renderOptions.aggregateBudget = { ...options.aggregateBudget };
                for (const key of ['calls', 'elapsedMs', 'toolCalls', 'renderCalls', 'tokens', 'costUsd']) renderOptions.aggregateBudget[key] = (options.aggregateBudget[key] || 0) + ((state.budget[key] || 0) - (beforeAgentBudget[key] || 0));
            }
            await managedRender(config, state, renderOptions, deps);
        }
        await check(config, state, deps);
    } catch (error) {
        const failedAgent = error.data?.reproAgent || error.data?.agent;
        if (failedAgent) {
            attempt.agents.push(failedAgent);
            if (failedAgent.targetHash) state.targetHash = failedAgent.targetHash;
        }
        attempt.error = { code: error.code || 'FAILED', message: String(error.message).slice(0, 1500) };
        attempt.finishedAt = now();
        state.status = deps.signal?.aborted || /CANCEL/.test(error.code) ? 'cancelled'
            : /BUDGET/.test(error.code) ? 'budget-exhausted'
                : /CONFIG|AUTH|UNAVAILABLE|NOT_FOUND/.test(error.code) ? 'blocked' : 'failed';
        await save(config, state);
        throw appError(error.code || 'REPRO_FAILED', error.message, { data: { command: 'repro:run', run: summarizeRun(state) } });
    } finally {
        try { attempt.checkpoint = await snapshotProject(state.workspace, { includeInputs: true, includeOutputs: true }); }
        catch (error) { attempt.checkpointError = error.message; }
        await save(config, state);
    }
    return { command: 'repro:run', run: summarizeRun(state) };
}
async function managedRender(config, state, options, deps) {
    const attempt = state.attempts.at(-1);
    if (!attempt?.executionCompleted) throw notReady('模型必须先完成源码制作，不能用渲染覆盖执行失败。');
    await assertReferences(state);
    if ((await frozenChecks(state)).some(c => !c.passed) || !(await sourceCheck(state)).passed) throw notReady('源码或冻结输入与执行记录不匹配。');
    const aggregate = options.aggregateBudget;
    const consumed = aggregate || state.budget;
    const duration = state.workflow.policy.maxDurationMs - consumed.elapsedMs;
    if (duration < 1000 || (consumed.renderCalls || 0) >= state.workflow.policy.maxRenderCalls) throw appError('REPRO_BUDGET_EXHAUSTED', '渲染次数或总时间预算已用尽。');
    state.budget.renderCalls += 1;
    const renderId = `render-${randomUUID()}`;
    const cancellation = `render-cancellations/${renderId}.json`;
    state.activeRender = { id: renderId, owner: { pid: process.pid, hostname: os.hostname() }, startedAt: now() };
    state.status = 'rendering'; await save(config, state);
    const controller = new AbortController();
    const abort = () => controller.abort();
    deps.signal?.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    if (deps.signal?.aborted) abort();
    const poll = setInterval(() => {
        readJson(storage(config), cancellation).then(() => abort()).catch(error => { if (error.code !== 'ENOENT') abort(); });
    }, 250);
    poll.unref?.();
    const started = Date.now();
    try {
        const render = deps.renderProject || (await import('./render.js')).renderProject;
        const result = await render(config, { workspace: state.workspace, spec: state.spec, signal: controller.signal,
            timeoutMs: Math.min(Number(options.timeoutMs) || duration, duration) }, { ...deps, onStart: async info => { state.activeRender.pid = info.pid; await save(config, state); } });
        attempt.renders = [...(attempt.renders || []), result];
        delete state.review; delete state.reviewSource;
        return result;
    } catch (error) {
        attempt.renders = [...(attempt.renders || []), error.data?.render || { status: 'failed', error: error.message, finishedAt: now() }];
        state.status = controller.signal.aborted ? 'cancelled' : 'blocked';
        throw error;
    } finally {
        clearInterval(poll); deps.signal?.removeEventListener('abort', abort);
        process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
        await fs.rm(path.join(storage(config), cancellation), { force: true });
        delete state.activeRender;
        state.budget.elapsedMs += Date.now() - started; await save(config, state);
    }
}
async function instantiate(config, value, options, deps) {
    const template = await loadTemplate(config, value);
    const spec = templateSpec(template);
    const inputs = await resolveInputs(config, spec, options.inputs, options.inputValues);
    const provenance = template.provenance || template.manifest?.provenance || {};
    const logicalRefs = provenance.references || template.references || [];
    const bindings = options.references ? await readJson(config.workspace, options.references) : undefined;
    const references = await referencesFor(config, logicalRefs.length ? logicalRefs : options.ref ? [options.ref] : [], bindings);
    const workflow = await loadWorkflow(config, { workflowPath: options.workflow, configPath: options.agentConfig });
    const slug = name(options.as);
    const { production: item } = await withLock(config, 'catalog-repro', async () => {
        const catalog = await readCatalog(config.catalogPath);
        // Imported templates bind local reference files without requiring the original gateway.
        for (const reference of references) {
            if (findReference(catalog, reference.id)) continue;
            name(reference.id);
            const dir = `references/${reference.id}`;
            const source = { schema: 'video-remake.source@1', ...reference.source, provider: { kind: 'local-binding' },
                archiveVideoId: reference.id, platform: 'local', title: reference.id, canonicalUrl: '', boundAt: now() };
            await writeJson(config.workspace, `${dir}/SOURCE.json`, source, { exclusive: true });
            catalog.references.push({ id: reference.id, dir, archiveVideoId: reference.id, platform: 'local', status: 'bound' });
        }
        await writeCatalog(config.catalogPath, catalog);
        return startProduction(config, { refId: references[0].id, slug });
    });
    const workspace = path.join(config.workspace, item.dir, 'project');
    await instantiateTemplate(config, template, { destination: workspace, inputs: Object.fromEntries(Object.entries(inputs).filter(([,v]) => v.type === 'text').map(([k,v]) => [k,v.value])) });
    const state = { schema: 'video-remake.reproduction-run@2', id: `r_${randomUUID()}`, production: slug, kind: 'trial', status: 'prepared',
        spec, specHash: jsonHash(spec), references, workspace, workflow, workflowHash: jsonHash(workflow), agentConfig: options.agentConfig,
        capabilityRequirements: validateRequirements(template.manifest.capabilities || []),
        generationMode: 'project-replay', template: { id: templateIdentity(template), treeHash: templateHash(template) }, inputs, inputsHash: inputFingerprint(inputs),
        attempts: [], budget: emptyBudget(), createdAt: now() };
    await save(config, state);
    await writeJson(config.workspace, `${item.dir}/REPRO.json`, { schema: 'video-remake.reproduction-pointer@2', id: state.id, specHash: state.specHash }, { exclusive: true });
    await installInputs(config, state);
    return options.run ? executeRun(config, state, options, deps) : { command: 'repro:instantiate', run: summarizeRun(state) };
}
async function generate(config, value, options, deps) {
    let method;
    try { method = await loadMethodRecipe(config, value); }
    catch (error) { if (error.code === 'ENOENT') throw appError('REPRO_MIGRATION_REQUIRED', '未找到方法配方。旧完整工程仅能用 repro:replay；使用 method-migrate 检查拆分。'); throw error; }
    const spec = validateSpec(options.specValue ?? await readJson(config.workspace, options.spec));
    const inputs = await resolveInputs(config, spec, options.inputs, options.inputValues);
    const bindings = options.references ? await readJson(config.workspace, options.references) : undefined;
    const refs = options.ref ? [options.ref] : Object.keys(bindings || {});
    const references = await referencesFor(config, refs, bindings);
    const workflow = await newWorkflow(config, options);
    if (workflow.policy.reviewSamples !== 2) throw appError('CONFIG_INVALID', '方法生成流程要求 reviewSamples:2；两位评审均完整评审同一成片。');
    if (workflow.policy.maxCalls < 3) throw appError('CONFIG_INVALID', '至少为制作和双评审预留三次调用。');
    const currentProtocol = await reviewProtocolFingerprint();
    if (workflow.policy.reviewProtocolHash && workflow.policy.reviewProtocolHash !== currentProtocol) throw notReady('配置中的评审协议哈希已过期；新实验需明确使用当前协议。');
    workflow.policy.reviewProtocolHash = currentProtocol;
    const slug = name(options.as);
    // Fail before creating catalogue state when the chosen execution role is not usable.
    const resolvedExecutor = deps.runProjectAgent ? null : await resolveRole(config, workflow, 'executor', { target: options.target, agentConfig: options.agentConfig });
    const executionEnvironmentMode = resolvedExecutor?.target.harness.adapter === 'deepseek-harness' && process.platform === 'darwin' ? 'restricted-filesystem' : 'context-only';
    const { production: item } = await withLock(config, 'catalog-repro', async () => {
        const catalog = await readCatalog(config.catalogPath);
        for (const ref of references) {
            if (findReference(catalog, ref.id)) continue;
            name(ref.id);
            const dir = `references/${ref.id}`;
            await writeJson(config.workspace, `${dir}/SOURCE.json`, { schema: 'video-remake.source@1', ...ref.source,
                provider: { kind: 'local-binding' }, archiveVideoId: ref.id, platform: 'local', title: ref.id, canonicalUrl: '', boundAt: now() }, { exclusive: true });
            catalog.references.push({ id: ref.id, dir, archiveVideoId: ref.id, platform: 'local', status: 'bound' });
        }
        await writeCatalog(config.catalogPath, catalog);
        return startProduction(config, { refId: references[0].id, slug });
    });
    const id = `r_${randomUUID()}`;
    const workspace = path.join(storage(config), 'projects', id);
    const assembled = await instantiateMethodRecipe(config, value, workspace, { spec, name: slug, applyMethod: !options.baseline });
    const state = { schema: 'video-remake.reproduction-run@2', id, production: slug, kind: options.baseline ? 'baseline' : 'trial', methodApplied: !options.baseline, generationMode: 'method-generation', status: 'prepared',
        spec, specHash: jsonHash(spec), inputs, inputsHash: inputFingerprint(inputs), references, workspace,
        workflow, workflowHash: jsonHash(workflow), agentConfig: options.agentConfig,
        target: options.target, method: assembled.recipe, scaffoldHash: assembled.scaffoldHash, targetHash: resolvedExecutor?.targetHash, executionEnvironmentMode,
        toolProfileHash: jsonHash({ harness: resolvedExecutor?.target.harness || 'injected-test-runtime', executionEnvironmentMode, capabilities: method.manifest.capabilities, renderer: 'hyperframes-0.8.191' }),
        methodAssembly: { lockedFiles: assembled.lockedFiles, assetLockHash: assembled.assetLockHash },
        capabilityRequirements: validateRequirements(method.manifest.capabilities || []),
        executionIsolation: { level: 'context-only', readIsolation: 'unverified', networkIsolation: 'native-harness',
            limitations: ['Fresh directory and context do not prevent native file reads outside the project.'] },
        attempts: [], budget: emptyBudget(), createdAt: now() };
    if (workflow.execution) await initializeStagedRun(config, state, stagedBridge);
    else {
        state.baseScaffoldHash = state.scaffoldHash; state.executionOverlayHash = jsonHash({ kind: 'no-stage-overlay' });
        state.executionProtocolHash = jsonHash({ kind: 'whole-video-execution@1' }); state.stagePolicyHash = jsonHash({ kind: 'no-stage-policy' });
        state.feedbackMode = state.workflow.policy.allowTeacherAssistance ? 'guided' : 'independent';
        state.checkerProfileHash = await checkerProfileFingerprint(state.workflow.policy.reviewProtocolHash); state.budgetPolicyHash = jsonHash(state.workflow.policy);
        await installInputs(config, state); state.preparedSnapshot = await snapshotProject(workspace, { includeInputs: true });
    }
    await save(config, state);
    await writeJson(config.workspace, `${item.dir}/REPRO.json`, { schema: 'video-remake.reproduction-pointer@2', id, specHash: state.specHash }, { exclusive: true });
    return options.run ? (state.stageState ? executeStaged(config, state, 'run', options, deps, stagedBridge) : executeRun(config, state, options, deps)) : { command: 'repro:generate', run: summarizeRun(state) };
}
async function review(config, state, options, deps, automatic) {
    if (state.method && !automatic) throw notReady('方法生成须由两份独立模型评审验收；单份人工报告不能替代双评审。');
    await check(config, state, deps);
    if (!state.technical.passed) throw notReady('技术检查未通过，不能评审。');
    if (!state.technical.evidence) await check(config, state, deps, { evidence: true });
    if (!state.technical.passed) throw notReady('外部证据生成失败。');
    const artifact = state.technical.artifact.sha256;
    let record, source;
    if (automatic) {
        const samples = state.workflow.policy.reviewSamples || 1;
        const implementationHash = await reviewProtocolFingerprint();
        if (state.workflow.policy.reviewProtocolHash && state.workflow.policy.reviewProtocolHash !== implementationHash) throw notReady('冻结评审协议已改变，不能使用新的判定规则评审此实验。');
        const resolved = await (deps.resolveRole || resolveRole)(config, state.workflow, 'reviewer', { target: options.target, agentConfig: options.agentConfig || state.agentConfig });
        const protocolHash = jsonHash({ protocol: REVIEW_PROTOCOL, implementationHash, samples, target: resolved.targetHash,
            spec: state.specHash, artifact, evidence: state.technical.evidenceManifestSha256 });
        if (state.review && state.reviewSource?.protocolHash === protocolHash) {
            return { command: 'repro:judge', cached: true, run: summarizeRun(state) };
        }
        const votes = state.reviewSession?.protocolHash === protocolHash ? state.reviewSession.votes : [];
        for (const vote of votes) validateReview(vote.review, state.spec, artifact, state.technical);
        for (let i = votes.length; i < samples; i++) {
        let judged;
        for (let invalidAttempt = 0; ; invalidAttempt++) {
            try {
                const judgeVote = () => (deps.judgeArtifacts || judgeArtifacts)(config, { state, target: options.target, workflow: state.workflow,
            agentConfig: options.agentConfig || state.agentConfig, timeoutMs: options.timeoutMs }, {
            ...deps, runProjectAgent: (cfg, payload) => callAgent(cfg, state, options, deps, payload),
        });
                judged = state.stageState ? await stageOperation(config, state, stagedBridge, { stageId: 'review', kind: 'final-review', amount: { calls: 1, elapsedMs: Number(options.timeoutMs) || state.workflow.execution.reviewerTimeoutMs }, holdback: finalReviewReserve(state.workflow, { remainingVotes: samples - i - 1, includeRender: false, includeEvidence: false }) }, judgeVote) : await judgeVote();
                break;
            } catch (error) {
                if (!state.method || !error.reviewReportInvalid) throw error;
                state.reviewFailures = [...(state.reviewFailures || []), { ...error.data?.rejectedReview,
                    artifactSha256: artifact, protocolHash, vote: i + 1, retry: invalidAttempt, at: now() }];
                state.status = 'review-incomplete';
                await save(config, state);
                if (invalidAttempt >= 1) throw error;
                // An invalid report is retryable; a valid unfavorable vote never reaches this branch.
                remainingBudget(state.workflow.policy, state.budget);
            }
        }
        votes.push(judged);
        state.reviewRuns = [...(state.reviewRuns || []), judged.agent];
        state.reviewSession = { protocolHash, votes };
        await save(config, state);
        }
        const judged = votes.at(-1);
        record = judged.review;
        source = { kind: 'model', requestedModel: judged.agent.requestedModel, observedModel: judged.agent.observedModel,
            harness: judged.agent.harness, runId: judged.agent.runId, protocolHash, implementationHash, protocol: REVIEW_PROTOCOL.version, samples };
        if (samples > 1) {
            const combined = combineReviews(votes.map(v => validateReview(v.review, state.spec, artifact, state.technical)));
            record = combined.review;
            source.disagreements = combined.disagreements;
            source.votes = votes.map(v => ({ runId: v.agent.runId, review: v.review }));
        }
    } else {
        await validateEvidenceReport(state.technical, { spec: state.spec });
        record = validateReview(options.reviewValue ?? await readJson(config.workspace, options.review), state.spec, artifact, state.technical);
        source = { kind: 'human', reviewer: record.reviewer };
    }
    await check(config, state, deps);
    if (!state.technical.passed || state.technical.artifact.sha256 !== artifact) throw notReady('评审期间成片改变，需要重新评审。');
    state.review = record; state.reviewSource = source;
    delete state.reviewSession;
    state.status = record.checks.every(c => c.status === 'pass') ? 'passed' : 'needs-revision';
    state.attempts.at(-1).review = { passed: state.status === 'passed', artifactSha256: record.artifactSha256, evidenceManifestSha256: record.evidenceManifestSha256 };
    await save(config, state);
    return { command: `repro:${automatic ? 'judge' : 'review'}`, run: summarizeRun(state) };
}
async function extract(config, state, options, deps) {
    if (state.kind !== 'teacher') throw notReady('方法提炼需要教师制作。旧模板使用 method-migrate 查看迁移清单。');
    await check(config, state, deps);
    if (state.status !== 'passed') throw notReady('教师制作须通过技术检查和独立评审。');
    let feedback = null, previousProvenance = {};
    if (options.feedback) {
        const trial = await loadRun(config, options.feedback);
        if (!trial.method || trial.specHash !== state.specHash || !trial.method.id.startsWith(`${options.name}@`)
            || Number(trial.method.id.split('@')[1]) >= Number(options.version)) throw appError('REPRO_INVALID', '反馈必须来自同一规格、同名较低版本方法的生成运行。');
        const prior = await loadMethodRecipe(config, trial.method.id);
        previousProvenance = prior.provenance || {};
        feedback = { runId: trial.id, method: trial.method, inputsHash: trial.inputsHash,
            references: trial.references.map(r => ({ id: r.id, sha256: r.source.sha256 })),
            checks: trial.technical?.checks, review: trial.review, error: trial.attempts.at(-1)?.error };
    }
    const workspace = path.join(storage(config), 'method-extract', `e_${randomUUID()}`, 'method');
    await scaffoldMethodRecipe(workspace, { title: state.spec.title, scope: 'same-reference' });
    const source = { teacherWorkspace: state.workspace, task: state.spec, review: state.review, feedback,
        references: state.references.map(r => ({ id: r.id, sha256: r.source.sha256 })) };
    // Extraction may inspect teacher code; it is never copied into the output.
    const agent = await callAgent(config, state, options, deps, { workspace, role: 'extractor', target: options.target,
        purpose: 'method-extraction', instruction: [
            '提炼一个只包含制作方法的配方。当前目录是空方法目录，教师工程仅作为只读研究来源。',
            `来源与验收上下文: ${JSON.stringify(source)}`,
            '编写 AGENTS.md、三个标准 Skill 和 methods/、constraints/、repair-playbooks/ 下的文档。',
            '说明分析、分镜、空间构图、镜头运动、字幕音频、观察和修复方法；不得复制场景源码、完整布局、时间轴、相机坐标数组、成片或素材。',
            '配方应指导另一模型从空工程独立制作。具体任务的时间与画面目标保留在任务输入中。',
            'recipe.json.files 明确列出全部文档；填写 contentReview 并声明 containsTargetImplementation:false。不要添加 package.json、src、运行日志或主机绝对路径。',
            '如果没有完成内容检查，不要声明已完成。不要启动新模型、修改教师工程或执行渲染。',
        ].join('\n') });
    if (agent.status !== 'completed') throw notReady('方法提炼未完成。');
    const method = await freezeMethodRecipe(config, { directory: workspace, name: options.name, version: Number(options.version),
        provenance: { teacher: { runId: state.id, artifactSha256: state.technical.artifact.sha256 },
            references: [...new Map([...source.references, ...(previousProvenance.references || []), ...(feedback?.references || [])].map(r => [r.sha256, r])).values()], extraction: { runId: agent.runId, requestedModel: agent.requestedModel, observedModel: agent.observedModel, harness: agent.harness },
            developmentInputs: [...new Set([state.inputsHash, ...(previousProvenance.developmentInputs || []), ...(feedback ? [feedback.inputsHash] : [])])], feedback: feedback ? { runId: feedback.runId, method: feedback.method.id, inputsHash: feedback.inputsHash } : null } });
    state.extractions = [...(state.extractions || []), { method: method.id, runId: agent.runId, createdAt: now() }];
    await save(config, state);
    return { command: 'repro:extract', method: method.id, path: method.root, status: 'candidate' };
}
async function publish(config, value, options, deps) {
    const state = await loadRun(config, options.production);
    if (!state.method) throw notReady('旧工程回放不能发布为独立生成成果；历史记录保持可读。');
    const method = await loadMethodRecipe(config, value);
    if (!state.method || state.method.id !== method.id || state.method.treeHash !== method.treeHash) throw notReady('发布必须对应方法配方的生成运行。');
    if (state.activeAgentRunId || state.activeRender) throw appError('REPRO_BUSY', '运行尚未结束。');
    await check(config, state, deps);
    if (state.status !== 'passed' || state.assisted || !state.generationAudit?.strictIndependent
        || state.reviewSource?.samples !== 2 || state.reviewSource?.kind !== 'model') throw notReady('独立生成发布需要技术通过、受验证的读取隔离、无外部协助及两份完整通过的模型评审。可继续保留和分享未认证的实验结果。');
    await validateEvidenceReport(state.technical, { spec: state.spec });
    const seen = new Set((method.provenance?.references || []).map(r => r.sha256));
    const heldOutReference = seen.size > 0 && state.references.every(r => !seen.has(r.source.sha256));
    const release = { schema: 'video-remake.method-release@1', method: method.id, treeHash: method.treeHash,
        validationScope: { scope: !seen.size ? 'lineage-unknown' : heldOutReference ? 'held-out-reference' : 'same-reference',
            generation: generationQualification(state), inputsHash: state.inputsHash, references: state.references.map(r => ({ id:r.id, sha256:r.source.sha256 })),
            executor: state.attempts.at(-1).agents.at(-1), attempts: state.attempts.length },
        trial: state.id, production: state.production, specHash: state.specHash, artifactSha256: state.technical.artifact.sha256,
        evidenceManifestSha256: state.technical.evidenceManifestSha256, review: state.review, reviewSource: state.reviewSource,
        budget: state.budget, publishedAt: now() };
    await writeJson(config.workspace, `reproductions/method-releases/${method.name}/v${method.version}.json`, release, { exclusive: true });
    return { command: 'repro:publish', release };
}
export async function listReproductions(config) {
    const catalog = await readCatalog(config.catalogPath);
    const runs = [];
    for (const production of catalog.productions) {
        try { runs.push(summarizeRun(await loadRun(config, production.slug))); }
        catch (error) { if (error.code !== 'ENOENT') runs.push({ production: production.slug, status: 'invalid', error: error.message }); }
    }
    const templates = [];
    const root = path.join(config.workspace, 'reproductions/templates');
    for (const id of await fs.readdir(root).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
        for (const version of await fs.readdir(path.join(root, id))) {
            if (!/^v[1-9]\d*$/.test(version)) continue;
            try {
                const template = await loadTemplate(config, `${id}@${version.slice(1)}`);
                let release;
                try { release = await readJson(config.workspace, `reproductions/releases/${id}/${version}.json`); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (release && (release.schema !== 'video-remake.reproduction-release@1' || release.template !== templateIdentity(template) || release.treeHash !== templateHash(template))) throw appError('REPRO_INVALID', '发布记录与模板不匹配。');
                templates.push({ generationMode: 'project-replay', id: templateIdentity(template), path: templateRoot(template), treeHash: templateHash(template), status: release ? 'released' : 'candidate',
                    ...(release ? { release: { production: release.production, validationScope: release.validationScope, publishedAt: release.publishedAt } } : {}) });
            }
            catch (error) { templates.push({ id: `${id}@${version.slice(1)}`, status: 'invalid', error: error.message }); }
        }
    }
    return { command: 'repro:list', runs, templates, methods: await listMethodRecipes(config) };
}
export async function executeRepro(config, action, subject, options = {}, deps = {}) {
    if (action === 'benchmark') {
        const { runBenchmark } = await import('./benchmark.js');
        return runBenchmark(config, subject, { loadRun });
    }
    if (action === 'cycle') {
        throw appError('REPRO_MIGRATION_REQUIRED', '旧工程模板循环入口已停用；请先提炼方法，再使用 generate、run、judge、repair 的受控流程。历史循环记录保留。');
    }
    if (action === 'logs' || action === 'cancel') {
        const state = await loadRun(config, subject);
        if (action === 'cancel' && state.activeRender) {
            await writeJson(storage(config), `render-cancellations/${name(state.activeRender.id)}.json`, { requestedAt: now() });
            return { command: 'repro:cancel', id: state.activeRender.id, status: 'cancellation-requested' };
        }
        if (action === 'cancel' && state.activeOperation && !state.activeAgentRunId) {
            await writeJson(storage(config), `stage-cancellations/${name(state.activeOperation.id)}.json`, { requestedAt: now() });
            return { command: 'repro:cancel', id: state.activeOperation.id, status: 'cancellation-requested' };
        }
        const id = options.runId || state.activeAgentRunId || state.agentRuns?.at(-1)?.runId || state.reviewRuns?.at(-1)?.runId || state.attempts.at(-1)?.agents.at(-1)?.runId;
        if (!id) throw notReady('没有可操作的 Agent 运行。');
        return { command: `repro:${action}`, ...(action === 'logs' ? await projectAgentLogs(config, id, options) : await projectAgentCancel(config, id)) };
    }
    if (action === 'list') return listReproductions(config);
    if (action === 'config') return { command: 'repro:config', workflow: await newWorkflow(config, options) };
    if (action === 'doctor') {
        const data = { command: 'repro:doctor', ...(await doctorWorkflow(config, { workflowPath: options.workflow, agentConfig: options.agentConfig, checkLogin: options.checkLogin }, deps)) };
        if (!data.ok) throw appError('REPRO_NOT_READY', '部分模型或 Harness 配置不可用。', { data });
        return data;
    }
    if (action === 'status') {
        const state = await loadRun(config, subject);
        const run = summarizeRun(state);
        if (state.activeAgentRunId) {
            try { run.activeAgent = await (deps.projectAgentStatus || projectAgentStatus)(config, state.activeAgentRunId); }
            catch (error) { run.activeAgentError = error.message; }
        }
        return { command: 'repro:status', run };
    }
    if (action === 'validate') {
        const data = { command: 'repro:validate', ...(await validateProject(path.resolve(config.workspace, subject))) };
        if (!data.ok) throw appError('REPRO_INVALID', '项目契约验证失败。', { data });
        return data;
    }
    if (action === 'method-revise') { const { reviseMethod } = await import('./method-revision.js'); return reviseMethod(config, subject, options, deps); }
    if (action === 'method-freeze') {
        const directory = path.resolve(config.workspace, subject);
        const { freezeMethodRevisionDraft } = await import('./method-revision.js');
        const revision = await freezeMethodRevisionDraft(config, directory, options, deps);
        return { command: 'repro:method-freeze', method: revision || await freezeMethodRecipe(config, { directory, name: options.name, version: Number(options.version) }) };
    }
    if (action === 'asset-freeze') return { command: 'repro:asset-freeze', assetPack: await freezeAssetPack(config, { directory: path.resolve(config.workspace, subject), name: options.name, version: Number(options.version) }) };
    if (action === 'method-migrate') return { command: 'repro:method-migrate', report: await inspectMethodMigration(config, subject) };
    if (action === 'export') {
        try { await loadMethodRecipe(config, subject); }
        catch (error) { if (error.code !== 'ENOENT') throw error; return { command: 'repro:export', generationMode: 'project-replay', ...(await exportTemplate(config, subject, { destination: path.resolve(config.workspace, options.to) })) }; }
        return { command: 'repro:export', ...(await exportMethodRecipe(config, subject, { destination: path.resolve(config.workspace, options.to) })) };
    }
    if (action === 'import') return { command: 'repro:import', ...(await importMethodRecipe(config, path.resolve(config.workspace, subject), options)) };
    if (action === 'migrate') { if (!options.dryRun) throw appError('REPRO_MIGRATION_REQUIRED', '旧工程迁移写入已停用；使用 method-migrate 检查拆分，旧包仍可 dry-run 检查。'); const { migrateLegacy } = await import('./migrate.js'); return migrateLegacy(config, subject, options); }
    const lockKey = ['instantiate','trial','generate','replay'].includes(action) ? name(options.as) : action === 'publish' ? name(options.production) : name(subject);
    return withLock(config, lockKey, async () => {
        if (action === 'init') return init(config, subject, options);
        if (action === 'replay') return instantiate(config, subject, options, deps);
        if (['instantiate','trial','generate'].includes(action)) return generate(config, subject, { ...options, run: action === 'trial' || options.run }, deps);
        if (action === 'publish') return publish(config, subject, options, deps);
        const state = await loadRun(config, subject);
        if (state.stageState && action === 'recover') {
            const result = await reconcileInterruptedRun(config, state, deps);
            if (result.changed) await save(config, state);
            return { command: 'repro:recover', recovered: result.changed, run: summarizeRun(state) };
        }
        if (action === 'recover') {
            const recovered = await reconcileInterruptedRun(config, state, deps);
            if (recovered.changed) await save(config, state);
            const attempt = state.attempts?.at(-1);
            let checkpointCreated = false;
            if (!state.activeAgentRunId && !state.activeRender && state.status === 'interrupted'
                && attempt?.error?.code === 'REPRO_INTERRUPTED' && !attempt.executionCompleted && !attempt.checkpoint) {
                await assertReferences(state);
                if ((await frozenChecks(state)).some(check => !check.passed)) throw notReady('冻结输入已改变，不能创建恢复检查点。');
                attempt.checkpoint = await snapshotProject(state.workspace, { includeInputs: true, includeOutputs: true });
                attempt.checkpointOrigin = 'explicit-recovery';
                // A crash leaves an interval in which outside edits cannot be
                // distinguished from maker work. Preserve it, but never claim
                // independent execution or completed source on that basis.
                state.assisted = true;
                checkpointCreated = true;
                await save(config, state);
            }
            return { command: 'repro:recover', recovered: recovered.changed || checkpointCreated, run: summarizeRun(state) };
        }
        const recovered = await reconcileInterruptedRun(config, state, deps);
        if (recovered.changed) await save(config, state);
        if (state.activeAgentRunId || state.activeRender || state.activeOperation) throw appError('REPRO_BUSY', '该制作仍有活动执行，不能覆盖当前状态。');
        if (state.stageState && ['run','teacher','retry','resume','repair','render','check','judge','review','continue'].includes(action)) {
            if (action === 'teacher' && state.kind !== 'teacher') throw notReady('此运行不是教师制作。');
            if (action === 'continue') throw notReady('阶段运行不通过续修批次重置预算；可修复当前阶段，或从空工程重试。');
            if (action === 'review') throw notReady('阶段运行使用 judge 执行两份完整独立评审。');
            return executeStaged(config, state, action === 'teacher' ? 'run' : action, options, deps, stagedBridge);
        }
        if (action === 'continue') {
            if (state.status === 'passed' || !state.attempts.length) throw notReady('续修批次仅用于已有但尚未通过的制作。');
            await assertReferences(state);
            if ((await frozenChecks(state)).some(check => !check.passed)) throw notReady('冻结输入已改变，不能续修。');
            const id = `r_${randomUUID()}`;
            const archive = path.join(storage(config), 'runs', state.id, 'continuations', id, 'project');
            await copyProject(state.workspace, archive, { includeInputs: true, includeOutputs: true });
            const continuedWorkspace = state.method ? path.join(storage(config), 'projects', id) : state.workspace;
            if (state.method) await copyProject(state.workspace, continuedWorkspace, { includeInputs: true, includeOutputs: true });
            const next = { schema: state.schema, id, production: state.production, kind: state.kind,
                status: 'prepared', spec: state.spec, specHash: state.specHash, references: state.references,
                workspace: continuedWorkspace, workflow: state.workflow, workflowHash: state.workflowHash,
                agentConfig: state.agentConfig, capabilityRequirements: state.capabilityRequirements,
                inputs: state.inputs, inputsHash: state.inputsHash, target: state.target, targetHash: state.targetHash,
                template: state.template, method: state.method, methodApplied: state.methodApplied, generationMode: state.generationMode, generation: state.generation, methodAssembly: state.methodAssembly, scaffoldHash: state.scaffoldHash, toolProfileHash: state.toolProfileHash, executionEnvironmentMode: state.executionEnvironmentMode, attempts: [], budget: emptyBudget(), assisted: true, createdAt: now(),
                feedback: { technical: state.technical?.checks ?? state.feedback?.technical, review: state.review ?? state.feedback?.review },
                continuation: { parentRunId: state.id, parentBudget: state.budget, parentStatus: state.status, archivedProject: archive } };
            await save(config, next);
            const { item } = await production(config, subject);
            await writeJson(config.workspace, `${item.dir}/REPRO.json`, { schema: 'video-remake.reproduction-pointer@2', id, specHash: next.specHash });
            return { command: 'repro:continue', run: summarizeRun(next) };
        }
        if (action === 'render') {
            await managedRender(config, state, options, deps);
            await check(config, state, deps);
            return { command: 'repro:render', run: summarizeRun(state) };
        }
        if (['run','teacher','retry','resume','repair'].includes(action)) {
            if (action === 'teacher' && state.kind !== 'teacher') throw notReady('此运行不是教师制作。');
            return executeRun(config, state, options, deps, { resume: action === 'resume', repair: action === 'repair' });
        }
        if (action === 'check') {
            const technical = await check(config, state, deps, { evidence: !!options.evidence });
            const result = { command: 'repro:check', run: summarizeRun(state) };
            if (!technical.passed) throw appError('REPRO_CHECK_FAILED', '技术检查未通过。', { data: result });
            return result;
        }
        if (action === 'review' || action === 'judge') return review(config, state, options, deps, action === 'judge');
        if (action === 'extract') return extract(config, state, options, deps);
        throw appError('INVALID_INPUT', `未知复刻命令: ${action}`);
    });
}

const stagedBridge = { save, installInputs, assertReferences, callAgent, managedRender, check, review, summarizeRun, instantiateMethodRecipe, scaffoldProject };

async function newWorkflow(config, options) {
    const workflow = await loadWorkflow(config, { workflowPath: options.workflow, configPath: options.agentConfig });
    const exists = await fs.access(workflow.workflowPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    return exists ? workflow : { ...workflow, ...createStagedWorkflow({ roles: workflow.roles }) };
}

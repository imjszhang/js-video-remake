import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { resolveConfig } from '../config.js';
import { loadAgentConfig } from '../agent-config.js';
import { readCatalog } from '../catalog.js';
import { appError } from '../errors.js';
import { loadWorkflow, validateWorkflow, createStagedWorkflow } from './config.js';
import { executeRepro, listReproductions, loadRun, summarizeRun } from './workflow.js';
import { projectAgentStatus } from './runner.js';
import { stageProtocolFingerprint } from './stages.js';
import { safeProjectFile } from './project.js';
import { storage, fileHash } from './store.js';

const MAX_BODY = 256 * 1024;
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const scopeIdentifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const templateId = /^[a-z][a-z0-9_-]{0,63}@[1-9]\d*$/;
const actions = {
    doctor: ['checkLogin'], init: ['specValue', 'inputValues', 'baseline'],
    generate: ['as', 'specValue', 'inputValues', 'ref', 'run'],
    replay: ['as', 'inputValues', 'ref', 'run'], run: ['target', 'timeoutMs', 'stage', 'shot', 'until', 'step'], teacher: ['target', 'timeoutMs'],
    retry: ['target', 'timeoutMs', 'step'], resume: ['target', 'timeoutMs', 'stage', 'shot', 'until', 'step'], recover: [], repair: ['target', 'timeoutMs', 'stage', 'shot', 'until', 'step'], render: ['timeoutMs', 'stage', 'shot'], check: ['evidence', 'stage', 'shot'], judge: ['target', 'timeoutMs'],
    extract: ['name', 'version', 'feedback', 'target', 'timeoutMs'], publish: ['production'], cancel: [],
    'method-revise': ['name', 'version', 'feedback', 'target', 'timeoutMs'],
};
const mediaTypes = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wav': 'audio/wav' };
const runMutations = ['run', 'teacher', 'retry', 'resume', 'recover', 'repair', 'render', 'check', 'judge', 'extract', 'publish', 'cancel'];

function respond(response, status, value, head = false) {
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    response.end(head ? undefined : body);
}
function failure(code, message, status = 400) { return Object.assign(appError(code, message), { status }); }
function localRequest(request) {
    const remote = request.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw failure('LOCAL_ONLY', '复刻工作台只接受本机请求。', 403);
    let host;
    try { host = new URL(`http://${request.headers.host}`); } catch { throw failure('HOST_INVALID', '请求来源无效。', 403); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) throw failure('HOST_INVALID', '复刻工作台只接受本机 Host。', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw failure('ORIGIN_INVALID', '拒绝跨站请求。', 403);
    if (request.headers.origin) {
        let origin;
        try { origin = new URL(request.headers.origin); } catch { throw failure('ORIGIN_INVALID', '请求来源无效。', 403); }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== host.host) throw failure('ORIGIN_INVALID', '只接受同源请求。', 403);
    }
}
async function bodyJson(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw failure('CONTENT_TYPE', '请求必须是 JSON。', 415);
    if (Number(request.headers['content-length']) > MAX_BODY) throw failure('BODY_TOO_LARGE', '请求超过 256 KiB。', 413);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw failure('BODY_TOO_LARGE', '请求超过 256 KiB。', 413);
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let value;
    try { value = JSON.parse(text); } catch { throw failure('INVALID_JSON', 'JSON 格式无效。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_JSON', '请求必须是 JSON 对象。');
    return value;
}
function jobInput(value) {
    for (const key of Object.keys(value)) if (!['action', 'subject', 'options'].includes(key)) throw failure('INVALID_INPUT', `未知请求字段: ${key}`);
    if (!Object.hasOwn(actions, value.action)) throw failure('INVALID_ACTION', '此操作不支持通过工作台执行。');
    const subject = value.subject || '';
    if (value.action !== 'doctor' && !(['generate', 'replay', 'publish', 'method-revise'].includes(value.action) ? templateId : identifier).test(subject)) throw failure('INVALID_INPUT', '制作或配方标识无效。');
    const options = value.options || {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure('INVALID_INPUT', 'options 必须是对象。');
    for (const key of Object.keys(options)) if (!actions[value.action].includes(key)) throw failure('INVALID_INPUT', `不支持的操作参数: ${key}`);
    for (const key of ['as', 'name', 'production', 'ref']) if (options[key] !== undefined && (typeof options[key] !== 'string' || !identifier.test(options[key]))) throw failure('INVALID_INPUT', `${key} 必须是项目标识。`);
    for (const key of ['stage', 'shot', 'until']) if (options[key] !== undefined && (typeof options[key] !== 'string' || !scopeIdentifier.test(options[key]) || ['constructor', 'prototype', '__proto__'].includes(options[key]))) throw failure('INVALID_INPUT', `${key} 必须是安全的阶段或镜头标识。`);
    if (options.feedback !== undefined) {
        if (value.action === 'method-revise') {
            if (!Array.isArray(options.feedback) || !options.feedback.length || options.feedback.length > 30 || options.feedback.some(id => typeof id !== 'string' || !identifier.test(id)) || new Set(options.feedback).size !== options.feedback.length) throw failure('INVALID_INPUT', '方法修订需要不重复的反馈制作标识列表。');
        } else if (typeof options.feedback !== 'string' || !identifier.test(options.feedback)) throw failure('INVALID_INPUT', 'feedback 必须是项目标识。');
    }
    if (options.target !== undefined && (typeof options.target !== 'string' || options.target.length > 128)) throw failure('INVALID_INPUT', '模型目标无效。');
    if (options.run !== undefined && typeof options.run !== 'boolean') throw failure('INVALID_INPUT', 'run 必须是布尔值。');
    if (options.step !== undefined && typeof options.step !== 'boolean') throw failure('INVALID_INPUT', 'step 必须是布尔值。');
    if (options.version !== undefined && (!Number.isSafeInteger(options.version) || options.version < 1)) throw failure('INVALID_INPUT', 'version 必须是正整数。');
    if (value.action === 'method-revise' && (!options.name || !options.version || !options.feedback?.length)) throw failure('INVALID_INPUT', '方法修订需要新版本名称、版本号与反馈记录。');
    if (value.action === 'generate' && (!options.specValue || typeof options.specValue !== 'object' || Array.isArray(options.specValue) || !options.ref || !options.as)) throw failure('INVALID_INPUT', '空工程生成需要独立的任务规格、参考视频和新制作标识。');
    return { action: value.action, subject, options };
}

/** Local-only HTTP transport; all mutations delegate to the CLI's workflow. */
export function createReproController({ root, config: suppliedConfig, deps = {}, sendAsset } = {}) {
    const config = suppliedConfig || resolveConfig({ workspace: root });
    const execute = deps.executeRepro || executeRepro;
    const list = deps.listReproductions || listReproductions;
    const getRun = deps.loadRun || loadRun;
    const jobs = new Map();
    const assets = new Map();
    let active = null;
    function publicJob(job) {
        return { id: job.id, action: job.action, subject: job.subject, status: job.status, startedAt: job.startedAt,
            finishedAt: job.finishedAt, result: job.result, error: job.error };
    }
    async function protocolCompatibility(state) {
        if (state.schema !== 'video-remake.reproduction-run@3' && !state.stageState) return null;
        const frozenHash = state.executionProtocolHash || state.stageState?.protocol?.hash || null;
        let currentHash;
        try { currentHash = await (deps.stageProtocolFingerprint || stageProtocolFingerprint)(); }
        catch { return { matches: false, frozenHash, currentHash: null, message: '当前执行协议无法核实，此运行暂为只读历史记录。' }; }
        return { matches: Boolean(frozenHash && frozenHash === currentHash), frozenHash, currentHash,
            message: frozenHash === currentHash ? '执行协议与冻结记录一致。' : '执行协议已变化，此运行仅供历史查看；请创建新实验。原有失败报告仍可用于方法修订。' };
    }
    async function assertJobProtocol(input) {
        if (!runMutations.includes(input.action)) return;
        const state = await getRun(config, input.action === 'publish' ? input.options.production : input.subject);
        const compatibility = await protocolCompatibility(state);
        if (compatibility?.matches === false && !(input.action === 'cancel' && (state.activeOperation || state.activeAgentRunId || state.activeRender))) {
            throw failure('REPRO_PROTOCOL_CHANGED', compatibility.message, 409);
        }
    }
    async function configuration() {
        let workflow = await (deps.loadWorkflow || loadWorkflow)(config);
        if (workflow.workflowPath) {
            try { await fs.access(workflow.workflowPath); }
            catch (error) { if (error.code !== 'ENOENT') throw error; workflow = { ...workflow, ...createStagedWorkflow({ roles: workflow.roles }) }; }
        }
        let targets = [], targetError;
        try {
            const settings = await (deps.loadAgentConfig || loadAgentConfig)(config);
            targets = settings.targets.map(target => ({ name: target.name, enabled: target.enabled,
                harness: target.harness.adapter, permission: target.harness.permission,
                contextMode: target.harness.contextMode || 'snapshot', model: target.backend.model || null,
                backend: target.backend.kind || target.backend.protocol || null }));
        } catch (error) { targetError = error.message; }
        const writable = !workflow.workflowPath || path.resolve(workflow.workflowPath) === path.join(config.workspace, 'reproduction-workflow.json');
        return { writable, workflow: { schemaVersion: workflow.schemaVersion || 1, roles: workflow.roles, policy: workflow.policy,
            ...(workflow.execution ? { execution: workflow.execution } : {}),
            ...(workflow.capabilitiesFile ? { capabilitiesFile: workflow.capabilitiesFile } : {}) }, targets, targetError };
    }
    async function registerAsset(file, sha256, label) {
        const type = mediaTypes[path.extname(file).toLowerCase()];
        if (!type || !/^[a-f0-9]{64}$/.test(sha256 || '')) return null;
        const real = await fs.realpath(file);
        if (real !== file || !(await fs.lstat(file)).isFile()) return null;
        const id = createHash('sha256').update(`${real}\0${sha256}`).digest('hex').slice(0, 32);
        assets.set(id, { path: real, sha256, name: path.basename(real), type });
        return { label, url: `api/repro/media/${id}`, type };
    }
    async function stageAssets(state, selectedStage) {
        const evidence = [];
        if (!identifier.test(state.id || '')) return evidence;
        const storeRoot = storage(config);
        const allowed = path.join(storeRoot, 'runs', state.id, 'stages');
        const submissions = [...(state.stageSubmissions || [])];
        if (state.stageReference) submissions.unshift({ ...state.stageReference, id: 'reference', stageId: 'analysis' });
        for (const submission of submissions) {
            const stageId = submission.stageId || submission.stage;
            if (selectedStage && selectedStage !== stageId) continue;
            const evidenceRoot = submission.evidenceRoot;
            if (typeof evidenceRoot !== 'string' || !path.resolve(evidenceRoot).startsWith(`${allowed}${path.sep}`)) continue;
            const items = [...(submission.items || submission.evidence?.items || [])];
            const artifact = submission.artifact || submission.preview?.artifact;
            if (artifact?.path && artifact?.sha256) items.unshift({ ...artifact, id: `${submission.id}:preview`, kind: 'video', label: '阶段预览（不代表质量通过）' });
            for (const item of items) {
                try {
                    // Check every parent from the trusted store root, not only the final
                    // evidence directory; a symlinked stage cannot broaden the allowlist.
                    const directory = path.relative(storeRoot, path.resolve(evidenceRoot)).split(path.sep).join('/');
                    const file = await safeProjectFile(storeRoot, `${directory}/${item.path}`);
                    if (await fileHash(file) !== item.sha256) continue;
                    const asset = await registerAsset(file, item.sha256, item.label || `${stageId} · ${item.sourceId || item.source || ''} ${item.timeSec ?? ''}`.trim());
                    const shotIds = item.shotIds || item.reasons?.filter(reason => /^(shot|transition):/.test(reason)).map(reason => reason.replace(/^(shot|transition):/, ''));
                    if (asset) evidence.push({ ...asset, id: item.id, stageId, shotId: submission.shotId || item.shotId || null,
                        shotIds: shotIds?.length ? shotIds : submission.shotIds || [],
                        submissionId: submission.id, submissionStatus: submission.status || null, staleReason: submission.staleReason || null, kind: item.kind || null, timeSec: item.timeSec ?? null,
                        sampleTimeSec: item.sampleTimeSec ?? item.requestedTimeSec ?? null, framePtsSec: item.framePtsSec ?? item.timing?.framePtsSec ?? null });
                } catch { /* Unfrozen, changed or escaping evidence is never exposed. */ }
            }
        }
        return evidence;
    }
    async function runDetail(slug, selectedStage = null, { summaryOnly = false } = {}) {
        if (!identifier.test(slug)) throw failure('INVALID_INPUT', '制作标识无效。');
        const state = await getRun(config, slug);
        if (selectedStage) {
            const stages = Array.isArray(state.stageState?.stages) ? state.stageState.stages : [];
            const stage = stages.find(item => (item.id || item.stageId) === selectedStage);
            if (!stage) throw failure('NOT_FOUND', '阶段不存在；历史运行不会补造阶段记录。', 404);
            return { stage, evidence: await stageAssets(state, selectedStage) };
        }
        const run = summarizeRun(state);
        const compatibility = await protocolCompatibility(state);
        if (compatibility) run.protocolCompatibility = compatibility;
        if (compatibility?.matches === false) {
            const activeRun = Boolean(state.activeOperation || state.activeAgentRunId || state.activeRender);
            run.allowedActions = ['status', 'logs', ...(activeRun ? ['cancel'] : [])];
            run.blockedReasons = { ...run.blockedReasons, ...Object.fromEntries(runMutations.filter(action => action !== 'cancel' || !activeRun).map(action => [action, compatibility.message])) };
        }
        if (state.activeAgentRunId) {
            try { run.activeAgent = await (deps.projectAgentStatus || projectAgentStatus)(config, state.activeAgentRunId); }
            catch (error) { run.activeAgentError = error.message; }
        }
        if (summaryOnly) return { run };
        const media = [];
        if (state.technical?.artifact?.sha256) {
            try {
                const file = await safeProjectFile(state.workspace, state.spec.acceptance.media.file);
                const asset = await registerAsset(file, state.technical.artifact.sha256, '复刻成片');
                if (asset) media.push(asset);
            } catch { /* Missing outputs remain visible through the run's checks. */ }
        }
        for (const ref of state.references || []) {
            try {
                const file = await safeProjectFile(ref.source.assetRoot, ref.source.relVideo);
                const asset = await registerAsset(file, ref.source.sha256, `对标 · ${ref.id}`);
                if (asset) media.push(asset);
            } catch { /* Invalid bindings are not made into media routes. */ }
        }
        const evidence = [];
        const evidenceRoot = state.technical?.evidenceRoot;
        const allowed = path.join(storage(config), 'runs', state.id, 'evidence');
        if (evidenceRoot && path.resolve(evidenceRoot).startsWith(`${allowed}${path.sep}`)) {
            for (const item of state.technical.evidence?.items || []) {
                try {
                    const file = await safeProjectFile(evidenceRoot, item.path);
                    const asset = await registerAsset(file, item.sha256, `${item.source} · ${item.timeSec}s`);
                    if (asset) evidence.push({ ...asset, id: item.id });
                } catch { /* Only frozen, existing evidence is exposed. */ }
            }
        }
        return { run, media, evidence, stageEvidence: await stageAssets(state) };
    }
    function launch(input) {
        if (active) throw failure('REPRO_BUSY', '已有工作台任务正在执行，请等待完成或取消。', 409);
        while (jobs.size >= 30) jobs.delete(jobs.keys().next().value);
        const controller = new AbortController();
        const job = { ...input, id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), controller };
        jobs.set(job.id, job); active = job.id;
        Promise.resolve().then(() => execute(config, input.action, input.subject, input.options, { ...deps, signal: controller.signal }))
            .then(result => { job.result = result; job.status = controller.signal.aborted ? 'cancelled' : 'completed'; })
            .catch(error => { job.error = { code: error.code || 'FAILED', message: error.message, ...(error.data ? { detail: error.data } : {}) }; job.status = controller.signal.aborted ? 'cancelled' : 'failed'; })
            .finally(() => { job.finishedAt = new Date().toISOString(); if (active === job.id) active = null; });
        return publicJob(job);
    }
    return {
        close() { for (const job of jobs.values()) if (job.status === 'running') job.controller.abort(); },
        async handle(request, response, url) {
            if (url.pathname !== '/api/repro' && !url.pathname.startsWith('/api/repro/')) return false;
            try {
                localRequest(request);
                const head = request.method === 'HEAD';
                const read = request.method === 'GET' || head;
                if (read && url.pathname === '/api/repro') {
                    const listing = await list(config);
                    const catalog = await (deps.readCatalog || readCatalog)(config.catalogPath);
                    respond(response, 200, { ...listing, methods: listing.methods || [], references: (catalog.references || []).map(ref => ({ id: ref.id, title: ref.title || ref.id })), productions: catalog.productions.map(p => ({ slug: p.slug, status: p.status })), jobs: [...jobs.values()].map(publicJob), activeJob: active }, head);
                } else if (read && url.pathname === '/api/repro/config') respond(response, 200, await configuration(), head);
                else if (request.method === 'POST' && url.pathname === '/api/repro/config') {
                    if (active) throw failure('REPRO_BUSY', '请等待当前工作台任务完成再修改默认工作流。', 409);
                    const value = validateWorkflow(await bodyJson(request));
                    const current = await (deps.loadWorkflow || loadWorkflow)(config);
                    if (current.workflowPath && path.resolve(current.workflowPath) !== path.join(config.workspace, 'reproduction-workflow.json')) throw failure('CONFIG_READ_ONLY', '当前使用外部工作流配置，请通过 CLI 编辑该配置；工作台只保存项目默认工作流。');
                    // This endpoint only edits the canonical workflow, never an
                    // arbitrary path supplied by a browser.
                    const file = await safeProjectFile(config.workspace, 'reproduction-workflow.json', { create: true });
                    const temporary = `${file}.${randomUUID()}.tmp`;
                    try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
                    finally { await fs.rm(temporary, { force: true }); }
                    respond(response, 200, { workflow: value });
                } else if (request.method === 'POST' && url.pathname === '/api/repro/jobs') {
                    const input = jobInput(await bodyJson(request));
                    await assertJobProtocol(input);
                    respond(response, 202, launch(input));
                }
                else {
                    const jobMatch = /^\/api\/repro\/jobs\/([a-f0-9-]{36})(\/cancel)?$/.exec(url.pathname);
                    const runMatch = /^\/api\/repro\/runs\/([^/]+)(\/logs)?$/.exec(url.pathname);
                    const stageMatch = /^\/api\/repro\/runs\/([^/]+)\/stages\/([^/]+)$/.exec(url.pathname);
                    const mediaMatch = /^\/api\/repro\/media\/([a-f0-9]{32})$/.exec(url.pathname);
                    if (jobMatch) {
                        const job = jobs.get(jobMatch[1]);
                        if (!job) throw failure('NOT_FOUND', '任务不存在；服务重启后请在制作列表查看持久化记录。', 404);
                        if (request.method === 'POST' && jobMatch[2]) { await bodyJson(request); job.controller.abort(); respond(response, 202, publicJob(job)); }
                        else if (read && !jobMatch[2]) respond(response, 200, publicJob(job), head);
                        else throw failure('METHOD_NOT_ALLOWED', '此路由不支持该方法。', 405);
                    } else if (read && stageMatch) {
                        const slug = decodeURIComponent(stageMatch[1]), stage = decodeURIComponent(stageMatch[2]);
                        if (!identifier.test(slug) || !identifier.test(stage)) throw failure('INVALID_INPUT', '制作或阶段标识无效。');
                        respond(response, 200, await runDetail(slug, stage), head);
                    } else if (read && runMatch) {
                        const slug = decodeURIComponent(runMatch[1]);
                        if (!identifier.test(slug)) throw failure('INVALID_INPUT', '制作标识无效。');
                        const value = runMatch[2] ? await execute(config, 'logs', slug, { lines: 100 }, deps)
                            : await runDetail(slug, null, { summaryOnly: url.searchParams.get('summary') === '1' });
                        respond(response, 200, value, head);
                    } else if (read && mediaMatch && sendAsset) {
                        const asset = assets.get(mediaMatch[1]);
                        if (!asset || await fileHash(asset.path) !== asset.sha256) throw failure('NOT_FOUND', '媒体已改变或不存在。', 404);
                        await sendAsset(request, response, asset, false);
                    } else throw failure('NOT_FOUND', '接口不存在。', 404);
                }
            } catch (error) {
                if (!response.headersSent && !response.destroyed) respond(response, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message, code: error.code || 'FAILED' }, request.method === 'HEAD');
            }
            return true;
        },
    };
}

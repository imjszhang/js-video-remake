import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWebServer } from '../src/web-server.js';
import { storage } from '../src/repro/store.js';

async function fixture(t, extra = {}) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-web-')));
    const workspace = path.join(directory, 'workspace');
    await fs.mkdir(workspace);
    const config = { workspace, catalogPath: path.join(workspace, 'catalog.json'), env: { VIDEO_REMAKE_AGENT_HOME: path.join(directory, 'state') } };
    const workflow = { schemaVersion: 1, roles: { teacher: 'high', executor: 'low', reviewer: 'review' }, policy: { maxAttempts: 3, maxCalls: 12, maxDurationMs: 3600000 } };
    const calls = [];
    const deps = {
        loadWorkflow: async () => workflow,
        loadAgentConfig: async () => ({ targets: [{ name: 'high', enabled: true, harness: { adapter: 'codex', permission: 'workspace-write', contextMode: 'snapshot' }, backend: { model: 'selected-model', auth: { apiKey: 'MUST-NOT-EXPOSE' } } }] }),
        readCatalog: async () => ({ productions: [{ slug: 'fixture', status: 'commissioned' }] }),
        listReproductions: async () => ({ runs: [], templates: [] }),
        loadRun: async (_config, production) => ({ schema: 'video-remake.reproduction-run@2', id: 'r_fixture', production, workflow: { policy: {} }, attempts: [], references: [] }),
        executeRepro: async (_config, action, subject, options) => { calls.push({ action, subject, options }); return { command: `repro:${action}`, ok: true }; },
        ...extra,
    };
    const server = createWebServer({ root: workspace, reproConfig: config, reproDeps: deps });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
    const post = (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { directory, workspace, config, calls, base, post, server };
}

test('reproduction API exposes role metadata without authentication and rejects unsafe requests', async t => {
    const f = await fixture(t);
    const response = await fetch(`${f.base}/api/repro/config`);
    const config = await response.json();
    assert.equal(config.targets[0].model, 'selected-model');
    assert.ok(!JSON.stringify(config).includes('MUST-NOT-EXPOSE'));
    assert.equal((await f.post('/api/repro/jobs', { action: 'run', subject: 'fixture' }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await f.post('/api/repro/jobs', { action: 'export', subject: '../../private' })).status, 400);
    assert.equal((await f.post('/api/repro/jobs', { action: 'run', subject: 'fixture', options: { agentConfig: '/private/auth.json' } })).status, 400);
    assert.equal((await f.post('/api/repro/jobs', { action: 'init', subject: 'fixture', options: { specValue: { text: 'x'.repeat(300000) } } })).status, 413);
    assert.equal((await fetch(`${f.base}/api/repro/jobs`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.post('/api/projects', {})).status, 405);
});

test('background jobs use shared workflow and keep a cancellable single active operation', async t => {
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, {
        executeRepro: async (_config, action, subject, options, deps) => {
            started({ action, subject, options });
            await new Promise((resolve, reject) => { if (deps.signal.aborted) reject(new Error('aborted')); else deps.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
        },
    });
    const request = await f.post('/api/repro/jobs', { action: 'run', subject: 'fixture' });
    assert.equal(request.status, 202); const job = await request.json();
    assert.equal((await begun).action, 'run');
    assert.equal((await f.post('/api/repro/jobs', { action: 'doctor' })).status, 409);
    assert.equal((await f.post('/api/repro/jobs', { action: 'cancel', subject: 'fixture' })).status, 409, 'a separate cancel job does not bypass the active UI job slot');
    assert.equal((await f.post(`/api/repro/jobs/${job.id}/cancel`, {})).status, 202);
    let status;
    for (let i = 0; i < 10; i++) { status = await (await fetch(`${f.base}/api/repro/jobs/${job.id}`)).json(); if (status.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(status.status, 'cancelled');
    assert.equal((await fetch(`${f.base}/api/repro/jobs/00000000-0000-0000-0000-000000000000`)).status, 404);
});

test('run cancellation delegates to the existing workflow using only a local registered production subject', async t => {
    const f = await fixture(t);
    assert.equal((await f.post('/api/repro/jobs', { action: 'cancel', subject: 'fixture' }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await f.post('/api/repro/jobs', { action: 'cancel', subject: '../outside' })).status, 400);
    assert.equal((await f.post('/api/repro/jobs', { action: 'cancel', subject: 'fixture', options: { runId: 'p_other' } })).status, 400);
    assert.equal(f.calls.length, 0);
    const response = await f.post('/api/repro/jobs', { action: 'cancel', subject: 'fixture' }); assert.equal(response.status, 202);
    const { id } = await response.json(); let job;
    for (let i = 0; i < 30; i++) { job = await (await fetch(`${f.base}/api/repro/jobs/${id}`)).json(); if (job.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(job.status, 'completed'); assert.deepEqual(f.calls, [{ action: 'cancel', subject: 'fixture', options: {} }]);
});

test('method generation requires its own task and reference; historical replay is explicit', async t => {
    const f = await fixture(t, {
        readCatalog: async () => ({ references: [{ id: 'youtube-reference', title: 'Reference', dir: '/private/reference' }], productions: [] }),
        listReproductions: async () => ({ runs: [], methods: [{ id: 'method@1', status: 'candidate' }], templates: [{ id: 'old@6' }] }),
    });
    const listing = await (await fetch(`${f.base}/api/repro`)).json();
    assert.equal(listing.methods[0].id, 'method@1');
    assert.deepEqual(listing.references, [{ id: 'youtube-reference', title: 'Reference' }]);
    assert.equal((await f.post('/api/repro/jobs', { action: 'instantiate', subject: 'old@6', options: { as: 'copy' } })).status, 400);
    assert.equal((await f.post('/api/repro/jobs', { action: 'generate', subject: 'method@1', options: { as: 'new' } })).status, 400);
    assert.equal((await f.post('/api/repro/jobs', { action: 'generate', subject: 'method@1', options: { as: 'new', ref: 'youtube-reference', specValue: {}, run: 'yes' } })).status, 400);
    const options = { as: 'new', ref: 'youtube-reference', specValue: { title: 'Independent task' }, inputValues: {}, run: false };
    const response = await f.post('/api/repro/jobs', { action: 'generate', subject: 'method@1', options });
    assert.equal(response.status, 202);
    const job = await response.json();
    for (let i = 0; i < 10; i++) {
        const current = await (await fetch(`${f.base}/api/repro/jobs/${job.id}`)).json();
        if (current.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(f.calls[0], { action: 'generate', subject: 'method@1', options });
    const replay = await f.post('/api/repro/jobs', { action: 'replay', subject: 'old@6', options: { as: 'history-copy', inputValues: {} } });
    assert.equal(replay.status, 202);
});

test('workflow save writes only canonical validated configuration and supports same-origin gateway requests', async t => {
    const f = await fixture(t);
    const response = await f.post('/api/repro/config', { roles: { teacher: 'new-high', executor: 'low', reviewer: 'review' }, policy: { maxAttempts: 2, renderProvider: 'agent' } }, { Origin: f.base });
    assert.equal(response.status, 200);
    const saved = JSON.parse(await fs.readFile(path.join(f.workspace, 'reproduction-workflow.json'), 'utf8'));
    assert.equal(saved.roles.extractor, 'new-high');
    assert.equal(saved.policy.maxAttempts, 2);
    assert.equal(saved.policy.renderProvider, 'agent');
    assert.equal((await f.post('/api/repro/config', { roles: {}, path: '/private/config' })).status, 400);
    await fs.rm(path.join(f.workspace, 'reproduction-workflow.json'));
    const outside = path.join(f.directory, 'outside.json'); await fs.writeFile(outside, '{}');
    await fs.symlink(outside, path.join(f.workspace, 'reproduction-workflow.json'));
    assert.equal((await f.post('/api/repro/config', { roles: {} })).status, 400);
    assert.equal(await fs.readFile(outside, 'utf8'), '{}');
});

test('managed render, repair and recovery delegate to workflow and preserve structured failure details', async t => {
    const called = [];
    const f = await fixture(t, { executeRepro: async (_config, action, subject, options) => {
        called.push({ action, subject, options });
        if (action === 'repair') throw Object.assign(new Error('Budget exhausted'), { code: 'REPRO_BUDGET', data: { stage: 'repair', budget: { calls: 12 } } });
        return { command: `repro:${action}`, artifact: 'outputs/final.mp4' };
    } });
    const waitJob = async id => {
        for (let i = 0; i < 10; i++) {
            const job = await (await fetch(`${f.base}/api/repro/jobs/${id}`)).json();
            if (job.status !== 'running') return job;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('Job did not finish');
    };
    const render = await f.post('/api/repro/jobs', { action: 'render', subject: 'fixture' });
    assert.equal(render.status, 202); assert.equal((await waitJob((await render.json()).id)).status, 'completed');
    const repair = await f.post('/api/repro/jobs', { action: 'repair', subject: 'fixture', options: { target: 'high' } });
    assert.equal(repair.status, 202);
    const result = await waitJob((await repair.json()).id);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.error.detail, { stage: 'repair', budget: { calls: 12 } });
    const recover = await f.post('/api/repro/jobs', { action: 'recover', subject: 'fixture' });
    assert.equal(recover.status, 202); assert.equal((await waitJob((await recover.json()).id)).status, 'completed');
    assert.deepEqual(called.map(item => item.action), ['render', 'repair', 'recover']);
});

test('externally selected workflow is displayed as read-only instead of silently saving an inactive default', async t => {
    const f = await fixture(t, { loadWorkflow: async () => ({ workflowPath: '/external/workflow.json', roles: {}, policy: {} }) });
    const config = await (await fetch(`${f.base}/api/repro/config`)).json();
    assert.equal(config.writable, false);
    const response = await f.post('/api/repro/config', { roles: {} });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'CONFIG_READ_ONLY');
    await assert.rejects(fs.access(path.join(f.workspace, 'reproduction-workflow.json')), { code: 'ENOENT' });
});

test('media routes register frozen artifacts only, support ranges and reject changed files', async t => {
    let state;
    const f = await fixture(t, { loadRun: async () => state });
    const project = path.join(f.workspace, 'productions/fixture/project'); await fs.mkdir(path.join(project, 'outputs'), { recursive: true });
    const video = path.join(project, 'outputs/final.mp4'); const bytes = Buffer.from('fixture media bytes'); await fs.writeFile(video, bytes);
    state = { id: 'run-1', production: 'fixture', workspace: project, kind: 'teacher', status: 'external-review', references: [], spec: { acceptance: { media: { file: 'outputs/final.mp4' } } }, workflow: { policy: {} }, attempts: [], technical: { artifact: { sha256: createHash('sha256').update(bytes).digest('hex') } } };
    assert.equal((await fetch(`${f.base}/api/repro/media/00000000000000000000000000000000`)).status, 404);
    const detail = await (await fetch(`${f.base}/api/repro/runs/fixture`)).json();
    assert.equal(detail.media.length, 1);
    const range = await fetch(`${f.base}/${detail.media[0].url}`, { headers: { Range: 'bytes=0-6' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'fixture');
    await fs.writeFile(video, 'changed');
    assert.equal((await fetch(`${f.base}/${detail.media[0].url}`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/repro/runs/not-a-run%2F..%2Fsecret`)).status, 400);
});

test('reproduction page and assets are served with same-origin CSP', async t => {
    const f = await fixture(t);
    await fs.cp(new URL('../web', import.meta.url), path.join(f.workspace, 'web'), { recursive: true });
    const response = await fetch(`${f.base}/repro`); assert.equal(response.status, 200);
    assert.match(await response.text(), /AI 复刻实验/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    for (const asset of ['repro.js', 'repro.css', 'navigation.css']) assert.equal((await fetch(`${f.base}/${asset}`)).status, 200);
});

test('stage-scoped actions and multi-run method feedback are validated before dispatch', async t => {
    const f = await fixture(t);
    for (const options of [{ stage: '../shots' }, { shot: 'constructor' }, { step: 'yes' }, { until: ['review'] }]) {
        assert.equal((await f.post('/api/repro/jobs', { action: 'run', subject: 'fixture', options })).status, 400);
    }
    for (const feedback of ['one', [], ['one', 'one'], ['../old']]) {
        assert.equal((await f.post('/api/repro/jobs', { action: 'method-revise', subject: 'method@1', options: { name: 'method', version: 2, feedback } })).status, 400);
    }
    assert.equal(f.calls.length, 0);
    const scopes = { stage: 'shots', shot: 'shot-02', until: 'integration', step: true };
    let response = await f.post('/api/repro/jobs', { action: 'run', subject: 'fixture', options: scopes });
    assert.equal(response.status, 202);
    const wait = async response => {
        const { id } = await response.json();
        for (let i = 0; i < 30; i++) { const job = await (await fetch(`${f.base}/api/repro/jobs/${id}`)).json(); if (job.status !== 'running') return; await new Promise(resolve => setTimeout(resolve, 5)); }
        throw new Error('Job did not finish');
    };
    await wait(response);
    assert.deepEqual(f.calls[0].options, scopes);
    const options = { name: 'method', version: 2, feedback: ['first', 'second'] };
    response = await f.post('/api/repro/jobs', { action: 'method-revise', subject: 'method@1', options });
    assert.equal(response.status, 202); await wait(response);
    assert.deepEqual(f.calls[1], { action: 'method-revise', subject: 'method@1', options });
});

test('new default configuration is staged while an existing v1 file is not silently upgraded', async t => {
    let workflowPath;
    const f = await fixture(t, { loadWorkflow: async () => ({ workflowPath, schemaVersion: 1, roles: { teacher: 'high' }, policy: { maxAttempts: 3, maxCalls: 12, maxDurationMs: 3600000, reviewSamples: 1 } }) });
    workflowPath = path.join(f.workspace, 'reproduction-workflow.json');
    let response = await (await fetch(`${f.base}/api/repro/config`)).json();
    assert.equal(response.workflow.schemaVersion, 2); assert.equal(response.workflow.policy.reviewSamples, 2); assert.equal(response.workflow.policy.maxCalls, 48);
    assert.deepEqual(response.workflow.execution.prototypeRequirements, ['character-interaction', 'complex-motion']);
    await fs.writeFile(workflowPath, '{}');
    response = await (await fetch(`${f.base}/api/repro/config`)).json();
    assert.equal(response.workflow.schemaVersion, 1); assert.equal(response.workflow.policy.reviewSamples, 1); assert.equal(response.workflow.execution, undefined);
});

test('run detail and lightweight polling expose a first active call without changing its persisted state', async t => {
    const state = { id: 'r_active', production: 'fixture', schema: 'video-remake.reproduction-run@3', status: 'running', kind: 'trial',
        activeAgentRunId: 'p_active', activeRole: 'executor', workflow: { policy: {} }, attempts: [], stageExecutions: [{ id: 'sx_first', stageId: 'analysis' }],
        stageState: { currentStage: 'analysis', stages: [{ id: 'analysis', status: 'running' }] }, references: [] };
    const before = structuredClone(state), reads = []; let unavailable = false;
    const f = await fixture(t, { loadRun: async () => state, projectAgentStatus: async (_config, id) => {
        reads.push(id); if (unavailable) throw new Error('Active receipt unavailable.');
        return { runId: id, status: 'running', requestedModel: 'deepseek-flash', observedModel: null, harness: { adapter: 'deepseek-harness' } };
    } });
    for (const suffix of ['', '?summary=1']) {
        const response = await fetch(`${f.base}/api/repro/runs/fixture${suffix}`); assert.equal(response.status, 200);
        const detail = await response.json();
        assert.equal(detail.run.activeAgent.requestedModel, 'deepseek-flash'); assert.equal(detail.run.activeAgent.observedModel, null);
        assert.equal(detail.run.activeAgent.harness.adapter, 'deepseek-harness');
        if (suffix) assert.equal(detail.media, undefined);
    }
    assert.deepEqual(reads, ['p_active', 'p_active']); assert.deepEqual(state, before);
    unavailable = true;
    const detail = await (await fetch(`${f.base}/api/repro/runs/fixture?summary=1`)).json();
    assert.equal(detail.run.activeAgent, undefined); assert.match(detail.run.activeAgentError, /unavailable/); assert.deepEqual(state, before);
});

test('changed staged protocols expose read-only history and reject jobs before dispatch without changing state', async t => {
    const state = { schema: 'video-remake.reproduction-run@3', id: 'r_frozen', production: 'fixture', status: 'needs-revision', kind: 'trial',
        executionProtocolHash: 'old-protocol', workflow: { policy: {} }, attempts: [], references: [],
        stageState: { currentStage: 'prototypes', stages: [{ id: 'freeze', status: 'complete' }, { id: 'analysis', status: 'evidence-complete' }, { id: 'prototypes', status: 'needs-revision' }] } };
    const before = structuredClone(state);
    const f = await fixture(t, { loadRun: async () => state, stageProtocolFingerprint: async () => 'current-protocol' });
    for (const suffix of ['', '?summary=1']) {
        const detail = await (await fetch(`${f.base}/api/repro/runs/fixture${suffix}`)).json();
        assert.equal(detail.run.protocolCompatibility.matches, false); assert.match(detail.run.protocolCompatibility.message, /请创建新实验/);
        assert.deepEqual(detail.run.allowedActions, ['status', 'logs']); assert.match(detail.run.blockedReasons.repair, /历史查看/);
    }
    for (const action of ['run', 'teacher', 'retry', 'resume', 'recover', 'repair', 'render', 'check', 'judge', 'extract', 'cancel', 'publish']) {
        const response = await f.post('/api/repro/jobs', { action, subject: action === 'publish' ? 'method@1' : 'fixture', options: action === 'publish' ? { production: 'fixture' } : {} });
        assert.equal(response.status, 409, action); assert.equal((await response.json()).code, 'REPRO_PROTOCOL_CHANGED');
    }
    assert.equal(f.calls.length, 0); assert.deepEqual(state, before);
    assert.equal((await (await fetch(`${f.base}/api/repro`)).json()).jobs.length, 0);
    const revision = await f.post('/api/repro/jobs', { action: 'method-revise', subject: 'method@1', options: { name: 'method', version: 2, feedback: ['fixture'] } });
    assert.equal(revision.status, 202, 'method research may still use historical failure reports');
    assert.deepEqual(state, before);
});

test('protocol guard keeps active cancellation and matching or legacy workflows available', async t => {
    let state = { schema: 'video-remake.reproduction-run@3', id: 'r_frozen', production: 'fixture', status: 'running', kind: 'trial',
        executionProtocolHash: 'old-protocol', activeOperation: { id: 'op_fixture' }, workflow: { policy: {} }, attempts: [], references: [],
        stageState: { currentStage: 'analysis', stages: [{ id: 'analysis', status: 'running' }] } };
    const f = await fixture(t, { loadRun: async () => state, stageProtocolFingerprint: async () => 'current-protocol' });
    const detail = await (await fetch(`${f.base}/api/repro/runs/fixture?summary=1`)).json();
    assert.deepEqual(detail.run.allowedActions, ['status', 'logs', 'cancel']);
    const finished = async response => {
        assert.equal(response.status, 202); const { id } = await response.json();
        for (let i = 0; i < 30; i++) { const job = await (await fetch(`${f.base}/api/repro/jobs/${id}`)).json(); if (job.status !== 'running') return; await new Promise(resolve => setTimeout(resolve, 5)); }
        throw new Error('Mock job did not finish');
    };
    await finished(await f.post('/api/repro/jobs', { action: 'cancel', subject: 'fixture' }));
    delete state.activeOperation; state.status = 'prepared'; state.executionProtocolHash = 'current-protocol';
    await finished(await f.post('/api/repro/jobs', { action: 'run', subject: 'fixture' }));
    state = { ...state, schema: 'video-remake.reproduction-run@2' }; delete state.stageState; delete state.executionProtocolHash;
    const legacy = await (await fetch(`${f.base}/api/repro/runs/fixture?summary=1`)).json(); assert.equal(legacy.run.protocolCompatibility, undefined);
    await finished(await f.post('/api/repro/jobs', { action: 'repair', subject: 'fixture' }));
    assert.deepEqual(f.calls.map(call => call.action), ['cancel', 'run', 'repair']);
});

test('stage evidence is limited to frozen run-owned files and rejects parent symlinks, traversal and mutation', async t => {
    let state;
    const f = await fixture(t, { loadRun: async () => state });
    const root = path.join(storage(f.config), 'runs/r_stage/stages/shots/s_1');
    await fs.mkdir(path.join(root, 'media'), { recursive: true });
    const bytes = Buffer.from('stage preview'), sha256 = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(root, 'media/subject.mp4'), bytes);
    await fs.writeFile(path.join(root, 'frame.png'), bytes);
    const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'frame.png'), bytes);
    const alias = path.join(storage(f.config), 'runs/r_stage/stages/shots/alias'); await fs.symlink(outside, alias);
    state = { id: 'r_stage', schema: 'video-remake.reproduction-run@3', production: 'fixture', workspace: f.workspace, kind: 'trial', status: 'needs-revision',
        references: [], spec: { acceptance: { media: { file: 'outputs/final.mp4' } } }, workflow: { policy: {} }, attempts: [],
        stageState: { currentStage: 'shots', stages: [{ id: 'analysis', status: 'evidence-complete' }, { id: 'shots', status: 'stale' }] },
        stageReference: { evidenceRoot: root, items: [{ id: 'reference-frame', path: 'frame.png', sha256, sourceId: 'reference', requestedTimeSec: 2, timeSec: 1.96 }] },
        stageSubmissions: [{ id: 's_1', stageId: 'shots', shotIds: ['shot-02'], status: 'stale', staleReason: 'Shared scene changed.', evidenceRoot: root, preview: { artifact: { path: 'media/subject.mp4', sha256 } },
            items: [{ id: 'frame', path: 'frame.png', sha256, sourceId: 'subject', timeSec: 2, sampleTimeSec: 2, reasons: ['shot:shot-02'] }, { id: 'escape', path: '../s_1/frame.png', sha256 }] },
            { id: 's_2', stageId: 'shots', evidenceRoot: outside, items: [{ id: 'outside', path: 'frame.png', sha256 }] },
            { id: 's_3', stageId: 'shots', evidenceRoot: alias, items: [{ id: 'symlink', path: 'frame.png', sha256 }] }],
    };
    const detail = await (await fetch(`${f.base}/api/repro/runs/fixture`)).json();
    assert.equal(detail.stageEvidence.length, 3);
    assert.deepEqual(detail.stageEvidence.find(item => item.id === 'frame').shotIds, ['shot-02']);
    assert.equal(detail.stageEvidence.find(item => item.id === 'frame').submissionStatus, 'stale');
    assert.deepEqual(detail.stageEvidence.find(item => item.type === 'video/mp4').shotIds, ['shot-02']);
    const analysis = await (await fetch(`${f.base}/api/repro/runs/fixture/stages/analysis`)).json();
    assert.equal(analysis.evidence.length, 1);
    assert.equal(analysis.evidence[0].sampleTimeSec, 2);
    assert.equal(analysis.evidence[0].timeSec, 1.96);
    assert.equal(analysis.evidence[0].framePtsSec, null);
    const stage = await (await fetch(`${f.base}/api/repro/runs/fixture/stages/shots`)).json();
    assert.equal(stage.stage.status, 'stale'); assert.equal(stage.evidence.length, 2);
    assert.equal((await fetch(`${f.base}/api/repro/runs/fixture/stages/absent`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/repro/runs/fixture/stages/%2E%2E%2Fsecrets`)).status, 400);
    const summary = await (await fetch(`${f.base}/api/repro/runs/fixture?summary=1`)).json();
    assert.equal(summary.stageEvidence, undefined);
    const clip = detail.stageEvidence.find(item => item.type === 'video/mp4');
    const range = await fetch(`${f.base}/${clip.url}`, { headers: { Range: 'bytes=0-4' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'stage');
    await fs.writeFile(path.join(root, 'media/subject.mp4'), 'changed');
    assert.equal((await fetch(`${f.base}/${clip.url}`)).status, 404);
    const after = await (await fetch(`${f.base}/api/repro/runs/fixture/stages/shots`)).json();
    assert.equal(after.evidence.length, 1);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { agentExecutionCatalog, describeAgentTargets, formatAgentConsole } from '../src/agent-console.js';
import { listConnectionModels } from '../src/agent-models.js';
import { createWebServer } from '../src/web-server.js';

test('agent console keeps commands and drops reasoning', () => {
    const text = [
        JSON.stringify({ type: 'tool', data: { name: 'Bash', input: { command: 'node cli/remake.js video:fork demo\n--skip-install' } } }),
        JSON.stringify({ type: 'raw', data: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'api_key=secret-value' }] } } }),
        JSON.stringify({ type: 'message', data: { text: '正在写入场景' } }),
        JSON.stringify({ type: 'message', data: { text: '正在写入场景' } }),
    ].join('\n');
    const lines = formatAgentConsole(text);
    assert.deepEqual(lines, ['$ Bash · node cli/remake.js video:fork demo', '正在写入场景']);
    assert.equal(lines.join('\n').includes('secret-value'), false);
});

async function serve(t, executeAgent) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-agent-console-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'productions/series'), { recursive: true });
    await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({
        version: 1,
        references: [],
        productions: [
            { slug: 'series', dir: 'productions/series', referenceIds: [], status: 'commissioned' },
            { slug: 'empty', dir: 'productions/empty', referenceIds: [], status: 'commissioned' },
        ],
    }));
    await fs.mkdir(path.join(root, 'productions/empty'), { recursive: true });
    await fs.writeFile(path.join(root, 'productions/series/agent-activity.json'), JSON.stringify({
        schemaVersion: 1, runId: 'r_test_activity', status: 'timed_out', target: 'fake',
        startedAt: '2026-11-15T06:00:00.000Z', updatedAt: '2026-11-15T06:10:00.000Z',
        summary: '停在转头', instruction: '补上人物动作', referenceId: null, continuedFrom: null, packages: [],
    }));
    const server = createWebServer({ root, agentDeps: { executeAgent } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test('agent target descriptions name the harness, service and model', () => {
    const targets = describeAgentTargets({
        defaultTarget: 'codex-native',
        targets: [
            { name: 'codex-native', enabled: true, harness: { adapter: 'codex', executable: '/secret/codex' }, backend: { auth: 'chatgpt', model: 'gpt-6.1-sol' } },
            { name: 'claude-local', enabled: true, harness: { adapter: 'claude-code' }, backend: { auth: 'claude-config', model: 'configured' } },
            { name: 'deepseek-flash', enabled: false, harness: { adapter: 'deepseek-harness' }, backend: { auth: 'api-key', provider: 'deepseek-local', model: 'deepseek-flash', baseURL: 'https://secret.example' } },
        ],
    });
    assert.deepEqual(targets.map(item => item.label), ['Codex · ChatGPT 订阅 · gpt-6.1-sol', 'Claude Code · Claude 本机登录 · 客户端当前模型']);
    assert.equal(targets[0].default, true);
    assert.equal(JSON.stringify(targets).includes('/secret'), false);
    assert.equal(JSON.stringify(targets).includes('secret.example'), false);
});

test('execution catalog separates provider connections and their models', () => {
    const catalog = agentExecutionCatalog({
        defaultTarget: 'deepseek-flash',
        targets: [
            { name: 'deepseek-flash', enabled: true, harness: { adapter: 'deepseek-harness' }, backend: { auth: 'api-key', provider: 'deepseek', protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' } },
            { name: 'deepseek-pro', enabled: true, harness: { adapter: 'deepseek-harness' }, backend: { auth: 'api-key', provider: 'deepseek', protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro' } },
        ],
        providers: [{ id: 'provider-abcdef0123456789', label: '我的接口', models: ['my-model'] }],
    });
    assert.equal(catalog.harnesses.length, 1);
    assert.equal(catalog.providers.find(item => item.id === 'deepseek-flash').models.join(','), 'deepseek-flash,deepseek-v4-pro');
    assert.equal(catalog.providers.find(item => item.label === '我的接口').models[0], 'my-model');
});

test('api providers contribute their live model list without exposing the key', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-agent-models-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'project');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'agent-runtime.json'), JSON.stringify({
        schemaVersion: 1,
        defaultTarget: 'deepseek-flash',
        targets: [{
            name: 'deepseek-flash', enabled: true,
            harness: { adapter: 'deepseek-harness', executable: 'dsh', permission: 'workspace-write' },
            backend: { auth: 'api-key', provider: 'deepseek', protocol: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash' },
        }],
    }));
    const secret = 'sk-live-model-key';
    const seen = [];
    const result = await listConnectionModels({ workspace, env: { VIDEO_REMAKE_AGENT_HOME: path.join(root, 'state'), DEEPSEEK_API_KEY: secret } }, { providerTarget: 'deepseek-flash' }, {
        fetchImpl: async (url, init) => {
            seen.push(url);
            const key = init.headers.Authorization || init.headers['x-api-key'] || '';
            assert.ok(String(key).includes(secret));
            return { ok: true, json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: secret }] }) };
        },
    });
    assert.deepEqual(result.models.map(item => item.id), ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner']);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(seen.length);
});

test('project agent console reads the run and can start or continue', async (t) => {
    const calls = [];
    const base = await serve(t, async (_config, action, options) => {
        calls.push({ action, options });
        if (action === 'config') return { defaultTarget: 'fake', targets: [{ name: 'fake', enabled: true, harness: { adapter: 'codex' }, backend: { auth: 'chatgpt', model: 'gpt-6.1-sol' } }, { name: 'off', enabled: false, harness: { adapter: 'claude-code' }, backend: { model: 'configured' } }] };
        if (action === 'logs') return { text: `${JSON.stringify({ type: 'message', data: { text: '正在出片' } })}\n` };
        if (action === 'run') return { command: 'agent:run', run: { id: 'r_next', status: 'completed' } };
        if (action === 'cancel') return { command: 'agent:cancel', status: 'cancel_requested' };
        throw new Error(action);
    });
    const view = await fetch(`${base}/api/projects/series/agent`).then(response => response.json());
    assert.equal(view.activity.runId, 'r_test_activity');
    assert.deepEqual(view.lines, ['正在出片']);
    assert.equal(view.targets[0].label, 'Codex · ChatGPT 订阅 · gpt-6.1-sol');
    assert.equal(view.targets[0].default, true);
    const page = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');
    assert.match(page, /id="agent-engine"/);
    assert.match(page, /value="film"/);
    const denied = await fetch(`${base}/api/projects/series/agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"prompt","instruction":"改字幕"}',
    });
    assert.equal(denied.status, 403);
    const started = await fetch(`${base}/api/projects/empty/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'agent' },
        body: JSON.stringify({ mode: 'prompt', instruction: '改字幕', target: 'fake' }),
    });
    assert.equal(started.status, 200);
    assert.equal(calls.at(-1).options.production, 'empty');
    assert.equal(calls.at(-1).options.instruction, '改字幕');
    const continued = await fetch(`${base}/api/projects/series/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'agent' },
        body: JSON.stringify({ mode: 'continue', instruction: '把转头做成动作' }),
    });
    assert.equal(continued.status, 200);
    assert.equal(calls.at(-1).options.continueRun, 'r_test_activity');
    assert.equal(calls.at(-1).options.instruction, '把转头做成动作');
    const custom = await fetch(`${base}/api/projects/empty/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'agent' },
        body: JSON.stringify({ mode: 'prompt', instruction: '换模型', providerTarget: 'fake', model: 'my-model-1' }),
    });
    assert.equal(custom.status, 200);
    assert.equal(calls.at(-1).options.providerTarget, 'fake');
    assert.equal(calls.at(-1).options.model, 'my-model-1');
    assert.equal(calls.at(-1).options.engine, 'hyperframes');
    const film = await fetch(`${base}/api/projects/empty/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'agent' },
        body: JSON.stringify({ mode: 'prompt', instruction: '用 film', engine: 'film' }),
    });
    assert.equal(film.status, 200);
    assert.equal(calls.at(-1).options.engine, 'film');
    const badEngine = await fetch(`${base}/api/projects/empty/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'agent' },
        body: JSON.stringify({ mode: 'prompt', instruction: '换引擎', engine: 'webgl' }),
    });
    assert.equal(badEngine.status, 400);
    const invalid = await fetch(`${base}/api/projects/empty/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'agent' },
        body: JSON.stringify({ mode: 'prompt', instruction: '换模型', model: 'bad model' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${base}/api/projects/missing/agent`)).status, 404);
});

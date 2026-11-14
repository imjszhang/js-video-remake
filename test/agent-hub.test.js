import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    AGENT_HUB_ALL_TOOLS, AGENT_HUB_READ_TOOLS, AGENT_HUB_TOKEN_REF, loadAgentHub, planAgentHub,
} from '../src/agent-hub.js';
import { probeHub } from '../src/media/mcp-hub.js';

const TOKEN = `mcp_hub_${'fixture-token-'.repeat(4)}`;
const HUB_URL = 'http://hub.test:8899/mcp/comfyui';
const target = (permission = 'workspace-write', adapter = 'codex') => ({ harness: { adapter, permission } });

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-agent-hub-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const tokenFile = path.join(workspace, '.secrets', 'hub.token');
    const config = { workspace, media: { video: {
        provider: 'comfy-mcp', settings: { hubUrl: HUB_URL, hubTokenFile: tokenFile },
    } } };
    async function writeToken(content = TOKEN) {
        await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
        await fs.writeFile(tokenFile, content, { mode: 0o600 });
    }
    return { root, workspace, tokenFile, config, writeToken };
}

function mockHub({ tools = AGENT_HUB_ALL_TOOLS, online = true, bridge = 'running', version = '0.41.0', status, beforeReply } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        assert.equal(url, HUB_URL);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        calls.push({ url, ...init });
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        const request = JSON.parse(init.body);
        await beforeReply?.(request, init);
        if (status) return new Response(TOKEN, { status });
        if (request.method === 'notifications/initialized') return new Response(null, { status: 204 });
        let result;
        if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {} };
        else if (request.method === 'tools/list') result = { tools: tools.map((name) => ({ name })) };
        else {
            assert.equal(request.method, 'tools/call');
            assert.deepEqual(request.params, { name: 'server_info', arguments: {} });
            result = { structuredContent: { bridge, remote: { online, version } } };
        }
        return Response.json({ jsonrpc: '2.0', id: request.id, result }, {
            headers: request.method === 'initialize' ? { 'Mcp-Session-Id': 'agent-hub-fixture' } : {},
        });
    };
    return { calls, fetchImpl };
}

test('Agent Hub 默认关闭，不读取项目配置、目标或令牌文件', async () => {
    const unreadable = new Proxy({}, { get() { assert.fail('未启用时不能读取 Hub 配置'); } });
    for (const setting of [undefined, {}, { projectHub: false }]) {
        assert.equal(await planAgentHub(unreadable, setting, unreadable), undefined);
    }
    assert.equal(await loadAgentHub(undefined, { fetchImpl: () => assert.fail('不得联网') }), undefined);
});

test('Agent Hub 规划无需令牌存在，不读取令牌正文或创建目录', async (t) => {
    const f = await fixture(t);
    const before = await fs.readdir(f.workspace);
    const plan = await planAgentHub(f.config, { projectHub: true }, target());
    assert.deepEqual(plan, { server: {
        name: 'comfy-hub', url: HUB_URL, bearerTokenRef: AGENT_HUB_TOKEN_REF, enabledTools: [...AGENT_HUB_ALL_TOOLS],
    }, tokenFile: f.tokenFile });
    assert.deepEqual(await fs.readdir(f.workspace), before);
    await f.writeToken('not-a-token-secret-content');
    assert.deepEqual(await planAgentHub(f.config, { projectHub: true }, target()), plan);
    assert.equal(JSON.stringify(plan).includes('not-a-token-secret-content'), false);
});

test('Agent Hub 继承原有权限，只读目标仅开放九个查询工具', async (t) => {
    const f = await fixture(t);
    for (const adapter of ['codex', 'claude-code', 'deepseek-harness']) {
        const read = await planAgentHub(f.config, { projectHub: true }, target('read-only', adapter));
        assert.deepEqual(read.server.enabledTools, [...AGENT_HUB_READ_TOOLS]);
        assert.equal(read.server.enabledTools.length, 9);
        assert.equal(read.server.enabledTools.includes('run_workflow'), false);
        for (const permission of ['workspace-write', 'bypass']) {
            const write = await planAgentHub(f.config, { projectHub: true }, target(permission, adapter));
            assert.deepEqual(write.server.enabledTools, [...AGENT_HUB_ALL_TOOLS]);
            assert.equal(write.server.enabledTools.length, 17);
        }
    }
});

test('Agent Hub 拒绝不支持的类型、其他服务及非显式启用值', async (t) => {
    const f = await fixture(t);
    for (const setting of [true, false, null, [], { projectHub: 'true' }, { projectHub: true, headers: {} }]) {
        await assert.rejects(planAgentHub(f.config, setting, target()), { code: 'CONFIG_INVALID' });
    }
    for (const changed of [
        { ...f.config, media: { video: { provider: 'other', settings: f.config.media.video.settings } } },
        { ...f.config, media: {} },
    ]) await assert.rejects(planAgentHub(changed, { projectHub: true }, target()), { code: 'CONFIG_INVALID' });
    for (const value of [undefined, 'http://hub.test/mcp/default', 'http://hub.test/mcp/other',
        'http://hub.test/mcp/comfyui?token=private', 'http://name:private@hub.test/mcp/comfyui']) {
        const changed = structuredClone(f.config);
        changed.media.video.settings.hubUrl = value;
        await assert.rejects(planAgentHub(changed, { projectHub: true }, target()), (error) => {
            assert.equal(error.code, 'CONFIG_INVALID');
            assert.equal(error.message.includes('private'), false);
            return true;
        });
    }
    await assert.rejects(planAgentHub(f.config, { projectHub: true }, target('workspace-write', 'cursor-agent')), { code: 'CONFIG_INVALID' });
    await assert.rejects(planAgentHub(f.config, { projectHub: true }, target('unknown')), { code: 'CONFIG_INVALID' });
});

test('Agent Hub 令牌路径拒绝项目外、符号链接和非普通文件，包括缺失文件的祖先', async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, 'outside'));
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.workspace, 'linked'));
    await fs.symlink('missing.token', path.join(f.workspace, 'dangling.token'));
    await fs.writeFile(path.join(f.workspace, 'plain-file'), 'x');
    await fs.mkdir(path.join(f.workspace, 'directory'));
    for (const value of [path.join(f.root, 'outside', 'missing.token'), '../outside/missing.token',
        'linked/missing/token', 'dangling.token', 'plain-file/leaf', 'directory', f.workspace]) {
        const changed = structuredClone(f.config);
        changed.media.video.settings.hubTokenFile = value;
        await assert.rejects(planAgentHub(changed, { projectHub: true }, target()), { code: 'CONFIG_INVALID' });
    }
    const alias = path.join(f.root, 'workspace-alias');
    await fs.symlink(f.workspace, alias);
    const aliasConfig = { ...f.config, workspace: alias, media: { video: {
        provider: 'comfy-mcp', settings: { hubUrl: HUB_URL, hubTokenFile: path.join(alias, '.secrets', 'hub.token') },
    } } };
    assert.equal((await planAgentHub(aliasConfig, { projectHub: true }, target())).tokenFile, f.tokenFile);
});

test('Agent Hub 只读设备可通过只读探活，默认媒体探活仍要求生成工具', async (t) => {
    const f = await fixture(t);
    await f.writeToken();
    const plan = await planAgentHub(f.config, { projectHub: true }, target('read-only'));
    const fake = mockHub({ tools: AGENT_HUB_READ_TOOLS });
    const result = await loadAgentHub(plan, fake);
    assert.equal(result.token, TOKEN);
    assert.deepEqual(result.server, plan.server);
    assert.deepEqual(result.summary, { name: 'comfy-hub', service: 'comfyui', url: HUB_URL, tools: 9, version: '0.41.0' });
    assert.equal(JSON.stringify(result.summary).includes(TOKEN), false);
    assert.equal(JSON.stringify(result.summary).includes(f.tokenFile), false);
    assert.deepEqual(fake.calls.map((call) => call.method === 'DELETE' ? 'DELETE' : JSON.parse(call.body).method),
        ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE']);
    await assert.rejects(probeHub(f.config.media.video.settings, mockHub({ tools: AGENT_HUB_READ_TOOLS })), /工具/);
});

test('Agent Hub 探活与运行返回同一个已读取的令牌，磁盘轮换不会混用凭据', async (t) => {
    const f = await fixture(t);
    await f.writeToken();
    const plan = await planAgentHub(f.config, { projectHub: true }, target());
    const fake = mockHub({ beforeReply: async (request) => {
        if (request.method === 'initialize') await f.writeToken(`mcp_hub_${'replacement-'.repeat(4)}`);
    } });
    const result = await loadAgentHub(plan, fake);
    assert.equal(result.token, TOKEN);
    assert.equal(result.summary.tools, 17);
    assert.ok(fake.calls.every((call) => call.headers.Authorization === `Bearer ${TOKEN}`));
});

test('Agent Hub 执行前拒绝失效、非设备和不安全权限的令牌，不向网络发送', async (t) => {
    const f = await fixture(t);
    const plan = await planAgentHub(f.config, { projectHub: true }, target());
    const noNetwork = { fetchImpl: () => assert.fail('无效令牌不得联网') };
    await assert.rejects(loadAgentHub(plan, noNetwork), { code: 'AGENT_HUB_NOT_READY' });
    for (const value of ['root-api-key', `${TOKEN}\n${TOKEN}`, 'mcp_hub_short']) {
        await f.writeToken(value);
        await assert.rejects(loadAgentHub(plan, noNetwork), { code: 'AGENT_HUB_NOT_READY' });
    }
    await f.writeToken();
    await fs.chmod(f.tokenFile, 0o644);
    await assert.rejects(loadAgentHub(plan, noNetwork), { code: 'AGENT_HUB_NOT_READY' });
});

test('Agent Hub 执行前重新检查父目录，规划后替换符号链接会失败', async (t) => {
    const f = await fixture(t);
    await f.writeToken();
    const plan = await planAgentHub(f.config, { projectHub: true }, target());
    await fs.rename(path.dirname(f.tokenFile), path.join(f.root, 'outside'));
    await fs.symlink(path.join(f.root, 'outside'), path.dirname(f.tokenFile));
    await assert.rejects(loadAgentHub(plan, { fetchImpl: () => assert.fail('不得联网') }), { code: 'AGENT_HUB_NOT_READY' });
});

test('Agent Hub 拒绝撤销授权、工具不全及离线桥接，错误不泄漏服务端文本', async (t) => {
    const f = await fixture(t);
    await f.writeToken();
    const plan = await planAgentHub(f.config, { projectHub: true }, target());
    for (const options of [{ status: 401 }, { tools: AGENT_HUB_READ_TOOLS }, { tools: ['server_info'] }, { online: false }, { bridge: 'starting' }]) {
        await assert.rejects(loadAgentHub(plan, mockHub(options)), (error) => {
            assert.equal(error.code, 'AGENT_HUB_NOT_READY');
            assert.equal(error.message.includes(TOKEN), false);
            assert.equal(error.message.includes(f.tokenFile), false);
            return true;
        });
    }
    await assert.rejects(loadAgentHub(plan, { fetchImpl: async () => { throw new Error(TOKEN); } }), (error) =>
        error.code === 'AGENT_HUB_NOT_READY' && !error.message.includes(TOKEN));
});

test('Agent Hub 取消检查不启动探活，并向请求传递取消信号', async (t) => {
    const f = await fixture(t);
    await f.writeToken();
    const plan = await planAgentHub(f.config, { projectHub: true }, target());
    const before = new AbortController();
    before.abort();
    await assert.rejects(loadAgentHub(plan, { signal: before.signal, fetchImpl: () => assert.fail('不得联网') }), { code: 'AGENT_HUB_NOT_READY' });
    const during = new AbortController();
    await assert.rejects(loadAgentHub(plan, { signal: during.signal, fetchImpl: async (_url, init) => {
        const failed = new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true }));
        during.abort();
        return failed;
    } }), { code: 'AGENT_HUB_NOT_READY' });
});

test('Agent Hub 执行时拒绝被改成其他服务或额外工具的连接计划', async (t) => {
    const f = await fixture(t);
    await f.writeToken();
    const plan = await planAgentHub(f.config, { projectHub: true }, target('read-only'));
    for (const change of [
        { url: 'http://hub.test:8899/mcp/other' },
        { bearerTokenRef: 'OTHER_SECRET' },
        { enabledTools: [...AGENT_HUB_READ_TOOLS, 'run_workflow'] },
    ]) {
        await assert.rejects(loadAgentHub({ ...plan, server: { ...plan.server, ...change } }, {
            fetchImpl: () => assert.fail('无效计划不得联网'),
        }), { code: 'AGENT_HUB_NOT_READY' });
    }
});

test('Agent Hub 拒绝模型凭据引用与设备令牌引用冲突', async (t) => {
    const f = await fixture(t);
    const collision = { ...target(), backend: { auth: 'api-key', apiKeyEnv: AGENT_HUB_TOKEN_REF } };
    await assert.rejects(planAgentHub(f.config, { projectHub: true }, collision), { code: 'CONFIG_INVALID' });
    assert.equal(await planAgentHub(f.config, { projectHub: false }, collision), undefined);
});

test('Agent Hub 不把服务端版本字段回显的设备令牌放入就绪摘要', async (t) => {
    const f = await fixture(t);
    const shortToken = `mcp_hub_${'a'.repeat(32)}`;
    await f.writeToken(shortToken);
    const plan = await planAgentHub(f.config, { projectHub: true }, target());
    const result = await loadAgentHub(plan, mockHub({ version: shortToken }));
    assert.equal(result.token, shortToken);
    assert.equal(result.summary.version, '');
    assert.equal(JSON.stringify(result.summary).includes(shortToken), false);
});

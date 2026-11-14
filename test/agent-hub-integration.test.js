import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeAgent } from '../src/agent.js';
import { AGENT_HUB_ALL_TOOLS, AGENT_HUB_READ_TOOLS, AGENT_HUB_TOKEN_REF } from '../src/agent-hub.js';

const API_KEY = 'fixture-model-private-key-976431';
const HUB_TOKEN = `mcp_hub_${'fixture-private-hub-'.repeat(3)}`;
const HUB_URL = 'http://hub.test:8899/mcp/comfyui';
const INSTRUCTION = '只检查这份离线测试工程，并报告检查结果。';

async function fixture(t, { enabled, token = true, permission = 'workspace-write', failed = false, configName = 'agent-runtime.json' } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-agent-hub-app-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const storage = path.join(root, 'agent-state');
    const callsFile = path.join(root, 'fake-invocations.jsonl');
    await fs.mkdir(workspace);
    const executable = path.join(root, 'fake-codex.mjs');
    const source = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const apiKey = process.env.JS_AGENT_RUNTIME_API_KEY;
const hubToken = process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0;
const isVersion = args.includes('--version');
const expectedHub = ${enabled === true};
const summary = {
    phase: isVersion ? 'version' : 'generate',
    hasApiKey: Boolean(apiKey), hasHubToken: Boolean(hubToken),
    correctApiKey: apiKey === ${JSON.stringify(API_KEY)}, correctHubToken: hubToken === ${JSON.stringify(HUB_TOKEN)},
    rawReferenceEnvPresent: process.env.${AGENT_HUB_TOKEN_REF} !== undefined,
    unrelatedEnvPresent: process.env.UNRELATED_PRIVATE_SECRET !== undefined,
    sandbox: args.includes('--sandbox') ? args[args.indexOf('--sandbox') + 1] : null,
    argvHasSecret: args.some(value => value.includes(${JSON.stringify(API_KEY)}) || value.includes(${JSON.stringify(HUB_TOKEN)})),
};
if (isVersion) {
    fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(summary) + '\\n', { mode: 0o600 });
    process.stdout.write('codex-cli fixture-1.0.0\\n');
    process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
summary.promptHasSecret = prompt.includes(${JSON.stringify(API_KEY)}) || prompt.includes(${JSON.stringify(HUB_TOKEN)});
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(summary) + '\\n', { mode: 0o600 });
if (!summary.correctApiKey || summary.hasHubToken !== expectedHub || (expectedHub && !summary.correctHubToken)
    || summary.argvHasSecret || summary.promptHasSecret || summary.rawReferenceEnvPresent || summary.unrelatedEnvPresent) {
    process.stderr.write('fixture credential transport failed\\n');
    process.exit(8);
}
const secrets = [apiKey, ...(hubToken ? [hubToken] : [])];
const echoed = secrets.flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), 'Bearer ' + value]).join(' | ');
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
emit({ type: 'thread.started', thread_id: 'fixture-hub-thread' });
process.stderr.write('fixture diagnostic ' + echoed + '\\n');
emit({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture completed ' + echoed } });
if (${failed}) emit({ type: 'turn.failed', error: { message: 'fixture failure ' + echoed } });
else emit({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 0 } });
`;
    await fs.writeFile(executable, source, { mode: 0o755 });
    const document = {
        schemaVersion: 1, defaultTarget: 'fixture', timeoutMs: 5000,
        ...(enabled === undefined ? {} : { mcp: { projectHub: enabled } }),
        targets: [{ name: 'fixture', enabled: true,
            harness: { adapter: 'codex', executable, permission },
            backend: { auth: 'api-key', provider: 'fixture', model: 'fixture', protocol: 'responses',
                baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'FIXTURE_MODEL_KEY' },
        }],
    };
    await fs.writeFile(path.join(workspace, configName), JSON.stringify(document));
    const tokenFile = path.join(workspace, 'private-data', 'access.note');
    if (token) {
        await fs.mkdir(path.dirname(tokenFile));
        await fs.writeFile(tokenFile, HUB_TOKEN, { mode: 0o600 });
    }
    const config = {
        workspace,
        env: { VIDEO_REMAKE_AGENT_HOME: storage, FIXTURE_MODEL_KEY: API_KEY,
            [AGENT_HUB_TOKEN_REF]: HUB_TOKEN, UNRELATED_PRIVATE_SECRET: 'must-not-be-inherited' },
        media: { video: { provider: 'comfy-mcp', settings: { hubUrl: HUB_URL, hubTokenFile: tokenFile } } },
    };
    const options = configName === 'agent-runtime.json' ? {} : { agentConfig: configName };
    async function invocations() {
        try { return (await fs.readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }
    return { root, workspace, storage, callsFile, tokenFile, config, options, invocations };
}

function mockHub({ tools = AGENT_HUB_ALL_TOOLS, online = true, status } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        assert.equal(url, HUB_URL);
        assert.equal(init.headers.Authorization, `Bearer ${HUB_TOKEN}`);
        assert.equal(init.redirect, 'error');
        calls.push({ method: init.method, rpc: init.body ? JSON.parse(init.body) : null });
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        if (status) return new Response(HUB_TOKEN, { status });
        const body = JSON.parse(init.body);
        if (body.method === 'notifications/initialized') return new Response(null, { status: 204 });
        let result;
        if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {} };
        else if (body.method === 'tools/list') result = { tools: tools.map(name => ({ name })) };
        else {
            assert.deepEqual(body.params, { name: 'server_info', arguments: {} });
            result = { structuredContent: { bridge: 'running', remote: { online, version: '0.41.0' } } };
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result }, {
            headers: body.method === 'initialize' ? { 'Mcp-Session-Id': 'fixture-session' } : {},
        });
    };
    return { calls, fetchImpl };
}

function assertPrivate(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of [API_KEY, HUB_TOKEN]) {
        for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
            assert.equal(text.includes(variant), false, '模型密钥和 Hub 令牌均须脱敏');
        }
    }
}

async function files(directory) {
    const result = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...await files(file));
        else result.push(file);
    }
    return result;
}

async function snapshot(directory) {
    const result = {};
    for (const file of await files(directory)) {
        result[path.relative(directory, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
    return result;
}

async function assertPrivateRun(config, run, events) {
    assertPrivate({ run, events });
    for (const file of await files(run.runDir)) assertPrivate(await fs.readFile(file, 'utf8'));
    for (const stream of ['stdout', 'stderr', 'events']) {
        const output = await executeAgent(config, 'logs', { runId: run.id, stream });
        assertPrivate(output);
        assert.match(output.text, /\[REDACTED\]/);
    }
    assertPrivate(await executeAgent(config, 'status', { runId: run.id }));
}

test('Agent 实际流程默认不加载 MCP，即使项目已配置 Hub 或环境中有令牌', async (t) => {
    for (const enabled of [undefined, false]) {
        const f = await fixture(t, { enabled, token: false });
        const noNetwork = { fetchImpl: () => assert.fail('未开启 Hub 不应联网') };
        const configuration = await executeAgent(f.config, 'config');
        assert.deepEqual(configuration.mcp, { projectHub: false });
        const planned = await executeAgent(f.config, 'plan', { instruction: INSTRUCTION });
        assert.deepEqual(planned.plan.execution.request.mcpServers ?? [], []);
        assert.equal(planned.plan.hubPlan, undefined);
        assert.equal(JSON.stringify(planned).includes(HUB_URL), false);
        assertPrivate(planned);
        const result = await executeAgent(f.config, 'run', { instruction: INSTRUCTION }, noNetwork);
        assert.equal(result.run.status, 'completed');
        assert.equal(result.run.mcp, undefined);
        const generation = (await f.invocations()).filter(call => call.phase === 'generate');
        assert.equal(generation.length, 1);
        assert.equal(generation[0].hasHubToken, false);
        assert.equal(generation[0].rawReferenceEnvPresent, false);
    }
});

test('Agent 显式 Hub 规划只含描述符，不要求令牌存在且不写文件或解析模型密钥', async (t) => {
    const f = await fixture(t, { enabled: true, token: false });
    Object.defineProperty(f.config.env, 'FIXTURE_MODEL_KEY', { get() { assert.fail('规划不得读取模型密钥'); } });
    const before = await snapshot(f.workspace);
    const planned = await executeAgent(f.config, 'plan', { instruction: INSTRUCTION });
    const server = planned.plan.execution.request.mcpServers[0];
    assert.deepEqual(server, { name: 'comfy-hub', url: HUB_URL, bearerTokenRef: AGENT_HUB_TOKEN_REF, enabledTools: [...AGENT_HUB_ALL_TOOLS] });
    assert.deepEqual(planned.plan.execution.mcpCredentials, [{ ref: AGENT_HUB_TOKEN_REF, envVar: 'JS_AGENT_RUNTIME_MCP_TOKEN_0' }]);
    assertPrivate(planned);
    assert.equal(planned.plan.execution.process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0, undefined);
    assert.deepEqual(await snapshot(f.workspace), before);
    await assert.rejects(fs.stat(f.storage), { code: 'ENOENT' });
    assert.deepEqual(await f.invocations(), []);
});

test('Agent doctor 只执行版本检查和 Hub 只读探活，不启动模型或创建运行记录', async (t) => {
    const f = await fixture(t, { enabled: true });
    const hub = mockHub();
    const before = await snapshot(f.workspace);
    const result = await executeAgent(f.config, 'doctor', {}, hub);
    assert.equal(result.readiness.ok, true);
    assert.ok(result.readiness.checks.some(check => check.name === 'mcp-hub' && check.status === 'passed'));
    assert.equal(result.readiness.mcp.tools, 17);
    assertPrivate(result);
    const invocations = await f.invocations();
    assert.ok(invocations.length > 0);
    assert.ok(invocations.every(call => call.phase === 'version' && !call.hasHubToken && !call.hasApiKey));
    assert.deepEqual(hub.calls.filter(call => call.rpc?.method === 'tools/call').map(call => call.rpc.params.name), ['server_info']);
    assert.deepEqual(await snapshot(f.workspace), before);
    await assert.rejects(fs.stat(f.storage), { code: 'ENOENT' });
});

for (const failed of [false, true]) {
    test(`Agent ${failed ? '失败' : '成功'}运行分别传递模型密钥与 Hub 令牌，结果及全部日志脱敏`, async (t) => {
        const f = await fixture(t, { enabled: true, failed });
        const hub = mockHub();
        const events = [];
        let run;
        try {
            const result = await executeAgent(f.config, 'run', { instruction: INSTRUCTION }, { ...hub, onEvent: event => events.push(event) });
            assert.equal(failed, false);
            run = result.run;
        } catch (error) {
            assert.equal(failed, true);
            assert.equal(error.code, 'AGENT_FAILED');
            assertPrivate({ message: error.message, data: error.data });
            run = error.data.run;
        }
        assert.equal(run.status, failed ? 'failed' : 'completed');
        assert.equal(run.mcp.tools, 17);
        const invocation = (await f.invocations()).find(call => call.phase === 'generate');
        assert.ok(invocation);
        assert.equal(invocation.correctApiKey, true);
        assert.equal(invocation.correctHubToken, true);
        assert.equal(invocation.argvHasSecret, false);
        assert.equal(invocation.promptHasSecret, false);
        assert.equal(invocation.rawReferenceEnvPresent, false);
        assert.equal(invocation.unrelatedEnvPresent, false);
        assert.equal(invocation.sandbox, 'workspace-write');
        await assertPrivateRun(f.config, run, events);
    });
}

test('Agent 只读目标保持原权限及九个工具，只读设备也能通过实际流程', async (t) => {
    const f = await fixture(t, { enabled: true, permission: 'read-only' });
    const hub = mockHub({ tools: AGENT_HUB_READ_TOOLS });
    const planned = await executeAgent(f.config, 'plan', { instruction: INSTRUCTION });
    assert.equal(planned.plan.target.harness.permission, 'read-only');
    assert.deepEqual(planned.plan.execution.request.mcpServers[0].enabledTools, [...AGENT_HUB_READ_TOOLS]);
    const result = await executeAgent(f.config, 'run', { instruction: INSTRUCTION }, hub);
    assert.equal(result.run.status, 'completed');
    assert.equal(result.run.mcp.tools, 9);
    assert.equal((await f.invocations()).find(call => call.phase === 'generate').sandbox, 'read-only');
});

test('Agent Hub 失效或缺少授权工具时拒绝生成，并保存可查询的失败记录', async (t) => {
    for (const failure of [{ status: 401 }, { tools: AGENT_HUB_READ_TOOLS }, { online: false }]) {
        const f = await fixture(t, { enabled: true });
        let run;
        await assert.rejects(executeAgent(f.config, 'run', { instruction: INSTRUCTION }, mockHub(failure)), (error) => {
            assert.equal(error.code, 'AGENT_FAILED');
            run = error.data.run;
            assert.equal(run.status, 'failed');
            assert.equal(run.execution, null);
            assertPrivate({ message: error.message, data: error.data });
            return true;
        });
        assert.deepEqual(await f.invocations(), []);
        await assert.rejects(fs.stat(path.join(run.runDir, 'runtime')), { code: 'ENOENT' });
        assert.equal((await executeAgent(f.config, 'status', { runId: run.id })).run.status, 'failed');
    }
});

test('Agent doctor 的 Hub 失败显示检查失败，仍不启动生成', async (t) => {
    const f = await fixture(t, { enabled: true });
    await assert.rejects(executeAgent(f.config, 'doctor', {}, mockHub({ status: 403 })), (error) => {
        assert.equal(error.code, 'AGENT_NOT_READY');
        assert.ok(error.data.readiness.checks.some(check => check.name === 'mcp-hub' && check.status === 'failed'));
        assertPrivate(error.data);
        return true;
    });
    assert.ok((await f.invocations()).every(call => call.phase === 'version'));
});

test('Agent 拒绝机密输入目录及自定义令牌、Agent 配置路径，三种输入入口一致', async (t) => {
    const f = await fixture(t, { enabled: false, configName: 'private-agent-settings.json' });
    const blocked = ['.secrets/token', '.mcp/client.json', '.mcp.json', '.codex/config.toml', '.codexconfig',
        '.cursor/mcp.json', '.claude/settings.json', 'AUTH.json', 'private-data/access.note', 'private-agent-settings.json'];
    for (const name of blocked) {
        if (['private-data/access.note', 'private-agent-settings.json'].includes(name)) continue;
        await fs.mkdir(path.dirname(path.join(f.workspace, name)), { recursive: true });
        await fs.writeFile(path.join(f.workspace, name), 'private configuration contents');
    }
    for (const name of blocked) {
        for (const input of [
            { instruction: INSTRUCTION, inputs: [name] }, { instruction: INSTRUCTION, skills: [name] }, { instructionFile: name },
        ]) {
            await assert.rejects(executeAgent(f.config, 'plan', { ...f.options, ...input }), { code: 'INVALID_INPUT' });
        }
    }
    assert.deepEqual(await f.invocations(), []);
    await assert.rejects(fs.stat(f.storage), { code: 'ENOENT' });
});

test('Agent 拒绝普通笔记或直接指令中复制的 Hub 令牌', async (t) => {
    const f = await fixture(t, { enabled: false });
    await fs.writeFile(path.join(f.workspace, 'notes.md'), `普通笔记中的意外凭据 ${HUB_TOKEN}`);
    for (const options of [
        { instruction: HUB_TOKEN }, { instructionFile: 'notes.md' },
        { instruction: INSTRUCTION, inputs: ['notes.md'] }, { instruction: INSTRUCTION, skills: ['notes.md'] },
    ]) {
        await assert.rejects(executeAgent(f.config, 'plan', options), (error) => {
            assert.equal(error.code, 'INVALID_INPUT');
            assertPrivate(error.message);
            return true;
        });
    }
    await assert.rejects(fs.stat(f.storage), { code: 'ENOENT' });
});

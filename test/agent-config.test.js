import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { agentStorageRoot, loadAgentConfig, selectAgentTarget } from '../src/agent-config.js';

function target(overrides = {}) {
    return {
        name: 'codex-api',
        harness: { adapter: 'codex', executable: 'codex', permission: 'workspace-write' },
        backend: {
            auth: 'api-key', provider: 'openai', protocol: 'responses',
            baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'test-model',
        },
        ...overrides,
    };
}

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-agent-config-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'project');
    await fs.mkdir(workspace);
    const env = { VIDEO_REMAKE_AGENT_HOME: path.join(directory, 'agent-state') };
    const config = { workspace, env };
    const write = async (document, name = 'agent-runtime.json') => {
        const filePath = path.join(workspace, name);
        await fs.writeFile(filePath, JSON.stringify(document));
        return filePath;
    };
    return { directory, workspace, env, config, write };
}

const isInvalid = (pattern) => (error) => error.code === 'CONFIG_INVALID' && pattern.test(error.message);

test('loads strict runtime targets, defaults timeout and keeps omitted enabled false', async (t) => {
    const f = await fixture(t);
    const configPath = await f.write({ schemaVersion: 1, defaultTarget: 'codex-api', targets: [target()] });
    const settings = await loadAgentConfig(f.config);
    assert.equal(settings.configPath, configPath);
    assert.equal(settings.defaultTarget, 'codex-api');
    assert.equal(settings.timeoutMs, 600_000);
    assert.deepEqual(settings.mcp, { projectHub: false });
    assert.deepEqual(settings.targets, [{ ...target(), enabled: false }]);
    const selected = selectAgentTarget(settings);
    assert.equal(selected.enabled, false);
    assert.deepEqual(selected.target, target());
    selected.target.backend.model = 'changed';
    assert.equal(settings.targets[0].backend.model, 'test-model');
    await assert.rejects(fs.stat(f.env.VIDEO_REMAKE_AGENT_HOME), { code: 'ENOENT' });
});

test('MCP configuration is explicit and rejects unknown fields or non-boolean enablement', async (t) => {
    const f = await fixture(t);
    for (const mcp of [null, [], 'true', { projectHub: 'true' }, { projectHub: 1 }, { projectHub: true, servers: [] }]) {
        await f.write({ schemaVersion: 1, targets: [target()], mcp });
        await assert.rejects(loadAgentConfig(f.config), isInvalid(/object|Unknown|boolean/));
    }
    for (const mcp of [{}, { projectHub: false }, { projectHub: true }]) {
        await f.write({ schemaVersion: 1, targets: [target()], mcp });
        assert.deepEqual((await loadAgentConfig(f.config)).mcp, { projectHub: mcp.projectHub ?? false });
    }
});

test('explicit configuration path takes priority over environment and workspace defaults', async (t) => {
    const f = await fixture(t);
    await f.write({ schemaVersion: 1, timeoutMs: 1000, targets: [target()] });
    await f.write({ schemaVersion: 1, timeoutMs: 2000, targets: [target()] }, 'env.json');
    const explicit = await f.write({ schemaVersion: 1, timeoutMs: 3000, targets: [target()] }, 'explicit.json');
    const env = { ...f.env, VIDEO_REMAKE_AGENT_CONFIG: 'env.json' };
    assert.equal((await loadAgentConfig(f.config)).timeoutMs, 1000);
    assert.equal((await loadAgentConfig(f.config, { env })).timeoutMs, 2000);
    const settings = await loadAgentConfig(f.config, { configPath: 'explicit.json', env });
    assert.equal(settings.timeoutMs, 3000);
    assert.equal(settings.configPath, explicit);
});

test('missing configuration points to the example and never silently falls back', async (t) => {
    const f = await fixture(t);
    await assert.rejects(loadAgentConfig(f.config), isInvalid(/Copy agent-runtime.example.json/));
    await f.write({ schemaVersion: 1, targets: [target()] });
    await assert.rejects(loadAgentConfig(f.config, { configPath: 'missing.json' }), isInvalid(/missing.json/));
});

test('rejects malformed JSON, non-object documents, unsupported schema, and unknown fields', async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.workspace, 'agent-runtime.json'), '{');
    await assert.rejects(loadAgentConfig(f.config), isInvalid(/parse/));
    for (const document of [null, [], { schemaVersion: 2, targets: [] }, { schemaVersion: 1, targets: [], unexpected: true }]) {
        await f.write(document);
        await assert.rejects(loadAgentConfig(f.config), isInvalid(/object|schemaVersion|Unknown/));
    }
    for (const entry of [null, target({ unexpected: true }), target({ enabled: 'true' })]) {
        await f.write({ schemaVersion: 1, targets: [entry] });
        await assert.rejects(loadAgentConfig(f.config), isInvalid(/object|Unknown|boolean/));
    }
});

test('requires integer timeout in bounds and a target array', async (t) => {
    const f = await fixture(t);
    for (const timeoutMs of [null, 999, 86_400_001, 1500.5, '1000']) {
        await f.write({ schemaVersion: 1, timeoutMs, targets: [target()] });
        await assert.rejects(loadAgentConfig(f.config), isInvalid(/timeoutMs/));
    }
    for (const timeoutMs of [1000, 86_400_000]) {
        await f.write({ schemaVersion: 1, timeoutMs, targets: [target()] });
        assert.equal((await loadAgentConfig(f.config)).timeoutMs, timeoutMs);
    }
    await f.write({ schemaVersion: 1, targets: {} });
    await assert.rejects(loadAgentConfig(f.config), isInvalid(/array/));
});

test('rejects duplicate targets and a missing or invalid default target', async (t) => {
    const f = await fixture(t);
    await f.write({ schemaVersion: 1, targets: [target(), target()] });
    await assert.rejects(loadAgentConfig(f.config), isInvalid(/Duplicate/));
    for (const defaultTarget of ['missing', '', null, 42]) {
        await f.write({ schemaVersion: 1, defaultTarget, targets: [target()] });
        await assert.rejects(loadAgentConfig(f.config), isInvalid(/defaultTarget/));
    }
});

test('runtime validates backend protocols, unknown fields, adapter and auth combinations', async (t) => {
    const f = await fixture(t);
    const cases = [
        target({ backend: { ...target().backend, protocol: 'chat-completions' } }),
        target({ backend: { ...target().backend, apiKey: 'not-a-credential-field' } }),
        target({ backend: { ...target().backend, auth: 'unknown' } }),
        target({ harness: { ...target().harness, adapter: 'missing-adapter' } }),
        target({ harness: { ...target().harness, extra: true } }),
        target({ harness: { ...target().harness, contextMode: 'project' } }),
        target({ backend: { ...target().backend, baseURL: 'https://user:password@example.com/v1' } }),
    ];
    for (const entry of cases) {
        await f.write({ schemaVersion: 1, targets: [entry] });
        await assert.rejects(loadAgentConfig(f.config), isInvalid(/Invalid agent target/));
    }
});

test('selects a sole target, defaults or an explicit target, and rejects disabled runs', async (t) => {
    const f = await fixture(t);
    await f.write({ schemaVersion: 1, targets: [target()] });
    let settings = await loadAgentConfig(f.config);
    assert.equal(selectAgentTarget(settings).target.name, 'codex-api');
    assert.throws(() => selectAgentTarget(settings, undefined, { requireEnabled: true }), isInvalid(/disabled/));
    await f.write({ schemaVersion: 1, defaultTarget: 'codex-api', targets: [target(), target({ name: 'enabled', enabled: true })] });
    settings = await loadAgentConfig(f.config);
    assert.equal(selectAgentTarget(settings).target.name, 'codex-api');
    assert.equal(selectAgentTarget(settings, 'enabled', { requireEnabled: true }).enabled, true);
    assert.throws(() => selectAgentTarget(settings, 'missing'), isInvalid(/does not exist/));
    delete settings.defaultTarget;
    assert.throws(() => selectAgentTarget(settings), isInvalid(/--target/));
    assert.throws(() => selectAgentTarget({ targets: [] }), isInvalid(/--target/));
});

test('loads the checked-in example with every target disabled without looking up credentials', async (t) => {
    const f = await fixture(t);
    const env = { ...f.env };
    Object.defineProperty(env, 'OPENAI_API_KEY', { get() { throw new Error('credential lookup during configuration'); } });
    Object.defineProperty(env, 'DEEPSEEK_API_KEY', { get() { throw new Error('credential lookup during configuration'); } });
    const settings = await loadAgentConfig(f.config, {
        configPath: new URL('../agent-runtime.example.json', import.meta.url).pathname,
        env,
    });
    assert.equal(settings.defaultTarget, 'deepseek-flash');
    assert.ok(settings.targets.every((entry) => entry.enabled === false));
    assert.deepEqual(settings.targets.map((entry) => entry.name), ['codex-native', 'claude-local', 'deepseek-flash', 'codex-api']);
});

test('storage defaults to XDG or home state with a workspace-specific stable hash', async (t) => {
    const f = await fixture(t);
    const canonicalWorkspace = await fs.realpath(f.workspace);
    const hash = createHash('sha256').update(canonicalWorkspace).digest('hex').slice(0, 16);
    const xdg = path.join(f.directory, 'xdg-state');
    assert.equal(agentStorageRoot(f.config, { XDG_STATE_HOME: xdg }), path.join(xdg, 'video-remake', 'agents', hash));
    assert.equal(agentStorageRoot(f.config, {}), path.join(os.homedir(), '.local', 'state', 'video-remake', 'agents', hash));
    assert.equal(agentStorageRoot(f.config), f.env.VIDEO_REMAKE_AGENT_HOME);
    assert.equal(agentStorageRoot(f.config, { VIDEO_REMAKE_AGENT_HOME: f.env.VIDEO_REMAKE_AGENT_HOME, XDG_STATE_HOME: f.workspace }), f.env.VIDEO_REMAKE_AGENT_HOME);
    assert.notEqual(agentStorageRoot({ workspace: path.join(f.directory, 'other') }, { XDG_STATE_HOME: xdg }), path.join(xdg, 'video-remake', 'agents', hash));
});

test('storage rejects workspace ancestors, descendants and equality but allows siblings', async (t) => {
    const f = await fixture(t);
    for (const root of [f.directory, f.workspace, path.join(f.workspace, '.agent-state'), path.parse(f.workspace).root]) {
        assert.throws(() => agentStorageRoot(f.config, { VIDEO_REMAKE_AGENT_HOME: root }), isInvalid(/outside the workspace/));
    }
    const sibling = `${f.workspace}-state`;
    assert.equal(agentStorageRoot(f.config, { VIDEO_REMAKE_AGENT_HOME: sibling }), sibling);
    assert.throws(() => agentStorageRoot(f.config, { VIDEO_REMAKE_AGENT_HOME: '' }), isInvalid(/nonempty path/));
});

test('storage rejects overlap through symlinks and hashes workspace aliases identically', async (t) => {
    const f = await fixture(t);
    const alias = path.join(f.directory, 'alias');
    await fs.symlink(f.workspace, alias, 'dir');
    assert.throws(() => agentStorageRoot(f.config, { VIDEO_REMAKE_AGENT_HOME: path.join(alias, 'new', 'logs') }), isInvalid(/outside the workspace/));
    assert.throws(() => agentStorageRoot({ workspace: alias }, { VIDEO_REMAKE_AGENT_HOME: path.join(f.workspace, 'logs') }), isInvalid(/outside the workspace/));
    const env = { XDG_STATE_HOME: path.join(f.directory, 'xdg') };
    assert.equal(agentStorageRoot(f.config, env), agentStorageRoot({ workspace: alias }, env));
});

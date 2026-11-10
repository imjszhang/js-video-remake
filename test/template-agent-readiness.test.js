import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkTemplateAgentExecutable } from '../src/template-agent-readiness.js';
import { templateAgentOptions } from '../src/template-agent.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-readiness-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'project');
    await fs.mkdir(workspace);
    return { root, config: { workspace, env: { PATH: root, VIDEO_REMAKE_AGENT_HOME: path.join(root, 'state') } } };
}
const target = executable => ({ name: 'local-private-name', enabled: true, harness: { adapter: 'codex', executable, permission: 'workspace-write' }, backend: { auth: 'chatgpt', model: 'fixture' } });

test('Harness availability resolves absolute paths and PATH without executing files', async t => {
    const { root, config } = await fixture(t);
    const executable = path.join(root, 'fixture-cli');
    await fs.writeFile(executable, 'This is not executable code.');
    await fs.chmod(executable, 0o700);
    for (const command of [executable, 'fixture-cli']) assert.deepEqual(await checkTemplateAgentExecutable(config, target(command)), { available: true, unavailableReason: null });
});

test('missing and non-executable Harness files explain the problem without disclosing paths', async t => {
    const { root, config } = await fixture(t);
    const executable = path.join(root, 'private-cli');
    const absent = await checkTemplateAgentExecutable(config, target(executable));
    assert.equal(absent.available, false);
    assert.match(absent.unavailableReason, /Codex CLI 启动程序不存在/);
    assert(!absent.unavailableReason.includes(root));
    await fs.writeFile(executable, 'unexecutable');
    await fs.chmod(executable, 0o600);
    assert.match((await checkTemplateAgentExecutable(config, target(executable))).unavailableReason, /不可执行/);
    assert.equal((await checkTemplateAgentExecutable(config, target(root))).available, false, 'directories cannot act as executables');
});

test('options retain unavailable targets while choosing an available default', async t => {
    const { config } = await fixture(t);
    const missing = target('/missing-private-cli');
    const present = { ...target(process.execPath), name: 'working' };
    const file = path.join(config.workspace, 'agent-runtime.json');
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, defaultTarget: missing.name, targets: [missing, present] }));
    const options = await templateAgentOptions(config);
    assert.equal(options.available, true);
    assert.equal(options.defaultTarget, present.name);
    assert.equal(options.targets[0].available, false);
    assert.equal(options.targets[1].available, true);
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, targets: [missing] }));
    const none = await templateAgentOptions(config);
    assert.equal(none.available, false);
    assert.equal(none.defaultTarget, null);
    assert.equal(none.targets.length, 1);
    assert.match(none.error, /均不可用/);
});

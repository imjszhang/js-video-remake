import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { templateAgentLabel } from '../src/template-agent-label.js';
import { templateAgentOptions } from '../src/template-agent.js';

test('Agent choice names describe the harness and selected model instead of a local configuration key', () => {
    for (const [adapter, harness] of [['codex', 'Codex CLI'], ['claude-code', 'Claude Code'], ['deepseek-harness', 'DeepSeek Harness'], ['cursor-agent', 'Cursor Agent'], ['opencode', 'OpenCode']]) {
        const display = templateAgentLabel({ name: 'internal-local-bypass', harness: { adapter }, backend: { model: 'chosen-model' } });
        assert.deepEqual(display, { harness, model: 'chosen-model', label: `${harness} · chosen-model` });
        assert(!display.label.includes('internal-local-bypass'));
    }
});

test('configured and missing model values do not claim a concrete model was selected', () => {
    for (const model of ['configured', undefined]) {
        const display = templateAgentLabel({ harness: { adapter: 'claude-code' }, backend: { model } });
        assert.equal(display.model, '跟随 Harness 本机设置');
        assert.equal(display.label, 'Claude Code · 跟随 Harness 本机设置');
    }
});

test('template Agent options publish only display metadata and the routing key', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-choice-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'project');
    await fs.mkdir(workspace);
    const config = { workspace, env: { VIDEO_REMAKE_AGENT_HOME: path.join(directory, 'state') } };
    const target = {
        name: 'private-routing-key', enabled: true,
        harness: { adapter: 'codex', executable: '/private/runtime/codex', permission: 'workspace-write' },
        backend: { auth: 'api-key', provider: 'provider', protocol: 'responses', baseURL: 'https://private.example.invalid/v1', apiKeyEnv: 'PRIVATE_API_KEY', model: 'chosen-model' },
    };
    await fs.writeFile(path.join(workspace, 'agent-runtime.json'), JSON.stringify({ schemaVersion: 1, defaultTarget: target.name, targets: [target, { ...target, name: 'disabled-routing-key', enabled: false }] }));
    const options = await templateAgentOptions(config, { checkTemplateAgentExecutable: async () => ({ available: true, unavailableReason: null }) });
    assert.equal(options.available, true);
    assert.equal(options.defaultTarget, target.name);
    assert.deepEqual(options.targets, [{ name: target.name, harness: 'Codex CLI', model: 'chosen-model', label: 'Codex CLI · private.example.invalid · chosen-model（配置）', provider: 'private.example.invalid', providerUrl: 'https://private.example.invalid', configuredModel: 'chosen-model', configurationSource: '项目执行配置', available: true, unavailableReason: null }]);
    const serialized = JSON.stringify(options);
    assert.equal(options.providers[0].baseURL, target.backend.baseURL); // Editable connection settings intentionally include the complete endpoint.
    assert(!JSON.stringify(options.targets).includes(target.backend.baseURL));
    for (const privateValue of [target.harness.executable, target.backend.apiKeyEnv, 'disabled-routing-key']) assert(!serialized.includes(privateValue));
});

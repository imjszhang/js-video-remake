import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineAgent, providerGroups } from '../src/template-agent-selection.js';
const config = { workspace: process.cwd(), env: {} };
const target = (name, adapter, backend, extra = {}) => ({ name, enabled: true, harness: { adapter, executable: process.execPath, permission: 'workspace-write', ...extra }, backend });
const settings = { timeoutMs: 600000, targets: [
    target('claude', 'claude-code', { auth: 'claude-config', model: 'configured' }, { contextMode: 'project' }),
    target('codex', 'codex', { auth: 'chatgpt', model: 'test' }),
    target('deep', 'deepseek-harness', { auth: 'api-key', provider: 'deep', protocol: 'anthropic-messages', baseURL: 'https://example.com', apiKeyEnv: 'DEEP_KEY', model: 'deep-pro' }),
    target('deep-flash', 'deepseek-harness', { auth: 'api-key', provider: 'deep', protocol: 'anthropic-messages', baseURL: 'https://example.com', apiKeyEnv: 'DEEP_KEY', model: 'deep-flash' }),
] };
test('Harness and Provider combine independently, with explicit model and isolated API settings', () => {
    const result = combineAgent(config, settings, { target: 'claude', providerTarget: 'deep', model: 'custom-model' });
    assert.equal(result.harness.adapter, 'claude-code');
    assert.equal(result.harness.contextMode, 'snapshot');
    assert.equal(result.backend.apiKeyEnv, 'DEEP_KEY');
    assert.equal(result.backend.model, 'custom-model');
    assert.equal(settings.targets[0].backend.model, 'configured');
    assert.equal(combineAgent(config, settings, { target: 'claude', model: 'sonnet' }).backend.model, 'sonnet');
});
test('incompatible protocols, native authentication and malformed models are rejected', () => {
    for (const options of [{ target: 'codex', providerTarget: 'deep' }, { target: 'deep', providerTarget: 'claude' }, { target: 'claude', model: '--bad value' }]) assert.throws(() => combineAgent(config, settings, options), { code: 'INVALID_INPUT' });
});
test('model variants of one connection are grouped without credentials in the UI', () => {
    const groups = providerGroups(settings);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[2].models, ['deep-pro', 'deep-flash']);
    assert.doesNotMatch(JSON.stringify(groups), /apiKeyEnv|DEEP_KEY/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { saveTemplateProvider, readTemplateProviders } from '../src/template-providers.js';
import { agentCredentialEnvironment } from '../src/agent-credentials.js';
import { combineAgent } from '../src/template-agent-selection.js';
const body = { label: '测试连接', baseURL: 'https://example.invalid/v1', protocol: 'responses', apiKey: 'test-private-key', models: ['model-one', 'model-two'] };
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-settings-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { workspace: root, env: {} };
}
test('provider saves atomically with private permissions; edit preserves and rotates secret without exposing it', async t => {
    const config = await fixture(t);
    const created = await saveTemplateProvider(config, body);
    assert.equal(created.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(created), /test-private-key|keyRef/);
    assert.equal((await fs.stat(path.join(config.workspace, '.env.agent.providers.json'))).mode & 0o777, 0o600);
    const edited = await saveTemplateProvider(config, { ...body, id: created.id, apiKey: undefined, label: '新名称', models: ['model-two'] });
    assert.equal(edited.label, '新名称');
    assert.equal((await readTemplateProviders(config))[0].apiKey, body.apiKey);
    await assert.rejects(saveTemplateProvider(config, { ...body, id: created.id, baseURL: 'https://different.invalid', apiKey: undefined }), /重新填写/);
    await saveTemplateProvider(config, { ...body, id: created.id, apiKey: 'replacement-key' });
    const settings = { timeoutMs: 1000, providers: await readTemplateProviders(config), targets: [{ name: 'codex', enabled: true, harness: { adapter: 'codex', executable: process.execPath, permission: 'workspace-write' }, backend: { auth: 'chatgpt', model: 'original' } }] };
    const combined = combineAgent(config, settings, { target: 'codex', providerTarget: created.id, model: 'model-two' });
    assert.equal(combined.backend.baseURL, body.baseURL);
    assert.equal(combined.backend.model, 'model-two');
    assert.equal((await agentCredentialEnvironment(config, combined))[combined.backend.apiKeyEnv], 'replacement-key');
});
test('provider rejects invalid addresses, models, keys and symlink storage without exposing secrets', async t => {
    const config = await fixture(t);
    for (const override of [{ baseURL: 'file:///tmp/test' }, { baseURL: 'https://user:secret@example.com' }, { baseURL: 'https://example.com?key=secret' }, { models: [] }, { models: ['bad model'] }, { apiKey: 'key\nvalue' }, { id: 'unknown' }]) {
        await assert.rejects(saveTemplateProvider(config, { ...body, ...override }), { code: 'INVALID_INPUT' });
    }
    const target = path.join(config.workspace, 'other'); await fs.writeFile(target, 'private-secret-broken-json');
    const store = path.join(config.workspace, '.env.agent.providers.json'); await fs.symlink(target, store);
    await assert.rejects(saveTemplateProvider(config, body), error => !error.message.includes('private-secret'));
    assert.equal(await fs.readFile(target, 'utf8'), 'private-secret-broken-json');
});

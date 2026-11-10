import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { probeTemplateProvider } from '../src/template-provider-probe.js';
import { saveTemplateProvider } from '../src/template-providers.js';
const body = { label: 'Probe', baseURL: 'https://example.invalid', protocol: 'responses', apiKey: 'private-secret', models: ['one'] };
async function fixture(t) { const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-probe-')); t.after(() => fs.rm(workspace, { recursive: true, force: true })); return { workspace }; }
const result = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
test('models lookup uses protocol authentication, deduplicates results and never saves draft secrets', async t => {
    const config = await fixture(t);
    for (const protocol of ['responses', 'chat-completions', 'anthropic-messages']) {
        const value = await probeTemplateProvider(config, { ...body, protocol }, { fetchImpl: async (url, options) => {
            assert.equal(url, 'https://example.invalid/v1/models');
            assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
            assert.equal(protocol === 'anthropic-messages' ? options.headers['x-api-key'] : options.headers.Authorization, protocol === 'anthropic-messages' ? body.apiKey : `Bearer ${body.apiKey}`);
            return result({ data: [{ id: 'one' }, { id: 'one' }, { id: 'two' }, { id: '<unsafe>' }, { id: body.apiKey }] });
        } });
        assert.deepEqual(value.models, ['one', 'two']);
        assert.match(value.message, /尚未验证/);
        assert.doesNotMatch(JSON.stringify(value), /private-secret/);
    }
    assert.deepEqual(await fs.readdir(config.workspace), []);
});
test('saved key is reusable only for unchanged endpoint and protocol', async t => {
    const config = await fixture(t); const saved = await saveTemplateProvider(config, body);
    let calls = 0;
    const deps = { fetchImpl: async () => { calls++; return result({ data: [{ id: 'one' }] }); } };
    await probeTemplateProvider(config, { ...body, id: saved.id, apiKey: undefined }, deps);
    assert.equal(calls, 1);
    await assert.rejects(probeTemplateProvider(config, { ...body, id: saved.id, apiKey: undefined, baseURL: 'https://other.invalid' }, deps), /重新填写/);
    assert.equal(calls, 1);
});
test('HTTP failures, malformed replies and timeout never expose remote bodies or credentials', async t => {
    const config = await fixture(t);
    for (const status of [302, 401, 403, 404, 429, 503]) {
        await assert.rejects(probeTemplateProvider(config, body, { fetchImpl: async () => new Response('private-secret', { status }) }), e => e.message.includes(`HTTP ${status}`) && !e.message.includes('private-secret'));
    }
    for (const response of [new Response('<html>private-secret</html>'), result({ error: 'private-secret' }), result({ data: [] }), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
        await assert.rejects(probeTemplateProvider(config, body, { fetchImpl: async () => response }), e => !e.message.includes('private-secret'));
    }
    await assert.rejects(probeTemplateProvider(config, body, { providerProbeTimeoutMs: 5, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-secret')))) }), /超时/);
});
test('custom prefixes are preserved and large model inventories are marked partial', async t => {
    const config = await fixture(t);
    const value = await probeTemplateProvider(config, { ...body, baseURL: 'https://example.invalid/proxy/v1/' }, { fetchImpl: async url => { assert.equal(url, 'https://example.invalid/proxy/v1/models'); return result({ data: Array.from({ length: 80 }, (_, i) => ({ id: `model-${i}` })) }); } });
    assert.equal(value.models.length, 50); assert.equal(value.partial, true);
});

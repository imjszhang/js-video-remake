import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHubRelay } from '../src/hub-relay.js';

const upstream = 'http://10.8.0.5:8899/mcp/comfyui';

test('hub relay forwards the project hub through the injected proxy and ignores other paths', async () => {
    const seen = [];
    const relay = await startHubRelay({
        proxy: 'socks5://127.0.0.1:1080', upstream,
        forward: async (proxy, url, init) => {
            seen.push({ proxy, url, method: init.method, authorization: init.headers.get('authorization'), body: Buffer.from(await new Response(init.body).arrayBuffer()).toString() });
            return new Response('ready', { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
        },
    });
    assert.equal(new URL(relay.url).hostname, '127.0.0.1');
    assert.equal(new URL(relay.url).pathname, '/mcp/comfyui');
    try {
        const response = await fetch(relay.url, { method: 'POST', headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0"}' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('mcp-session-id'), 'session-1');
        assert.equal(await response.text(), 'ready');
        assert.deepEqual(seen, [{
            proxy: 'socks5://127.0.0.1:1080', url: upstream, method: 'POST', authorization: 'Bearer secret-token', body: '{"jsonrpc":"2.0"}',
        }]);
        assert.equal((await fetch(`${relay.url}/other`, { method: 'POST' })).status, 404);
    } finally {
        await relay.close();
    }
});

test('hub relay is unnecessary for a loopback hub or a run without a proxy', async () => {
    assert.equal(await startHubRelay({ proxy: 'socks5://127.0.0.1:1080', upstream: 'http://127.0.0.1:8899/mcp/comfyui' }), null);
    assert.equal(await startHubRelay({ upstream }), null);
});

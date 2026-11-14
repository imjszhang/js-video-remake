import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseHubUrl, probeHub, readHubToken } from '../src/media/mcp-hub.js';
import { resolveMediaConfig } from '../src/media/config.js';
import { mediaDoctor } from '../src/media/index.js';
import comfy from '../src/media/providers/comfy-mcp.js';

const TOKEN = 'mcp_hub_' + 'test-only-token-'.repeat(3);
const URL = 'http://hub.test:8899/mcp/comfyui';
const TOOLS = ['server_info', 'validate_workflow', 'upload_file', 'run_workflow', 'job', 'fetch_outputs'];

async function settings(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-hub-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'token');
    await fs.writeFile(file, TOKEN + '\n', { mode: 0o600 });
    return { hubUrl: URL, hubTokenFile: file };
}

function server({ sse = false, tools = TOOLS, online = true, failure, session = false } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, ...init });
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        const body = JSON.parse(init.body);
        if (failure) return new Response(TOKEN, { status: failure });
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {} }
            : body.method === 'tools/list' ? { tools: tools.map((name) => ({ name })) }
                : { structuredContent: { bridge: 'running', remote: { online, version: '0.41.0' } } };
        const value = { jsonrpc: '2.0', id: body.id, result };
        const headers = { 'Content-Type': sse ? 'text/event-stream' : 'application/json',
            ...(session && body.method === 'initialize' ? { 'Mcp-Session-Id': 'fixture-session' } : {}) };
        if (!sse) return new Response(JSON.stringify(value), { headers });
        // Include notifications and split frame delimiters, then keep the
        // connection open: the probe must finish when its response arrives.
        const text = ': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n'
            + `event: message\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
        return new Response(new ReadableStream({ start(controller) {
            for (const char of text) controller.enqueue(new TextEncoder().encode(char));
        } }), { headers });
    };
    return { fetchImpl, calls };
}

test('Hub configuration separates credentials and prefers environment overrides', () => {
    const media = resolveMediaConfig({ video: { hubUrl: URL, hubTokenFile: '.secrets/token' } }, {
        COMFY_MCP_HUB_URL: 'http://alternate.test/mcp/comfyui',
    }, '/workspace');
    assert.equal(media.video.settings.hubUrl, 'http://alternate.test/mcp/comfyui');
    assert.equal(media.video.settings.hubTokenFile, '/workspace/.secrets/token');
    assert.deepEqual(parseHubUrl(URL + '/'), { url: URL, origin: 'http://hub.test:8899', service: 'comfyui' });
    for (const url of ['http://host/mcp/default', 'http://user:secret@host/mcp/comfyui', 'http://host/mcp/comfyui?token=x',
        'http://host/mcp/comfyui#token', 'http://host:8188/', 'file:///mcp/comfyui']) {
        assert.throws(() => parseHubUrl(url));
        assert.throws(() => resolveMediaConfig({ video: { hubUrl: url } }, {}, '/workspace'), /专用入口/);
    }
});

for (const sse of [false, true]) {
    test(`read-only Hub doctor supports ${sse ? 'SSE' : 'JSON'} and session lifecycle`, async (t) => {
        const config = await settings(t);
        const fake = server({ sse, session: true });
        const result = await probeHub(config, fake);
        assert.equal(result.version, '0.41.0');
        assert.equal(result.tools, 6);
        assert.deepEqual(fake.calls.map((call) => call.method === 'DELETE' ? 'DELETE' : JSON.parse(call.body).method),
            ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE']);
        for (const call of fake.calls) {
            assert.equal(call.url, URL);
            assert.equal(call.headers.Authorization, 'Bearer ' + TOKEN);
            assert.equal(call.redirect, 'error');
        }
        assert.equal(fake.calls[2].headers['Mcp-Session-Id'], 'fixture-session');
        assert.equal(fake.calls[2].headers['MCP-Protocol-Version'], '2025-03-26');
        assert.equal(JSON.parse(fake.calls[3].body).params.name, 'server_info');
    });
}

test('Hub doctor fails closed for revoked/read-only/offline grants and hides errors', async (t) => {
    const config = await settings(t);
    for (const options of [{ failure: 401 }, { tools: ['server_info', 'job'] }, { online: false }]) {
        const fake = server(options);
        const result = await comfy.doctor({ ...config, url: 'http://should-not-fallback.test:8188' }, fake);
        assert.equal(result.ready, false);
        assert.match(result.hint, /MCP Hub 不可用/);
        assert.ok(!result.hint.includes(TOKEN));
        assert.ok(!result.hint.includes(config.hubTokenFile));
        assert.ok(fake.calls.every((call) => call.url === URL));
    }
    const network = await comfy.doctor(config, { fetchImpl: async () => { throw new Error(TOKEN); } });
    assert.equal(network.ready, false);
    assert.ok(!network.hint.includes(TOKEN));
});

test('Hub token requires a private regular file and rejects root-key substitutes', async (t) => {
    const config = await settings(t);
    assert.equal(await readHubToken(config.hubTokenFile), TOKEN);
    const symlink = config.hubTokenFile + '-link';
    await fs.symlink(config.hubTokenFile, symlink);
    await assert.rejects(readHubToken(symlink), /无法读取/);
    if (process.platform !== 'win32') {
        await fs.chmod(config.hubTokenFile, 0o644);
        await assert.rejects(readHubToken(config.hubTokenFile), /chmod 600/);
        await fs.chmod(config.hubTokenFile, 0o600);
    }
    await fs.writeFile(config.hubTokenFile, 'gateway-root-key');
    await assert.rejects(readHubToken(config.hubTokenFile), /设备令牌/);
    const missing = await comfy.doctor({ hubUrl: URL }, { fetchImpl: () => assert.fail('must not connect') });
    assert.equal(missing.ready, false);
});

test('media:doctor reports actual Hub readiness without exposing token paths', async (t) => {
    const config = await settings(t);
    const fake = server();
    const result = await mediaDoctor({ media: { video: { provider: 'comfy-mcp', settings: config } } }, { task: 'video' }, fake);
    assert.equal(result.media.video.ready, true);
    assert.equal(result.media.video.version, 'MCP Hub / ComfyUI 0.41.0');
    assert.deepEqual(result.media.video.settings, { hubUrl: URL });
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(config.hubTokenFile));
});

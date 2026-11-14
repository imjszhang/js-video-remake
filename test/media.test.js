import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgv } from '../src/args.js';
import { execute } from '../cli/remake.js';
import { DEFAULT_PROVIDERS, resolveMediaConfig } from '../src/media/config.js';
import { downloadedVideo, run, tempWorkspace } from './helpers.js';

const WS = '/tmp/ws';

async function production(t) {
    const workspace = await tempWorkspace(t, { videos: { abcdefghijk: downloadedVideo() } });
    await run(['bind', 'abcdefghijk'], workspace.env);
    await run(['start', 'youtube-abcdefghijk', '--as', 'demo'], workspace.env);
    return workspace;
}

function fakeFetch(routes) {
    const calls = [];
    const impl = async (url, init = {}) => {
        const href = String(url);
        calls.push({ url: href, init });
        const route = routes[href];
        if (!route) throw new Error(`connect ECONNREFUSED ${href}`);
        const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
        return new Response(body, { status: route.status ?? 200 });
    };
    return { impl, calls };
}

test('media defaults to this project\'s providers', () => {
    const media = resolveMediaConfig({}, {}, WS);
    assert.deepEqual(Object.fromEntries(Object.entries(media).map(([task, entry]) => [task, entry.provider])), DEFAULT_PROVIDERS);
    assert.deepEqual(DEFAULT_PROVIDERS, { image: 'codex-image', video: 'comfy-mcp', transcribe: 'mlx-whisper', speech: 'macos-say' });
    assert.deepEqual(media.image.settings, {});
    assert.equal(media.transcribe.settings.model, 'whisper-large-v3');
});

test('media settings come from env first, then video-remake.json', () => {
    const media = resolveMediaConfig({
        image: { provider: 'openai-image', apiKeyFile: 'keys/image' },
        video: { url: 'http://file-host:8188' },
        transcribe: { transcriptionUrl: 'http://file-host/v1/audio/transcriptions', apiKeyFile: '~/key', language: 'en' },
    }, {
        COMFYUI_URL: 'http://env-host:8188',
        WHISPER_HEALTH_URL: 'http://env-host/health',
    }, WS);
    assert.equal(media.image.settings.apiKeyFile, path.join(WS, 'keys/image'));
    assert.equal(media.video.settings.url, 'http://env-host:8188/');
    assert.equal(media.transcribe.settings.healthUrl, 'http://env-host/health');
    assert.equal(media.transcribe.settings.transcriptionUrl, 'http://file-host/v1/audio/transcriptions');
    assert.equal(media.transcribe.settings.apiKeyFile, path.join(os.homedir(), 'key'));
    assert.equal(media.transcribe.settings.language, 'en');
});

test('media config rejects unknown providers, tasks and settings', () => {
    assert.throws(() => resolveMediaConfig({ image: { provider: 'midjourney' } }, {}, WS), /Unknown media\.image\.provider: midjourney/);
    assert.throws(() => resolveMediaConfig({}, { VIDEO_REMAKE_MEDIA_VIDEO: 'kling' }, WS), /Unknown media\.video\.provider: kling/);
    assert.throws(() => resolveMediaConfig({ audio: {} }, {}, WS), /Unknown media task: audio/);
    assert.throws(() => resolveMediaConfig({ video: { skillDir: '/x' } }, {}, WS), /media\.video\.skillDir is not a comfy-mcp setting/);
    assert.throws(() => resolveMediaConfig({ transcribe: { healthUrl: 'ftp://host/health' } }, {}, WS), /HTTP\(S\)/);
    assert.throws(() => resolveMediaConfig({ video: { url: 'http://user:pw@host' } }, {}, WS), /without credentials/);
});

test('media section in video-remake.json reaches the CLI and paths', async (t) => {
    const workspace = await tempWorkspace(t);
    const configPath = path.join(workspace.directory, 'video-remake.json');
    const file = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(configPath, JSON.stringify({ ...file, media: { image: { provider: 'nope' } } }));
    const bad = await execute(parseArgv(['paths']), workspace.env).catch((error) => error);
    assert.equal(bad.code, 'CONFIG_INVALID');
    await fs.writeFile(configPath, JSON.stringify({ ...file, media: { video: { url: 'http://comfy.test:8188' } } }));
    const result = await run(['paths'], workspace.env);
    assert.deepEqual(result.data.media, DEFAULT_PROVIDERS);
});

test('media:doctor probes each provider and hides local paths', async (t) => {
    const workspace = await tempWorkspace(t);
    const keyFile = path.join(workspace.directory, 'image-key');
    await fs.writeFile(keyFile, 'fixture-key');
    await fs.writeFile(path.join(workspace.directory, 'key'), 'whisper-secret\n');
    const env = {
        ...workspace.env,
        VIDEO_REMAKE_MEDIA_IMAGE: 'openai-image', OPENAI_IMAGE_API_KEY_FILE: keyFile,
        OPENAI_API_KEY: 'sk-test',
        COMFYUI_URL: 'http://comfy.test:8188',
        WHISPER_HEALTH_URL: 'http://whisper.test/health',
        WHISPER_TRANSCRIPTION_URL: 'http://whisper.test/v1/audio/transcriptions',
        WHISPER_API_KEY_FILE: path.join(workspace.directory, 'key'),
    };
    const fetch = fakeFetch({
        'http://comfy.test:8188/system_stats': { body: { system: { comfyui_version: '0.41.0' } } },
        'http://whisper.test/health': { body: { status: 'ok' } },
    });
    const result = await execute(parseArgv(['media:doctor']), env, { fetchImpl: fetch.impl });
    assert.equal(result.ok, true);
    assert.equal(result.data.media.image.ready, true);
    assert.equal(result.data.media.video.version, 'ComfyUI 0.41.0');
    assert.equal(result.data.media.video.agentOnly, true);
    assert.equal(result.data.media.transcribe.ready, true);
    const health = fetch.calls.find((call) => call.url === 'http://whisper.test/health');
    assert.equal(health.init.headers.Authorization, 'Bearer whisper-secret');
    const comfy = fetch.calls.find((call) => call.url === 'http://comfy.test:8188/system_stats');
    assert.equal(comfy.init.headers, undefined);
    assert.equal(result.data.media.image.guide, '.agents/skills/remake-media/providers/openai-image.md');
    assert.equal(result.data.media.image.settings.apiKeyFile, undefined);
    assert.equal(result.data.media.transcribe.settings.apiKeyFile, undefined);
    assert.equal(result.data.media.speech.ready, true);
    assert.equal(result.data.media.speech.provider, 'macos-say');
    assert.equal(result.data.media.speech.settings.apiKeyFile, undefined);
    assert.deepEqual(result.data.warnings, []);
    await fs.access(path.join(process.cwd(), result.data.media.video.guide));
    await fs.access(path.join(process.cwd(), result.data.media.transcribe.guide));

    const down = fakeFetch({});
    const all = await execute(parseArgv(['media:doctor']), env, { fetchImpl: down.impl });
    assert.equal(all.ok, true);
    assert.equal(all.data.warnings.length, 2);
    const scoped = await execute(parseArgv(['media:doctor', '--task', 'video']), env, { fetchImpl: down.impl }).catch((error) => error);
    assert.equal(scoped.code, 'DOCTOR_FAILED');
    assert.match(scoped.message, /ComfyUI 目标不可达/);
});

test('comfy-mcp doctor sends the gateway key when a key file is configured', async (t) => {
    const workspace = await tempWorkspace(t);
    const keyFile = path.join(workspace.directory, 'comfy-key');
    await fs.writeFile(keyFile, 'gateway-key\n');
    const env = {
        ...workspace.env,
        COMFYUI_URL: 'http://127.0.0.1:8888/services/comfyui/',
        COMFYUI_API_KEY_FILE: keyFile,
    };
    const fetch = fakeFetch({
        'http://127.0.0.1:8888/services/comfyui/system_stats': { body: { system: { comfyui_version: '0.41.0' } } },
    });
    const result = await execute(parseArgv(['media:doctor', '--task', 'video']), env, { fetchImpl: fetch.impl });
    assert.equal(result.ok, true);
    assert.equal(result.data.media.video.ready, true);
    assert.equal(result.data.media.video.version, 'ComfyUI 0.41.0');
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer gateway-key');
    assert.equal(result.data.media.video.settings.apiKeyFile, undefined);
});

test('media:transcribe posts verbose_json with the key and writes the transcript', async (t) => {
    const workspace = await production(t);
    const audio = path.join(workspace.directory, 'aud-demo-take1.wav');
    await fs.writeFile(audio, 'wav');
    const keyFile = path.join(workspace.directory, 'key');
    await fs.writeFile(keyFile, 'secret-key\nignored\n');
    const env = { ...workspace.env, WHISPER_TRANSCRIPTION_URL: 'http://whisper.test/v1/audio/transcriptions', WHISPER_API_KEY_FILE: keyFile };
    const transcript = { text: 'hi', segments: [{ start: 0, end: 1, text: 'hi' }] };
    const fetch = fakeFetch({ 'http://whisper.test/v1/audio/transcriptions': { body: transcript } });

    const result = await execute(parseArgv(['media:transcribe', 'demo', '--from', 'aud-demo-take1.wav', '--language', 'en']), env, { fetchImpl: fetch.impl });
    assert.equal(result.data.path, 'productions/demo/assets/aud-demo-take1.transcript.json');
    assert.equal(result.data.next, 'remake captions demo --from assets/aud-demo-take1.transcript.json');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace.directory, result.data.path), 'utf8')), transcript);
    const { init } = fetch.calls[0];
    assert.equal(init.headers.Authorization, 'Bearer secret-key');
    assert.equal(init.body.get('model'), 'whisper-large-v3');
    assert.equal(init.body.get('language'), 'en');
    assert.equal(init.body.get('response_format'), 'verbose_json');

    const again = await execute(parseArgv(['media:transcribe', 'demo', '--from', 'aud-demo-take1.wav']), env, { fetchImpl: fetch.impl }).catch((error) => error);
    assert.equal(again.code, 'ALREADY_EXISTS');
    const forced = await execute(parseArgv(['media:transcribe', 'demo', '--from', 'aud-demo-take1.wav', '--force']), env, { fetchImpl: fetch.impl });
    assert.equal(forced.ok, true);

    const badId = await execute(parseArgv(['media:transcribe', 'demo', '--from', 'aud-demo-take1.wav', '--id', 'Bad Id']), env, { fetchImpl: fetch.impl }).catch((error) => error);
    assert.equal(badId.code, 'INVALID_INPUT');
    const unconfigured = await execute(parseArgv(['media:transcribe', 'demo', '--from', 'aud-demo-take1.wav', '--id', 'aud-demo-x']), workspace.env).catch((error) => error);
    assert.equal(unconfigured.code, 'MEDIA_UNAVAILABLE');
    const broken = fakeFetch({ 'http://whisper.test/v1/audio/transcriptions': { body: { text: 'no segments' } } });
    const noSegments = await execute(parseArgv(['media:transcribe', 'demo', '--from', 'aud-demo-take1.wav', '--id', 'aud-demo-y']), env, { fetchImpl: broken.impl }).catch((error) => error);
    assert.equal(noSegments.code, 'MEDIA_FAILED');
});

test('media:image runs the configured provider and media:land records it', async (t) => {
    const workspace = await production(t);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=', 'base64');
    const produced = path.join(workspace.directory, 'out.png');
    await fs.writeFile(path.join(workspace.directory, 'reference.png'), png);
    const keyFile = path.join(workspace.directory, 'key');
    await fs.writeFile(keyFile, 'fixture-key');
    const env = { ...workspace.env, VIDEO_REMAKE_MEDIA_IMAGE: 'openai-image', OPENAI_IMAGE_API_KEY_FILE: keyFile };
    const fetchImpl = async (url, init) => {
        assert.match(url, /images\/edits$/);
        assert.equal(init.body.get('quality'), 'medium');
        assert.equal(init.body.getAll('image[]').length, 1);
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    };
    const image = await execute(parseArgv(['media:image', '--intent', '16:9 still', '--image', 'reference.png', '--image-quality', 'medium', '--out', 'out.png']), env, { fetchImpl });
    assert.equal(image.data.provider, 'openai-image.edit');
    assert.equal(image.data.path, produced);
    const badQuality = await execute(parseArgv(['media:image', '--intent', 'x', '--image-quality', 'ultra']), env, { fetchImpl }).catch(error => error);
    assert.equal(badQuality.code, 'INVALID_INPUT');

    const landed = await execute(parseArgv(['media:land', 'demo', '--kind', 'image', '--from', 'out.png', '--intent', '16:9 still', '--provider', image.data.provider]), env);
    assert.match(landed.data.id, /^img-demo-\d{8}-[0-9a-f]{4}$/);
    assert.match(landed.data.html, /src="\.\/assets\/image\//);
    const ledger = JSON.parse(await fs.readFile(path.join(workspace.directory, 'productions/demo/assets/ledger.json'), 'utf8'));
    assert.equal(ledger.items[0].provider, 'openai-image.edit');

    const unregistered = await execute(parseArgv(['media:land', 'ghost', '--kind', 'image', '--from', 'out.png', '--intent', 'x', '--provider', 'y']), env).catch((error) => error);
    assert.equal(unregistered.code, 'NOT_FOUND');
    const noKind = await execute(parseArgv(['media:land', 'demo', '--from', 'out.png', '--intent', 'x', '--provider', 'y']), env).catch((error) => error);
    assert.equal(noKind.code, 'INVALID_INPUT');
});

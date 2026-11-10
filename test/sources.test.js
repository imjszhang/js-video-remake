import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';
import { gatewayVideo } from '../src/sources/gateway-video.js';
import { resolveAssets } from '../src/sources/assets.js';
import { downloadedVideo, run, tempWorkspace, readState } from './helpers.js';

const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('gateway uses public HTTP contract and Bearer auth, forwards force and quality', async t => {
    const w = await tempWorkspace(t);
    const result = await run(['ingest', 'https://youtube.com/watch?v=abcdefghijk', '--force', '--quality', '720'], w.env);
    assert.equal(result.data.source.quality, '720');
    assert.equal(result.data.source.sha256.length, 64);
    assert.equal(result.data.source.provider.kind, 'gateway-video');
    const state = await readState(w.statePath);
    assert.deepEqual(state.calls[0][2], { url: 'https://youtube.com/watch?v=abcdefghijk', quality: '720', force: true });
    assert.equal(state.calls.filter(c => c[0] === 'add').length, 1);
});

test('gateway rejects missing write credentials before enqueue', async t => {
    const w = await tempWorkspace(t);
    delete w.env.VIDEO_REMAKE_SOURCE_TOKEN;
    await assert.rejects(run(['ingest', 'https://youtube.com/watch?v=abcdefghijk'], w.env), { code: 'SOURCE_AUTH' });
    assert.equal((await readState(w.statePath)).calls.length, 0);
});

test('gateway maps errors, rejects malformed entries, and times out', async t => {
    const w = await tempWorkspace(t);
    const config = resolveConfig({}, w.env, w.directory);
    for (const [status, code] of [[401, 'SOURCE_AUTH'], [404, 'NOT_FOUND'], [503, 'SOURCE_HTTP']]) {
        const provider = gatewayVideo(config, { fetchImpl: async () => response({}, status) });
        await assert.rejects(provider.get('demo'), { code });
    }
    for (const body of [{ status: 'error' }, { status: 'ok', video: downloadedVideo({ status: 'unexpected' }) }, { status: 'ok', video: downloadedVideo() }]) {
        await assert.rejects(gatewayVideo(config, { fetchImpl: async () => response(body) }).get('demo'), { code: 'SOURCE_PROTOCOL' });
    }
    await assert.rejects(gatewayVideo(config, { fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }).health(), { code: 'SOURCE_TIMEOUT' });
    await assert.rejects(gatewayVideo(config, { fetchImpl: async () => new Response('not json') }).health(), { code: 'SOURCE_PROTOCOL' });
});

test('ingest timeout polls without resubmitting or running a worker', async t => {
    const w = await tempWorkspace(t);
    // Replace queue auto-completion after POST through the HTTP fixture's state.
    const state = await readState(w.statePath);
    state.keepQueued = true;
    await fs.writeFile(w.statePath, JSON.stringify(state));
    await assert.rejects(run(['ingest', 'https://youtube.com/watch?v=abcdefghijk', '--wait-timeout-ms', '30'], w.env), { code: 'INGEST_TIMEOUT' });
    const final = await readState(w.statePath);
    assert.equal(final.calls.filter(c => c[0] === 'add').length, 1);
    assert.ok(final.calls.some(c => c[0] === 'get'));
});

test('failed download exits without binding', async t => {
    const w = await tempWorkspace(t);
    const state = await readState(w.statePath);
    state.failDownload = true;
    await fs.writeFile(w.statePath, JSON.stringify(state));
    await assert.rejects(run(['ingest', 'https://youtube.com/watch?v=abcdefghijk'], w.env), { code: 'SOURCE_FAILED' });
    const catalog = JSON.parse(await fs.readFile(path.join(w.directory, 'catalog.json')));
    assert.equal(catalog.references.length, 0);
});

test('manifest binds without any HTTP service and rejects URL ingestion', async t => {
    const w = await tempWorkspace(t);
    await fs.writeFile(path.join(w.libraryDir, 'local.mp4'), 'media');
    await fs.writeFile(path.join(w.directory, 'sources.json'), JSON.stringify({ schema: 'video-remake.source-list@1', items: [{ video: downloadedVideo(), files: { video: 'local.mp4' } }] }));
    w.env.VIDEO_REMAKE_SOURCE_PROVIDER = 'manifest';
    const result = await run(['bind', 'abcdefghijk'], w.env);
    assert.equal(result.data.source.relVideo, 'local.mp4');
    assert.equal(result.data.source.provider.kind, 'manifest');
    await assert.rejects(run(['ingest', 'https://example.com/video'], w.env), { code: 'SOURCE_UNSUPPORTED' });
    assert.equal((await readState(w.statePath)).calls.length, 0);
});

test('asset resolution rejects traversal, absolute paths, escaping symlinks and missing media', async t => {
    const w = await tempWorkspace(t);
    const config = { assetRoot: w.libraryDir };
    for (const video of ['../package.json', path.join(w.directory, 'package.json')]) {
        await assert.rejects(resolveAssets(config, downloadedVideo(), { video }), error => ['ASSET_OUTSIDE_ROOT', 'SOURCE_ASSET_INVALID'].includes(error.code));
    }
    await fs.symlink(path.join(w.directory, 'package.json'), path.join(w.libraryDir, 'escape.mp4'));
    await assert.rejects(resolveAssets(config, downloadedVideo(), { video: 'escape.mp4' }), { code: 'ASSET_OUTSIDE_ROOT' });
    await assert.rejects(resolveAssets(config, downloadedVideo(), { video: 'missing.mp4' }), { code: 'SOURCE_ASSET_MISSING' });
});

test('source configuration validates URLs and timeouts; defaults have no archive project dependency', async t => {
    const w = await tempWorkspace(t);
    await fs.unlink(path.join(w.directory, 'video-remake.json'));
    const config = resolveConfig({}, { VIDEO_REMAKE_WORKSPACE: w.directory, YT_ARCHIVE_HOME: '/ignored' });
    assert.equal(config.assetRoot, path.join(w.directory, 'assets/source'));
    assert.equal(config.source.provider, 'local');
    assert.equal(config.archiveCli, undefined);
    for (const overrides of [{ sourceUrl: 'file:///tmp/a' }, { sourceUrl: 'http://user:secret@localhost/' }, { pollIntervalMs: 0 }, { sourceProvider: 'unknown' }]) {
        assert.throws(() => resolveConfig({ workspace: w.directory, ...overrides }, {}), { code: 'CONFIG_INVALID' });
    }
});

test('token JSON file supports existing credentials and environment override', async t => {
    const w = await tempWorkspace(t);
    const config = resolveConfig({}, w.env, w.directory);
    const tokenFile = path.join(w.directory, 'token.json');
    await fs.writeFile(tokenFile, JSON.stringify({ key: 'file-token' }));
    config.source.tokenFile = tokenFile;
    config.source.tokenJsonKey = 'key';
    for (const [env, expected] of [[{}, 'file-token'], [{ VIDEO_REMAKE_SOURCE_TOKEN: 'env-token' }, 'env-token']]) {
        config.env = env;
        const provider = gatewayVideo(config, { fetchImpl: async (_, options) => {
            assert.equal(options.headers.Authorization, `Bearer ${expected}`);
            assert.equal(options.redirect, 'error');
            return response({ status: 'ok', video: downloadedVideo() });
        } });
        await provider.enqueue({ url: 'https://example.com', quality: '1080', force: false });
    }
});

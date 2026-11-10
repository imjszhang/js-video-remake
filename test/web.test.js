import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { readWebLibrary } from '../src/web-library.js';
import { createWebServer, parseByteRange } from '../src/web-server.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-web-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const write = async (file, data) => {
        const target = path.join(root, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
    };
    const catalog = {
        references: [{ id: 'youtube-source', dir: 'references/youtube-source' }],
        productions: [
            { slug: 'series', title: '测试系列', status: 'picture-review', referenceIds: ['youtube-source'], drafts: { version: 'v1', dir: 'productions/series/drafts/v1', manifest: 'MANIFEST.json' } },
            { slug: 'delivered', status: 'delivered', deliverable: { version: 'v2', dir: 'deliverables/delivered/v2', file: 'film.mp4' }, comparison: { version: 'v3', dir: 'productions/delivered/drafts/comparisons/v3', file: 'comparison.mp4' } },
            { slug: 'empty', status: 'commissioned' },
        ],
    };
    const source = {
        canonicalUrl: 'https://www.youtube.com/shorts/source', title: 'Original source', durationSec: 13,
        relVideo: 'videos/source/video.mp4', relThumb: 'videos/source/thumb.jpg',
        assetRoot: '/private', videoPath: '/private/original.mp4', thumbPath: '/private/thumb.jpg',
    };
    await Promise.all([
        write('catalog.json', catalog),
        write('video-remake.json', { assetRoot: path.join(root, 'archive') }),
        write('references/youtube-source/SOURCE.json', source),
        write('archive/videos/source/video.mp4', 'original-0123456789'),
        write('archive/videos/source/thumb.jpg', 'source-poster'),
        write('productions/series/drafts/v1/MANIFEST.json', { audio: 'none', language: 'en', renders: [{ episode: 1, title: 'First', file: 'clip.mp4', duration: 12, width: 1920, height: 1080, bytes: 9000 }] }),
        write('productions/series/drafts/v1/clip.mp4', '0123456789'),
        write('productions/series/drafts/v1/01-poster.jpg', 'poster'),
        write('productions/series/drafts/v1/review/01-contact-sheet.jpg', 'sheet'),
        write('productions/series/assets/unpublished.mp4', 'private'),
        write('deliverables/delivered/v2/film.mp4', 'delivery'),
        write('deliverables/delivered/v2/MANIFEST.json', { title: 'Delivery title', cover: 'cover.png' }),
        write('deliverables/delivered/v2/cover.png', 'cover'),
        write('deliverables/delivered/v2/REVIEW.json', { exportProbe: { streams: [{ codec_type: 'video', width: 1280, height: 720 }, { codec_type: 'audio' }], format: { duration: '21.5' } } }),
        write('productions/delivered/drafts/comparisons/v3/comparison.mp4', 'comparison'),
        write('productions/delivered/drafts/comparisons/v3/MANIFEST.json', { verification: { width: 1080, height: 1920, duration: 15, audioStreams: 0 }, inputs: { top: { path: '/private/remake.mp4' } } }),
        write('web/index.html', '<script src="app.js" defer></script><link rel="stylesheet" href="style.css">'),
        write('web/app.js', 'fetch("api/projects")'),
        write('web/comparison.js', 'export function compare() {}'),
        write('web/versions.js', 'export function versions() {}'),
        write('web/workspace.js', 'export function workspaceForProject() {}'),
        write('web/style.css', 'body { color: white; }'),
    ]);
    return { root, write, catalog, source };
}

async function serve(t, root) {
    const server = createWebServer({ root });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test('library exposes only published outputs, reads metadata, and keeps unfinished projects', async (t) => {
    const f = await fixture(t);
    const { projects, warnings, media } = await readWebLibrary(f.root);
    assert.equal(projects.length, 3);
    assert.deepEqual(warnings, []);
    assert.equal(projects.find((project) => project.slug === 'empty').videos.length, 0);
    const draft = projects.find((project) => project.slug === 'series').videos[0];
    assert.equal(draft.title, 'First');
    assert.equal(draft.audio, 'none');
    assert.equal(draft.language, 'en');
    assert.equal(draft.bytes, 10, 'disk bytes take precedence over stale manifest metadata');
    assert.equal(draft.duration, 12);
    assert.equal(draft.width, 1920);
    assert.equal(draft.height, 1080);
    assert.equal(draft.referenceUrl, 'https://www.youtube.com/shorts/source');
    assert.equal(draft.reference.id, 'youtube-source');
    assert.equal(draft.reference.title, 'Original source');
    assert.equal(draft.reference.duration, 13);
    assert.equal(draft.reference.audio, 'unknown');
    assert.equal(draft.reference.bytes, 19);
    assert.match(draft.reference.url, /^media\/[a-f0-9]{32}$/);
    assert.match(draft.reference.poster, /^media\/[a-f0-9]{32}$/);
    assert.equal(draft.reference.sourceUrl, draft.referenceUrl);
    assert.match(draft.url, /^media\/[a-f0-9]{32}$/);
    assert.match(draft.poster, /^media\//);
    assert.match(draft.contactSheet, /^media\//);
    const delivered = projects.find((project) => project.slug === 'delivered').videos;
    assert.equal(delivered[0].title, 'Delivery title');
    assert.equal(delivered[0].audio, 'present');
    assert.equal(delivered[0].duration, 21.5);
    assert.equal(delivered[0].width, 1280);
    assert.equal(delivered[1].kind, 'comparison');
    assert.equal(delivered[1].audio, 'none');
    assert.equal(media.size, 8);
    assert.ok(!JSON.stringify(projects).includes('/private/'));
    assert.ok(!JSON.stringify(projects).includes(f.root));
});

test('library rejects output traversal and symlink escapes', async (t) => {
    const f = await fixture(t);
    await fs.symlink(path.join(f.root, 'productions/series/assets/unpublished.mp4'), path.join(f.root, 'productions/series/drafts/v1/escaped.mp4'));
    await f.write('productions/series/drafts/v1/MANIFEST.json', { renders: [
        { file: '../../assets/unpublished.mp4' },
        { file: 'escaped.mp4' },
        { file: '/private/original.mp4' },
        { file: 'clip.mp4', poster: '../../../../catalog.json' },
    ] });
    f.catalog.productions[1].deliverable.dir = 'productions/series/assets';
    await f.write('catalog.json', f.catalog);
    const { projects, warnings, media } = await readWebLibrary(f.root);
    const series = projects.find((project) => project.slug === 'series');
    assert.equal(series.videos.length, 1);
    assert.equal(series.videos[0].width, null);
    assert.equal(series.videos[0].height, null);
    assert.equal(series.videos[0].duration, null);
    assert.equal(series.videos[0].audio, 'unknown');
    assert.equal(warnings.length, 4);
    assert.ok([...media.values()].every((asset) => !asset.path.includes('/assets/')));
});

test('draft versions retain six original drafts and expose only the one published pilot', async (t) => {
    const f = await fixture(t);
    const oldDraft = f.catalog.productions[0].drafts;
    f.catalog.productions[0].drafts = { ...oldDraft, activeVersion: 'v2', versions: [
        oldDraft,
        { version: 'v2', label: '首条校准样片', dir: 'productions/series/drafts/v2' },
        { version: 'v3', dir: 'productions/series/drafts/v3' },
    ] };
    const renders = [];
    for (let episode = 1; episode <= 6; episode += 1) {
        const file = `clip-${episode}.mp4`;
        await f.write(`productions/series/drafts/v1/${file}`, `v1 episode ${episode}`);
        renders.push({ episode, title: `Episode ${episode}`, file });
    }
    await Promise.all([
        f.write('catalog.json', f.catalog),
        f.write('productions/series/drafts/v1/MANIFEST.json', { renders, audio: 'none' }),
        f.write('productions/series/drafts/v2/MANIFEST.json', { audio: 'present', renders: [{ episode: 1, file: 'pilot.mp4', title: '校准样片', referenceId: 'youtube-source', audioStreams: 1 }] }),
        f.write('productions/series/drafts/v2/pilot.mp4', 'v2 pilot'),
        f.write('productions/series/drafts/v2/not-published.mp4', 'future episode'),
        f.write('productions/series/drafts/v3/MANIFEST.json', { renders: [] }),
    ]);
    const { projects, warnings, media } = await readWebLibrary(f.root);
    const project = projects.find((item) => item.slug === 'series');
    assert.deepEqual(warnings, []);
    assert.equal(project.videos.length, 7, 'duplicate legacy v1 descriptor is read only once');
    assert.deepEqual(project.draftVersions, [
        { version: 'v1', label: null, videoCount: 6, forkedFrom: null, importedAt: null, frozen: false, renderVerified: null, note: null },
        { version: 'v2', label: '首条校准样片', videoCount: 1, forkedFrom: null, importedAt: null, frozen: false, renderVerified: null, note: null },
    ]);
    assert.equal(project.defaultDraftVersion, 'v2');
    const pilot = project.videos.find((video) => video.version === 'v2');
    const first = project.videos.find((video) => video.version === 'v1' && video.episode === 1);
    assert.notEqual(pilot.url, first.url);
    assert.equal(pilot.reference.url, first.reference.url, 'both versions compare with the same original');
    assert.equal(pilot.audio, 'present', 'pilot metadata is not inherited from silent v1');
    assert.ok(![...media.values()].some((asset) => asset.name === 'not-published.mp4'));
    const base = await serve(t, f.root);
    assert.equal(await (await fetch(`${base}/${first.url}`)).text(), 'v1 episode 1');
    assert.equal(await (await fetch(`${base}/${pilot.url}`)).text(), 'v2 pilot');
});

test('invalid or empty draft revisions do not become selectable or change the default', async (t) => {
    const f = await fixture(t);
    f.catalog.productions[0].drafts.activeVersion = 'v2';
    f.catalog.productions[0].drafts.versions = [
        { version: 'v2', dir: 'productions/series/drafts/v2' },
        { version: 'escape', dir: 'productions/series/assets' },
    ];
    await Promise.all([
        f.write('catalog.json', f.catalog),
        f.write('productions/series/drafts/v2/MANIFEST.json', { renders: [{ file: 'missing.mp4' }] }),
    ]);
    const { projects, warnings } = await readWebLibrary(f.root);
    const project = projects.find((item) => item.slug === 'series');
    assert.deepEqual(project.draftVersions, [{ version: 'v1', label: null, videoCount: 1, forkedFrom: null, importedAt: null, frozen: false, renderVerified: null, note: null }]);
    assert.equal(project.defaultDraftVersion, 'v1');
    assert.equal(warnings.length, 2);
});

test('original playback requires catalog authority and archive containment; project attachment still requires binding', async (t) => {
    const f = await fixture(t);
    await f.write('archive/videos/unbound/video.mp4', 'unbound');
    await f.write('references/youtube-unbound/SOURCE.json', { relVideo: 'videos/unbound/video.mp4' });
    f.catalog.references.push({ id: 'youtube-unbound' });
    await f.write('catalog.json', f.catalog);
    await fs.symlink(path.join(f.root, 'productions/series/assets/unpublished.mp4'), path.join(f.root, 'archive/escape.mp4'));
    for (const relVideo of ['../productions/series/assets/unpublished.mp4', path.join(f.root, 'productions/series/assets/unpublished.mp4'), 'escape.mp4', 'missing.mp4']) {
        await f.write('references/youtube-source/SOURCE.json', { ...f.source, relVideo });
        const { projects, media } = await readWebLibrary(f.root);
        const draft = projects.find((project) => project.slug === 'series').videos[0];
        assert.equal(draft.reference, null, relVideo);
        assert.equal(draft.referenceUrl, f.source.canonicalUrl);
        assert.deepEqual([...media.values()].filter(asset => asset.path.includes('/archive/')).map(asset => path.basename(path.dirname(asset.path))), ['unbound'], relVideo);
    }
    await f.write('references/youtube-source/SOURCE.json', f.source);
    await f.write('productions/series/drafts/v1/MANIFEST.json', { renders: [{ file: 'clip.mp4', referenceId: 'youtube-unbound' }] });
    const unbound = await readWebLibrary(f.root);
    assert.equal(unbound.projects.find((project) => project.slug === 'series').videos[0].reference, null);
    assert.ok(unbound.referenceMedia.some(item => item.id === 'youtube-unbound')); // 可独立播放，但不能冒充制作绑定原片。
    f.catalog.references = [];
    await f.write('catalog.json', f.catalog);
    await f.write('productions/series/drafts/v1/MANIFEST.json', { renders: [{ file: 'clip.mp4', referenceId: 'youtube-source' }] });
    assert.equal((await readWebLibrary(f.root)).projects.find((project) => project.slug === 'series').videos[0].reference, null);
});

test('original selection follows episode order, supports bound overrides and one-source projects', async (t) => {
    const f = await fixture(t);
    f.catalog.references.push({ id: 'youtube-second' });
    f.catalog.productions[0].referenceIds.push('youtube-second');
    await Promise.all([
        f.write('catalog.json', f.catalog),
        f.write('references/youtube-second/SOURCE.json', { ...f.source, title: 'Second', relVideo: 'videos/second/video.mp4' }),
        f.write('archive/videos/second/video.mp4', 'second'),
        f.write('productions/series/drafts/v1/MANIFEST.json', { renders: [
            { file: 'clip.mp4', episode: 2 }, { file: 'clip.mp4', episode: 1, referenceId: 'youtube-second' }, { file: 'clip.mp4', episode: 3 },
        ] }),
    ]);
    const videos = (await readWebLibrary(f.root)).projects.find((project) => project.slug === 'series').videos;
    assert.deepEqual(videos.map((video) => video.reference?.id ?? null), ['youtube-second', 'youtube-second', null]);
    f.catalog.productions[0].referenceIds = ['youtube-source'];
    await f.write('catalog.json', f.catalog);
    assert.equal((await readWebLibrary(f.root)).projects.find((project) => project.slug === 'series').videos[2].reference.id, 'youtube-source');
});

test('reference metadata symlinks and thumbnail traversal cannot expand the original allowlist', async (t) => {
    const f = await fixture(t);
    const sourcePath = path.join(f.root, 'references/youtube-source/SOURCE.json');
    await f.write('outside-SOURCE.json', f.source);
    await fs.unlink(sourcePath);
    await fs.symlink(path.join(f.root, 'outside-SOURCE.json'), sourcePath);
    const denied = await readWebLibrary(f.root);
    assert.equal(denied.projects.find((project) => project.slug === 'series').videos[0].reference, null);
    assert.ok([...denied.media.values()].every((asset) => !asset.path.includes('/archive/')));
    await fs.unlink(sourcePath);
    await f.write('private.jpg', 'private image');
    await f.write('references/youtube-source/SOURCE.json', { ...f.source, relThumb: '../private.jpg' });
    const safe = await readWebLibrary(f.root);
    const reference = safe.projects.find((project) => project.slug === 'series').videos[0].reference;
    assert.ok(reference.url);
    assert.equal(reference.poster, null);
    assert.ok([...safe.media.values()].every((asset) => path.basename(asset.path) !== 'private.jpg'));
});

test('source metadata uses matching analysis while explicit archive config overrides SOURCE paths', async (t) => {
    const f = await fixture(t);
    const original = path.join(f.root, 'archive/videos/source/video.mp4');
    await Promise.all([
        f.write('productions/series/EPISODES.json', [{ episode: 1, slug: 'first', referenceId: 'youtube-source', duration: 13.2, width: 640, height: 360 }]),
        f.write('productions/series/episodes/01-first/analysis/probe.json', { format: { filename: original, duration: '13.25' }, streams: [{ codec_type: 'video', width: 1280, height: 720 }, { codec_type: 'audio' }] }),
    ]);
    let reference = (await readWebLibrary(f.root)).projects.find((project) => project.slug === 'series').videos[0].reference;
    assert.equal(reference.duration, 13.25);
    assert.equal(reference.width, 1280);
    assert.equal(reference.height, 720);
    assert.equal(reference.audio, 'present');
    await f.write('alternate/videos/source/video.mp4', 'alternate');
    const library = await readWebLibrary(f.root, { env: { REMAKE_ASSET_ROOT: path.join(f.root, 'alternate') } });
    reference = library.projects.find((project) => project.slug === 'series').videos[0].reference;
    assert.equal(reference.bytes, 9);
    assert.equal(reference.audio, 'unknown', 'probe for another physical file is ignored');
    assert.equal(reference.poster, null);
    const expectedPath = await fs.realpath(path.join(f.root, 'alternate/videos/source/video.mp4'));
    assert.ok([...library.media.values()].some((asset) => asset.path === expectedPath));
});

test('byte range parsing handles seek, suffix, overflow, and invalid/multipart ranges', () => {
    assert.equal(parseByteRange(undefined, 10), null);
    assert.deepEqual(parseByteRange('bytes=2-5', 10), { start: 2, end: 5 });
    assert.deepEqual(parseByteRange('bytes=8-', 10), { start: 8, end: 9 });
    assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
    assert.deepEqual(parseByteRange('bytes=-30', 10), { start: 0, end: 9 });
    assert.deepEqual(parseByteRange('bytes=2-99', 10), { start: 2, end: 9 });
    for (const value of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,5-6', 'bytes=9007199254740992-', 'cats=1-3']) assert.equal(parseByteRange(value, 10), false);
    assert.equal(parseByteRange('bytes=0-', 0), false);
});

test('HTTP serves full/ranged media, HEAD, downloads and safe API without arbitrary files', async (t) => {
    const f = await fixture(t);
    const base = await serve(t, f.root);
    const response = await fetch(`${base}/api/projects`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['projects', 'warnings']);
    const clip = body.projects.find((project) => project.slug === 'series').videos[0];
    const url = `${base}/${clip.url}`;
    const original = await fetch(`${base}/${clip.reference.url}`, { headers: { Range: 'bytes=9-12' } });
    assert.equal(original.status, 206);
    assert.equal(original.headers.get('content-range'), 'bytes 9-12/19');
    assert.equal(await original.text(), '0123');
    const full = await fetch(url);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(await full.text(), '0123456789');
    const range = await fetch(url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(range.headers.get('content-length'), '4');
    assert.equal(await range.text(), '2345');
    const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
    assert.equal(await suffix.text(), '789');
    const invalid = await fetch(url, { headers: { Range: 'bytes=99-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */10');
    const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '4');
    assert.equal(await head.text(), '');
    const download = await fetch(`${url}?download=1`);
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="clip.mp4"/);
    await download.arrayBuffer();
    const changed = await fetch(url, { headers: { Range: 'bytes=2-5', 'If-Range': '"different"' } });
    assert.equal(changed.status, 200);
    await changed.arrayBuffer();
    for (const route of ['/catalog.json', '/references/youtube-source/SOURCE.json', '/archive/videos/source/video.mp4', '/productions/series/assets/unpublished.mp4', '/media/../../catalog.json', `/media/${'0'.repeat(32)}`]) {
        const denied = await fetch(`${base}${route}`);
        assert.equal(denied.status, 404, route);
    }
    assert.equal((await fetch(`${base}/api/projects`, { method: 'POST' })).status, 405);
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, service: 'video-remake' });
});

test('removed or replaced originals stop streaming without affecting their remake', async (t) => {
    const f = await fixture(t);
    const base = await serve(t, f.root);
    const projects = (await (await fetch(`${base}/api/projects`)).json()).projects;
    const clip = projects.find((project) => project.slug === 'series').videos[0];
    const sourcePath = path.join(f.root, 'archive/videos/source/video.mp4');
    await fs.unlink(sourcePath);
    assert.equal((await fetch(`${base}/${clip.reference.url}`)).status, 404);
    await fs.symlink(path.join(f.root, 'productions/series/assets/unpublished.mp4'), sourcePath);
    assert.equal((await fetch(`${base}/${clip.reference.url}`)).status, 404);
    assert.equal((await fetch(`${base}/${clip.url}`)).status, 200);
});

test('catalog changes are reflected without a server restart', async (t) => {
    const f = await fixture(t);
    const base = await serve(t, f.root);
    const first = await (await fetch(`${base}/api/projects`)).json();
    const oldMedia = first.projects.find((project) => project.slug === 'series').videos[0].url;
    f.catalog.productions = f.catalog.productions.filter((entry) => entry.slug !== 'series');
    await f.write('catalog.json', f.catalog);
    const second = await (await fetch(`${base}/api/projects`)).json();
    assert.equal(second.projects.length, 2);
    assert.equal((await fetch(`${base}/${oldMedia}`)).status, 404);
});

test('relative static and API URLs remain usable behind a stripped /remake/ mount', async (t) => {
    const f = await fixture(t);
    const base = await serve(t, f.root);
    const proxy = http.createServer((request, response) => {
        const upstream = http.request(`${base}${request.url.replace(/^\/remake/, '')}`, { method: request.method, headers: request.headers }, (result) => {
            response.writeHead(result.statusCode, result.headers);
            result.pipe(response);
        });
        upstream.on('error', () => response.destroy());
        request.pipe(upstream);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    t.after(async () => { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); });
    const mounted = `http://127.0.0.1:${proxy.address().port}/remake/`;
    const html = await (await fetch(mounted)).text();
    assert.match(html, /src="app.js"/);
    assert.equal((await fetch(new URL('app.js', mounted))).status, 200);
    assert.equal((await fetch(new URL('comparison.js', mounted))).status, 200);
    assert.equal((await fetch(new URL('versions.js', mounted))).status, 200);
    const workspace = await fetch(new URL('workspace.js', mounted));
    assert.equal(workspace.status, 200);
    assert.match(workspace.headers.get('content-type'), /^text\/javascript/);
    assert.match(await workspace.text(), /export function workspaceForProject/);
    const api = await (await fetch(new URL('api/projects', mounted))).json();
    const clip = api.projects.find((project) => project.slug === 'series').videos[0];
    const response = await fetch(new URL(clip.url, mounted), { headers: { Range: 'bytes=4-6' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '456');
    const original = await fetch(new URL(clip.reference.url, mounted), { headers: { Range: 'bytes=9-12' } });
    assert.equal(original.status, 206);
    assert.equal(await original.text(), '0123');
});

test('cancelled media streaming does not crash the server or prevent later seeks', async (t) => {
    const f = await fixture(t);
    await f.write('productions/series/drafts/v1/clip.mp4', Buffer.alloc(8 * 1024 * 1024, 7));
    const base = await serve(t, f.root);
    const api = await (await fetch(`${base}/api/projects`)).json();
    const clip = api.projects.find((project) => project.slug === 'series').videos[0];
    await new Promise((resolve, reject) => {
        const request = http.get(`${base}/${clip.url}`, (response) => {
            response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
        });
        request.on('error', reject);
    });
    const result = await fetch(`${base}/${clip.url}`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(result.status, 206);
    assert.equal((await result.arrayBuffer()).byteLength, 100);
});

test('missing catalog is an empty library without creating files; invalid catalogs still fail', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-empty-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.deepEqual((await readWebLibrary(root)).projects, []);
    await assert.rejects(fs.stat(path.join(root, 'catalog.json')), { code: 'ENOENT' });
    await fs.writeFile(path.join(root, 'catalog.json'), '{"productions":[]}');
    assert.deepEqual((await readWebLibrary(root)).projects, []);
    await fs.writeFile(path.join(root, 'catalog.json'), 'broken');
    await assert.rejects(readWebLibrary(root));
});

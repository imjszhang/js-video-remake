import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importReference, listReferences, readReferenceCatalog } from '../src/references.js';
import { localSource } from '../src/sources/local.js';

async function fixture(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-references-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const assetRoot = path.join(workspace, 'source-files');
    await fs.mkdir(assetRoot);
    return { workspace, catalogPath: path.join(workspace, 'catalog.json'), assetRoot, source: { provider: 'local' }, quality: '1080' };
}
async function media(config, name = 'video.mp4', data = 'video fixture') {
    const file = path.join(config.assetRoot, name);
    await fs.writeFile(file, data);
    return file;
}
async function manifest(config, items) {
    const file = path.join(config.workspace, 'sources.json');
    await fs.writeFile(file, JSON.stringify({ schema: 'video-remake.source-list@1', items }));
    return file;
}
function entry(id, file = 'video.mp4') {
    return { video: { videoId: id, platform: 'example', status: 'downloaded', title: `标题 ${id}` }, files: { video: file } };
}

test('local reference listing and source health are read-only when the catalog is absent', async t => {
    const config = await fixture(t);
    assert.deepEqual(await listReferences(config), { command: 'reference:list', references: [] });
    assert.equal((await localSource(config).health()).total, 0);
    await assert.rejects(fs.access(config.catalogPath), { code: 'ENOENT' });
    await assert.rejects(localSource(config).enqueue({ url: 'https://example.com/video' }), { code: 'SOURCE_UNSUPPORTED' });
});

test('local import snapshots a pointer without copying and preserves identity and production links', async t => {
    const config = await fixture(t);
    const file = await media(config);
    const first = await importReference(config, { file, title: '原片' });
    assert.match(first.references[0].id, /^local-[a-f0-9]{64}$/);
    assert.equal(first.references[0].localFile, await fs.realpath(file));
    const dir = path.join(config.workspace, first.references[0].dir);
    assert.deepEqual(await fs.readdir(dir), ['SOURCE.json']);
    const catalog = await readReferenceCatalog(config);
    catalog.references[0].status = 'understanding';
    catalog.productions.push({ slug: 'example-remake', referenceIds: [first.references[0].id] });
    await fs.writeFile(config.catalogPath, JSON.stringify(catalog));
    await importReference(config, { file, title: '新标题' });
    const listed = (await listReferences(config)).references;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'understanding');
    assert.equal(listed[0].title, '新标题');
    assert.equal(listed[0].available, true);
    assert.deepEqual(listed[0].productions, ['example-remake']);
    const provider = localSource({ ...config, assetRoot: '/unavailable/gateway-root' });
    const video = await provider.get(first.references[0].id);
    const resolved = await provider.resolveAssets(video);
    assert.equal(resolved.video.videoPath, await fs.realpath(file));
    assert.equal(resolved.assetRoot, await fs.realpath(config.assetRoot));
    assert.equal(resolved.sourceProvider.kind, 'local');
});

test('explicit local id cannot overwrite a different file and invalid ids write nothing', async t => {
    const config = await fixture(t);
    const file = await media(config);
    await assert.rejects(importReference(config, { file, id: '../escape' }), { code: 'INVALID_INPUT' });
    await assert.rejects(fs.access(config.catalogPath), { code: 'ENOENT' });
    await importReference(config, { file, id: 'chosen' });
    const other = await media(config, 'other.mp4', 'different file');
    await assert.rejects(importReference(config, { file: other, id: 'chosen' }), { code: 'REFERENCE_CONFLICT' });
    assert.equal((await listReferences(config)).references[0].videoPath, await fs.realpath(file));
});

test('manifest batches are validated before writing and keep metadata and relative-root semantics', async t => {
    const config = await fixture(t);
    await media(config);
    const file = await manifest(config, [entry('one'), entry('two', '../outside.mp4')]);
    await assert.rejects(importReference(config, { manifest: file }), { code: 'ASSET_OUTSIDE_ROOT' });
    await assert.rejects(fs.access(config.catalogPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(config.workspace, 'references')), { code: 'ENOENT' });
    await manifest(config, [entry('one'), entry('two')]);
    const result = await importReference(config, { manifest: 'sources.json' });
    assert.equal(result.count, 2);
    assert.deepEqual(result.references.map(item => item.id), ['example-one', 'example-two']);
    assert.equal(result.references[0].localFile, await fs.realpath(path.join(config.assetRoot, 'video.mp4')));
    const listed = await listReferences(config);
    assert.equal(listed.references[0].title, '标题 one');
    assert.equal(listed.references[0].provider, 'manifest');
});

test('manifest rejects duplicate IDs, unfinished downloads and symlink escapes without registering references', async t => {
    const config = await fixture(t);
    await media(config);
    const file = await manifest(config, [entry('one'), entry('one')]);
    await assert.rejects(importReference(config, { manifest: file }), { code: 'SOURCE_PROTOCOL' });
    const pending = entry('one'); pending.video.status = 'queued';
    await manifest(config, [pending]);
    await assert.rejects(importReference(config, { manifest: file }), { code: 'NOT_DOWNLOADED' });
    const outside = path.join(config.workspace, 'outside.mp4');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(config.assetRoot, 'link.mp4'));
    await manifest(config, [entry('one', 'link.mp4')]);
    await assert.rejects(importReference(config, { manifest: file }), { code: 'ASSET_OUTSIDE_ROOT' });
    assert.equal((await readReferenceCatalog(config)).references.length, 0);
});

test('legacy gateway snapshots remain usable offline and a missing original is listed with its links', async t => {
    const config = await fixture(t);
    const file = await media(config);
    const imported = await importReference(config, { file, id: 'legacy' });
    const snapshot = path.join(config.workspace, imported.references[0].dir, 'SOURCE.json');
    const source = JSON.parse(await fs.readFile(snapshot));
    source.provider = { kind: 'gateway-video', location: 'https://invalid.example/api/' };
    await fs.writeFile(snapshot, JSON.stringify(source));
    const provider = localSource(config);
    const resolved = await provider.resolveAssets(await provider.get('legacy'));
    assert.equal(resolved.sourceProvider.kind, 'gateway-video');
    assert.equal(resolved.video.videoPath, await fs.realpath(file));
    await fs.unlink(file);
    const listed = (await listReferences(config)).references[0];
    assert.equal(listed.available, false);
    assert.match(listed.availabilityError, /原片/);
    assert.equal(listed.provider, 'gateway-video');
});

test('missing SOURCE is surfaced per entry and snapshot directory symlinks cannot receive imports', async t => {
    const config = await fixture(t);
    const file = await media(config);
    const result = await importReference(config, { file, id: 'missing' });
    await fs.unlink(path.join(config.workspace, result.references[0].dir, 'SOURCE.json'));
    assert.equal((await listReferences(config)).references[0].available, false);
    const outside = path.join(config.workspace, 'elsewhere');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(config.workspace, 'references', 'local-unsafe'));
    await assert.rejects(importReference(config, { file, id: 'unsafe' }), { code: 'ASSET_OUTSIDE_ROOT' });
    assert.deepEqual(await fs.readdir(outside), []);
});

test('empty files, directories and malformed catalogs are not imported', async t => {
    const config = await fixture(t);
    const empty = await media(config, 'empty.mp4', '');
    await assert.rejects(importReference(config, { file: empty }), { code: 'SOURCE_ASSET_MISSING' });
    await assert.rejects(importReference(config, { file: config.assetRoot }), { code: 'SOURCE_ASSET_MISSING' });
    await fs.writeFile(config.catalogPath, '{broken');
    await assert.rejects(listReferences(config), { code: 'CATALOG_INVALID' });
});

test('hash-less legacy snapshots and orphaned snapshots cannot be overwritten with another original', async t => {
    const config = await fixture(t);
    const file = await media(config);
    const result = await importReference(config, { file, id: 'legacy' });
    const snapshot = path.join(config.workspace, result.references[0].dir, 'SOURCE.json');
    const source = JSON.parse(await fs.readFile(snapshot));
    source.sha256 = '';
    await fs.writeFile(snapshot, JSON.stringify(source));
    const other = await media(config, 'other.mp4', 'different');
    await assert.rejects(importReference(config, { file: other, id: 'legacy' }), { code: 'REFERENCE_CONFLICT' });
    await fs.unlink(config.catalogPath);
    await assert.rejects(importReference(config, { file: other, id: 'legacy' }), { code: 'REFERENCE_CONFLICT' });
    assert.equal(JSON.parse(await fs.readFile(snapshot)).videoPath, source.videoPath);
    await importReference(config, { file, id: 'legacy' });
    assert.equal((await listReferences(config)).references.length, 1);
});

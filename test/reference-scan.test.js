import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanReferences } from '../src/reference-scan.js';
import { importReference, importReferenceFiles, readReferenceCatalog, readReferenceSource } from '../src/references.js';

async function fixture(t) {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reference-scan-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const root = path.join(workspace, 'inputs');
    await fs.mkdir(root);
    const config = { workspace, catalogPath: path.join(workspace, 'catalog.json'), assetRoot: path.join(workspace, 'unused'), source: { provider: 'local' } };
    async function write(name, data = `fixture:${name}`) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, data);
        return file;
    }
    return { config, root, write };
}

test('folder scanning is read-only, sorted and excludes hidden, empty and linked files', async t => {
    const f = await fixture(t);
    await f.write('z.mp4');
    await f.write('a.MOV');
    await f.write('empty.mp4', '');
    await f.write('notes.txt');
    await f.write('.hidden.mp4');
    await f.write('nested/b.webm');
    await fs.symlink(path.join(f.root, 'z.mp4'), path.join(f.root, 'alias.mp4'));
    const result = await scanReferences(f.config, { directory: 'inputs' });
    assert.deepEqual(result.candidates.map(item => item.relativePath), ['a.MOV', 'z.mp4']);
    assert.ok(result.candidates.every(item => item.bytes > 0 && item.referenceIds.length === 0));
    assert.deepEqual(result.imported, []);
    assert.equal(result.skipped.length, 3);
    await assert.rejects(fs.access(f.config.catalogPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.config.workspace, 'references')), { code: 'ENOENT' });
});

test('recursive scanning skips linked directories and imports only explicit selections', async t => {
    const f = await fixture(t);
    await f.write('a.mp4');
    const selected = await f.write('nested/b.mkv');
    await f.write('.private/c.mp4');
    await fs.symlink(path.join(f.root, 'nested'), path.join(f.root, 'linked'));
    const result = await scanReferences(f.config, { directory: f.root, recursive: true, import: true, select: ['nested/b.mkv'] });
    assert.deepEqual(result.candidates.map(item => item.relativePath), ['a.mp4', 'nested/b.mkv']);
    assert.equal(result.imported.length, 1);
    const source = await readReferenceSource(f.config, result.imported[0]);
    assert.equal(source.videoPath, await fs.realpath(selected));
    assert.deepEqual(await fs.readdir(path.join(f.config.workspace, result.imported[0].dir)), ['SOURCE.json']);
});

test('repeat folder import preserves registered aliases, titles and snapshots', async t => {
    const f = await fixture(t);
    const file = await f.write('a.mp4');
    const first = await importReference(f.config, { file, id: 'custom', title: '保留原始标题' });
    const snapshot = path.join(f.config.workspace, first.references[0].dir, 'SOURCE.json');
    const before = await fs.readFile(snapshot, 'utf8');
    const result = await scanReferences(f.config, { directory: f.root, import: true });
    assert.deepEqual(result.candidates[0].referenceIds, ['local-custom']);
    assert.deepEqual(result.imported, []);
    assert.equal(await fs.readFile(snapshot, 'utf8'), before);
    assert.equal((await readReferenceCatalog(f.config)).references.length, 1);
});

test('batch folder import deduplicates equal content without redirecting an existing binding', async t => {
    const f = await fixture(t);
    const a = await f.write('a.mp4', 'same content');
    await f.write('b.mp4', 'same content');
    const result = await scanReferences(f.config, { directory: f.root, import: true });
    assert.equal(result.imported.length, 1);
    assert.equal((await readReferenceSource(f.config, result.imported[0])).videoPath, await fs.realpath(a));
    const second = await scanReferences(f.config, { directory: f.root, import: true });
    assert.equal(second.imported.length, 0);
    assert.equal((await readReferenceCatalog(f.config)).references.length, 1);
});

test('invalid selections and input directories never write reference records', async t => {
    const f = await fixture(t);
    await f.write('a.mp4');
    for (const options of [
        { directory: f.root, select: ['a.mp4'] },
        { directory: f.root, import: true, select: ['../inputs/a.mp4'] },
        { directory: f.root, import: true, select: [path.join(f.root, 'a.mp4')] },
        { directory: f.root, import: true, select: ['missing.mp4'] },
    ]) await assert.rejects(scanReferences(f.config, options), { code: 'INVALID_INPUT' });
    await assert.rejects(scanReferences(f.config, { directory: 'absent' }), { code: 'SOURCE_ASSET_MISSING' });
    await assert.rejects(scanReferences(f.config, { directory: path.join(f.root, 'a.mp4') }), { code: 'SOURCE_ASSET_MISSING' });
    await assert.rejects(fs.access(f.config.catalogPath), { code: 'ENOENT' });
});

test('file batch preflights every file and destination before writing snapshots', async t => {
    const f = await fixture(t);
    const a = await f.write('a.mp4');
    const empty = await f.write('empty.mp4', '');
    await assert.rejects(importReferenceFiles(f.config, [a, empty]), { code: 'SOURCE_ASSET_MISSING' });
    await assert.rejects(fs.access(f.config.catalogPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.config.workspace, 'references')), { code: 'ENOENT' });
    const link = path.join(f.root, 'alias.mp4');
    await fs.symlink(a, link);
    await assert.rejects(importReferenceFiles(f.config, [a, link]), { code: 'SOURCE_ASSET_INVALID' });
    await assert.rejects(fs.access(f.config.catalogPath), { code: 'ENOENT' });
});

test('file batch rejects a discovered directory replaced by a symlink before import', async t => {
    const f = await fixture(t);
    await f.write('nested/a.mp4');
    const scanned = await scanReferences(f.config, { directory: f.root, recursive: true });
    const outside = path.join(f.config.workspace, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'a.mp4'), 'outside private video');
    await fs.rm(path.join(f.root, 'nested'), { recursive: true });
    await fs.symlink(outside, path.join(f.root, 'nested'));
    await assert.rejects(importReferenceFiles(f.config, scanned.candidates.map(item => item.path)), { code: 'SOURCE_ASSET_INVALID' });
    await assert.rejects(fs.access(f.config.catalogPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.config.workspace, 'references')), { code: 'ENOENT' });
});

test('download provenance uses a validated adapter URL and preserves content-based local identity', async t => {
    const f = await fixture(t);
    const file = await f.write('download.mp4');
    const result = await importReference(f.config, { file, origin: { provider: 'yt-dlp', url: 'https://example.com/watch?id=123', title: '下载标题', channel: '频道', durationSec: 12.5 } });
    assert.match(result.references[0].id, /^local-[a-f0-9]{64}$/);
    const source = await readReferenceSource(f.config, result.references[0]);
    assert.equal(source.title, '下载标题');
    assert.equal(source.channel, '频道');
    assert.equal(source.durationSec, 12.5);
    assert.deepEqual(source.provider, { kind: 'yt-dlp', location: 'https://example.com/watch?id=123' });
    assert.equal(source.canonicalUrl, source.provider.location);
    const other = await importReference(f.config, { file, origin: { provider: 'fixture-downloader', url: 'https://example.com/video' } });
    assert.equal((await readReferenceSource(f.config, other.references[0])).provider.kind, 'fixture-downloader');
    for (const origin of [
        { provider: '../bad', url: 'https://example.com/video' },
        { provider: 'yt-dlp', url: 'file:///tmp/video' },
        { provider: 'yt-dlp', url: 'https://user:password@example.com/video' },
        { provider: 'yt-dlp', url: 'https://example.com/video', durationSec: -1 },
    ]) await assert.rejects(importReference(f.config, { file, origin }), { code: 'INVALID_INPUT' });
    await assert.rejects(importReference(f.config, { file, title: '' }), { code: 'INVALID_INPUT' });
});

test('scan limits abort before importing any part of an oversized directory', async t => {
    const f = await fixture(t);
    await f.write('video.mp4');
    for (let start = 0; start < 10000; start += 100) {
        await Promise.all(Array.from({ length: 100 }, (_, i) => f.write(`f${start + i}.txt`, 'x')));
    }
    await assert.rejects(scanReferences(f.config, { directory: f.root, import: true }), { code: 'SCAN_LIMIT' });
    await assert.rejects(fs.access(f.config.catalogPath), { code: 'ENOENT' });
});

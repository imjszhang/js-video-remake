import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { resolveConfig, WORKSPACE_DIRS } from '../src/config.js';
import { buildSource, emptyCatalog } from '../src/schema.js';

async function fixture(t, { catalog = true } = {}) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-reference-cli-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    for (const name of WORKSPACE_DIRS) await fs.mkdir(path.join(workspace, name), { recursive: true });
    if (catalog) await fs.writeFile(path.join(workspace, 'catalog.json'), JSON.stringify(emptyCatalog()));
    const env = { VIDEO_REMAKE_WORKSPACE: workspace };
    const run = (args, deps = {}) => execute(parseArgv(args), env, deps);
    return { workspace, env, run };
}

function offlineTools() {
    return {
        fetchImpl: async () => assert.fail('本地清单不应访问素材网关'),
        connect() { throw new Error('fixture: no listener'); },
        spawnImpl() {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            queueMicrotask(() => child.emit('close', 1));
            return child;
        },
    };
}

test('reference:list in a new workspace is read-only and local is the default', async t => {
    const f = await fixture(t, { catalog: false });
    const config = resolveConfig({}, f.env);
    assert.equal(config.source.provider, 'local');
    const result = await f.run(['reference:list'], offlineTools());
    assert.equal(result.ok, true);
    assert.equal(result.data.command, 'reference:list');
    assert.deepEqual(result.data.references, []);
    const all = await f.run(['list'], offlineTools());
    assert.deepEqual(all.data.references, []);
    assert.deepEqual(all.data.productions, []);
    await assert.rejects(f.run(['get', 'missing'], offlineTools()), { code: 'NOT_FOUND' });
    await assert.rejects(fs.access(path.join(f.workspace, 'catalog.json')), { code: 'ENOENT' });
});

test('CLI imports a local file, lists it and creates a linked production without a gateway', async t => {
    const f = await fixture(t);
    const original = path.join(f.workspace, 'example.mp4');
    await fs.writeFile(original, 'local-video-fixture');
    const imported = await f.run(['reference:import', 'example.mp4', '--id', 'example', '--title', '本地参考']);
    assert.equal(imported.data.command, 'reference:import');
    assert.equal(imported.data.references.length, 1);
    let result = await f.run(['reference:list']);
    const reference = result.data.references[0];
    assert.equal(reference.id, 'local-example');
    assert.equal(reference.title, '本地参考');
    assert.equal(reference.available, true);
    const sourceFile = path.join(f.workspace, reference.dir, 'SOURCE.json');
    const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
    assert.equal(source.videoPath, await fs.realpath(original));
    assert.equal(source.sha256.length, 64);
    assert.deepEqual(await fs.readdir(path.dirname(sourceFile)), ['SOURCE.json']);
    await f.run(['start', reference.id, '--as', 'local-demo']);
    result = await f.run(['reference:list']);
    assert.deepEqual(result.data.references[0].productions, ['local-demo']);
    const all = await f.run(['list']);
    assert.equal(all.data.references[0].title, '本地参考');
    assert.equal(all.data.references[0].available, true);
    assert.deepEqual(all.data.references[0].productions, ['local-demo']);
    await fs.unlink(original);
    result = await f.run(['reference:list']);
    assert.equal(result.data.references[0].available, false);
    assert.deepEqual(result.data.references[0].productions, ['local-demo']);
});

test('CLI imports all manifest entries using the explicit asset root and keeps their identities', async t => {
    const f = await fixture(t);
    const root = path.join(f.workspace, 'input-library');
    await fs.mkdir(root);
    const items = [];
    for (const id of ['first', 'second']) {
        await fs.writeFile(path.join(root, `${id}.mp4`), `video-${id}`);
        items.push({ video: { videoId: id, platform: 'example', status: 'downloaded', title: id }, files: { video: `${id}.mp4` } });
    }
    await fs.writeFile(path.join(f.workspace, 'sources.json'), JSON.stringify({ schema: 'video-remake.source-list@1', items }));
    const result = await f.run(['reference:import', '--manifest', 'sources.json', '--asset-root', root]);
    assert.equal(result.data.references.length, 2);
    await fs.unlink(path.join(f.workspace, 'sources.json'));
    const listed = await f.run(['reference:list']);
    assert.deepEqual(listed.data.references.map(item => item.id).sort(), ['example-first', 'example-second']);
    assert.ok(listed.data.references.every(item => item.available));
    await f.run(['start', 'example-first', '--as', 'manifest-demo']);
});

test('local doctor ignores an unused asset root and ingestion has no implicit gateway fallback', async t => {
    const f = await fixture(t);
    const result = await f.run(['doctor'], offlineTools());
    assert.equal(result.ok, true);
    assert.equal(result.data.source.provider, 'local');
    assert.equal(result.data.source.available, true);
    assert.equal(result.data.assetRoot.readable, false);
    await assert.rejects(f.run(['ingest', 'https://example.com/video'], offlineTools()), { code: 'SOURCE_UNSUPPORTED' });
    const catalog = JSON.parse(await fs.readFile(path.join(f.workspace, 'catalog.json'), 'utf8'));
    assert.deepEqual(catalog, emptyCatalog());
});

test('legacy gateway SOURCE snapshots remain usable offline without rewriting their identity or origin', async t => {
    const f = await fixture(t);
    const original = path.join(f.workspace, 'legacy.mp4');
    await fs.writeFile(original, 'legacy-video');
    const reference = { id: 'youtube-old-id', archiveVideoId: 'old-id', platform: 'youtube', status: 'understanding', dir: 'references/youtube-old-id' };
    const source = buildSource({ video: { videoId: 'old-id', platform: 'youtube', title: '旧参考', videoPath: original }, destDir: f.workspace, assetRoot: f.workspace });
    source.provider = { kind: 'gateway-video', location: 'https://unused.invalid/video/api/v1/' };
    await fs.mkdir(path.join(f.workspace, reference.dir));
    const sourceFile = path.join(f.workspace, reference.dir, 'SOURCE.json');
    await fs.writeFile(sourceFile, JSON.stringify(source));
    await fs.writeFile(path.join(f.workspace, 'catalog.json'), JSON.stringify({ ...emptyCatalog(), references: [reference] }));
    const before = await fs.readFile(sourceFile, 'utf8');
    const listed = await f.run(['reference:list'], offlineTools());
    assert.equal(listed.data.references[0].id, reference.id);
    assert.equal(listed.data.references[0].available, true);
    assert.equal(listed.data.references[0].title, '旧参考');
    const started = await f.run(['start', reference.id, '--as', 'legacy-demo'], offlineTools());
    assert.deepEqual(started.data.production.referenceIds, [reference.id]);
    assert.equal(await fs.readFile(sourceFile, 'utf8'), before);
});

test('explicit source selection retains file, environment and CLI precedence', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.workspace, 'video-remake.json'), JSON.stringify({ source: { provider: 'gateway-video' } }));
    assert.equal(resolveConfig({}, f.env).source.provider, 'gateway-video');
    assert.equal(resolveConfig({}, { ...f.env, VIDEO_REMAKE_SOURCE_PROVIDER: 'manifest' }).source.provider, 'manifest');
    assert.equal(resolveConfig({ sourceProvider: 'local' }, { ...f.env, VIDEO_REMAKE_SOURCE_PROVIDER: 'manifest' }).source.provider, 'local');
});

test('reference commands reject ambiguous or missing import inputs before writing records', async t => {
    const f = await fixture(t, { catalog: false });
    for (const args of [
        ['reference:import'],
        ['reference:import', 'a.mp4', 'b.mp4'],
        ['reference:import', 'a.mp4', '--manifest', 'sources.json'],
        ['reference:list', 'unexpected'],
    ]) await assert.rejects(f.run(args), { code: 'INVALID_INPUT' });
    await assert.rejects(fs.access(path.join(f.workspace, 'catalog.json')), { code: 'ENOENT' });
});

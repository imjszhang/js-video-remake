import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { readWebLibrary } from '../src/web-library.js';

async function fixture(t, { manifest = false } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-reference-web-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const input = path.join(root, 'input-library');
    await fs.mkdir(workspace);
    await fs.mkdir(input);
    const original = path.join(input, 'original.mp4');
    const unrelated = path.join(input, 'unrelated.mp4');
    await fs.writeFile(original, 'imported-original');
    await fs.writeFile(unrelated, 'unrelated-private-video');
    const env = { VIDEO_REMAKE_WORKSPACE: workspace };
    const run = args => execute(parseArgv(args), env);
    const thumbnail = path.join(input, 'poster.png');
    await fs.writeFile(thumbnail, 'imported-thumbnail');
    let imported;
    if (manifest) {
        const manifestFile = path.join(workspace, 'sources.json');
        await fs.writeFile(manifestFile, JSON.stringify({ schema: 'video-remake.source-list@1', items: [{
            video: { videoId: 'example', platform: 'fixture', status: 'downloaded', title: '清单原片' },
            files: { video: 'original.mp4', thumbnail: 'poster.png' },
        }] }));
        imported = await run(['reference:import', '--manifest', manifestFile, '--asset-root', input]);
        await fs.unlink(manifestFile);
    } else imported = await run(['reference:import', original, '--id', 'example']);
    const reference = imported.data.references[0];
    await run(['start', reference.id, '--as', 'demo']);
    const catalogFile = path.join(workspace, 'catalog.json');
    const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
    catalog.productions[0].drafts = { version: 'v1', dir: 'productions/demo/drafts/v1' };
    await fs.writeFile(catalogFile, JSON.stringify(catalog));
    const draftDir = path.join(workspace, catalog.productions[0].drafts.dir);
    await fs.mkdir(draftDir, { recursive: true });
    await fs.writeFile(path.join(draftDir, 'clip.mp4'), 'published-draft');
    await fs.writeFile(path.join(draftDir, 'MANIFEST.json'), JSON.stringify({ renders: [{ file: 'clip.mp4' }] }));
    const sourceFile = path.join(workspace, reference.dir, 'SOURCE.json');
    const read = () => readWebLibrary(workspace, { env });
    return { root, workspace, original: await fs.realpath(original), unrelated, sourceFile, catalogFile, catalog, read, thumbnail: await fs.realpath(thumbnail) };
}

function publishedReference(library) {
    return library.projects.find(project => project.slug === 'demo').videos[0].reference;
}

function originalAsset(library) {
    const reference = publishedReference(library);
    return reference && library.media.get(reference.url.split('/').at(-1));
}

test('web playback registers the exact imported local original outside the configured asset root', async t => {
    const f = await fixture(t);
    const library = await f.read();
    assert.equal(originalAsset(library).path, f.original);
    assert.equal(originalAsset(library).size, Buffer.byteLength('imported-original'));
    assert.ok(!JSON.stringify(library.projects).includes(f.root));
    assert.ok(![...library.media.values()].some(asset => asset.path === f.unrelated));
});

test('tampering SOURCE absolute and relative pointers cannot redirect an explicitly imported local file', async t => {
    const f = await fixture(t);
    const source = JSON.parse(await fs.readFile(f.sourceFile, 'utf8'));
    source.videoPath = f.unrelated;
    source.assetRoot = path.dirname(f.unrelated);
    source.relVideo = path.basename(f.unrelated);
    source.thumbPath = f.unrelated;
    source.relThumb = path.basename(f.unrelated);
    await fs.writeFile(f.sourceFile, JSON.stringify(source));
    const library = await f.read();
    assert.equal(originalAsset(library).path, f.original);
    assert.ok(![...library.media.values()].some(asset => asset.path === f.unrelated));
});

test('a missing imported file fails closed and does not fall back to SOURCE pointers', async t => {
    const f = await fixture(t);
    await fs.unlink(f.original);
    const source = JSON.parse(await fs.readFile(f.sourceFile, 'utf8'));
    source.videoPath = f.unrelated;
    source.relVideo = path.basename(f.unrelated);
    await fs.writeFile(f.sourceFile, JSON.stringify(source));
    const library = await f.read();
    assert.equal(publishedReference(library), null);
    assert.equal(library.projects[0].videos.length, 1, 'the published remake remains visible');
    assert.ok(![...library.media.values()].some(asset => asset.path === f.unrelated));
});

test('SOURCE alone does not authorize serving an absolute path outside the configured root', async t => {
    const f = await fixture(t);
    delete f.catalog.references[0].localFile;
    await fs.writeFile(f.catalogFile, JSON.stringify(f.catalog));
    const allowed = path.join(f.workspace, 'assets/source');
    await fs.mkdir(allowed, { recursive: true });
    const library = await f.read();
    assert.equal(publishedReference(library), null);
    assert.ok(![...library.media.values()].some(asset => asset.path === f.original));
});

test('replacing an imported file with a symlink cannot authorize a sibling private file', async t => {
    const f = await fixture(t);
    await fs.unlink(f.original);
    await fs.symlink(f.unrelated, f.original);
    const library = await f.read();
    assert.equal(publishedReference(library), null);
    assert.ok(![...library.media.values()].some(asset => asset.path === f.unrelated));
});


test('manifest imports retain exact original and thumbnail authorization after one-off settings disappear', async t => {
    const f = await fixture(t, { manifest: true });
    const library = await f.read();
    const reference = publishedReference(library);
    assert.equal(originalAsset(library).path, f.original);
    assert.equal(library.media.get(reference.poster.split('/').at(-1)).path, f.thumbnail);
    assert.ok(![...library.media.values()].some(asset => asset.path === f.unrelated));
    assert.ok(!JSON.stringify(library.projects).includes(f.root));
    const source = JSON.parse(await fs.readFile(f.sourceFile, 'utf8'));
    source.relVideo = path.basename(f.unrelated);
    source.videoPath = f.unrelated;
    source.relThumb = 'private.png';
    source.thumbPath = path.join(path.dirname(f.thumbnail), 'private.png');
    await fs.writeFile(source.thumbPath, 'private-thumbnail');
    await fs.writeFile(f.sourceFile, JSON.stringify(source));
    const after = await f.read();
    assert.equal(originalAsset(after).path, f.original);
    assert.equal(after.media.get(publishedReference(after).poster.split('/').at(-1)).path, f.thumbnail);
    assert.ok(![...after.media.values()].some(asset => asset.path === source.thumbPath));
});

test('replacing the imported manifest thumbnail with a sibling symlink does not expose that sibling', async t => {
    const f = await fixture(t, { manifest: true });
    const privateImage = path.join(path.dirname(f.thumbnail), 'private.png');
    await fs.writeFile(privateImage, 'private-thumbnail');
    await fs.unlink(f.thumbnail);
    await fs.symlink(privateImage, f.thumbnail);
    const library = await f.read();
    assert.equal(originalAsset(library).path, f.original);
    assert.equal(publishedReference(library).poster, null);
    assert.ok(![...library.media.values()].some(asset => asset.path === privateImage));
});

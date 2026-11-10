import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { downloadedVideo, run, tempWorkspace } from './helpers.js';

async function boundWorkspace(t) {
    const workspace = await tempWorkspace(t, {
        videos: { abcdefghijk: downloadedVideo() },
    });
    await run(['bind', 'abcdefghijk'], workspace.env);
    return workspace;
}

test('start creates a production and rejects a duplicate slug', async (t) => {
    const workspace = await boundWorkspace(t);
    const result = await run(['start', 'youtube-abcdefghijk', '--as', 'my-face'], workspace.env);
    assert.equal(result.ok, true);
    const root = path.join(workspace.directory, 'productions/my-face');
    for (const name of ['BRIEF.md', 'TREATMENT.md', 'PROGRESS.md', 'assets', 'drafts', 'videos']) {
        await fs.access(path.join(root, name));
    }
    await assert.rejects(fs.access(path.join(root, 'composition')), { code: 'ENOENT' });
    const brief = await fs.readFile(path.join(root, 'BRIEF.md'), 'utf8');
    assert.match(brief, /references\/youtube-abcdefghijk/);
    assert.match(brief, /remake video:new my-face/);
    await assert.rejects(
        run(['start', 'youtube-abcdefghijk', '--as', 'other', '--width', '1280'], workspace.env),
        (error) => error.code === 'INVALID_INPUT' && /video:new/.test(error.message),
    );
    await assert.rejects(
        run(['start', 'youtube-abcdefghijk', '--as', 'my-face'], workspace.env),
        (error) => error.code === 'ALREADY_EXISTS',
    );
});

test('list and get read the catalog', async (t) => {
    const workspace = await boundWorkspace(t);
    await run(['start', 'abcdefghijk', '--as', 'my-face'], workspace.env);
    const list = await run(['list'], workspace.env);
    assert.equal(list.data.references.length, 1);
    assert.equal(list.data.productions[0].slug, 'my-face');
    const reference = await run(['get', 'youtube-abcdefghijk'], workspace.env);
    assert.equal(reference.data.kind, 'reference');
    const production = await run(['get', 'my-face'], workspace.env);
    assert.equal(production.data.kind, 'production');
});

test('deliver --from increments versions and writes a manifest', async (t) => {
    const workspace = await boundWorkspace(t);
    await run(['start', 'youtube-abcdefghijk', '--as', 'my-face'], workspace.env);
    const source = path.join(workspace.directory, 'draft.mp4');
    await fs.writeFile(source, 'take-one');
    const first = await run(['deliver', 'my-face', '--from', source], workspace.env);
    assert.equal(first.data.version, 'v1');
    const second = await run(['deliver', 'my-face', '--from', source], workspace.env);
    assert.equal(second.data.version, 'v2');
    const manifest = JSON.parse(await fs.readFile(
        path.join(workspace.directory, 'deliverables/my-face/v2/MANIFEST.json'),
        'utf8',
    ));
    assert.equal(manifest.slug, 'my-face');
    assert.deepEqual(manifest.referenceIds, ['youtube-abcdefghijk']);
    const catalog = JSON.parse(await fs.readFile(path.join(workspace.directory, 'catalog.json'), 'utf8'));
    assert.equal(catalog.productions[0].status, 'delivered');
    assert.equal(catalog.productions[0].deliverable.version, 'v2');
});

test('deliver rejects a Hypit build id', async (t) => {
    const workspace = await boundWorkspace(t);
    await run(['start', 'youtube-abcdefghijk', '--as', 'my-face'], workspace.env);
    await assert.rejects(
        run(['deliver', 'my-face', '--build', '20260919-build', '--output', 'final.video'], workspace.env),
        (error) => error.code === 'INVALID_INPUT' && /--from/.test(error.message),
    );
});

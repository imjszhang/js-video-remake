import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { land, LEDGER_FORMAT, makeId } from '../src/media/land.js';

async function tempWorkspace(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'remake-land-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, 'productions', 'demo', 'composition'), { recursive: true });
    return directory;
}

test('makeId uses kind prefix and slug', () => {
    const id = makeId('image', 'demo-announcement', new Date(2026, 8, 19, 12, 0, 0), 'ab12');
    assert.equal(id, 'img-demo-announcement-20260919-ab12');
});

test('lands an image and returns a pasteable tag', async (t) => {
    const workspace = await tempWorkspace(t);
    const source = path.join(workspace, 'src.png');
    await writeFile(source, 'png');

    const result = land({
        workspace, slug: 'demo', kind: 'image', from: source,
        intent: 'speaker look', provider: 'codex-image.generate', id: 'img-demo-look',
    });

    assert.equal(result.path, 'productions/demo/assets/image/img-demo-look.png');
    assert.equal(result.html, '<img id="img-demo-look" class="clip" src="./assets/image/img-demo-look.png" alt="" data-start="0" data-duration="1">');
    const ledger = JSON.parse(await readFile(path.join(workspace, 'productions/demo/assets/ledger.json'), 'utf8'));
    assert.equal(ledger.format, LEDGER_FORMAT);
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].provider, 'codex-image.generate');
    assert.equal(await readFile(path.join(workspace, ledger.items[0].path), 'utf8'), 'png');
});

test('appends a second item and rejects a reused id', async (t) => {
    const workspace = await tempWorkspace(t);
    const first = path.join(workspace, 'a.png');
    const second = path.join(workspace, 'b.wav');
    await writeFile(first, 'a');
    await writeFile(second, 'b');
    const now = new Date(2026, 8, 19, 12, 0, 0);

    land({ workspace, slug: 'demo', kind: 'image', from: first, intent: 'one', provider: 'codex-image.generate', id: 'img-demo-a', now });
    land({ workspace, slug: 'demo', kind: 'audio', from: second, intent: 'two', provider: 'comfy.fetch_outputs', id: 'aud-demo-b', now });
    assert.throws(() => land({ workspace, slug: 'demo', kind: 'image', from: first, intent: 'again', provider: 'x', id: 'img-demo-a' }), /id 已存在/);

    const ledger = JSON.parse(await readFile(path.join(workspace, 'productions/demo/assets/ledger.json'), 'utf8'));
    assert.equal(ledger.items.map((item) => item.id).join(','), 'img-demo-a,aud-demo-b');
});

test('rejects a missing production and a wrong extension', async (t) => {
    const workspace = await tempWorkspace(t);
    const source = path.join(workspace, 'x.png');
    await writeFile(source, 'x');
    assert.throws(
        () => land({ workspace, slug: 'missing', kind: 'image', from: source, intent: 'nope', provider: 'codex-image.generate' }),
        /制作不存在/,
    );
    assert.throws(
        () => land({ workspace, slug: 'demo', kind: 'video', from: source, intent: 'nope', provider: 'comfy.run_template' }),
        /video 不接受扩展名 \.png/,
    );
});

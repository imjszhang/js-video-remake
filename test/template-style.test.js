import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readTemplateStyle, saveTemplateStyle } from '../src/template-style.js';

const CSS = `:root { --bg: #101820; --ink: #fafafa; --blue: #4488cc; --gold: #eec244; --sans: "Local Sans", sans-serif; }
#root { color: var(--ink); }
.slot { opacity: 0; }
.k-card { border-radius: 6px; }
.cap-zh { font: 700 26px/35px var(--sans); }
.cap-en { font: 500 15px/18px sans-serif; }
`;
const manifest = { template: { format: 'video-template@1' } };
async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-template-style-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/shared.css'), CSS);
    await fs.writeFile(path.join(dir, 'build.mjs'), "const css = read('src/shared.css');\n");
    return dir;
}

test('styles read without writing and derive defaults from recognized template source', async t => {
    const dir = await fixture(t);
    const before = await fs.readdir(dir);
    const data = await readTemplateStyle(dir, manifest);
    assert.equal(data.supported, true);
    assert.equal(data.values.background, '#101820');
    assert.equal(data.values.radius, 6);
    assert.equal(data.presets.find(preset => preset.id === 'violet').values.background, '#160e23');
    assert.deepEqual(await fs.readdir(dir), before);
});

test('style saves are portable, idempotent, avoid timeline code and restore exact original source', async t => {
    const dir = await fixture(t);
    const originalBuild = await fs.readFile(path.join(dir, 'build.mjs'));
    const selected = { preset: 'violet', font: 'serif', captionScale: 1.1, radius: 12, showHud: false, showGrid: false };
    const data = await saveTemplateStyle(dir, manifest, selected);
    assert.equal(data.values.accent, '#b794f6');
    const modified = await fs.readFile(path.join(dir, 'src/shared.css'), 'utf8');
    assert.match(modified, /--blue: #b794f6/);
    assert.match(modified, /font-size: 28\.6px; line-height: 38\.5px/);
    assert.match(modified, /visibility: hidden/);
    assert.match(modified, /slot:not\(\.slot-circle\)/);
    assert.doesNotMatch(modified.slice(CSS.length), /transform|setTimeout|https?:/);
    await saveTemplateStyle(dir, manifest, selected);
    assert.equal(await fs.readFile(path.join(dir, 'src/shared.css'), 'utf8'), modified);
    const copied = await fixture(t);
    await fs.copyFile(path.join(dir, 'src/shared.css'), path.join(copied, 'src/shared.css'));
    await fs.copyFile(path.join(dir, 'template-style.json'), path.join(copied, 'template-style.json'));
    assert.deepEqual((await readTemplateStyle(copied, manifest)).values, data.values);
    await saveTemplateStyle(copied, manifest, { preset: 'original' });
    assert.equal(await fs.readFile(path.join(copied, 'src/shared.css'), 'utf8'), CSS);
    await assert.rejects(fs.stat(path.join(copied, 'template-style.json')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(dir, 'build.mjs')), originalBuild);
});

test('unsupported templates return an explicit reason and cannot be changed', async t => {
    const dir = await fixture(t);
    await fs.writeFile(path.join(dir, 'build.mjs'), 'console.log("other builder");');
    assert.equal((await readTemplateStyle(dir, manifest)).supported, false);
    await assert.rejects(saveTemplateStyle(dir, manifest, { preset: 'forest' }), { code: 'VIDEO_STYLE_INVALID' });
    assert.equal(await fs.readFile(path.join(dir, 'src/shared.css'), 'utf8'), CSS);
    const declared = { template: { style: { format: 'video-style@1', adapter: 'shared-css-v1', file: 'src/shared.css' } } };
    assert.equal((await readTemplateStyle(dir, declared)).supported, true);
    declared.template.style.file = '../escape.css';
    assert.equal((await readTemplateStyle(dir, declared)).supported, false);
});

test('unsafe values, unknown fields, symlinks and malformed blocks are rejected before writes', async t => {
    const dir = await fixture(t);
    for (const value of [
        { background: 'red; background:url(https://example.com)' }, { foreground: '#fffffff' },
        { preset: 'url(x)' }, { font: 'url(x)' }, { radius: -1 }, { radius: 33 }, { captionScale: 2 },
        { showHud: 'false' }, { extra: 'value' }, null, [],
    ]) await assert.rejects(saveTemplateStyle(dir, manifest, value), { code: 'VIDEO_STYLE_INVALID' });
    assert.equal(await fs.readFile(path.join(dir, 'src/shared.css'), 'utf8'), CSS);
    const other = path.join(dir, 'private.json');
    await fs.writeFile(other, 'keep');
    await fs.symlink(other, path.join(dir, 'template-style.json'));
    await assert.rejects(saveTemplateStyle(dir, manifest, { preset: 'forest' }), { code: 'VIDEO_STYLE_INVALID' });
    assert.equal(await fs.readFile(other, 'utf8'), 'keep');
    await fs.unlink(path.join(dir, 'template-style.json'));
    await fs.writeFile(path.join(dir, 'src/shared.css'), CSS + '\n/* video-remake:style:start */\nunfinished');
    await assert.rejects(readTemplateStyle(dir, manifest), { code: 'VIDEO_STYLE_INVALID' });
});

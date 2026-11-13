import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWebServer } from '../src/web-server.js';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).dependencies.hyperframes;
const defaults = { presenter: { src: null, mediaStart: 0, objectPosition: '50% 30%' }, voice: null, music: null, captions: null, texts: null, identity: { name: '你的名字' } };
const rows = [[0, 2, '第一句', 'First line'], [2, 9, '第二句 {{name}}', 'Second line']];

async function fixture(t, identity = { name: '小林' }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-prompt-web-'));
    const dir = path.join(root, 'productions/demo/videos/demo-v1');
    const write = async (file, value) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    await write(path.join(root, 'catalog.json'), { version: 1, references: [], productions: [{ slug: 'demo', title: '模板演示', dir: 'productions/demo', referenceIds: [], status: 'commissioned' }] });
    await write(path.join(dir, 'video.json'), {
        schema: 'video-package@1', id: 'demo', version: 1, title: '测试模板', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, entry: 'index.html', output: 'renders/out.mp4',
        template: { format: 'video-template@1', summary: '测试', inputs: { presenter: { kind: 'video' }, voice: { kind: 'audio' }, music: { kind: 'audio' }, captions: { kind: 'json', count: 2 }, texts: { kind: 'json' }, identity: { kind: 'fields', fields: { name: { default: '你的名字' } } } } },
    });
    await write(path.join(dir, 'package.json'), { dependencies: { hyperframes: version }, scripts: { inputs: 'node tools/inputs.mjs' } });
    await write(path.join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes: version } }, 'node_modules/hyperframes': { version } } });
    await write(path.join(dir, 'src/data/captions.json'), rows);
    await write(path.join(dir, 'inputs.json'), { ...defaults, identity });
    const server = createWebServer({ root, templateDeps: { runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }), probe: async () => ({ duration: 10, width: 1280, height: 720, frameRate: '30/1', frames: 300, audioStreams: 1 }) } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    return `http://127.0.0.1:${server.address().port}/api/projects/demo/templates/demo-v1`;
}

test('prompt export serves a plain teleprompter draft without writing into the package', async t => {
    const base = await fixture(t);
    const response = await fetch(`${base}/prompt?language=zh&format=txt`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /demo-v1-prompt-zh\.txt/);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.equal(await response.text(), '第一句\n第二句 小林\n');
});

test('prompt export supports srt, cards and english, and refuses unknown formats', async t => {
    const base = await fixture(t);
    const srt = await fetch(`${base}/prompt?language=zh&format=srt`);
    assert.equal(srt.status, 200);
    assert.match(await srt.text(), /00:00:02,000 --> 00:00:09,000/);
    const cards = await fetch(`${base}/prompt?format=cards`);
    assert.match(await cards.text(), /<title>测试模板 口播提词稿<\/title>/);
    const english = await fetch(`${base}/prompt?language=en&format=txt`);
    assert.equal(await english.text(), 'First line\nSecond line\n');
    const invalid = await fetch(`${base}/prompt?format=pdf`);
    assert.equal(invalid.status, 400);
});

test('unfilled identity placeholder is reported instead of exporting the default', async t => {
    const base = await fixture(t, {});
    const response = await fetch(`${base}/prompt`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /第 2 句.*\{\{name\}\}/);
});

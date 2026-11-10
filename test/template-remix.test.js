import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { getTemplateEditor, remixTemplate, saveVideoStyle, treeHash, unpackVideo, runTemplateAction } from '../src/videos.js';
import { createWebServer } from '../src/web-server.js';
import { createTemplateController } from '../src/template-web.js';
import { readZip, writeZip } from '../src/zip.js';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).dependencies.hyperframes;
const css = ':root { --bg: #101010; --ink: #fafafa; --blue: #4488ff; --gold: #ffaa44; }\n#root {color:var(--ink)}\n.cap-zh {font:700 25px/34px sans-serif}\n.slot {}\n.k-card {border-radius:8px}\n';
const missing = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });
async function fixture(t, { frozen = false } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-remix-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { workspace: root, catalogPath: path.join(root, 'catalog.json') };
    const options = { slug: 'demo', name: 'demo-v1' };
    const manifest = { schema: 'video-package@1', id: 'demo', version: 1, title: '原模板', entry: 'index.html', output: 'renders/demo-v1.mp4', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, template: { format: 'video-template@1', inputs: { identity: { fields: { name: { default: '你的名字' } } }, music: {}, voice: {}, presenter: {} }, pack: { exclude: ['index.html', 'SCRIPT.md', 'slots.json', 'assets/audio/'] } } };
    const files = {
        'video.json': manifest,
        'package.json': { dependencies: { hyperframes: version }, scripts: { inputs: 'node tools/inputs.mjs', build: 'node build.mjs', compose: 'node tools/compose.mjs', render: 'hyperframes render -o renders/demo-v1.mp4' } },
        'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes: version } }, 'node_modules/hyperframes': { version } } },
        'src/shared.css': css,
        'build.mjs': "const read = () => ''; read('src/shared.css');\n",
    };
    const archive = path.join(root, 'original.video');
    await fs.writeFile(archive, writeZip(Object.entries(files).map(([name, value]) => ({ name: `demo-v1/${name}`, data: typeof value === 'string' ? value : JSON.stringify(value) }))));
    const imported = await unpackVideo(config, { file: archive });
    const dir = path.join(root, imported.dir);
    const write = async (relative, value) => {
        const target = path.join(dir, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
    };
    await write('inputs/voice.wav', 'private voice');
    await write('inputs.json', { identity: { name: '私人名字' }, voice: 'inputs/voice.wav' });
    await write('SCRIPT.md', '私人名字');
    await write('index.html', 'generated private');
    await write('assets/audio/soundtrack.wav', 'private audio');
    if (frozen) {
        const draft = path.join(root, 'productions/demo/drafts/demo-v1');
        await fs.mkdir(draft, { recursive: true });
        await fs.writeFile(path.join(draft, 'MANIFEST.json'), JSON.stringify({ package: { treeHash: await treeHash(dir) }, renders: [] }));
    }
    return { root, dir, config, options, write };
}

test('remix creates a reusable new design and leaves a frozen original byte-identical', async t => {
    const f = await fixture(t, { frozen: true });
    const before = await treeHash(f.dir);
    await assert.rejects(saveVideoStyle(f.config, { ...f.options, style: { preset: 'forest' } }), { code: 'VIDEO_FROZEN' });
    const remix = await remixTemplate(f.config, { ...f.options, title: '森林风模板', style: { preset: 'forest' } });
    assert.match(remix.video, /^template-[a-f0-9]{12}-v1$/);
    assert.equal(remix.inputsReset, true);
    assert.equal(await treeHash(f.dir), before);
    const next = path.join(f.root, remix.dir);
    for (const relative of ['inputs.json', 'inputs', 'index.html', 'SCRIPT.md', 'assets/audio']) await missing(path.join(next, relative));
    const editor = await getTemplateEditor(f.config, { slug: 'demo', name: remix.video });
    assert.equal(editor.title, '森林风模板');
    assert.equal(editor.frozen, false);
    assert.equal(editor.inputs.identity.name, '你的名字');
    assert.equal(editor.inputs.voice, null);
    assert.equal(editor.style.values.preset, 'forest');
    assert.match(await fs.readFile(path.join(next, 'src/shared.css'), 'utf8'), /#091b18/);
    const manifest = JSON.parse(await fs.readFile(path.join(next, 'video.json')));
    assert.equal(manifest.template.style.adapter, 'shared-css-v1');
    assert.equal(manifest.source.forkedFrom.treeHash, before);
});

test('style export and reimport preserve a portable design without personal inputs', async t => {
    const f = await fixture(t);
    const remix = await runTemplateAction(f.config, { ...f.options, action: 'remix', title: '紫罗兰模板', style: { preset: 'violet', radius: 20, showHud: false } });
    const packed = await runTemplateAction(f.config, { slug: 'demo', name: remix.video, action: 'export' });
    const entries = readZip(await fs.readFile(path.join(f.root, packed.output)));
    assert.ok(entries.some(entry => entry.name === `${remix.video}/template-style.json`));
    assert.ok(entries.some(entry => entry.name === `${remix.video}/src/shared.css`));
    assert.ok(!entries.some(entry => entry.name.endsWith('/inputs.json') || entry.name.endsWith('voice.wav') || entry.name.includes('assets/audio/')));
    const received = await unpackVideo(f.config, { file: packed.output, slug: 'received' });
    const editor = await getTemplateEditor(f.config, { slug: received.slug, name: received.video });
    assert.equal(editor.style.values.preset, 'violet');
    assert.equal(editor.style.values.radius, 20);
    assert.equal(editor.style.values.showHud, false);
    assert.equal(editor.inputs.voice, null);
    await runTemplateAction(f.config, { slug: 'demo', name: remix.video, action: 'export' });
});

test('invalid style inputs and failed remix do not change source or leave partial versions', async t => {
    const f = await fixture(t);
    const before = await treeHash(f.dir);
    for (const style of [{ accent: 'red; background:url(https://evil.test)' }, { radius: 999 }, { arbitrary: 'body{}' }, { font: 'url(https://evil.test)' }]) {
        await assert.rejects(saveVideoStyle(f.config, { ...f.options, style }), { code: 'VIDEO_STYLE_INVALID' });
        assert.equal(await treeHash(f.dir), before);
    }
    await assert.rejects(remixTemplate(f.config, { ...f.options, title: '坏模板', style: { accent: 'invalid' } }), { code: 'VIDEO_STYLE_INVALID' });
    assert.deepEqual(await fs.readdir(path.join(f.root, 'productions/demo/videos')), ['demo-v1']);
    assert.equal(await treeHash(f.dir), before);
    await assert.rejects(remixTemplate(f.config, { ...f.options, title: '' }), { code: 'INVALID_INPUT' });
    await saveVideoStyle(f.config, { ...f.options, style: { preset: 'midnight' } });
    await saveVideoStyle(f.config, { ...f.options, style: { preset: 'original' } });
    assert.equal(await fs.readFile(path.join(f.dir, 'src/shared.css'), 'utf8'), css);
});

test('a failure during the initial fork removes the incomplete remix and copied private assets', async t => {
    const f = await fixture(t);
    await f.write('README.md/unusual.txt', 'This path makes the fork rewrite fail.');
    const before = await treeHash(f.dir);
    await assert.rejects(remixTemplate(f.config, { ...f.options, title: '无法完成的新模板' }), { code: 'EISDIR' });
    assert.deepEqual(await fs.readdir(path.join(f.root, 'productions/demo/videos')), ['demo-v1']);
    assert.equal(await treeHash(f.dir), before);
});

test('CLI video:remix reads the style file and requires a useful title', async t => {
    const f = await fixture(t, { frozen: true });
    await fs.writeFile(path.join(f.root, 'style.json'), JSON.stringify({ preset: 'midnight' }));
    const result = await execute(parseArgv(['video:remix', 'demo', '--video', 'demo-v1', '--title', 'CLI新模板', '--style', 'style.json', '--workspace', f.root]), {});
    assert.equal(result.data.command, 'video:remix');
    assert.equal(result.data.title, 'CLI新模板');
    assert.equal((await getTemplateEditor(f.config, { slug: 'demo', name: result.data.video })).style.values.preset, 'midnight');
    await assert.rejects(execute(parseArgv(['video:remix', 'demo', '--video', 'demo-v1', '--workspace', f.root]), {}), { code: 'INVALID_INPUT' });
});

async function web(t, f, deps = {}) {
    const server = createWebServer({ root: f.root, templateDeps: deps });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await server.shutdownTasks(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, { method = 'GET', data, headers = {} } = {}) => fetch(`${base}/api/projects/demo/templates/demo-v1/${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'template', ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const wait = async initial => {
        for (let i = 0; i < 200; i++) {
            const job = await (await request(`jobs/${initial.id}`)).json();
            if (job.status !== 'running') return job;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('Job did not finish');
    };
    const pack = () => fetch(`${base}/api/projects/demo/templates/demo-v1`, { method: 'POST', headers: { 'X-Remake-Action': 'pack' } });
    return { request, wait, pack };
}

test('web style writes obey origin and frozen protections while frozen remix/export succeed', async t => {
    const f = await fixture(t, { frozen: true });
    const api = await web(t, f);
    assert.equal((await api.request('style', { method: 'PUT', data: { style: { preset: 'forest' } }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await api.request('style', { method: 'PUT', data: { style: { preset: 'forest' } } })).status, 409);
    for (const action of [{ action: 'export' }, { action: 'remix', title: '网页新模板', style: { preset: 'violet' } }]) {
        const response = await api.request('jobs', { method: 'POST', data: action });
        assert.equal(response.status, 202, await response.clone().text());
        const result = await api.wait(await response.json());
        assert.equal(result.status, 'succeeded', result.error);
        if (action.action === 'remix') assert.match(result.result.video, /^template-[a-f0-9]{12}-v1$/);
    }
});

test('web style saves are blocked during template jobs and work after cancellation', async t => {
    const f = await fixture(t);
    const api = await web(t, f, { runCommand: async (exe, args, options) => new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ exitCode: null, termination: 'cancelled' }), { once: true })) });
    const response = await api.request('jobs', { method: 'POST', data: { action: 'check' } });
    const job = await response.json();
    assert.equal(response.status, 202);
    assert.equal((await api.request('style', { method: 'PUT', data: { style: { preset: 'forest' } } })).status, 409);
    assert.equal((await api.pack()).status, 409);
    await api.request(`jobs/${job.id}/cancel`, { method: 'POST', data: {} });
    assert.equal((await api.wait(job)).status, 'cancelled');
    assert.equal((await api.request('style', { method: 'PUT', data: { style: { preset: 'forest' } } })).status, 200);
    assert.equal((await api.pack()).status, 200);
});

test('package operation locks cover queued work and release after failure', async t => {
    const f = await fixture(t);
    const controller = createTemplateController({ root: f.root });
    let failQueuedOperation;
    const queue = new Promise((resolve, reject) => { failQueuedOperation = reject; });
    const pending = controller.withPackageLock(f.options, () => queue);
    await assert.rejects(controller.withPackageLock(f.options, () => 'overlap'), { code: 'TEMPLATE_BUSY' });
    const failed = assert.rejects(pending, /queued operation failed/);
    failQueuedOperation(new Error('queued operation failed'));
    await failed;
    assert.equal(await controller.withPackageLock(f.options, () => 'next operation'), 'next operation');
    await controller.close();
});

test('derived templates start independent v1 families and revisions advance only their own family', async t => {
    const f = await fixture(t, { frozen: true });
    const originalHash = await treeHash(f.dir);
    const first = await remixTemplate(f.config, { ...f.options, title: '冷蓝发布会' });
    const other = await remixTemplate(f.config, { ...f.options, title: '森林绿' });
    const get = name => getTemplateEditor(f.config, { slug: 'demo', name });
    const blue = (await get(first.video)).lineage;
    const green = (await get(other.video)).lineage;
    assert.equal(blue.version, 1);
    assert.equal(green.version, 1);
    assert.notEqual(blue.id, green.id);
    assert.equal(blue.kind, 'derived');
    assert.equal(blue.origin.id, 'demo');
    assert.equal(blue.origin.version, 1);
    const second = await remixTemplate(f.config, { ...f.options, name: first.video, title: '冷蓝发布会', mode: 'revise' });
    const third = await remixTemplate(f.config, { ...f.options, name: first.video, title: '冷蓝发布会', mode: 'revise' });
    const two = (await get(second.video)).lineage;
    const three = (await get(third.video)).lineage;
    assert.equal(two.id, blue.id);
    assert.equal(three.id, blue.id);
    assert.equal(two.version, 2);
    assert.equal(three.version, 3, 'forking an older revision still uses the family maximum');
    assert.equal(three.parent.version, 1);
    assert.equal(three.parent.video, first.video);
    assert.equal((await get(other.video)).lineage.version, 1);
    assert.equal(await treeHash(f.dir), originalHash);
    await assert.rejects(remixTemplate(f.config, { ...f.options, title: '原作', mode: 'revise' }), { code: 'INVALID_INPUT' });
    await assert.rejects(remixTemplate(f.config, { ...f.options, title: '无效', mode: 'unknown' }), { code: 'INVALID_INPUT' });
});

test('legacy derived v8 export uses its own v1 identity and keeps original files unchanged', async t => {
    const f = await fixture(t, { frozen: true });
    const originalHash = await treeHash(f.dir);
    const legacy = path.join(f.root, 'productions/demo/videos/demo-v8');
    await fs.cp(f.dir, legacy, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(legacy, 'video.json')));
    manifest.version = 8;
    manifest.title = '历史衍生模板';
    manifest.source = { forkedFrom: { video: 'demo-v1', version: 1, treeHash: originalHash } };
    await fs.writeFile(path.join(legacy, 'video.json'), JSON.stringify(manifest));
    const before = await treeHash(legacy);
    const editor = await getTemplateEditor(f.config, { slug: 'demo', name: 'demo-v8' });
    assert.equal(editor.lineage.version, 1);
    assert.equal(editor.lineage.kind, 'derived');
    const packed = await runTemplateAction(f.config, { slug: 'demo', name: 'demo-v8', action: 'export' });
    const entries = readZip(await fs.readFile(path.join(f.root, packed.output)));
    const exported = JSON.parse(entries.find(entry => entry.name.endsWith('/video.json')).data.toString());
    assert.equal(exported.id, editor.lineage.id);
    assert.equal(exported.version, 1);
    assert.equal(exported.template.lineage.origin.id, 'demo');
    assert.equal(exported.template.lineage.origin.version, 1);
    const received = await unpackVideo(f.config, { file: packed.output, slug: 'received-lineage' });
    const imported = await getTemplateEditor(f.config, { slug: received.slug, name: received.video });
    assert.equal(imported.lineage.id, editor.lineage.id);
    assert.equal(imported.lineage.version, 1);
    assert.equal(imported.lineage.origin.version, 1);
    assert.equal(await treeHash(legacy), before);
    assert.equal(await treeHash(f.dir), originalHash);
});

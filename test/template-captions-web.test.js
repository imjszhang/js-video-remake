import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWebServer } from '../src/web-server.js';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).dependencies.hyperframes;
const defaults = { presenter: { src: null, mediaStart: 0, objectPosition: '50% 30%' }, voice: null, music: null, captions: null, texts: null, identity: { name: '你的名字' } };
const okReport = { ok: true, errors: [], warnings: ['未提供口播'], info: ['使用内置音乐'] };
const missing = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, { runner, report = okReport, probe } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-captions-web-'));
    const dir = path.join(root, 'productions/demo/videos/demo-v1');
    const write = async (file, value) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    await write(path.join(root, 'catalog.json'), { version: 1, references: [], productions: [{ slug: 'demo', title: '模板演示', dir: 'productions/demo', referenceIds: [], status: 'commissioned' }] });
    await write(path.join(dir, 'video.json'), {
        schema: 'video-package@1', id: 'demo', version: 1, title: '测试模板', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, entry: 'index.html', output: 'renders/out.mp4',
        template: { format: 'video-template@1', summary: '测试', inputs: { presenter: { kind: 'video' }, voice: { kind: 'audio' }, music: { kind: 'audio' }, captions: { kind: 'json', count: 2 }, texts: { kind: 'json' }, identity: { kind: 'fields', fields: { name: { default: '你的名字' } } } } },
    });
    await write(path.join(dir, 'package.json'), { dependencies: { hyperframes: version }, scripts: { inputs: 'node tools/inputs.mjs', build: 'node build.mjs', compose: 'node tools/compose.mjs', render: 'hyperframes render' } });
    await write(path.join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes: version } }, 'node_modules/hyperframes': { version } } });
    await write(path.join(dir, 'src/data/captions.json'), [[0, 3, '第一句', 'First line'], [3, 8, '第二句', 'Second line']]);
    const calls = [];
    const fakeRunner = async (executable, args, options) => {
        calls.push({ executable, args, signal: options.signal });
        const intercepted = await runner?.(executable, args, options);
        if (intercepted) return intercepted;
        if (executable === 'npm' && args[0] === 'ci') await write(path.join(options.cwd, 'node_modules/hyperframes/bin/hyperframes.mjs'), '');
        if (args.includes('--init')) await write(path.join(options.cwd, 'inputs.json'), defaults);
        if (args.includes('--json')) return { exitCode: report.ok ? 0 : 1, stdout: JSON.stringify(report), stderr: '' };
        if (args.includes('build')) {
            await write(path.join(options.cwd, 'SCRIPT.md'), '# 录制稿\n0–10秒：你好');
            await write(path.join(options.cwd, 'index.html'), '<html>生成画面</html>');
        }
        if (args.includes('snapshot')) await write(path.join(options.cwd, '.work/preview/contact-sheet.jpg'), 'preview');
        if (executable === 'npm' && args.includes('render')) await write(path.join(options.cwd, 'renders/out.mp4'), 'rendered video');
        return { exitCode: 0, stdout: '', stderr: '' };
    };
    let server;
    let base;
    const start = async () => {
        server = createWebServer({ root, templateDeps: { runCommand: fakeRunner, probe: probe || (async () => ({ duration: 10, width: 1280, height: 720, frameRate: '30/1', frames: 300, audioStreams: 1 })) } });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        base = `http://127.0.0.1:${server.address().port}`;
    };
    const stop = async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    };
    await start();
    t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
    const endpoint = '/api/projects/demo/templates/demo-v1';
    const request = (route, { method = 'GET', data, headers = {}, raw = false } = {}) => fetch(`${base}${endpoint}/${route}`, {
        method, headers: { ...(method !== 'GET' ? { 'X-Remake-Action': 'template', 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...headers },
        ...(data !== undefined ? { body: raw ? data : JSON.stringify(data) } : {}),
    });
    const job = async action => {
        const response = await request('jobs', { method: 'POST', data: typeof action === 'string' ? { action } : action });
        assert.equal(response.status, 202, await response.clone().text());
        return response.json();
    };
    const wait = async job => {
        for (let i = 0; i < 200; i++) {
            const current = await (await request(`jobs/${job.id}`)).json();
            if (current.status !== 'running') { await delay(10); return current; }
            await delay(10);
        }
        throw new Error('Job did not finish');
    };
    return { root, dir, write, calls, request, job, wait, restart: async () => { await stop(); await start(); }, fetch: (route, options) => fetch(`${base}${route}`, options) };
}


test('caption reads and original download are read-only and expose fixed time windows', async t => {
    const f = await fixture(t);
    const before = await fs.readdir(f.dir);
    const response = await f.request('captions');
    assert.equal(response.status, 200, await response.clone().text());
    const captions = await response.json();
    assert.equal(captions.supported, true);
    assert.equal(captions.count, 2);
    assert.equal(captions.source, 'default');
    assert.equal(captions.frozen, false);
    assert.deepEqual(captions.rows.map(({ start, end, zh, en }) => ({ start, end, zh, en })), [
        { start: 0, end: 3, zh: '第一句', en: 'First line' },
        { start: 3, end: 8, zh: '第二句', en: 'Second line' },
    ]);
    assert.deepEqual(captions.original, captions.rows);
    assert.equal(typeof captions.revision, 'string');
    const download = await f.request('captions/original');
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(await download.json(), captions.original.map(({ at, zh, en }) => ({ at, zh, en })));
    assert.deepEqual(await fs.readdir(f.dir), before);
    assert.equal(f.calls.length, 0);
    await missing(path.join(f.dir, 'inputs.json'));
    await missing(path.join(f.root, 'productions/demo/drafts'));
});

test('caption save preserves other material settings, invalidates previews and is used by the next preview', async t => {
    let observed;
    const f = await fixture(t, { runner: async (executable, args, options) => {
        if (args.includes('build')) {
            const inputs = JSON.parse(await fs.readFile(path.join(options.cwd, 'inputs.json'), 'utf8'));
            observed = JSON.parse(await fs.readFile(path.join(options.cwd, inputs.captions), 'utf8'));
        }
    } });
    const originalSource = await fs.readFile(path.join(f.dir, 'src/data/captions.json'), 'utf8');
    await f.write(path.join(f.dir, 'inputs.json'), { ...defaults, identity: { name: '已有个人信息' } });
    await f.write(path.join(f.dir, '.work/preview/old.png'), 'old');
    const current = await (await f.request('captions')).json();
    const rows = current.rows.map(row => ({ ...row, zh: `${row.zh}已修改`, en: `${row.en} updated` }));
    const response = await f.request('captions', { method: 'PUT', data: { rows, revision: current.revision } });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.deepEqual(saved.inputs.identity, { name: '已有个人信息' });
    assert.match(saved.inputs.captions, /^inputs\/uploads\//);
    assert.equal(saved.captions.source, 'custom');
    assert.equal(saved.captions.rows[0].zh, '第一句已修改');
    assert.notEqual(saved.captions.revision, current.revision);
    assert.equal(await fs.readFile(path.join(f.dir, 'src/data/captions.json'), 'utf8'), originalSource);
    await missing(path.join(f.dir, '.work/preview/old.png'));
    const reloaded = await (await f.request('captions')).json();
    assert.equal(reloaded.rows[1].en, 'Second line updated');
    assert.equal(reloaded.original[1].en, 'Second line');
    const preview = await f.wait(await f.job({ action: 'preview', at: [1] }));
    assert.equal(preview.status, 'succeeded', preview.error);
    assert.deepEqual(observed.map(row => row.zh), ['第一句已修改', '第二句已修改']);
    assert.equal(await (await f.request('preview/contact-sheet.jpg')).text(), 'preview');
});

test('caption edits reject changed timing, wrong counts, invalid text and stale updates without changing saved values', async t => {
    const f = await fixture(t);
    const current = await (await f.request('captions')).json();
    const request = rows => f.request('captions', { method: 'PUT', data: { rows, revision: current.revision } });
    for (const rows of [
        current.rows.slice(1),
        current.rows.map((row, index) => index ? row : { ...row, start: 1 }),
        current.rows.map((row, index) => index ? row : { ...row, at: '1–3' }),
        current.rows.map((row, index) => index ? row : { ...row, zh: '' }),
        current.rows.map((row, index) => index ? row : { ...row, en: 'x'.repeat(2001) }),
    ]) {
        assert.equal((await request(rows)).status, 400);
    }
    assert.equal((await f.request('captions', { method: 'PUT', data: { rows: current.rows }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    await missing(path.join(f.dir, 'inputs.json'));
    const first = await request(current.rows.map(row => ({ zh: `${row.zh}新稿`, en: '' })));
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal((await request(current.rows)).status, 409);
    const reloaded = await (await f.request('captions')).json();
    assert.equal(reloaded.rows[0].zh, '第一句新稿');
    assert.equal(reloaded.rows[0].en, '');
});

test('existing uploaded captions are merged over the original while original downloads remain unchanged', async t => {
    const f = await fixture(t);
    await f.write(path.join(f.dir, 'inputs/uploaded.json'), [{ zh: '上传中文', en: 'Uploaded English' }, ['另一个上传中文', 'Another uploaded English']]);
    await f.write(path.join(f.dir, 'inputs.json'), { ...defaults, captions: 'inputs/uploaded.json' });
    const current = await (await f.request('captions')).json();
    assert.equal(current.source, 'custom');
    assert.equal(current.rows[0].zh, '上传中文');
    assert.equal(current.rows[1].en, 'Another uploaded English');
    const original = await (await f.request('captions/original')).json();
    assert.equal(original[0].zh, '第一句');
});

test('original manuscript remains downloadable when saved inputs or uploaded captions are broken', async t => {
    const f = await fixture(t);
    for (const inputs of [
        '{ invalid JSON',
        { ...defaults, captions: 'inputs/missing.json' },
        { ...defaults, captions: 'inputs/broken.json' },
    ]) {
        await f.write(path.join(f.dir, 'inputs/broken.json'), [{ zh: '错误条数' }]);
        await f.write(path.join(f.dir, 'inputs.json'), inputs);
        assert.equal((await f.request('captions')).status, 400);
        const response = await f.request('captions/original');
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual((await response.json()).map(row => row.zh), ['第一句', '第二句']);
    }
    assert.equal(f.calls.length, 0);
});

test('frozen templates allow reading and original download but reject caption writes', async t => {
    const f = await fixture(t);
    await f.write(path.join(f.root, 'productions/demo/drafts/demo-v1/MANIFEST.json'), { package: {} });
    const current = await (await f.request('captions')).json();
    assert.equal(current.frozen, true);
    assert.equal((await f.request('captions/original')).status, 200);
    assert.equal((await f.request('captions', { method: 'PUT', data: { rows: current.rows } })).status, 409);
    await missing(path.join(f.dir, 'inputs.json'));
});

test('caption adapters report missing sources as unsupported and reject linked or external files', async t => {
    const f = await fixture(t);
    const source = path.join(f.dir, 'src/data/captions.json');
    await fs.unlink(source);
    const unsupported = await (await f.request('captions')).json();
    assert.equal(unsupported.supported, false);
    assert.equal(typeof unsupported.reason, 'string');
    assert.equal((await f.request('captions', { method: 'PUT', data: { rows: [{ zh: 'x', en: '' }] } })).status, 400);
    const outside = path.join(f.root, 'private.json');
    await f.write(outside, [[0, 3, 'private marker', 'Private']]);
    await fs.symlink(outside, source);
    const linked = await f.request('captions');
    assert.equal(linked.status, 400);
    assert(!await linked.text().then(text => text.includes('private marker')));
    await fs.unlink(source);
    await f.write(source, [[0, 3, '第一句', 'First'], [3, 8, '第二句', 'Second']]);
    await f.write(path.join(f.dir, 'inputs.json'), { ...defaults, captions: outside });
    assert.equal((await f.request('captions')).status, 400);
});

test('running preview keeps caption writes locked until it is cancelled', async t => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = await fixture(t, { runner: async (exe, args, options) => {
        if (exe === 'npm' && args.includes('build')) {
            entered();
            return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ exitCode: null, termination: 'cancelled', stdout: '', stderr: '' }), { once: true }));
        }
    } });
    const current = await (await f.request('captions')).json();
    const job = await f.job({ action: 'preview', at: [1] });
    await started;
    assert.equal((await f.request('captions', { method: 'PUT', data: { rows: current.rows } })).status, 409);
    await f.request(`jobs/${job.id}/cancel`, { method: 'POST', data: {} });
    assert.equal((await f.wait(job)).status, 'cancelled');
    const saved = await f.request('captions', { method: 'PUT', data: { rows: current.rows } });
    assert.equal(saved.status, 200, await saved.clone().text());
});

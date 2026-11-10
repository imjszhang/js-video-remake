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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-web-'));
    const dir = path.join(root, 'productions/demo/videos/demo-v1');
    const write = async (file, value) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    await write(path.join(root, 'catalog.json'), { version: 1, references: [], productions: [{ slug: 'demo', title: '模板演示', dir: 'productions/demo', referenceIds: [], status: 'commissioned' }] });
    await write(path.join(dir, 'video.json'), {
        schema: 'video-package@1', id: 'demo', version: 1, title: '测试模板', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, entry: 'index.html', output: 'renders/out.mp4',
        template: { format: 'video-template@1', summary: '测试', inputs: { presenter: { kind: 'video' }, voice: { kind: 'audio' }, music: { kind: 'audio' }, captions: { kind: 'json', count: 1 }, texts: { kind: 'json' }, identity: { kind: 'fields', fields: { name: { default: '你的名字' } } } } },
    });
    await write(path.join(dir, 'package.json'), { dependencies: { hyperframes: version }, scripts: { inputs: 'node tools/inputs.mjs', build: 'node build.mjs', compose: 'node tools/compose.mjs', render: 'hyperframes render' } });
    await write(path.join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes: version } }, 'node_modules/hyperframes': { version } } });
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

test('editor GET is read-only; saving and uploads only accept declared package-owned inputs', async t => {
    const f = await fixture(t);
    const response = await f.request('editor');
    assert.equal(response.status, 200);
    const editor = await response.json();
    assert.deepEqual(editor.inputs, defaults);
    assert.equal(editor.installed, false);
    assert.equal(editor.job, null);
    assert.equal(f.calls.length, 0);
    await missing(path.join(f.dir, 'inputs.json'));
    const upload = await f.request('assets?kind=voice&filename=voice.wav', { method: 'POST', data: Buffer.from('voice'), raw: true });
    assert.equal(upload.status, 201);
    const asset = await upload.json();
    assert.match(asset.path, /^inputs\/uploads\/voice-/);
    const inputs = { ...defaults, voice: asset.path, identity: { name: '小张' } };
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs } })).status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dir, 'inputs.json'), 'utf8')), inputs);
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs: { ...inputs, voice: '/etc/passwd' } } })).status, 400);
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs: { ...inputs, identity: { admin: 'x' } } } })).status, 400);
    assert.equal((await f.request('assets?kind=captions&filename=captions.json', { method: 'POST', data: Buffer.from('[]'), raw: true })).status, 400);
    assert.equal((await f.request('assets?kind=texts&filename=texts.json', { method: 'POST', data: Buffer.from('{"title":"你好"}'), raw: true })).status, 201);
    assert.equal((await f.request('jobs', { method: 'POST', data: { action: 'prepare' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs }, headers: { 'X-Remake-Action': '' } })).status, 403);
    assert.equal((await f.request('jobs', { method: 'POST', data: { action: 'shell' } })).status, 400);
});

test('prepare, checks, previews and compose complete through jobs and register a frozen playable draft', async t => {
    const f = await fixture(t);
    assert.equal((await f.wait(await f.job('prepare'))).status, 'succeeded');
    assert.match((await (await f.request('editor')).json()).script, /录制稿/);
    const check = await f.wait(await f.job('check'));
    assert.deepEqual(check.result.report, okReport);
    const preview = await f.wait(await f.job({ action: 'preview', at: [1, 5] }));
    assert.equal(preview.status, 'succeeded', preview.error);
    assert.deepEqual(preview.result.previewFiles, ['contact-sheet.jpg']);
    assert.equal(await (await f.request('preview/contact-sheet.jpg')).text(), 'preview');
    const compose = await f.wait(await f.job('compose'));
    assert.equal(compose.status, 'succeeded', compose.error);
    assert.equal(compose.result.imported.renderVerified, true);
    const library = await (await f.fetch('/api/projects')).json();
    assert.equal(library.projects[0].videos.length, 1);
    const editor = await (await f.request('editor')).json();
    assert.equal(editor.frozen, true);
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs: defaults } })).status, 409);
    assert.equal((await f.request('assets?kind=voice&filename=voice.wav', { method: 'POST', data: 'voice', raw: true })).status, 409);
    assert.equal((await f.request('jobs', { method: 'POST', data: { action: 'preview' } })).status, 409);
    const fork = await f.wait(await f.job('fork'));
    assert.equal(fork.status, 'succeeded', fork.error);
    assert.match(fork.result.video, /^template-[a-f0-9]{12}-v1$/);
});

test('failed input checks are visible and block previews and rendering', async t => {
    const report = { ok: false, errors: ['口播时长不足'], warnings: [], info: [] };
    const f = await fixture(t, { report });
    assert.deepEqual((await f.wait(await f.job('check'))).result.report, report);
    const compose = await f.wait(await f.job('compose'));
    assert.equal(compose.status, 'failed');
    assert.deepEqual(compose.report, report);
    assert.ok(!f.calls.some(call => call.args.includes('render')));
    await missing(path.join(f.root, 'productions/demo/drafts/demo-v1/MANIFEST.json'));
});

test('active jobs reject writes and duplicate starts; cancel propagates to the subprocess', async t => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = await fixture(t, { runner: async (exe, args, options) => {
        if (exe === 'npm' && args.includes('build')) {
            entered();
            return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ exitCode: null, termination: 'cancelled', stdout: '', stderr: '' }), { once: true }));
        }
    } });
    const pending = await f.job('prepare');
    await started;
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs: defaults } })).status, 409);
    assert.equal((await f.request('jobs', { method: 'POST', data: { action: 'prepare' } })).status, 409);
    assert.equal((await f.request('assets?kind=voice&filename=voice.wav', { method: 'POST', data: 'voice', raw: true })).status, 409);
    assert.equal((await f.request(`jobs/${pending.id}/cancel`, { method: 'POST', data: {} })).status, 200);
    assert.equal((await f.wait(pending)).status, 'cancelled');
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs: defaults } })).status, 200);
});

test('saved running jobs become interrupted after restart and preview routes reject links and nonimages', async t => {
    const f = await fixture(t);
    const job = { id: 'dead-beef', status: 'running', action: 'compose' };
    await f.write(path.join(f.root, 'productions/demo/drafts/.template-jobs/demo-v1.json'), job);
    await f.restart();
    const editor = await (await f.request('editor')).json();
    assert.equal(editor.job.status, 'failed');
    assert.equal(editor.job.stage, 'interrupted');
    assert.equal((await (await f.request('jobs/dead-beef')).json()).status, 'failed');
    await f.write(path.join(f.dir, '.work/preview/good.png'), 'image');
    await f.write(path.join(f.root, 'secret.jpg'), 'secret');
    await fs.symlink(path.join(f.root, 'secret.jpg'), path.join(f.dir, '.work/preview/link.jpg'));
    assert.equal((await f.request('preview/good.png')).status, 200);
    assert.equal((await f.request('preview/link.jpg')).status, 404);
    assert.equal((await f.request('preview/video.json')).status, 404);
    assert.equal((await f.request('preview/..%2F..%2Fsecret.jpg')).status, 404);
});

test('job storage rejects symlink directories and previews cannot read a redirected package', async t => {
    const f = await fixture(t);
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(path.join(f.root, 'productions/demo/drafts'), { recursive: true });
    await fs.symlink(outside, path.join(f.root, 'productions/demo/drafts/.template-jobs'));
    assert.equal((await f.request('jobs', { method: 'POST', data: { action: 'prepare' } })).status, 400);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.unlink(path.join(f.root, 'productions/demo/drafts/.template-jobs'));
    await f.write(path.join(f.dir, '.work/preview/secret.png'), 'private');
    const moved = path.join(f.root, 'redirected-package');
    await fs.rename(f.dir, moved);
    await fs.symlink(moved, f.dir);
    assert.equal((await f.request('preview/secret.png')).status, 404);
});


test('a long-running job prevents another package from starting until cancellation completes', async t => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = await fixture(t, { runner: async (exe, args, options) => {
        if (exe === 'npm' && args.includes('build') && options.cwd.endsWith('demo-v1')) {
            entered();
            return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ exitCode: null, termination: 'cancelled', stdout: '', stderr: '' }), { once: true }));
        }
    } });
    const second = path.join(f.root, 'productions/demo/videos/demo-v2');
    await fs.cp(f.dir, second, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(second, 'video.json'), 'utf8'));
    await f.write(path.join(second, 'video.json'), { ...manifest, version: 2 });
    const secondRoute = '/api/projects/demo/templates/demo-v2';
    assert.equal((await f.fetch(`${secondRoute}/editor`)).status, 200);
    const pending = await f.job('prepare');
    await started;
    const startSecond = () => f.fetch(`${secondRoute}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'template' }, body: JSON.stringify({ action: 'check' }) });
    assert.equal((await startSecond()).status, 409);
    await f.request(`jobs/${pending.id}/cancel`, { method: 'POST', data: {} });
    assert.equal((await f.wait(pending)).status, 'cancelled');
    const response = await startSecond();
    assert.equal(response.status, 202);
    const next = await response.json();
    for (let i = 0; i < 100; i++) {
        const state = await (await f.fetch(`${secondRoute}/jobs/${next.id}`)).json();
        if (state.status !== 'running') {
            assert.equal(state.status, 'succeeded');
            await delay(10);
            return;
        }
        await delay(10);
    }
    assert.fail('Second package job did not finish');
});


test('cancellation during completed-render registration preserves a successful playable result', async t => {
    let enterProbe, releaseProbe;
    const entered = new Promise(resolve => { enterProbe = resolve; });
    const released = new Promise(resolve => { releaseProbe = resolve; });
    const f = await fixture(t, { probe: async () => {
        enterProbe();
        await released;
        return { duration: 10, width: 1280, height: 720, frameRate: '30/1', frames: 300, audioStreams: 1 };
    } });
    t.after(() => releaseProbe());
    const pending = await f.job('compose');
    await entered;
    const registering = await (await f.request(`jobs/${pending.id}`)).json();
    assert.equal(registering.status, 'running');
    assert.equal(registering.stage, 'register');
    assert.equal((await f.request(`jobs/${pending.id}/cancel`, { method: 'POST', data: {} })).status, 200);
    releaseProbe();
    const completed = await f.wait(pending);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.result.imported.renderVerified, true);
    assert.equal((await (await f.request('editor')).json()).frozen, true);
    const library = await (await f.fetch('/api/projects')).json();
    assert.equal(library.projects[0].videos.length, 1);
    const video = library.projects[0].videos[0];
    assert.equal(await (await f.fetch(`/${video.url}`)).text(), 'rendered video');
});

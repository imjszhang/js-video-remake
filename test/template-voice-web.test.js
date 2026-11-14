import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWebServer } from '../src/web-server.js';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).dependencies.hyperframes;
const defaults = { voice: null, captions: null, identity: { name: '你的名字' } };
const audioBytes = Buffer.from('RIFF-fixture-WAVE-generated-speech');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, { synthesize, options } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-voice-web-'));
    const dir = path.join(root, 'productions/demo/videos/demo-v1');
    const write = async (file, value) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    await write(path.join(root, 'catalog.json'), { version: 1, references: [], productions: [{ slug: 'demo', title: '模板演示', dir: 'productions/demo', referenceIds: [], status: 'commissioned' }] });
    await write(path.join(dir, 'video.json'), {
        schema: 'video-package@1', id: 'demo', version: 1, title: '测试模板', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, entry: 'index.html', output: 'renders/out.mp4',
        template: { format: 'video-template@1', inputs: { voice: { kind: 'audio' }, captions: { kind: 'json', count: 2 }, identity: { kind: 'fields', fields: { name: { default: '你的名字' } } } } },
    });
    await write(path.join(dir, 'package.json'), { dependencies: { hyperframes: version }, scripts: { inputs: 'node tools/inputs.mjs', build: 'node build.mjs', compose: 'node tools/compose.mjs', render: 'hyperframes render' } });
    await write(path.join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes: version } }, 'node_modules/hyperframes': { version } } });
    await write(path.join(dir, 'src/data/captions.json'), [[0, 3, '第一句', 'First line'], [3, 8, '第二句', 'Second line']]);
    const calls = [];
    const scripts = [];
    const templateDeps = {
        speechOptions: options || (async () => ({ provider: 'fixture', label: '测试语音', available: true, voices: [{ id: 'zh-test', label: '测试中文' }], defaultVoice: 'zh-test' })),
        synthesizeCaptionSpeech: async (config, args, deps) => {
            calls.push({ args: structuredClone(args), signal: deps.signal });
            if (synthesize) return synthesize(config, args, deps, write);
            await write(args.outputFile, audioBytes);
            return { provider: 'fixture', voice: args.voice, language: args.language, count: args.rows.length, duration: args.duration, firstAt: args.rows[0].start };
        },
        runCommand: async (...args) => { scripts.push(args); throw new Error('Speech must not run template scripts'); },
    };
    let server;
    let base;
    const start = async () => {
        server = createWebServer({ root, templateDeps });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        base = `http://127.0.0.1:${server.address().port}`;
    };
    const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
    await start();
    t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
    const request = (route, { method = 'GET', data, headers = {} } = {}) => fetch(`${base}/api/projects/demo/templates/demo-v1/${route}`, {
        method, headers: { ...(!['GET', 'HEAD'].includes(method) ? { 'X-Remake-Action': 'template', 'Content-Type': 'application/json' } : {}), ...headers },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const job = async data => {
        const response = await request('jobs', { method: 'POST', data: { action: 'voice', voice: 'zh-test', language: 'zh', ...data } });
        assert.equal(response.status, 202, await response.clone().text());
        return response.json();
    };
    const wait = async job => {
        for (let i = 0; i < 200; i++) {
            const current = await (await request(`jobs/${job.id}`)).json();
            if (current.status !== 'running') { await delay(10); return current; }
            await delay(10);
        }
        throw new Error('Voice job did not finish');
    };
    const readInputs = async () => JSON.parse(await fs.readFile(path.join(dir, 'inputs.json'), 'utf8'));
    return { root, dir, calls, scripts, write, request, job, wait, readInputs, restart: async () => { await stop(); await start(); } };
}

test('speech options are read-only and audio is absent before generation', async t => {
    const f = await fixture(t);
    const before = await fs.readdir(f.dir);
    const response = await f.request('voice');
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.available, true);
    assert.equal(data.supported, true);
    assert.equal(data.provider, 'fixture');
    assert.equal(data.defaultVoice, 'zh-test');
    assert.equal(data.audio, null);
    assert.equal(data.revision, (await (await f.request('captions')).json()).revision);
    assert.equal((await f.request('voice/audio')).status, 404);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await fs.readdir(f.dir), before);
});

test('edited captions and saved identity drive asynchronous speech and attach playable audio', async t => {
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const release = new Promise(resolve => { finish = resolve; });
    const f = await fixture(t, { synthesize: async (config, args, deps, write) => {
        await deps.onProgress?.({ stage: 'voice', message: '正在生成第 1 / 2 句' });
        entered(); await release;
        await write(args.outputFile, audioBytes);
        return { provider: 'fixture', voice: args.voice, language: args.language, count: 2, duration: args.duration, firstAt: 0 };
    } });
    t.after(() => finish());
    await f.write(path.join(f.dir, 'inputs.json'), { ...defaults, identity: { name: '已保存名字' } });
    const captions = await (await f.request('captions')).json();
    const rows = captions.rows.map((row, index) => ({ ...row, zh: `修改后的第${index + 1}句`, en: `Changed ${index + 1}` }));
    const saved = await f.request('captions', { method: 'PUT', data: { rows, revision: captions.revision } });
    assert.equal(saved.status, 200, await saved.clone().text());
    const speech = await (await f.request('voice')).json();
    const job = await f.job({ revision: speech.revision });
    await started;
    const refreshing = await (await f.request('editor')).json();
    assert.equal(refreshing.job.id, job.id);
    assert.equal(refreshing.job.status, 'running');
    assert.match(refreshing.job.message, /1 \/ 2/);
    assert.equal((await f.request('inputs', { method: 'PUT', data: { inputs: defaults } })).status, 409);
    assert.equal((await f.request('captions', { method: 'PUT', data: { rows } })).status, 409);
    assert.deepEqual(f.calls[0].args.rows.map(row => row.zh), ['修改后的第1句', '修改后的第2句']);
    assert.deepEqual(f.calls[0].args.identity, { name: '已保存名字' });
    assert.equal(f.calls[0].args.duration, 10);
    assert.equal(f.calls[0].args.voice, 'zh-test');
    assert.equal(f.calls[0].args.language, 'zh');
    finish();
    const completed = await f.wait(job);
    assert.equal(completed.status, 'succeeded', completed.error);
    const inputs = await f.readInputs();
    assert.match(inputs.voice, /^inputs\/uploads\/voice-[a-f0-9-]+\.wav$/);
    assert.equal(inputs.identity.name, '已保存名字');
    assert.equal(completed.result.inputs.voice, inputs.voice);
    assert.deepEqual(await fs.readFile(path.join(f.dir, inputs.voice)), audioBytes);
    assert.equal(f.scripts.length, 0);
    await f.restart();
    const restored = await (await f.request('voice')).json();
    assert.equal(restored.audio.path, inputs.voice);
    assert.equal(restored.audio.stale, false);
    assert.equal(restored.audio.voice, 'zh-test');
    assert.equal((await (await f.request('editor')).json()).job.status, 'succeeded');
    const audio = await f.request('voice/audio');
    assert.equal(audio.status, 200);
    assert.match(audio.headers.get('content-type'), /audio/);
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), audioBytes);
    const range = await f.request('voice/audio', { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'RIFF');
    const head = await f.request('voice/audio', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
});

test('failed or cancelled speech leaves previous voice and material settings intact', async t => {
    for (const cancelled of [false, true]) await t.test(cancelled ? 'cancel' : 'failure', async t => {
        let entered;
        const started = new Promise(resolve => { entered = resolve; });
        const f = await fixture(t, { synthesize: async (config, args, deps, write) => {
            await write(args.outputFile, 'partial-audio'); entered();
            if (cancelled) await new Promise((resolve, reject) => deps.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
            throw new Error('模拟语音失败');
        } });
        const old = { ...defaults, voice: 'inputs/old.wav', identity: { name: '保留名字' } };
        await f.write(path.join(f.dir, 'inputs/old.wav'), 'old-audio');
        await f.write(path.join(f.dir, 'inputs.json'), old);
        const job = await f.job(); await started;
        if (cancelled) assert.equal((await f.request(`jobs/${job.id}/cancel`, { method: 'POST', data: {} })).status, 200);
        const terminal = await f.wait(job);
        assert.equal(terminal.status, cancelled ? 'cancelled' : 'failed');
        assert.deepEqual(await f.readInputs(), old);
        assert.equal(await fs.readFile(path.join(f.dir, old.voice), 'utf8'), 'old-audio');
        await assert.rejects(fs.stat(f.calls[0].args.outputFile), { code: 'ENOENT' });
        await assert.rejects(fs.stat(`${f.calls[0].args.outputFile}.json`), { code: 'ENOENT' });
    });
});

test('voice job resolves an uploaded reference clip and rejects paths outside the package', async t => {
    const f = await fixture(t);
    await f.write(path.join(f.dir, 'inputs/uploads/voice-ref.wav'), 'reference-audio');
    const completed = await f.wait(await f.job({ reference: 'inputs/uploads/voice-ref.wav', referenceText: '参考原话' }));
    assert.equal(completed.status, 'succeeded', completed.error);
    assert.equal(f.calls[0].args.referenceText, '参考原话');
    assert.ok(f.calls[0].args.reference.endsWith(`${path.sep}inputs${path.sep}uploads${path.sep}voice-ref.wav`));
    const escaped = await f.wait(await f.job({ reference: 'inputs/uploads/../../secret.wav', referenceText: '不行' }));
    assert.equal(escaped.status, 'failed');
    assert.equal(f.calls.length, 1);
});

test('speech rejects frozen templates, cross-site requests and stale caption revisions', async t => {
    const f = await fixture(t);
    const original = await (await f.request('captions')).json();
    const current = await f.request('captions', { method: 'PUT', data: { revision: original.revision, rows: original.rows.map(row => ({ ...row, zh: row.zh + '已改' })) } });
    assert.equal(current.status, 200);
    const stale = await f.wait(await f.job({ revision: original.revision }));
    assert.equal(stale.status, 'failed');
    assert.equal(f.calls.length, 0);
    const crossSite = await f.request('jobs', { method: 'POST', data: { action: 'voice', voice: 'zh-test', language: 'zh' }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    await f.write(path.join(f.root, 'productions/demo/drafts/demo-v1/MANIFEST.json'), { package: {} });
    assert.equal((await (await f.request('voice')).json()).frozen, true);
    assert.equal((await f.request('jobs', { method: 'POST', data: { action: 'voice', voice: 'zh-test', language: 'zh' } })).status, 409);
    assert.equal(f.calls.length, 0);
});

test('speech metadata becomes stale when captions or identity change', async t => {
    const f = await fixture(t);
    assert.equal((await f.wait(await f.job())).status, 'succeeded');
    assert.equal((await (await f.request('voice')).json()).audio.stale, false);
    const inputs = await f.readInputs();
    const saved = await f.request('inputs', { method: 'PUT', data: { inputs: { ...inputs, identity: { name: '另一个名字' } } } });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await (await f.request('voice')).json()).audio.stale, true);
    assert.equal((await f.wait(await f.job())).status, 'succeeded');
    assert.equal((await (await f.request('voice')).json()).audio.stale, false);
    const captions = await (await f.request('captions')).json();
    assert.equal((await f.request('captions', { method: 'PUT', data: { revision: captions.revision, rows: captions.rows.map(row => ({ ...row, zh: row.zh + '新文本' })) } })).status, 200);
    assert.equal((await (await f.request('voice')).json()).audio.stale, true);
});

test('voice audio does not expose paths outside the template or linked files', async t => {
    const f = await fixture(t);
    const outside = path.join(f.root, 'private.wav');
    await f.write(outside, 'private-audio-marker');
    await f.write(path.join(f.dir, 'inputs.json'), { ...defaults, voice: outside });
    const external = await f.request('voice/audio');
    assert.equal(external.status, 404);
    assert(!await external.text().then(text => text.includes('private-audio-marker')));
    await fs.mkdir(path.join(f.dir, 'inputs'), { recursive: true });
    await fs.symlink(outside, path.join(f.dir, 'inputs/linked.wav'));
    await f.write(path.join(f.dir, 'inputs.json'), { ...defaults, voice: 'inputs/linked.wav' });
    const linked = await f.request('voice/audio');
    assert.equal(linked.status, 400);
    assert(!await linked.text().then(text => text.includes('private-audio-marker')));
});


test('external material edits during speech prevent an outdated audio commit', async t => {
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const release = new Promise(resolve => { finish = resolve; });
    const f = await fixture(t, { synthesize: async (config, args, deps, write) => {
        entered(); await release;
        await write(args.outputFile, audioBytes);
        return { provider: 'fixture', voice: args.voice, language: args.language, duration: args.duration, count: 2, firstAt: 0 };
    } });
    t.after(() => finish());
    await f.write(path.join(f.dir, 'inputs/old.wav'), 'old-audio');
    const original = { ...defaults, voice: 'inputs/old.wav' };
    await f.write(path.join(f.dir, 'inputs.json'), original);
    const job = await f.job(); await started;
    const external = { ...original, identity: { name: '外部最新名字' } };
    await f.write(path.join(f.dir, 'inputs.json'), external);
    finish();
    const result = await f.wait(job);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /生成期间.*更新/);
    assert.deepEqual(await f.readInputs(), external);
    await assert.rejects(fs.stat(f.calls[0].args.outputFile), { code: 'ENOENT' });
});

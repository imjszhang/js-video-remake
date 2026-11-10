import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createReferenceController } from '../src/reference-web.js';

async function fixture(t, deps = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-reference-api-'));
    const controller = createReferenceController({ root, deps: { env: {}, ...deps } });
    const server = http.createServer(async (request, response) => {
        if (!await controller.handle(request, response, new URL(request.url, 'http://localhost'))) {
            response.writeHead(404); response.end();
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        await controller.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    async function request(route = '', { method = 'GET', body, headers = {}, raw } = {}) {
        const response = await fetch(`${base}/api/references${route}`, {
            method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Remake-Action': 'references' } : {}), ...headers },
            body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        const data = method === 'HEAD' ? null : await response.json();
        return { status: response.status, headers: response.headers, data };
    }
    const post = (route, body, headers) => request(route, { method: 'POST', body, headers });
    const write = async (file, data = 'fixture-video') => {
        const absolute = path.join(root, file);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, data);
        return absolute;
    };
    return { root, base, controller, request, post, write };
}

async function waitJob(f, id, terminal = true) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await f.request(`/jobs/${id}`);
        if (!terminal || response.data.job.status !== 'running') return response.data.job;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('job did not settle');
}

function mockDownload({ gate, onCall } = {}) {
    return async (executable, args, options) => {
        onCall?.(executable, args, options);
        if (args.includes('--version') || args.includes('-version')) return { stdout: 'fixture-version\n' };
        if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ title: '下载原片', duration: 10, webpage_url: 'https://example.com/demo' }) };
        if (gate) await gate(options);
        const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
        await fs.writeFile(output, 'downloaded-video');
        return { stdout: JSON.stringify({ filepath: output, title: '下载原片', duration: 10, webpage_url: 'https://example.com/demo' }) };
    };
}

test('reference API reads an empty catalog without creating data, imports local files and starts linked productions', async t => {
    const f = await fixture(t);
    assert.deepEqual((await f.request()).data.references, []);
    await assert.rejects(fs.access(path.join(f.root, 'catalog.json')), { code: 'ENOENT' });
    await f.write('incoming/demo.mp4');
    const imported = await f.post('/import', { file: 'incoming/demo.mp4', id: 'demo', title: '参考标题' });
    assert.equal(imported.status, 201);
    assert.equal(imported.data.references[0].id, 'local-demo');
    let list = await f.request();
    assert.equal(list.data.references[0].title, '参考标题');
    assert.equal(list.data.references[0].available, true);
    const started = await f.post('/start', { referenceId: 'local-demo', slug: 'remake-demo' });
    assert.equal(started.status, 201);
    assert.deepEqual(started.data.production.referenceIds, ['local-demo']);
    list = await f.request();
    assert.deepEqual(list.data.references[0].productions, ['remake-demo']);
    assert.equal((await f.post('/start', { referenceId: 'local-demo', slug: 'remake-demo' })).status, 409);
    await fs.unlink(path.join(f.root, 'incoming/demo.mp4'));
    assert.equal((await f.post('/start', { referenceId: 'local-demo', slug: 'unavailable' })).status, 400);
    await assert.rejects(fs.access(path.join(f.root, 'productions/unavailable')), { code: 'ENOENT' });
});

test('manifest and selected scan imports use supplied paths while preview remains read-only', async t => {
    const f = await fixture(t);
    await f.write('incoming/a.mp4', 'a');
    await f.write('incoming/nested/b.mov', 'b');
    const preview = await f.post('/scan', { directory: 'incoming', recursive: true, import: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.candidates.length, 2);
    assert.deepEqual(preview.data.imported, []);
    await assert.rejects(fs.access(path.join(f.root, 'catalog.json')), { code: 'ENOENT' });
    assert.equal((await f.post('/scan/import', { directory: 'incoming', select: [] })).status, 400);
    assert.equal((await f.post('/scan/import', { directory: 'incoming', select: ['../a.mp4'] })).status, 400);
    const chosen = await f.post('/scan/import', { directory: 'incoming', recursive: true, select: ['nested/b.mov'] });
    assert.equal(chosen.status, 201);
    assert.equal(chosen.data.imported.length, 1);
    await f.write('sources.json', JSON.stringify({ schema: 'video-remake.source-list@1', items: [
        { video: { videoId: 'external', platform: 'example', status: 'downloaded', title: '清单参考' }, files: { video: 'a.mp4' } },
    ] }));
    const manifest = await f.post('/import', { manifest: 'sources.json', assetRoot: 'incoming' });
    assert.equal(manifest.status, 201);
    assert.equal(manifest.data.references[0].id, 'example-external');
    assert.equal((await f.request()).data.references.length, 2);
});

test('reference mutation APIs reject cross-site requests, unsupported methods and oversized/invalid input', async t => {
    const f = await fixture(t);
    const body = { file: 'never.mp4' };
    assert.equal((await f.post('/import', body, { 'X-Remake-Action': '' })).status, 403);
    assert.equal((await f.post('/import', body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await f.post('/import', body, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await f.post('/import', body, { Origin: 'null' })).status, 403);
    assert.equal((await f.request('/import')).status, 405);
    assert.equal((await f.post('', {})).status, 405);
    assert.equal((await f.request('/unknown')).status, 404);
    assert.equal((await f.request('/import', { method: 'POST', raw: '{broken' })).status, 400);
    assert.equal((await f.post('/import', [])).status, 400);
    assert.equal((await f.post('/import', body, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await f.post('/import', { file: 'a'.repeat(65536) })).status, 413);
    assert.equal((await f.request('', { method: 'HEAD' })).status, 200);
    await assert.rejects(fs.access(path.join(f.root, 'catalog.json')), { code: 'ENOENT' });
});

test('download starts asynchronously, rejects duplicates and queues only registration so other imports remain usable', async t => {
    let release;
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let queueCalls = 0;
    let serial = Promise.resolve();
    const f = await fixture(t, {
        runDownload: mockDownload({ gate: async () => { entered(); await gate; } }),
        withCatalogWrite(operation) {
            queueCalls += 1;
            const pending = serial.then(operation); serial = pending.catch(() => {}); return pending;
        },
    });
    t.after(() => release());
    const started = await f.post('/download', { url: 'https://example.com/demo', quality: '720' });
    assert.equal(started.status, 202);
    await reached;
    assert.equal(queueCalls, 0);
    assert.equal((await f.post('/download', { url: 'https://example.com/other' })).status, 409);
    assert.equal((await waitJob(f, started.data.job.id, false)).status, 'running');
    await f.write('local.mp4', 'other-local-file');
    const imported = await f.post('/import', { file: 'local.mp4', id: 'local' });
    assert.equal(imported.status, 201);
    assert.equal(queueCalls, 1);
    release();
    const job = await waitJob(f, started.data.job.id);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.references.length, 1);
    assert.equal(queueCalls, 2);
    assert.equal((await f.request()).data.references.length, 2);
    assert.equal((await f.request('/jobs')).data.jobs[0].id, job.id);
});

test('download input is validated before a job is accepted and doctor remains an offline version probe', async t => {
    const calls = [];
    const f = await fixture(t, { runDownload: mockDownload({ onCall: (exe, args) => calls.push({ exe, args }) }) });
    for (const body of [
        { url: 'file:///tmp/video' }, { url: 'https://user:secret@example.com/video' },
        { url: 'https://example.com/video', quality: 'audio' }, { url: 'not a link' },
    ]) assert.equal((await f.post('/download', body)).status, 400);
    assert.deepEqual((await f.request('/jobs')).data.jobs, []);
    assert.equal(calls.length, 0);
    const doctor = await f.request('/download/doctor');
    assert.equal(doctor.status, 200);
    assert.equal(doctor.data.ready, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.args.includes('--version') || call.args.includes('-version')));
    assert.equal((await f.request('/jobs/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('failed registration keeps downloaded file and exposes its recovery path in the polled job', async t => {
    const f = await fixture(t, { runDownload: mockDownload() });
    await f.write('catalog.json', '{broken');
    const started = await f.post('/download', { url: 'https://example.com/demo' });
    assert.equal(started.status, 202);
    const job = await waitJob(f, started.data.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'DOWNLOAD_IMPORT_FAILED');
    assert.equal(job.error.data.retained, true);
    assert.equal(await fs.readFile(job.error.data.file, 'utf8'), 'downloaded-video');
});

test('shutdown aborts active download and rejects later mutations without registering a partial reference', async t => {
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    let receivedSignal;
    const f = await fixture(t, {
        runDownload: mockDownload({ gate: options => new Promise((resolve, reject) => {
            receivedSignal = options.signal;
            entered();
            options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'DOWNLOAD_CANCELLED' })), { once: true });
        }) }),
    });
    const started = await f.post('/download', { url: 'https://example.com/demo' });
    await reached;
    await f.controller.close();
    assert.equal(receivedSignal.aborted, true);
    const job = await waitJob(f, started.data.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'DOWNLOAD_CANCELLED');
    assert.equal((await f.post('/import', { file: 'a.mp4' })).status, 503);
    assert.deepEqual((await f.request()).data.references, []);
});

test('download history retains only the latest twenty completed jobs', async t => {
    const f = await fixture(t, { runDownload: async () => { throw Object.assign(new Error('fixture missing tool'), { code: 'ENOENT' }); } });
    const ids = [];
    for (let index = 0; index < 21; index += 1) {
        const started = await f.post('/download', { url: `https://example.com/video/${index}` });
        assert.equal(started.status, 202);
        ids.push(started.data.job.id);
        assert.equal((await waitJob(f, started.data.job.id)).status, 'failed');
    }
    const list = await f.request('/jobs');
    assert.equal(list.data.jobs.length, 20);
    assert.equal(list.data.jobs[0].id, ids.at(-1));
    assert.equal((await f.request(`/jobs/${ids[0]}`)).status, 404);
    await assert.rejects(fs.access(path.join(f.root, 'catalog.json')), { code: 'ENOENT' });
});

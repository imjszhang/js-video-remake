import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWebServer } from '../src/web-server.js';
import { writeZip } from '../src/zip.js';

const rootPackage = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = rootPackage.dependencies.hyperframes;
function template(id = 'demo') {
    const files = {
        'video.json': { schema: 'video-package@1', id, version: 1, title: '测试模板', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, entry: 'index.html', output: 'renders/out.mp4', template: { format: 'video-template@1', inputs: {} } },
        'package.json': { dependencies: { hyperframes: version }, scripts: { inputs: 'node tools/inputs.mjs', build: 'node build.mjs', compose: 'node tools/compose.mjs', render: 'hyperframes render' } },
        'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes: version } }, 'node_modules/hyperframes': { version } } },
    };
    return writeZip(Object.entries(files).map(([name, data]) => ({ name: `${id}-v1/${name}`, data: JSON.stringify(data) })));
}
async function serve(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-web-import-'));
    const server = createWebServer({ root });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const upload = (data, slug = '', headers = {}) => fetch(`${base}/api/templates/import${slug ? `?slug=${slug}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Remake-Action': 'import', ...headers }, body: data,
    });
    return { root, base, upload };
}

test('web imports an external template and exposes its project without executing scripts', async (t) => {
    const f = await serve(t);
    const response = await f.upload(template());
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.slug, 'demo');
    assert.equal(result.installed, false);
    const projects = await (await fetch(`${f.base}/api/projects`)).json();
    assert.equal(projects.projects.length, 1);
    assert.deepEqual(projects.projects[0].videos, []);
    assert.equal(projects.projects[0].templatePackages.length, 1);
    await assert.rejects(fs.stat(path.join(f.root, result.dir, 'node_modules')), { code: 'ENOENT' });
    const duplicate = await f.upload(template());
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /已有|存在/);
    assert.equal((await f.upload(template(), 'another')).status, 201);
});

test('web rejects cross-site uploads, invalid bodies and invalid slugs without creating projects', async (t) => {
    const f = await serve(t);
    assert.equal((await f.upload(template(), '', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await f.upload(template(), '', { 'X-Remake-Action': '' })).status, 403);
    assert.equal((await f.upload(template(), '', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await f.upload(Buffer.alloc(0))).status, 400);
    assert.equal((await f.upload(Buffer.from('broken'))).status, 400);
    assert.equal((await f.upload(template(), '../escape')).status, 400);
    const projects = await (await fetch(`${f.base}/api/projects`)).json();
    assert.deepEqual(projects.projects, []);
});

test('web bounds declared upload sizes before accepting a body', async (t) => {
    const f = await serve(t);
    const status = await new Promise((resolve, reject) => {
        const request = http.request(`${f.base}/api/templates/import`, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Remake-Action': 'import', 'Content-Length': 100 * 1024 * 1024 + 1 },
        }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
        request.end();
    });
    assert.equal(status, 413);
});

test('concurrent web imports keep both projects in the catalog', async (t) => {
    const f = await serve(t);
    const responses = await Promise.all([f.upload(template('first')), f.upload(template('second'))]);
    assert.deepEqual(responses.map(response => response.status), [201, 201]);
    const catalog = JSON.parse(await fs.readFile(path.join(f.root, 'catalog.json'), 'utf8'));
    assert.deepEqual(catalog.productions.map(project => project.slug).sort(), ['first', 'second']);
});

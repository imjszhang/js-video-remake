import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../src/web-server.js';

test('standalone reference exposes poster and range playback, and removing registration revokes access', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-preview-'));
    const server = createWebServer({ root, referenceDeps: { env: {} } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {
        await server.shutdownTasks(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}/`;
    await fs.writeFile(path.join(root, 'clip.mp4'), 'test-video-bytes');
    await fs.writeFile(path.join(root, 'poster.jpg'), 'test-poster');
    await fs.writeFile(path.join(root, 'private.mp4'), 'private');
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ schema: 'video-remake.source-list@1', items: [{
        video: { videoId: 'test', platform: 'fixture', title: '原片', status: 'downloaded' },
        files: { video: 'clip.mp4', thumbnail: 'poster.jpg' },
    }] }));
    const imported = await fetch(base + 'api/references/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'references' }, body: JSON.stringify({ manifest: 'manifest.json', assetRoot: root }) });
    assert.equal(imported.status, 201);
    const { references } = await (await fetch(base + 'api/references')).json();
    const item = references[0];
    assert.deepEqual(item.productions, []);
    assert.match(item.videoUrl, /^media\/[a-f0-9]{32}$/);
    assert.equal(await (await fetch(base + item.posterUrl)).text(), 'test-poster');
    const range = await fetch(base + item.videoUrl, { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'test');
    assert.equal((await fetch(base + item.videoUrl, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(base + 'private.mp4')).status, 404);
    await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ productions: [], references: [] }));
    assert.equal((await fetch(base + item.videoUrl)).status, 404);
    assert.equal((await fetch(base + item.posterUrl)).status, 404);
});

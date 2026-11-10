import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../src/web-server.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
test('reference page and assets are served with relative navigation and read-only empty API', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-web-routes-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'web'));
    for (const name of ['index.html', 'references.html', 'references.css', 'references.js', 'style.css', 'navigation.css']) {
        await fs.copyFile(path.join(webRoot, name), path.join(root, 'web', name));
    }
    const server = createWebServer({ root, referenceDeps: { env: {} } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { await server.shutdownTasks(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['/references', '/references.html', '/references.js', '/references.css', '/navigation.css']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
        assert.ok((await response.text()).length > 0);
        const head = await fetch(base + route, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
    }
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /href="\.\/references"/);
    const html = await (await fetch(base + '/references')).text();
    assert.match(html, /src="\.\/references.js"/);
    assert.match(html, /href="\.\/references.css"/);
    assert.doesNotMatch(html, /onclick=|<script(?![^>]*src=)/);
    const result = await (await fetch(base + '/api/references')).json();
    assert.deepEqual(result.references, []);
    await assert.rejects(fs.access(path.join(root, 'catalog.json')), { code: 'ENOENT' });
});

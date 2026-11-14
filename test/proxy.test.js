import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { httpFetch } from '../src/http.js';
import { run, tempWorkspace } from './helpers.js';

test('项目代理来自环境变量，其次是配置文件', async (t) => {
    const workspace = await tempWorkspace(t);
    const file = JSON.parse(await fs.readFile(path.join(workspace.directory, 'video-remake.json'), 'utf8'));
    await fs.writeFile(path.join(workspace.directory, 'video-remake.json'), JSON.stringify({ ...file, proxy: 'socks5://10.1.0.8:1080' }));
    assert.equal(resolveConfig({ workspace: workspace.directory }, workspace.env, workspace.directory).proxy, 'socks5://10.1.0.8:1080');
    const env = { ...workspace.env, VIDEO_REMAKE_PROXY: 'socks5://127.0.0.1:1080' };
    assert.equal(resolveConfig({ workspace: workspace.directory }, env, workspace.directory).proxy, 'socks5://127.0.0.1:1080');
    assert.throws(() => resolveConfig({ workspace: workspace.directory }, { ...workspace.env, VIDEO_REMAKE_PROXY: 'http://127.0.0.1:1080' }, workspace.directory), /socks5/);
    const paths = await run(['paths'], env);
    assert.equal(paths.data.proxy, 'socks5://127.0.0.1:1080');
});

test('本机地址不走已配置的代理', async (t) => {
    let tunneled = 0;
    const proxy = net.createServer(() => { tunneled += 1; });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    t.after(() => new Promise((resolve) => proxy.close(resolve)));
    const site = http.createServer((_request, response) => response.end('{"ok":true}'));
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    t.after(() => new Promise((resolve) => site.close(resolve)));
    const response = await httpFetch(`socks5://127.0.0.1:${proxy.address().port}`)(`http://127.0.0.1:${site.address().port}/health`);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(tunneled, 0);
});

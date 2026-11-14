import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { configureMcpHub, parseOptions } from '../scripts/configure-mcp-hub.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/configure-mcp-hub.mjs', import.meta.url));
const token = `mcp_hub_${'a'.repeat(48)}`;
const url = 'http://hub.test:8899/mcp/comfyui';
const targets = ['.codex/config.toml', '.mcp.json', '.cursor/mcp.json'];

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-configure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await exec('git', ['init', '--quiet', root]);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'video-remake' }));
    await fs.writeFile(path.join(root, '.gitignore'), '/.secrets/\n/.codex/config.toml\n/.mcp.json\n/.cursor/mcp.json\n');
    await fs.mkdir(path.join(root, '.secrets'), { mode: 0o700 });
    await fs.writeFile(path.join(root, '.secrets/comfy-hub.token'), token + '\n', { mode: 0o600 });
    await fs.writeFile(path.join(root, 'video-remake.json'), JSON.stringify({
        media: { video: { hubUrl: url, hubTokenFile: '.secrets/comfy-hub.token' } },
    }));
    return root;
}

test('project configuration writes native HTTP connections at mode 0600 and rotates credentials', async (t) => {
    const root = await fixture(t);
    const options = { workspace: root };
    const result = await configureMcpHub(options, { env: {} });
    assert.deepEqual(result, { files: targets, server: 'comfy-hub' });
    for (const relative of targets) {
        const file = path.join(root, relative);
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        assert.match(await fs.readFile(file, 'utf8'), /Bearer mcp_hub_/);
        await exec('git', ['-C', root, 'check-ignore', '--quiet', '--', relative]);
    }
    const claude = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(claude.mcpServers['comfy-hub'], { type: 'http', url, headers: { Authorization: `Bearer ${token}` } });
    assert.match(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8'), /tool_timeout_sec = 400/);
    const rotated = `mcp_hub_${'b'.repeat(48)}`;
    await fs.writeFile(path.join(root, '.secrets/comfy-hub.token'), rotated);
    await configureMcpHub(options, { env: {} });
    for (const relative of targets) {
        const content = await fs.readFile(path.join(root, relative), 'utf8');
        assert.ok(content.includes(rotated));
        assert.ok(!content.includes(token));
    }
    await assert.rejects(fs.stat(path.join(root, '.secrets/mcp-hub-config.lock')), { code: 'ENOENT' });
});

test('JSON merging preserves other services, settings, and non-authorization headers', async (t) => {
    const root = await fixture(t);
    const other = { command: 'node', args: ['server.js'] };
    await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ settings: { keep: true }, mcpServers: {
        other, 'comfy-hub': { type: 'http', url: 'http://old.test/mcp/comfyui', headers: { authorization: 'old', 'X-Region': 'local' } },
    } }));
    await configureMcpHub({ workspace: root }, { env: {} });
    const output = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(output.settings, { keep: true });
    assert.deepEqual(output.mcpServers.other, other);
    assert.deepEqual(output.mcpServers['comfy-hub'].headers, { 'X-Region': 'local', Authorization: `Bearer ${token}` });
});

test('unmanaged TOML and conflicting JSON fail before writing any client config', async (t) => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, '.codex'));
    const existing = 'model = "example"\n[mcp_servers.other]\ncommand = "server"\n';
    await fs.writeFile(path.join(root, '.codex/config.toml'), existing);
    await assert.rejects(configureMcpHub({ workspace: root }, { env: {} }), /无法安全合并 TOML/);
    assert.equal(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8'), existing);
    await assert.rejects(fs.stat(path.join(root, '.mcp.json')), { code: 'ENOENT' });
    await fs.unlink(path.join(root, '.codex/config.toml'));
    await fs.mkdir(path.join(root, '.cursor'));
    await fs.writeFile(path.join(root, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { 'comfy-hub': { command: 'existing-server' } } }));
    await assert.rejects(configureMcpHub({ workspace: root }, { env: {} }), /HTTP 连接冲突/);
    await assert.rejects(fs.stat(path.join(root, '.codex/config.toml')), { code: 'ENOENT' });
});

test('symlink destinations, external tokens and unignored credentials are rejected', async (t) => {
    const root = await fixture(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.symlink(outside, path.join(root, '.codex'));
    await assert.rejects(configureMcpHub({ workspace: root }, { env: {} }), /符号链接/);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.unlink(path.join(root, '.codex'));
    await assert.rejects(configureMcpHub({ workspace: root, tokenFile: path.join(outside, 'token') }, { env: {} }), /当前项目内/);
    await fs.writeFile(path.join(root, '.gitignore'), '/.secrets/\n');
    await assert.rejects(configureMcpHub({ workspace: root }, { env: {} }), /Git 忽略/);
    await assert.rejects(fs.stat(path.join(root, '.mcp.json')), { code: 'ENOENT' });
});

test('a concurrent configuration operation is not removed or overwritten', async (t) => {
    const root = await fixture(t);
    const lock = path.join(root, '.secrets/mcp-hub-config.lock');
    await fs.mkdir(lock);
    await assert.rejects(configureMcpHub({ workspace: root }, { env: {} }), /尚未结束/);
    assert.ok((await fs.stat(lock)).isDirectory());
    await assert.rejects(fs.stat(path.join(root, '.mcp.json')), { code: 'ENOENT' });
});

test('standalone CLI accepts explicit overrides without printing the token', async (t) => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'video-remake.json'), '{}');
    const result = await exec(process.execPath, [script, '--workspace', root, '--url', url, '--token-file', '.secrets/comfy-hub.token']);
    assert.match(result.stdout, /已配置项目 MCP/);
    assert.ok(!(result.stdout + result.stderr).includes(token));
    const config = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.equal(config.mcpServers['comfy-hub'].url, url);
    assert.deepEqual(parseOptions(['--workspace', root, '--url', url]), { workspace: root, url });
    assert.throws(() => parseOptions(['--token', token]), /参数无效/);
});

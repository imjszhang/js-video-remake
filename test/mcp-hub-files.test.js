import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeHubFiles, MAX_ASSET_BYTES } from '../scripts/mcp-hub-files.js';

const ID = '1234567890abcdef1234567890abcdef';
const TOKEN = `mcp_hub_${'a'.repeat(40)}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-hub-files-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'device.token'), `${TOKEN}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'video-remake.json'), JSON.stringify({ media: { video: {
        provider: 'comfy-mcp', hubUrl: 'http://hub.example:8899/mcp/comfyui', hubTokenFile: 'device.token',
    } } }));
    const run = (args, fetchImpl, extra = {}) => executeHubFiles(args, { cwd: dir, env: {}, fetchImpl, ...extra });
    return { dir, run };
}

function streamResponse(chunks, headers = {}) {
    let index = 0;
    return new Response(new ReadableStream({ pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
    } }), { headers });
}

async function assertNoPart(dir) {
    assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.part')), false);
}

test('Hub 文件上传读取项目配置，流式发送原始文件并核对服务端散列', async (t) => {
    const { dir, run } = await fixture(t);
    const contents = Buffer.alloc(180_000, 17);
    await fs.writeFile(path.join(dir, '素材.bin'), contents);
    let calls = 0;
    const result = await run(['upload', '素材.bin'], async (url, init) => {
        calls++;
        assert.equal(new URL(url).origin, 'http://hub.example:8899');
        assert.equal(new URL(url).pathname, '/assets');
        assert.equal(new URL(url).searchParams.get('service'), 'comfyui');
        assert.equal(new URL(url).searchParams.get('filename'), '素材.bin');
        assert.equal(init.method, 'PUT');
        assert.equal(init.duplex, 'half');
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(init.headers['Content-Length'], String(contents.length));
        assert.equal(init.headers['Content-Type'], 'application/octet-stream');
        assert.equal(Buffer.isBuffer(init.body), false);
        const chunks = [];
        for await (const chunk of init.body) chunks.push(chunk);
        assert.ok(chunks.length > 1);
        assert.deepEqual(Buffer.concat(chunks), contents);
        return Response.json({ id: ID, service: 'comfyui', bytes: contents.length, sha256: sha256(contents), secret: TOKEN }, { status: 201 });
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { id: ID, service: 'comfyui', name: '素材.bin', bytes: contents.length, sha256: sha256(contents), download_path: `/assets/${ID}` });
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('Hub 文件参数覆盖配置，服务取自专用 MCP 地址', async (t) => {
    const { dir, run } = await fixture(t);
    const otherToken = `mcp_hub_${'b'.repeat(40)}`;
    await fs.writeFile(path.join(dir, 'other.token'), otherToken, { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'input.txt'), 'abc');
    await run(['--url', 'https://other.example/mcp/studio', '--token-file', 'other.token', 'upload', 'input.txt'], async (url, init) => {
        assert.equal(new URL(url).origin, 'https://other.example');
        assert.equal(new URL(url).searchParams.get('service'), 'studio');
        assert.equal(init.headers.Authorization, `Bearer ${otherToken}`);
        for await (const _chunk of init.body) { /* consume the upload stream */ }
        return Response.json({ id: ID, service: 'studio', bytes: 3, sha256: sha256('abc') }, { status: 201 });
    });
});

test('Hub 文件命令拒绝原始令牌参数及无效素材路径，不回显参数', async (t) => {
    const { run } = await fixture(t);
    for (const args of [
        ['--token', TOKEN, 'upload', 'input.txt'], ['download', '../other', '--out', 'x'],
        ['download', ID, '--out', 'x', '--sha256', 'bad'], ['upload', 'input.txt', '--out', 'x'],
    ]) {
        await assert.rejects(run(args, () => assert.fail('不得联网')), (error) => {
            assert.equal(error.code, 'HUB_ARGUMENT_INVALID');
            assert.equal(error.message.includes(TOKEN), false);
            return true;
        });
    }
    const help = await run(['--help'], () => assert.fail('帮助不得联网'));
    assert.match(help.help, /只上传和下载/);
});

test('Hub 文件命令拒绝宽松权限及符号链接令牌文件', async (t) => {
    const { dir, run } = await fixture(t);
    await fs.chmod(path.join(dir, 'device.token'), 0o644);
    await assert.rejects(run(['upload', 'input.txt'], () => assert.fail('不得联网')), { code: 'HUB_TOKEN_INVALID' });
    await fs.chmod(path.join(dir, 'device.token'), 0o600);
    await fs.symlink('device.token', path.join(dir, 'link.token'));
    await assert.rejects(run(['--token-file', 'link.token', 'upload', 'input.txt'], () => assert.fail('不得联网')), { code: 'HUB_TOKEN_INVALID' });
});

test('Hub 上传在联网前拒绝超过 512 MiB 的文件', async (t) => {
    const { dir, run } = await fixture(t);
    const handle = await fs.open(path.join(dir, 'large.bin'), 'w');
    await handle.truncate(MAX_ASSET_BYTES + 1);
    await handle.close();
    await assert.rejects(run(['upload', 'large.bin'], () => assert.fail('不得联网')), { code: 'HUB_FILE_TOO_LARGE' });
});

test('Hub 下载流式校验长度和散列，保存权限 0600 并拒绝覆盖', async (t) => {
    const { dir, run } = await fixture(t);
    const contents = Buffer.from('downloaded-video-bytes');
    const result = await run(['download', ID, '--out', 'output.bin', '--sha256', sha256(contents)], async (url, init) => {
        assert.equal(url, `http://hub.example:8899/assets/${ID}`);
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(init.headers['Accept-Encoding'], 'identity');
        assert.equal(init.redirect, 'error');
        return streamResponse([contents.subarray(0, 5), contents.subarray(5)], { 'content-length': String(contents.length) });
    });
    assert.deepEqual(await fs.readFile(result.path), contents);
    assert.equal(result.sha256, sha256(contents));
    assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
    await assert.rejects(run(['download', ID, '--out', 'output.bin'], () => assert.fail('不得联网')), { code: 'ALREADY_EXISTS' });
    await fs.symlink('missing', path.join(dir, 'dangling.bin'));
    await assert.rejects(run(['download', ID, '--out', 'dangling.bin'], () => assert.fail('不得联网')), { code: 'ALREADY_EXISTS' });
    await assertNoPart(dir);
});

test('Hub 下载拒绝短文件、超长文件、错误散列或未声明的完整性信息，并清理临时文件', async (t) => {
    const { dir, run } = await fixture(t);
    for (const [headers, extra, code] of [
        [{ 'content-length': '4' }, [], 'HUB_DOWNLOAD_INVALID'],
        [{ 'content-length': '2' }, [], 'HUB_DOWNLOAD_INVALID'],
        [{ 'content-length': String(MAX_ASSET_BYTES + 1) }, [], 'HUB_FILE_TOO_LARGE'],
        [{ 'content-length': '3' }, ['--sha256', '0'.repeat(64)], 'HUB_DOWNLOAD_INVALID'],
        [{}, [], 'HUB_RESPONSE_INVALID'],
        [{ 'content-length': '3', 'content-encoding': 'gzip' }, [], 'HUB_RESPONSE_INVALID'],
    ]) {
        await assert.rejects(run(['download', ID, '--out', 'invalid.bin', ...extra], async () =>
            streamResponse([Buffer.from('abc')], headers)), { code });
        await assert.rejects(fs.stat(path.join(dir, 'invalid.bin')), { code: 'ENOENT' });
        await assertNoPart(dir);
    }
});

test('Hub 无长度下载必须有匹配散列，零字节文件也可正确传输', async (t) => {
    const { dir, run } = await fixture(t);
    const data = Buffer.from('verified-with-hash');
    const result = await run(['download', ID, '--out', 'hash.bin', '--sha256', sha256(data)], async () => streamResponse([data]));
    assert.equal(result.bytes, data.length);
    await fs.writeFile(path.join(dir, 'empty.bin'), '');
    await run(['upload', 'empty.bin'], async (_url, init) => {
        for await (const _chunk of init.body) { /* consume the upload stream */ }
        return Response.json({ id: ID, service: 'comfyui', bytes: 0, sha256: sha256('') }, { status: 201 });
    });
    const empty = await run(['download', ID, '--out', 'empty-download.bin'], async () =>
        streamResponse([], { 'content-length': '0' }));
    assert.equal(empty.bytes, 0);
});

test('Hub 下载期间其他进程创建目标也不会被覆盖', async (t) => {
    const { dir, run } = await fixture(t);
    await assert.rejects(run(['download', ID, '--out', 'race.bin'], async () => {
        await fs.writeFile(path.join(dir, 'race.bin'), 'existing');
        return streamResponse([Buffer.from('new')], { 'content-length': '3' });
    }), { code: 'ALREADY_EXISTS' });
    assert.equal(await fs.readFile(path.join(dir, 'race.bin'), 'utf8'), 'existing');
    await assertNoPart(dir);
});

test('Hub 传输中断不保留半成品，不回显网络异常或服务端敏感响应', async (t) => {
    const { dir, run } = await fixture(t);
    for (const fetchImpl of [
        async () => { throw new Error(`request failed ${TOKEN}`); },
        async () => new Response(TOKEN, { status: 403 }),
        async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(TOKEN)); } }), { headers: { 'content-length': '3' } }),
    ]) {
        await assert.rejects(run(['download', ID, '--out', 'broken.bin'], fetchImpl), (error) => {
            assert.equal(error.message.includes(TOKEN), false);
            assert.match(error.code, /^HUB_/);
            return true;
        });
        await assertNoPart(dir);
        await assert.rejects(fs.stat(path.join(dir, 'broken.bin')), { code: 'ENOENT' });
    }
});

test('Hub 上传响应散列不匹配时不报告成功且不自动重试', async (t) => {
    const { dir, run } = await fixture(t);
    await fs.writeFile(path.join(dir, 'input.bin'), 'abc');
    let calls = 0;
    await assert.rejects(run(['upload', 'input.bin'], async (_url, init) => {
        calls++;
        for await (const _chunk of init.body) { /* consume the upload stream */ }
        return Response.json({ id: ID, service: 'comfyui', bytes: 3, sha256: '0'.repeat(64) }, { status: 201 });
    }), { code: 'HUB_RESPONSE_INVALID' });
    assert.equal(calls, 1);
});

test('Hub 上传途中原文件增长会终止流，不接受变化后的文件', async (t) => {
    const { dir, run } = await fixture(t);
    await fs.writeFile(path.join(dir, 'changing.bin'), 'abc');
    let calls = 0;
    await assert.rejects(run(['upload', 'changing.bin'], async (_url, init) => {
        calls++;
        await fs.appendFile(path.join(dir, 'changing.bin'), 'grew');
        for await (const _chunk of init.body) { /* the stream must reject */ }
        assert.fail('变化中的文件不能上传成功');
    }), { code: 'HUB_CONNECTION_FAILED' });
    assert.equal(calls, 1);
});

test('Hub 下载主动取消会关闭流并清除临时文件', async (t) => {
    const { dir, run } = await fixture(t);
    const abort = new AbortController();
    let canceled = false;
    await assert.rejects(run(['download', ID, '--out', 'canceled.bin'], async () =>
        new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(Buffer.from('abc'));
                setImmediate(() => abort.abort());
            },
            cancel() { canceled = true; },
        }), { headers: { 'content-length': '30' } }), { signal: abort.signal }), { code: 'HUB_TRANSFER_FAILED' });
    assert.equal(canceled, true);
    await assertNoPart(dir);
    await assert.rejects(fs.stat(path.join(dir, 'canceled.bin')), { code: 'ENOENT' });
});

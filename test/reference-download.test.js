import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { downloadReference, downloadDoctor, createDownloadProvider } from '../src/downloads/index.js';
import { runDownloadProcess } from '../src/downloads/process.js';
import { listReferences } from '../src/references.js';

async function fixture(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-download-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    return { workspace, catalogPath: path.join(workspace, 'catalog.json'), quality: '1080', source: { provider: 'local' }, env: {},
        download: { provider: 'yt-dlp', executable: 'fixture-yt-dlp', directory: path.join(workspace, 'downloads'), timeoutMs: 1000 } };
}

function downloader(config, { preflight = {}, output = {}, onRun, contents = 'video fixture' } = {}) {
    const calls = [];
    const runDownload = async (executable, args, options) => {
        calls.push({ executable, args, options });
        await onRun?.(executable, args, options);
        if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ id: 'demo', title: '原视频', duration: 15, webpage_url: 'https://example.com/watch?v=demo', ...preflight }) };
        const file = path.join(options.cwd, 'video.mp4');
        await fs.writeFile(file, contents);
        return { stdout: JSON.stringify({ filepath: file, title: '下载标题', channel: '示例频道', duration: 15, ...output }) };
    };
    return { runDownload, calls };
}

test('download uses isolated yt-dlp options and imports its result into the local catalog', async t => {
    const config = await fixture(t);
    const deps = downloader(config);
    const result = await downloadReference(config, { url: 'https://example.com/watch?v=demo', quality: '720' }, deps);
    assert.equal(result.command, 'reference:download');
    assert.equal(result.provider, 'yt-dlp');
    assert.equal(result.references.length, 1);
    assert.equal(deps.calls.length, 2);
    for (const call of deps.calls) {
        assert.equal(call.executable, 'fixture-yt-dlp');
        assert.ok(call.args.includes('--ignore-config'));
        assert.ok(call.args.includes('--no-plugin-dirs'));
        assert.ok(call.args.includes('--no-playlist'));
        assert.ok(call.args.includes(`node:${process.execPath}`));
        assert.equal(call.args.at(-2), '--');
        assert.equal(call.args.at(-1), 'https://example.com/watch?v=demo');
        assert.ok(call.options.timeoutMs <= 1000);
    }
    assert.ok(deps.calls[0].args.includes('--skip-download'));
    const args = deps.calls[1].args;
    assert.equal(args[args.indexOf('--format') + 1], 'bv*[height<=720]+ba/b[height<=720]/bv[height<=720]');
    assert.equal(args[args.indexOf('--output') + 1], path.join(deps.calls[1].options.cwd, 'video.%(ext)s'));
    assert.ok(args.includes('--no-simulate'));
    assert.equal(await fs.readFile(result.file, 'utf8'), 'video fixture');
    const source = JSON.parse(await fs.readFile(path.join(config.workspace, result.references[0].dir, 'SOURCE.json'), 'utf8'));
    assert.equal(source.title, '下载标题');
    assert.equal(source.channel, '示例频道');
    assert.equal(source.durationSec, 15);
    assert.equal(source.canonicalUrl, 'https://example.com/watch?v=demo');
    assert.equal(source.provider.kind, 'yt-dlp');
    assert.equal((await listReferences(config)).references[0].available, true);
});

test('download rejects invalid URLs and audio requests before creating files or invoking tools', async t => {
    const config = await fixture(t);
    const deps = { runDownload: () => assert.fail('must not run') };
    for (const url of ['file:///etc/passwd', 'https://user:secret@example.com/v', '--exec=touch /tmp/file', 'invalid']) {
        await assert.rejects(downloadReference(config, { url }, deps), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(downloadReference(config, { url: 'https://example.com/v', quality: 'audio' }, deps), { code: 'INVALID_INPUT' });
    await assert.rejects(fs.access(config.download.directory), { code: 'ENOENT' });
});

test('playlist and live preflight results never reach the download call', async t => {
    const config = await fixture(t);
    for (const preflight of [{ _type: 'playlist', entries: [] }, { _type: 'multi_video' }, { is_live: true }, { live_status: 'is_upcoming' }]) {
        const deps = downloader(config, { preflight });
        await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, deps), { code: 'INVALID_INPUT' });
        assert.equal(deps.calls.length, 1);
        assert.deepEqual(await fs.readdir(config.download.directory), []);
    }
});

test('download refuses malformed records, missing files and paths outside its owned directory', async t => {
    const config = await fixture(t);
    const outside = path.join(config.workspace, 'private.mp4');
    await fs.writeFile(outside, 'private');
    for (const output of [{ filepath: outside }, { filepath: '../private.mp4' }, { filepath: '' }, { filepath: 'missing.mp4' }, { filepath: '.' }]) {
        const deps = downloader(config, { output });
        await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, deps), error => ['DOWNLOAD_PROTOCOL', 'DOWNLOAD_FAILED'].includes(error.code));
        assert.deepEqual(await fs.readdir(config.download.directory), []);
        assert.equal(await fs.readFile(outside, 'utf8'), 'private');
    }
    for (const stdout of ['not-json', '[]', '{}\n{}', 'null', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
        await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, { runDownload: async () => ({ stdout }) }), { code: 'DOWNLOAD_PROTOCOL' });
    }
    await assert.rejects(fs.access(config.catalogPath), { code: 'ENOENT' });
});

test('download rejects output symlink escape and zero-byte originals', async t => {
    const config = await fixture(t);
    const outside = path.join(config.workspace, 'outside.mp4');
    await fs.writeFile(outside, 'private');
    let calls = 0;
    await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, {
        runDownload: async (_, args, options) => {
            calls += 1;
            if (args.includes('--dump-single-json')) return { stdout: '{}' };
            await fs.symlink(outside, path.join(options.cwd, 'escape.mp4'));
            return { stdout: JSON.stringify({ filepath: path.join(options.cwd, 'escape.mp4') }) };
        },
    }), { code: 'DOWNLOAD_PROTOCOL' });
    assert.equal(calls, 2);
    assert.equal(await fs.readFile(outside, 'utf8'), 'private');
    await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, downloader(config, { contents: '' })), { code: 'DOWNLOAD_PROTOCOL' });
    assert.deepEqual(await fs.readdir(config.download.directory), []);
});

test('failure cleans only its own directory and does not expose downloader stderr', async t => {
    const config = await fixture(t);
    await fs.mkdir(config.download.directory);
    await fs.writeFile(path.join(config.download.directory, 'keep.mp4'), 'keep');
    for (const [error, code] of [
        [Object.assign(new Error('secret-token'), { stderr: 'secret-token' }), 'DOWNLOAD_FAILED'],
        [Object.assign(new Error('secret-token'), { code: 'ENOENT' }), 'DOWNLOAD_UNAVAILABLE'],
        [Object.assign(new Error('secret-token'), { killed: true }), 'DOWNLOAD_TIMEOUT'],
    ]) {
        await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, { runDownload: async () => { throw error; } }), e => e.code === code && !e.message.includes('secret-token'));
        assert.deepEqual(await fs.readdir(config.download.directory), ['keep.mp4']);
    }
});

test('successful original is retained with a recovery path when catalog registration fails', async t => {
    const config = await fixture(t);
    await fs.writeFile(config.catalogPath, '{broken');
    let retained;
    await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, downloader(config)), error => {
        retained = error.data.file;
        return error.code === 'DOWNLOAD_IMPORT_FAILED' && error.data.retained === true && error.message.includes(retained);
    });
    assert.equal(await fs.readFile(retained, 'utf8'), 'video fixture');
    assert.equal(await fs.readFile(config.catalogPath, 'utf8'), '{broken');
});

test('download doctor only invokes local version commands and reports missing prerequisites', async t => {
    const config = await fixture(t);
    const calls = [];
    const deps = { runDownload: async (executable, args) => {
        calls.push({ executable, args });
        assert.ok(args.includes('--version') || args.includes('-version'));
        assert.ok(args.every(value => !value.startsWith('https:')));
        return { stdout: executable === 'ffmpeg' ? 'ffmpeg version fixture\n' : '2026.01.01\n' };
    } };
    const result = await downloadDoctor(config, deps);
    assert.equal(result.ready, true);
    assert.equal(result.checks.length, 2);
    assert.equal(calls.length, 2);
    const missing = await downloadDoctor(config, { runDownload: async () => { throw new Error('secret stderr'); } });
    assert.equal(missing.ready, false);
    assert.equal(JSON.stringify(missing).includes('secret stderr'), false);
    assert.throws(() => createDownloadProvider({ download: { provider: 'unknown' } }), { code: 'CONFIG_INVALID' });
});

function fakeSpawn(onSpawn) {
    return (executable, args, options) => {
        const child = new EventEmitter();
        child.pid = 12345;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        queueMicrotask(() => onSpawn(child, executable, args, options));
        return child;
    };
}

test('process runner disables shell use, captures UTF-8 and bounds both output streams', async () => {
    const result = await runDownloadProcess('test', ['https://example.com/$(secret)'], {
        spawnImpl: fakeSpawn((child, _, args, options) => {
            assert.equal(options.shell, false);
            assert.equal(options.detached, true);
            assert.deepEqual(args, ['https://example.com/$(secret)']);
            const bytes = Buffer.from('中文');
            child.stdout.write(bytes.subarray(0, 2));
            child.stdout.write(bytes.subarray(2));
            child.emit('close', 0);
        }), platform: 'darwin',
    });
    assert.equal(result.stdout, '中文');
    const killed = [];
    let activeChild;
    await assert.rejects(runDownloadProcess('test', [], {
        maxOutputBytes: 3, platform: 'darwin', killImpl: (...args) => {
            killed.push(args);
            queueMicrotask(() => activeChild.emit('close', null, 'SIGKILL'));
        },
        spawnImpl: fakeSpawn(child => { activeChild = child; child.stderr.write('secret-too-long'); }),
    }), { code: 'DOWNLOAD_OUTPUT_LIMIT' });
    assert.deepEqual(killed, [[-12345, 'SIGKILL']]);
});

test('process runner terminates the process group on timeout without returning private stderr', async () => {
    const killed = [];
    let activeChild;
    await assert.rejects(runDownloadProcess('test', [], {
        timeoutMs: 5, platform: 'darwin', killImpl: (...args) => {
            killed.push(args);
            queueMicrotask(() => activeChild.emit('close', null, 'SIGKILL'));
        },
        spawnImpl: fakeSpawn(child => { activeChild = child; child.stderr.write('private'); }),
    }), error => error.code === 'DOWNLOAD_TIMEOUT' && !error.message.includes('private'));
    assert.deepEqual(killed, [[-12345, 'SIGKILL']]);
});

test('termination waits for close before rejecting so callers can safely remove partial files', async () => {
    let activeChild;
    let closed = false;
    let settled = false;
    const promise = runDownloadProcess('test', [], {
        timeoutMs: 5, platform: 'darwin',
        killImpl: () => {
            setTimeout(() => {
                assert.equal(settled, false);
                closed = true;
                activeChild.emit('close', null, 'SIGKILL');
            }, 10);
        },
        spawnImpl: fakeSpawn(child => { activeChild = child; }),
    }).finally(() => { settled = true; });
    await assert.rejects(promise, { code: 'DOWNLOAD_TIMEOUT' });
    assert.equal(closed, true);
});

test('unconfirmed termination is bounded and preserves partial files instead of racing a live child', async t => {
    await assert.rejects(runDownloadProcess('test', [], {
        timeoutMs: 5, platform: 'darwin', killImpl() {}, spawnImpl: fakeSpawn(() => {}),
    }), { code: 'DOWNLOAD_STOP_UNCONFIRMED' });
    const config = await fixture(t);
    let directory;
    await assert.rejects(downloadReference(config, { url: 'https://example.com/v' }, {
        runDownload: async (_, __, options) => {
            directory = options.cwd;
            await fs.writeFile(path.join(directory, 'video.part'), 'partial');
            throw Object.assign(new Error('unconfirmed'), { code: 'DOWNLOAD_STOP_UNCONFIRMED' });
        },
    }), error => error.code === 'DOWNLOAD_STOP_UNCONFIRMED' && error.data.retained && error.data.directory === directory);
    assert.equal(await fs.readFile(path.join(directory, 'video.part'), 'utf8'), 'partial');
    await assert.rejects(fs.access(config.catalogPath), { code: 'ENOENT' });
});

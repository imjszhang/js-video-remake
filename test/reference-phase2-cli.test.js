import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';
import { parseArgv } from '../src/args.js';
import { execute } from '../cli/remake.js';
import { printHuman } from '../src/format.js';

async function fixture(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-source-phase2-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const env = { VIDEO_REMAKE_WORKSPACE: workspace };
    return { workspace, env, run: (args, deps) => execute(parseArgv(args), env, deps) };
}

test('download configuration is independent of the local catalog and follows override priority', async t => {
    const f = await fixture(t);
    const defaults = resolveConfig({}, f.env);
    assert.equal(defaults.source.provider, 'local');
    assert.equal(defaults.download.provider, 'yt-dlp');
    assert.equal(defaults.download.executable, 'yt-dlp');
    assert.equal(defaults.download.directory, path.join(f.workspace, 'assets/source/downloads'));
    await fs.writeFile(path.join(f.workspace, 'video-remake.json'), JSON.stringify({
        download: { executable: './tools/yt-dlp', directory: 'local-downloads', timeoutMs: 1234 },
    }));
    const file = resolveConfig({}, f.env);
    assert.equal(file.download.executable, path.join(f.workspace, 'tools/yt-dlp'));
    assert.equal(file.download.timeoutMs, 1234);
    const env = { ...f.env, VIDEO_REMAKE_DOWNLOAD_EXECUTABLE: 'custom-ytdlp', VIDEO_REMAKE_DOWNLOAD_DIR: 'env-dir', VIDEO_REMAKE_DOWNLOAD_TIMEOUT_MS: '5678' };
    const resolved = resolveConfig(parseArgv(['reference:download', 'https://example.com/video', '--download-dir', 'cli-dir']).config, env);
    assert.equal(resolved.download.executable, 'custom-ytdlp');
    assert.equal(resolved.download.directory, path.join(f.workspace, 'cli-dir'));
    assert.equal(resolved.download.timeoutMs, 5678);
    for (const settings of [{ downloadProvider: 'unknown' }, { downloadTimeoutMs: 0 }, { downloadTimeoutMs: 'bad' }, { downloadExecutable: '' }]) {
        assert.throws(() => resolveConfig(settings, f.env), { code: 'CONFIG_INVALID' });
    }
});

test('CLI folder preview is read-only and explicit selection imports only that video', async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.workspace, 'incoming/nested'), { recursive: true });
    await fs.writeFile(path.join(f.workspace, 'incoming/one.mp4'), 'one');
    await fs.writeFile(path.join(f.workspace, 'incoming/nested/two.mov'), 'two');
    const preview = await f.run(['reference:scan', 'incoming', '--recursive']);
    assert.equal(preview.data.candidates.length, 2);
    assert.equal(preview.data.imported.length, 0);
    await assert.rejects(fs.access(path.join(f.workspace, 'catalog.json')), { code: 'ENOENT' });
    const selected = await f.run(['reference:scan', 'incoming', '--recursive', '--import', '--select', 'nested/two.mov']);
    assert.equal(selected.data.imported.length, 1);
    const list = await f.run(['reference:list']);
    assert.equal(list.data.references.length, 1);
    assert.equal(list.data.references[0].title, 'two');
    const lines = [];
    printHuman(selected, line => lines.push(line));
    assert.match(lines.join('\n'), /已导入 1 条参考/);
    assert.deepEqual(parseArgv(['reference:scan', 'incoming', '--import', '--select', 'one.mp4', '--select', 'nested/two.mov']).flags.select, ['one.mp4', 'nested/two.mov']);
});

test('new CLI commands reject missing arguments and invalid selection without a downloader call', async t => {
    const f = await fixture(t);
    const deps = { runDownload: () => assert.fail('should not execute') };
    for (const args of [['reference:scan'], ['reference:download'], ['reference:download', 'one', 'two'], ['download:doctor', 'extra']]) {
        await assert.rejects(f.run(args, deps), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(f.run(['reference:scan', '.', '--select', 'x.mp4'], deps), { code: 'INVALID_INPUT' });
    await assert.rejects(fs.access(path.join(f.workspace, 'catalog.json')), { code: 'ENOENT' });
});

test('CLI download registers origin and can immediately start a production using mocked downloader', async t => {
    const f = await fixture(t);
    const calls = [];
    const runDownload = async (exe, args, options) => {
        calls.push({ exe, args });
        if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ title: '测试原片', webpage_url: 'https://example.com/watch/demo', duration: 12 }) };
        const file = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
        await fs.writeFile(file, 'download-fixture');
        assert.equal(options.cwd, path.dirname(file));
        return { stdout: JSON.stringify({ filepath: file, title: '测试原片', webpage_url: 'https://example.com/watch/demo', duration: 12 }) };
    };
    const result = await f.run(['reference:download', 'https://example.com/watch/demo', '--quality', '720'], { runDownload });
    assert.equal(result.data.command, 'reference:download');
    assert.equal(result.data.references.length, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes('bv*[height<=720]+ba/b[height<=720]/bv[height<=720]'));
    const reference = result.data.references[0];
    const detail = await f.run(['get', reference.id]);
    assert.equal(detail.data.source.canonicalUrl, 'https://example.com/watch/demo');
    assert.equal(detail.data.source.provider.kind, 'yt-dlp');
    assert.equal(detail.data.source.title, '测试原片');
    await f.run(['start', reference.id, '--as', 'download-demo']);
    const listed = await f.run(['reference:list']);
    assert.deepEqual(listed.data.references[0].productions, ['download-demo']);
});

test('download doctor reports unavailable tool as failure and stays separate from local list', async t => {
    const f = await fixture(t);
    const calls = [];
    const runDownload = async (exe, args) => {
        calls.push({ exe, args });
        if (exe === 'ffmpeg') return { stdout: 'ffmpeg version fixture\n' };
        throw Object.assign(new Error('not installed'), { code: 'ENOENT' });
    };
    let failure;
    await assert.rejects(f.run(['download:doctor'], { runDownload }), error => {
        failure = error;
        return error.code === 'DOCTOR_FAILED' && error.data.ready === false;
    });
    assert.ok(calls.every(item => item.args.includes('--version') || item.args.includes('-version')));
    const lines = [];
    printHuman({ ok: false, error: { code: failure.code, message: failure.message }, data: failure.data }, line => lines.push(line));
    assert.match(lines.join('\n'), /未就绪/);
    assert.deepEqual((await f.run(['reference:list'])).data.references, []);
    await assert.rejects(fs.access(path.join(f.workspace, 'catalog.json')), { code: 'ENOENT' });
});

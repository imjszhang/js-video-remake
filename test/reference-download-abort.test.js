import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runDownloadProcess } from '../src/downloads/process.js';
import { ytDlp } from '../src/downloads/yt-dlp.js';

test('aborted downloads never launch a child process or create a download directory', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runDownloadProcess('yt-dlp', [], {
        signal: controller.signal, spawnImpl: () => assert.fail('must not launch'),
    }), { code: 'DOWNLOAD_CANCELLED' });
    await assert.rejects(ytDlp.download({}, { url: 'https://example.com/video' }, {
        signal: controller.signal, runDownload: () => assert.fail('must not launch'),
    }), { code: 'DOWNLOAD_CANCELLED' });
});

test('active download cancellation stops its process group and waits for close', async () => {
    const controller = new AbortController();
    const child = new EventEmitter();
    child.pid = 43210;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const signals = [];
    let settled = false;
    const pending = runDownloadProcess('yt-dlp', [], {
        signal: controller.signal, platform: 'darwin', spawnImpl: () => child,
        killImpl: (...args) => signals.push(args), timeoutMs: 10000,
    });
    pending.catch(() => { settled = true; });
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(signals, [[-43210, 'SIGKILL']]);
    assert.equal(settled, false);
    child.emit('close', null, 'SIGKILL');
    await assert.rejects(pending, { code: 'DOWNLOAD_CANCELLED' });
});

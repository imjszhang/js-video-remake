import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { httpFetch } from '../src/http.js';
import mlxWhisper, { MAX_UPLOAD_BYTES } from '../src/media/providers/mlx-whisper.js';

async function fixture(t, content = 'audio') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-mlx-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'speech.wav');
    await fs.writeFile(file, content);
    return file;
}

test('MLX 保留普通请求格式，逐词需求显式请求词和分段时间', async (t) => {
    const file = await fixture(t);
    for (const required of [[], ['word-timestamps']]) {
        const result = await mlxWhisper.transcribe({ transcriptionUrl: 'http://localhost/transcribe', language: 'zh' }, {
            file, language: 'en', require: required,
        }, {
            fetchImpl: async (url, { body }) => {
                assert.equal(body.get('model'), 'whisper-large-v3');
                assert.equal(body.get('language'), 'en');
                assert.equal(body.get('response_format'), 'verbose_json');
                assert.deepEqual(body.getAll('timestamp_granularities[]'), required.length ? ['word', 'segment'] : []);
                return Response.json({ segments: [{ start: 0, end: 1, text: 'hello', words: [{ word: 'hello', start: 0, end: 1 }] }] });
            },
        });
        assert.equal(result.segments[0].words[0].word, 'hello');
    }
});

function listen(server) {
    server.listen(0, '127.0.0.1');
    return once(server, 'listening').then(() => server.address().port);
}

function startTarget(t) {
    const seen = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        const chunks = [];
        let sent = false;
        const respond = () => {
            if (sent) return;
            sent = true;
            const raw = Buffer.concat(chunks).toString('utf8');
            seen.push(raw);
            const payload = Buffer.from(JSON.stringify(raw.startsWith('POST ')
                ? { segments: [{ start: 0, end: 1, text: 'hi' }] }
                : { status: 'ok' }));
            const body = `${payload.length.toString(16)}\r\n${payload.toString('utf8')}\r\n0\r\n\r\n`;
            socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body}`);
        };
        socket.on('data', (chunk) => {
            chunks.push(chunk);
            const raw = Buffer.concat(chunks);
            const sep = raw.indexOf('\r\n\r\n');
            if (sep < 0) return;
            const head = raw.subarray(0, sep).toString('latin1');
            const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
            if (raw.length >= sep + 4 + length) respond();
        });
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { server, seen, port: () => listen(server) };
}

function startSocks(t) {
    const server = net.createServer((client) => {
        let buf = Buffer.alloc(0);
        let stage = 0;
        const onData = (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (stage === 0) {
                if (buf.length < 2 || buf.length < 2 + buf[1]) return;
                buf = buf.subarray(2 + buf[1]);
                client.write(Buffer.from([5, 0]));
                stage = 1;
            }
            if (stage !== 1 || buf.length < 5 || buf[3] !== 3 || buf.length < 7 + buf[4]) return;
            const port = buf.readUInt16BE(5 + buf[4]);
            const extra = buf.subarray(7 + buf[4]);
            stage = 2;
            client.off('data', onData);
            const upstream = net.connect(port, '127.0.0.1', () => {
                client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                if (extra.length) upstream.write(extra);
                client.pipe(upstream);
                upstream.pipe(client);
            });
            upstream.on('error', () => client.destroy());
        };
        client.on('data', onData);
        client.on('error', () => {});
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return listen(server);
}

test('MLX 经 socks5 代理探活和转写，并带上密钥', async (t) => {
    const target = startTarget(t);
    const targetPort = await target.port();
    const proxyPort = await startSocks(t);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-mlx-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'speech.wav');
    const keyFile = path.join(dir, 'key');
    await fs.writeFile(file, 'audio');
    await fs.writeFile(keyFile, 'gateway-key\n');
    const settings = {
        healthUrl: `http://whisper.test:${targetPort}/api/whisper-large-v3/health`,
        transcriptionUrl: `http://whisper.test:${targetPort}/v1/audio/transcriptions`,
        apiKeyFile: keyFile,
    };
    const fetchImpl = httpFetch(`socks5://127.0.0.1:${proxyPort}`);
    const check = await mlxWhisper.doctor(settings, { fetchImpl });
    assert.equal(check.ready, true, check.hint);
    assert.match(target.seen[0], /Authorization: Bearer gateway-key/i);
    const result = await mlxWhisper.transcribe(settings, { file, require: [] }, { fetchImpl });
    assert.equal(result.segments[0].text, 'hi');
    assert.match(target.seen[1], /whisper-large-v3/);
    assert.match(target.seen[1], /Authorization: Bearer gateway-key/i);
});

test('MLX 在空文件和超限文件上传前失败', async (t) => {
    const file = await fixture(t, '');
    const deps = { fetchImpl: () => assert.fail('非法文件不得上传') };
    const settings = { transcriptionUrl: 'http://localhost/transcribe' };
    await assert.rejects(mlxWhisper.transcribe(settings, { file }, deps), { code: 'INVALID_INPUT' });
    await fs.truncate(file, MAX_UPLOAD_BYTES + 1);
    await assert.rejects(mlxWhisper.transcribe(settings, { file }, deps), { code: 'INVALID_INPUT' });
});

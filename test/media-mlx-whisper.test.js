import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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

test('MLX 在空文件和超限文件上传前失败', async (t) => {
    const file = await fixture(t, '');
    const deps = { fetchImpl: () => assert.fail('非法文件不得上传') };
    const settings = { transcriptionUrl: 'http://localhost/transcribe' };
    await assert.rejects(mlxWhisper.transcribe(settings, { file }, deps), { code: 'INVALID_INPUT' });
    await fs.truncate(file, MAX_UPLOAD_BYTES + 1);
    await assert.rejects(mlxWhisper.transcribe(settings, { file }, deps), { code: 'INVALID_INPUT' });
});

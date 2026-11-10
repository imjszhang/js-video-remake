import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import provider, { API_VERSION, MAX_UPLOAD_BYTES, normalizeAzureTranscript, transcribe } from '../src/media/providers/azure-speech.js';
import { validateTranscriptResult } from '../src/media/contracts.js';

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-azure-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'speech.wav');
    const apiKeyFile = path.join(dir, 'key');
    await fs.writeFile(file, 'audio fixture');
    await fs.writeFile(apiKeyFile, 'azure-test-key\nignored-line');
    return { file, settings: { endpoint: 'https://resource.cognitiveservices.azure.com/', apiKeyFile } };
}

const responseBody = {
    durationMilliseconds: 3400,
    combinedPhrases: [{ text: '你好。 Hello!' }],
    phrases: [
        { offsetMilliseconds: 125, durationMilliseconds: 875, text: '你好。', locale: 'zh-CN', words: [{ text: '你好。', offsetMilliseconds: 125, durationMilliseconds: 875 }] },
        { offsetMilliseconds: 1500, durationMilliseconds: 600, text: 'Hello!', locale: 'en-US', words: [{ text: 'Hello!', offsetMilliseconds: 1500, durationMilliseconds: 600 }] },
    ],
};

test('Azure uploads local audio using the Fast Transcription protocol and normalizes milliseconds', async (t) => {
    const { file, settings } = await fixture(t);
    let calls = 0;
    const result = await transcribe({ ...settings, language: 'en-US' }, { file, language: 'zh' }, {
        async fetchImpl(url, init) {
            calls++;
            assert.equal(url, `https://resource.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`);
            assert.equal(init.method, 'POST');
            assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'azure-test-key');
            assert.equal(init.headers['Content-Type'], undefined);
            assert.equal(init.redirect, 'error');
            assert.ok(init.signal instanceof AbortSignal);
            const audio = init.body.get('audio');
            assert.equal(audio.name, 'speech.wav');
            assert.equal(await audio.text(), 'audio fixture');
            assert.deepEqual(JSON.parse(init.body.get('definition')), { locales: ['zh-CN'], profanityFilterMode: 'None' });
            return Response.json(responseBody);
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.text, '你好。 Hello!');
    assert.equal(result.duration, 3.4);
    assert.equal(result.language, undefined);
    assert.deepEqual(result.segments[0], {
        start: 0.125, end: 1, text: '你好。', language: 'zh-CN',
        words: [{ start: 0.125, end: 1, word: '你好。' }],
    });
    assert.deepEqual(result.segments[1].words[0], { start: 1.5, end: 2.1, word: 'Hello!' });
    assert.equal(validateTranscriptResult(result, { require: ['word-timestamps'] }), result);
});

test('Azure supports auto language and retains valid silent audio results', async (t) => {
    const { file, settings } = await fixture(t);
    const result = await transcribe(settings, { file }, {
        async fetchImpl(url, init) {
            assert.equal(JSON.parse(init.body.get('definition')).locales, undefined);
            return Response.json({ durationMilliseconds: 1000, combinedPhrases: [], phrases: [] });
        },
    });
    assert.deepEqual(result, { duration: 1, text: '', segments: [] });
});

test('Azure doctor checks local setup without requesting cloud services and does not reveal the key', async (t) => {
    const { settings } = await fixture(t);
    const check = await provider.doctor(settings, { fetchImpl: () => assert.fail('must stay offline') });
    assert.equal(check.ready, true);
    assert.match(check.hint, /未验证密钥有效性/);
    assert.ok(!JSON.stringify(check).includes('azure-test-key'));
    assert.deepEqual(provider.publicSettings, ['endpoint', 'language']);
    assert.equal((await provider.doctor({})).ready, false);
    await fs.writeFile(settings.apiKeyFile, '\n');
    assert.equal((await provider.doctor(settings)).ready, false);
    await fs.rm(settings.apiKeyFile);
    assert.equal((await provider.doctor(settings)).ready, false);
});

test('Azure rejects unsafe/misconfigured endpoints and language before uploading audio', async (t) => {
    const { file, settings } = await fixture(t);
    const deps = { fetchImpl: () => assert.fail('invalid configuration must not upload') };
    for (const endpoint of ['http://resource.example', 'https://u:p@resource.example', 'https://resource.example/path', 'https://resource.example?key=x']) {
        await assert.rejects(transcribe({ ...settings, endpoint }, { file }, deps), { code: 'CONFIG_INVALID' });
    }
    await assert.rejects(transcribe(settings, { file, language: 'not a locale' }, deps), { code: 'INVALID_INPUT' });
    assert.throws(() => provider.validateRequest({ language: 'ja', options: {} }), /完整语言区域代码/);
    provider.validateRequest({ language: 'ja-JP', options: {} });
    assert.throws(() => provider.validateRequest({ options: { arbitrary: true } }), /不支持专属 options/);
});

test('Azure rejects missing, empty and oversized files without a cloud request', async (t) => {
    const { file, settings } = await fixture(t);
    const deps = { fetchImpl: () => assert.fail('invalid audio must not upload') };
    await assert.rejects(transcribe(settings, { file: `${file}.missing` }, deps), { code: 'NOT_FOUND' });
    await fs.truncate(file, 0);
    await assert.rejects(transcribe(settings, { file }, deps), /音频为空/);
    await fs.truncate(file, MAX_UPLOAD_BYTES);
    await assert.rejects(transcribe(settings, { file }, deps), /小于 250 MB/);
});

test('Azure reports authentication/throttling/server errors without leaking response text or retrying', async (t) => {
    const { file, settings } = await fixture(t);
    for (const status of [400, 401, 429, 503]) {
        let calls = 0;
        await assert.rejects(transcribe(settings, { file }, {
            async fetchImpl() {
                calls++;
                return new Response('private transcript azure-test-key', { status });
            },
        }), (error) => {
            assert.equal(error.code, 'MEDIA_FAILED');
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.equal(error.retryable, status === 429 || status >= 500);
            assert.ok(!error.message.includes('private transcript'));
            assert.ok(!error.message.includes('azure-test-key'));
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('Azure handles request timeout, unreadable body and non-JSON responses', async (t) => {
    const { file, settings } = await fixture(t);
    await assert.rejects(transcribe(settings, { file }, {
        fetchImpl: async () => { throw new Error('secret-in-network-message'); },
    }), (error) => error.code === 'MEDIA_FAILED' && !error.message.includes('secret-in-network-message'));
    await assert.rejects(transcribe(settings, { file }, {
        fetchImpl: async () => ({ ok: true, text: async () => { throw new Error('stream broken'); } }),
    }), /读取响应失败/);
    await assert.rejects(transcribe(settings, { file }, {
        fetchImpl: async () => new Response('<html>not JSON</html>'),
    }), /有效 JSON/);
});

test('Azure normalization rejects malformed text/time and never invents word timestamps', () => {
    assert.throws(() => normalizeAzureTranscript({ text: 'untimed' }), /缺少 phrases/);
    assert.throws(() => normalizeAzureTranscript({ phrases: [], combinedPhrases: [{ text: 'untimed' }] }), /缺少带时间/);
    for (const mutation of [
        { offsetMilliseconds: -1 }, { offsetMilliseconds: null }, { durationMilliseconds: -10 },
        { durationMilliseconds: '10' }, { text: null }, { words: {} },
        { words: [{ offsetMilliseconds: 0, durationMilliseconds: 10 }] },
    ]) {
        assert.throws(() => normalizeAzureTranscript({ phrases: [{ ...responseBody.phrases[0], ...mutation }] }), { code: 'MEDIA_FAILED' });
    }
    const noWords = normalizeAzureTranscript({ phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 200, text: 'Hello', locale: 'en-US' }] });
    assert.equal(noWords.language, 'en-US');
    assert.equal(noWords.segments[0].words, undefined);
    assert.equal(validateTranscriptResult(noWords, { require: [] }), noWords);
    assert.throws(() => validateTranscriptResult(noWords, { require: ['word-timestamps'] }), /词级时间/);
});

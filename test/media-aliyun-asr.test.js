import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import aliyunAsr, { transcribeAliyun, normalizeAliyunTranscript, MAX_UPLOAD_BYTES } from '../src/media/providers/aliyun-asr.js';
import { validateTranscriptResult } from '../src/media/contracts.js';

const policy = {
    data: {
        oss_access_key_id: 'temporary-access', signature: 'temporary-signature', policy: 'temporary-policy',
        x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
        upload_host: 'https://upload.oss-cn-beijing.aliyuncs.com', upload_dir: 'dashscope-instant/test',
    },
};
const pending = { output: { task_id: 'test-task', task_status: 'PENDING' } };
const success = { output: { task_status: 'SUCCEEDED', results: [
    { subtask_status: 'SUCCEEDED', transcription_url: 'https://results.oss-cn-beijing.aliyuncs.com/result.json?Signature=secret-signature' },
] } };
const transcript = { transcripts: [{ channel_id: 0, text: 'Hello world!', sentences: [
    { begin_time: 100, end_time: 1200, text: 'Hello world!', words: [
        { begin_time: 100, end_time: 500, text: 'Hello ', punctuation: '' },
        { begin_time: 600, end_time: 1200, text: 'world', punctuation: '!' },
    ] },
] }] };
const jsonResponse = (json, status = 200) => new Response(JSON.stringify(json), { status });

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-aliyun-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, '中文 私有音频.wav');
    const apiKeyFile = path.join(dir, 'key');
    await fs.writeFile(file, 'audio-bytes');
    await fs.writeFile(apiKeyFile, 'test-key\nignored-second-line');
    return { file, settings: { apiKeyFile } };
}

function fakeApi(responses) {
    const calls = [];
    return {
        calls,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            assert.ok(responses.length, 'unexpected network request');
            const next = responses.shift();
            return next instanceof Response ? next : jsonResponse(next);
        },
    };
}

test('aliyun uploads a local file, polls once, and normalizes word timestamps without leaking the key', async (t) => {
    const { file, settings } = await fixture(t);
    const api = fakeApi([policy, new Response(''), pending, pending, success, transcript]);
    const waits = [];
    const result = await transcribeAliyun(settings, { file, language: 'en' }, {
        ...api, sleep: async (ms) => waits.push(ms), pollIntervalMs: 10,
    });
    assert.deepEqual(waits, [10]);
    assert.deepEqual(result, { text: 'Hello world!', language: 'en', segments: [
        { start: 0.1, end: 1.2, text: 'Hello world!', words: [
            { start: 0.1, end: 0.5, word: 'Hello ' }, { start: 0.6, end: 1.2, word: 'world!' },
        ] },
    ] });
    validateTranscriptResult(result, { require: ['word-timestamps'] });
    assert.equal(api.calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=paraformer-v2');
    assert.equal(api.calls[0].options.headers.Authorization, 'Bearer test-key');
    const upload = api.calls[1].options;
    assert.equal(upload.headers, undefined);
    assert.equal(upload.body.get('OSSAccessKeyId'), 'temporary-access');
    assert.equal(upload.body.get('Signature'), 'temporary-signature');
    assert.equal(upload.body.get('x-oss-object-acl'), 'private');
    assert.equal(upload.body.get('success_action_status'), '200');
    assert.equal(await upload.body.get('file').text(), 'audio-bytes');
    assert.match(upload.body.get('key'), /^dashscope-instant\/test\/[a-z0-9-]+\.wav$/);
    assert.equal(upload.body.get('key').includes('私有'), false);
    const submit = api.calls[2].options;
    assert.equal(submit.method, 'POST');
    assert.equal(submit.headers['X-DashScope-Async'], 'enable');
    assert.equal(submit.headers['X-DashScope-OssResourceResolve'], 'enable');
    assert.deepEqual(JSON.parse(submit.body), {
        model: 'paraformer-v2', input: { file_urls: [`oss://${upload.body.get('key')}`] },
        parameters: { channel_id: [0], timestamp_alignment_enabled: true, language_hints: ['en'] },
    });
    assert.equal(api.calls[3].options.method, 'GET');
    assert.equal(api.calls[5].options.headers, undefined);
    assert.ok(api.calls.every(({ options }) => options.redirect === 'error' && options.signal instanceof AbortSignal));
    assert.equal(JSON.stringify(result).includes('Signature'), false);
});

test('aliyun supports distinct inference and upload endpoints, default language and model binding', async (t) => {
    const { file, settings } = await fixture(t);
    const api = fakeApi([policy, new Response(''), pending, success, transcript]);
    await transcribeAliyun({ ...settings, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/',
        uploadUrl: 'https://dashscope.aliyuncs.com/api/v1/uploads', language: 'zh',
    }, { file }, api);
    assert.match(api.calls[0].url, /^https:\/\/dashscope.aliyuncs.com/);
    assert.match(api.calls[2].url, /^https:\/\/workspace.cn-beijing.maas.aliyuncs.com/);
    assert.deepEqual(JSON.parse(api.calls[2].options.body).parameters.language_hints, ['zh']);
});

test('aliyun doctor is local only and does not claim an account or quota check', async (t) => {
    const { settings } = await fixture(t);
    const deps = { fetchImpl: () => assert.fail('doctor must not call cloud services') };
    assert.equal((await aliyunAsr.doctor({}, deps)).ready, false);
    assert.equal((await aliyunAsr.doctor({ apiKeyFile: '/missing-key' }, deps)).ready, false);
    const check = await aliyunAsr.doctor(settings, deps);
    assert.equal(check.ready, true);
    assert.match(check.hint, /未验证账号权限/);
    await fs.writeFile(settings.apiKeyFile, '\nsecond-line-key');
    assert.equal((await aliyunAsr.doctor(settings, deps)).ready, false);
});

test('aliyun rejects unsupported model or language before any upload', async (t) => {
    const { file, settings } = await fixture(t);
    const deps = { fetchImpl: () => assert.fail('must not upload') };
    await assert.rejects(transcribeAliyun({ ...settings, model: 'qwen-asr' }, { file }, deps), { code: 'CONFIG_INVALID' });
    await assert.rejects(transcribeAliyun(settings, { file, language: 'zh-CN' }, deps), { code: 'INVALID_INPUT' });
    await assert.rejects(transcribeAliyun({ ...settings, model: 'paraformer-v1', language: 'zh' }, { file }, deps), { code: 'CONFIG_INVALID' });
    await assert.rejects(transcribeAliyun({ ...settings, baseUrl: 'http://example.com' }, { file }, deps), /HTTPS/);
});

test('aliyun rejects missing, empty and oversize local files before network access', async (t) => {
    const { file, settings } = await fixture(t);
    const deps = { fetchImpl: () => assert.fail('must not upload') };
    await assert.rejects(transcribeAliyun(settings, { file: `${file}.missing` }, deps), { code: 'NOT_FOUND' });
    await fs.truncate(file, 0);
    await assert.rejects(transcribeAliyun(settings, { file }, deps), { code: 'INVALID_INPUT' });
    await fs.truncate(file, MAX_UPLOAD_BYTES + 1);
    await assert.rejects(transcribeAliyun(settings, { file }, deps), { code: 'INVALID_INPUT' });
});

test('aliyun refuses failed subtasks, unknown states and malformed result JSON', async (t) => {
    const { file, settings } = await fixture(t);
    for (const result of [
        { output: { task_status: 'FAILED' } },
        { output: { task_status: 'UNKNOWN' } },
        { output: { task_status: 'SUCCEEDED', results: [{ subtask_status: 'FAILED' }] } },
        { output: { task_status: 'SUCCEEDED', results: [] } },
    ]) {
        const api = fakeApi([policy, new Response(''), pending, result]);
        await assert.rejects(transcribeAliyun(settings, { file }, api), (error) => {
            assert.equal(error.code, 'MEDIA_FAILED');
            assert.deepEqual(error.data, { taskId: 'test-task' });
            assert.match(error.message, /test-task.*避免重复提交/);
            return true;
        });
        assert.equal(api.calls.length, 4);
    }
    const api = fakeApi([policy, new Response(''), pending, success, new Response('not-json')]);
    await assert.rejects(transcribeAliyun(settings, { file }, api), (error) => {
        assert.match(error.message, /有效 JSON/);
        assert.deepEqual(error.data, { taskId: 'test-task' });
        return true;
    });
});

test('aliyun never retries a submission and does not surface response bodies or secret URLs', async (t) => {
    const { file, settings } = await fixture(t);
    const api = fakeApi([policy, new Response(''), jsonResponse({ message: 'test-key secret-signature' }, 401)]);
    await assert.rejects(transcribeAliyun(settings, { file }, api), (error) => {
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /test-key|secret-signature/);
        return true;
    });
    assert.equal(api.calls.length, 3);
});

test('aliyun polling is bounded even with an injected immediate clock', async (t) => {
    const { file, settings } = await fixture(t);
    const api = fakeApi([policy, new Response(''), pending, pending, pending]);
    await assert.rejects(transcribeAliyun(settings, { file }, {
        ...api, timeoutMs: 20000, pollIntervalMs: 10000, sleep: async () => {},
    }), (error) => {
        assert.match(error.message, /超时.*test-task/);
        assert.deepEqual(error.data, { taskId: 'test-task' });
        return true;
    });
    assert.equal(api.calls.length, 5);
});

test('aliyun rejects non-OSS upload and result addresses before transmitting data', async (t) => {
    const { file, settings } = await fixture(t);
    const upload = fakeApi([{ data: { ...policy.data, upload_host: 'https://unrelated.example/upload' } }]);
    await assert.rejects(transcribeAliyun(settings, { file }, upload), /OSS/);
    assert.equal(upload.calls.length, 1);
    const result = fakeApi([policy, new Response(''), pending, { output: {
        task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'http://results.oss-cn-beijing.aliyuncs.com/result' }],
    } }]);
    await assert.rejects(transcribeAliyun(settings, { file }, result), /HTTPS/);
    assert.equal(result.calls.length, 4);
});

test('aliyun normalizer preserves silence and refuses invented or invalid timestamps', () => {
    assert.deepEqual(normalizeAliyunTranscript({ transcripts: [] }), { text: '', segments: [] });
    assert.throws(() => normalizeAliyunTranscript({ transcripts: [{ channel_id: 0, text: 'untimed' }] }), /句子时间/);
    for (const begin_time of [null, -1, '100', NaN]) {
        const json = structuredClone(transcript);
        json.transcripts[0].sentences[0].begin_time = begin_time;
        assert.throws(() => normalizeAliyunTranscript(json), /毫秒时间/);
    }
    const missingWords = structuredClone(transcript);
    delete missingWords.transcripts[0].sentences[0].words;
    const result = normalizeAliyunTranscript(missingWords);
    validateTranscriptResult(result, { require: [] });
    assert.throws(() => validateTranscriptResult(result, { require: ['word-timestamps'] }), /词级时间/);
});

test('aliyun preserves the service full text and spaces between English sentences', () => {
    const json = { transcripts: [{ channel_id: 0, text: 'Hello. Next sentence.', sentences: [
        { begin_time: 0, end_time: 100, text: 'Hello.' },
        { begin_time: 200, end_time: 300, text: 'Next sentence.' },
    ] }] };
    assert.equal(normalizeAliyunTranscript(json).text, 'Hello. Next sentence.');
    delete json.transcripts[0].text;
    assert.equal(normalizeAliyunTranscript(json).text, 'Hello. Next sentence.');
});

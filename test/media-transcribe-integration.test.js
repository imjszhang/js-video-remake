import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { resolveConfig } from '../src/config.js';
import { transcriptWords } from '../src/captions.js';

const words = [
    { word: 'Hello', start: 0.125, end: 0.5 },
    { word: 'world!', start: 0.6, end: 1.125 },
];
const expectedCaptions = words.map(({ word: text, start, end }) => ({ text, start, end }));
const selections = [
    { id: 'mlx-whisper', ledger: 'local-llm.whisper-large-v3', settings: { transcriptionUrl: 'http://whisper.test/v1/audio/transcriptions' } },
    { id: 'faster-whisper', ledger: 'faster-whisper.transcribe', settings: { python: '.venv/bin/python' } },
    { id: 'aliyun-asr', ledger: 'aliyun-asr', settings: {} },
    { id: 'azure-speech', ledger: 'azure-speech', settings: { endpoint: 'https://speech-test.cognitiveservices.azure.com' } },
];

async function workspace(t, selection) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-transcribe-integration-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, 'productions/demo/assets'), { recursive: true });
    await fs.writeFile(path.join(directory, 'catalog.json'), JSON.stringify({
        version: 1, references: [], productions: [{ slug: 'demo', dir: 'productions/demo', referenceIds: [] }],
    }));
    await fs.writeFile(path.join(directory, 'speech.wav'), 'local-audio-fixture');
    await fs.writeFile(path.join(directory, 'key'), 'fixture-secret\n');
    const transcribe = { provider: selection.id, ...selection.settings, language: 'zh' };
    if (selection.id !== 'faster-whisper') transcribe.apiKeyFile = 'key';
    await fs.writeFile(path.join(directory, 'video-remake.json'), JSON.stringify({ media: { transcribe } }));
    return { directory, env: { VIDEO_REMAKE_WORKSPACE: directory } };
}

// 只替换网络/进程边界，使用注册表中的真实适配器、配置解析与 CLI 写入路径。
function protocol(selection, directory, withWords = true) {
    const calls = [];
    const transcript = {
        text: 'Hello world!', language: 'en',
        segments: [{ text: 'Hello world!', start: 0.125, end: 1.125, ...(withWords ? { words } : {}) }],
    };
    const deps = {
        fetchImpl: async () => assert.fail('unexpected cloud request'),
        runTranscribe: async () => assert.fail('unexpected Python invocation'),
    };
    if (selection.id === 'faster-whisper') {
        deps.runTranscribe = async (executable, args, options) => {
            calls.push({ executable, args, options });
            assert.equal(executable, path.join(directory, '.venv/bin/python'));
            const input = JSON.parse(args[3]);
            assert.equal(input.file, path.join(directory, 'speech.wav'));
            assert.equal(input.language, 'en');
            assert.equal(input.localFilesOnly, true);
            assert.equal(options.env.VIDEO_REMAKE_WORKSPACE, directory);
            return { stdout: JSON.stringify(transcript) };
        };
    } else if (selection.id === 'mlx-whisper') {
        deps.fetchImpl = async (url, init) => {
            calls.push({ url, init });
            assert.equal(url, selection.settings.transcriptionUrl);
            assert.equal(init.body.get('language'), 'en');
            assert.equal(init.body.get('model'), 'whisper-large-v3');
            assert.equal(init.headers.Authorization, 'Bearer fixture-secret');
            return Response.json(transcript);
        };
    } else if (selection.id === 'azure-speech') {
        deps.fetchImpl = async (url, init) => {
            calls.push({ url, init });
            assert.match(url, /\/speechtotext\/transcriptions:transcribe\?api-version=2025-10-15$/);
            assert.deepEqual(JSON.parse(init.body.get('definition')).locales, ['en-US']);
            assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'fixture-secret');
            return Response.json({
                combinedPhrases: [{ text: transcript.text }],
                phrases: [{
                    text: transcript.text, offsetMilliseconds: 125, durationMilliseconds: 1000, locale: 'en-US',
                    ...(withWords ? { words: [
                        { text: 'Hello', offsetMilliseconds: 125, durationMilliseconds: 375 },
                        { text: 'world!', offsetMilliseconds: 600, durationMilliseconds: 525 },
                    ] } : {}),
                }],
            });
        };
    } else {
        let polled = false;
        deps.pollIntervalMs = 1;
        deps.sleep = async () => {};
        deps.fetchImpl = async (url, init) => {
            calls.push({ url, init });
            if (url.includes('/uploads?')) return Response.json({ data: {
                oss_access_key_id: 'temporary', signature: 'signature', policy: 'policy',
                x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
                upload_host: 'https://upload.oss-cn-beijing.aliyuncs.com', upload_dir: 'fixture',
            } });
            if (new URL(url).hostname === 'upload.oss-cn-beijing.aliyuncs.com') return new Response('');
            if (url.endsWith('/services/audio/asr/transcription')) {
                assert.deepEqual(JSON.parse(init.body).parameters.language_hints, ['en']);
                assert.equal(init.headers.Authorization, 'Bearer fixture-secret');
                return Response.json({ output: { task_id: 'fixture-task' } });
            }
            if (url.endsWith('/tasks/fixture-task')) {
                if (!polled) {
                    polled = true;
                    return Response.json({ output: { task_status: 'RUNNING' } });
                }
                return Response.json({ output: { task_status: 'SUCCEEDED', results: [{
                    subtask_status: 'SUCCEEDED', transcription_url: 'https://result.oss-cn-beijing.aliyuncs.com/transcript.json',
                }] } });
            }
            assert.equal(new URL(url).hostname, 'result.oss-cn-beijing.aliyuncs.com');
            assert.equal(init.headers, undefined);
            return Response.json({ transcripts: [{ channel_id: 0, sentences: [{
                text: transcript.text, begin_time: 125, end_time: 1125,
                ...(withWords ? { words: [
                    { text: 'Hello', begin_time: 125, end_time: 500 },
                    { text: 'world', punctuation: '!', begin_time: 600, end_time: 1125 },
                ] } : {}),
            }] }] });
        };
    }
    return { deps, calls };
}

for (const selection of selections) {
    test(`${selection.id} CLI 从配置到真实适配器落地统一字幕格式，命令语言覆盖默认`, async (t) => {
        const { directory, env } = await workspace(t, selection);
        const config = resolveConfig({}, env);
        assert.equal(config.media.transcribe.provider, selection.id);
        assert.equal(config.media.transcribe.settings.language, 'zh');
        const { deps, calls } = protocol(selection, directory);
        const result = await execute(parseArgv([
            'media:transcribe', 'demo', '--from', 'speech.wav', '--language', 'en', '--require', 'word-timestamps',
        ]), env, deps);
        assert.equal(result.ok, true);
        assert.equal(result.data.provider, selection.ledger);
        assert.equal(result.data.path, 'productions/demo/assets/speech.transcript.json');
        assert.equal(result.data.next, 'remake captions demo --from assets/speech.transcript.json');
        assert.ok(calls.length > 0);
        const written = JSON.parse(await fs.readFile(path.join(directory, result.data.path), 'utf8'));
        assert.equal(written.text, 'Hello world!');
        assert.deepEqual(transcriptWords(written), expectedCaptions);
        assert.equal(JSON.stringify(written).includes('fixture-secret'), false);
    });

    test(`${selection.id} CLI 在逐词结果缺失时拒绝覆盖原有转写`, async (t) => {
        const { directory, env } = await workspace(t, selection);
        const target = path.join(directory, 'productions/demo/assets/speech.transcript.json');
        const original = '{"text":"原始转写","segments":[{"text":"原始转写","start":0,"end":1}]}\n';
        await fs.writeFile(target, original);
        const { deps, calls } = protocol(selection, directory, false);
        const argv = ['media:transcribe', 'demo', '--from', 'speech.wav', '--language', 'en', '--require', 'word-timestamps'];
        await assert.rejects(execute(parseArgv(argv), env, deps), { code: 'ALREADY_EXISTS' });
        assert.equal(calls.length, 0, '不覆盖时不应转写或上传');
        await assert.rejects(execute(parseArgv([...argv, '--force']), env, deps), { code: 'MEDIA_FAILED' });
        assert.ok(calls.length > 0);
        assert.equal(await fs.readFile(target, 'utf8'), original);
    });
}

test('faster-whisper CLI doctor 透传模拟进程且不启动转写或访问网络', async (t) => {
    const selection = selections.find((entry) => entry.id === 'faster-whisper');
    const { directory, env } = await workspace(t, selection);
    let calls = 0;
    const result = await execute(parseArgv(['media:doctor', '--task', 'transcribe']), env, {
        fetchImpl: async () => assert.fail('doctor 不应联网'),
        runTranscribe: async (executable, args, options) => {
            calls++;
            assert.equal(executable, path.join(directory, '.venv/bin/python'));
            assert.deepEqual(args.slice(2), ['--doctor']);
            assert.equal(options.env.VIDEO_REMAKE_WORKSPACE, directory);
            return { stdout: '{"status":"ok","version":"mock-local-package"}' };
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.data.media.transcribe.provider, 'faster-whisper');
    assert.equal(result.data.media.transcribe.ready, true);
    assert.equal(result.data.media.transcribe.version, 'mock-local-package');
    assert.equal(result.data.media.transcribe.settings.python, undefined);
});

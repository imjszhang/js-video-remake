import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { resolveMediaConfig } from '../src/media/config.js';
import qwenTts, { pcmWavInfo } from '../src/media/providers/qwen-tts.js';
import macosSay from '../src/media/providers/macos-say.js';
import { tempWorkspace } from './helpers.js';

function wav(seconds = 1.2) {
    const rate = 16000;
    const data = Buffer.alloc(Math.round(seconds * rate) * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

test('qwen-tts 用参考音频提交克隆请求并保存 WAV', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-tts-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const reference = path.join(dir, 'ref.wav');
    const keyFile = path.join(dir, 'key');
    await fs.writeFile(reference, wav());
    await fs.writeFile(keyFile, 'gateway-key\n');
    let seen;
    const result = await qwenTts.synthesize({
        baseUrl: 'http://speech.test', apiKeyFile: keyFile, model: 'qwen3-tts',
    }, {
        text: '你好', reference, referenceText: '你', language: 'Chinese', options: {},
    }, {
        fetchImpl: async (url, init) => {
            seen = { url: String(url), body: JSON.parse(init.body), authorization: init.headers.Authorization };
            return new Response(wav(), { status: 200 });
        },
    });
    assert.equal(seen.url, 'http://speech.test/v1/audio/speech');
    assert.equal(seen.authorization, 'Bearer gateway-key');
    assert.equal(seen.body.model, 'qwen3-tts');
    assert.equal(seen.body.input, '你好');
    assert.equal(seen.body.ref_text, '你');
    assert.equal(seen.body.language, 'Chinese');
    assert.equal(seen.body.response_format, 'wav');
    assert.equal(seen.body.ref_audio_base64, wav().toString('base64'));
    assert.equal((await fs.readFile(result.path)).subarray(0, 4).toString(), 'RIFF');
    assert.equal(result.provider, 'qwen-tts.speak');
    let calls = 0;
    const retried = await qwenTts.synthesize({
        baseUrl: 'http://speech.test', apiKeyFile: keyFile,
    }, {
        text: '你好', reference, referenceText: '你', options: {},
    }, {
        fetchImpl: async () => {
            calls += 1;
            return calls === 1
                ? new Response('<html>502</html>', { status: 502 })
                : new Response(wav(), { status: 200 });
        },
    });
    assert.equal(calls, 2);
    assert.equal((await fs.readFile(retried.path)).subarray(0, 4).toString(), 'RIFF');
    const short = path.join(dir, 'short.wav');
    await fs.writeFile(short, wav(0.2));
    await assert.rejects(qwenTts.synthesize({
        baseUrl: 'http://speech.test', apiKeyFile: keyFile,
    }, {
        text: '你好', reference: short, referenceText: '你', options: {},
    }, { fetchImpl: () => assert.fail('过短参考音频不得上传') }), { code: 'INVALID_INPUT' });
});

test('参考音频时长在本地按 WAV 头计算', () => {
    assert.ok(pcmWavInfo(wav(2)).duration > 1.9);
    assert.throws(() => pcmWavInfo(wav(0.4)), /1 到 30 秒/);
    assert.throws(() => pcmWavInfo(Buffer.from('not-wav')), /WAV/);
});

test('语音合成配置按 provider 隔离，命令把需求交给所选工具', async (t) => {
    assert.throws(() => resolveMediaConfig({ speech: { provider: 'macos-say', baseUrl: 'http://speech.test' } }, {}, '/tmp/work'), /not a macos-say setting/);
    assert.equal(resolveMediaConfig({ speech: { provider: 'qwen-tts', baseUrl: 'http://file.test' } }, { QWEN_TTS_BASE_URL: 'http://env.test' }, '/tmp/work').speech.settings.baseUrl, 'http://env.test/');
    const workspace = await tempWorkspace(t);
    const target = path.join(workspace.directory, 'out.wav');
    const result = await execute(parseArgv([
        'media:speech', '--text', '下一句', '--voice', 'Tingting', '--out', 'out.wav',
    ]), { ...workspace.env, VIDEO_REMAKE_MEDIA_SPEECH: 'macos-say' }, {
        runSay: async (_executable, args) => {
            assert.ok(args.includes('Tingting'));
            const output = args[args.indexOf('-o') + 1];
            await fs.writeFile(output, wav());
            return { exitCode: 0 };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.provider, 'macos-say.speak');
    assert.equal(result.data.path, target);
});

test('qwen-tts 未传参考音频时使用已保存音色，显式参考音频则不用它', async (t) => {
    const workspace = await tempWorkspace(t);
    const reference = path.join(workspace.directory, 'ref.wav');
    const other = path.join(workspace.directory, 'other.wav');
    const keyFile = path.join(workspace.directory, 'key');
    await fs.writeFile(reference, wav());
    await fs.writeFile(other, wav(2));
    await fs.writeFile(keyFile, 'gateway-key\n');
    const env = {
        ...workspace.env,
        VIDEO_REMAKE_MEDIA_SPEECH: 'qwen-tts',
        QWEN_TTS_BASE_URL: 'http://speech.test',
        QWEN_TTS_API_KEY_FILE: keyFile,
    };
    const saved = await execute(parseArgv(['voice:save', '--from', 'ref.wav', '--text', '参考原话']), workspace.env);
    assert.equal(saved.ok, true);
    assert.equal(saved.data.id, 'default');
    assert.equal(saved.data.file, 'voices/default.wav');
    let bodies = [];
    const speak = async (argv) => execute(parseArgv(argv), env, {
        fetchImpl: async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            return new Response(wav(), { status: 200 });
        },
    });
    const result = await speak(['media:speech', '--text', '新台词', '--out', 'out.wav']);
    assert.equal(result.data.voiceId, 'default');
    assert.equal(bodies[0].input, '新台词');
    assert.equal(bodies[0].ref_text, '参考原话');
    assert.equal(bodies[0].ref_audio_base64, wav().toString('base64'));
    bodies = [];
    const override = await speak(['media:speech', '--text', '另一句', '--reference', 'other.wav', '--reference-text', '另一段原话', '--out', 'other-out.wav']);
    assert.equal(override.data.voiceId, undefined);
    assert.equal(bodies[0].ref_text, '另一段原话');
    assert.equal(bodies[0].ref_audio_base64, wav(2).toString('base64'));
});

test('没有保存音色时不会请求语音服务，系统音色也不读取音色样本', async (t) => {
    const workspace = await tempWorkspace(t);
    const keyFile = path.join(workspace.directory, 'key');
    await fs.writeFile(keyFile, 'gateway-key\n');
    const listed = await execute(parseArgv(['voice:list']), workspace.env);
    assert.equal(listed.data.voices.length, 0);
    await assert.rejects(fs.access(path.join(workspace.directory, 'voices.json')), { code: 'ENOENT' });
    await assert.rejects(execute(parseArgv(['media:speech', '--text', '你好', '--out', 'out.wav']), {
        ...workspace.env,
        VIDEO_REMAKE_MEDIA_SPEECH: 'qwen-tts',
        QWEN_TTS_BASE_URL: 'http://speech.test',
        QWEN_TTS_API_KEY_FILE: keyFile,
    }, { fetchImpl: () => assert.fail('没有音色时不得请求服务') }), /voice:save/);
    await assert.rejects(execute(parseArgv(['media:speech', '--text', '你好', '--voice-id', 'default']), {
        ...workspace.env, VIDEO_REMAKE_MEDIA_SPEECH: 'macos-say',
    }), /系统音色/);
});

test('macos-say 在非 macOS 上未就绪，并且不接受参考音频', async () => {
    const check = await macosSay.doctor({}, { platform: 'linux' });
    assert.equal(check.ready, false);
    assert.throws(() => macosSay.validateRequest({ text: '你好', reference: '/tmp/a.wav', referenceText: '你好', options: {} }), /参考音频/);
});

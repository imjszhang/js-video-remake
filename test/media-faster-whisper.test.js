import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import provider from '../src/media/providers/faster-whisper.js';

async function audio(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'faster-whisper-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'speech ; $(never-execute).wav');
    await fs.writeFile(file, 'fixture');
    return file;
}

const transcript = {
    text: '你好', language: 'zh', duration: 1.5,
    segments: [{ start: 0.25, end: 1.5, text: '你好', words: [{ start: 0.25, end: 1.5, word: '你好' }] }],
};

test('faster-whisper 直接调用 Python，传递本地路径与秒制词时间且默认不下载', async (t) => {
    const file = await audio(t);
    let calls = 0;
    const env = { PATH: '/mock/bin', CUSTOM_VALUE: 'kept' };
    const result = await provider.transcribe({}, { file, require: ['word-timestamps'] }, {
        env,
        runTranscribe: async (executable, args, options) => {
            calls += 1;
            assert.equal(executable, 'python3');
            assert.equal(args[0], '-I');
            assert.equal(path.basename(args[1]), 'faster-whisper-runner.py');
            assert.equal(args[2], '--transcribe');
            assert.deepEqual(JSON.parse(args[3]), { model: 'large-v3', device: 'cpu', computeType: 'int8', localFilesOnly: true, file, language: null });
            assert.deepEqual(options.env, { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' });
            assert.equal(env.HF_HUB_OFFLINE, undefined);
            assert.equal(options.timeout, 1800000);
            assert.equal(options.maxBuffer, 32 * 1024 * 1024);
            assert.equal(options.killSignal, 'SIGKILL');
            assert.equal(options.shell, undefined);
            return { stdout: JSON.stringify(transcript), stderr: '' };
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, transcript);
});

test('faster-whisper 指定环境、模型、缓存、设备与命令语言优先', async (t) => {
    const file = await audio(t);
    await provider.transcribe({ python: '/venv with spaces/python', model: '/models/large', device: 'cuda', computeType: 'float16', cacheDir: '/cache', localFilesOnly: 'false', language: 'zh' }, { file, language: 'en' }, {
        timeoutMs: 1234,
        runTranscribe: async (executable, args, options) => {
            assert.equal(executable, '/venv with spaces/python');
            assert.deepEqual(JSON.parse(args[3]), { model: '/models/large', device: 'cuda', computeType: 'float16', localFilesOnly: false, cacheDir: '/cache', file, language: 'en' });
            assert.equal(options.timeout, 1234);
            return JSON.stringify(transcript);
        },
    });
});

test('faster-whisper doctor 仅验证包，明确未验证模型与设备', async () => {
    const result = await provider.doctor({}, {
        runTranscribe: async (executable, args, options) => {
            assert.equal(executable, 'python3');
            assert.deepEqual(args.slice(2), ['--doctor']);
            assert.equal(options.timeout, 15000);
            return { stdout: '{"status":"ok","version":"test-version"}' };
        },
    });
    assert.equal(result.ready, true);
    assert.equal(result.version, 'test-version');
    assert.match(result.hint, /未加载模型/);
    for (const stdout of ['{}', '{"status":"ok"}', 'unexpected logging']) {
        assert.equal((await provider.doctor({}, { runTranscribe: async () => stdout })).ready, false);
    }
    const missing = await provider.doctor({}, { runTranscribe: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    assert.equal(missing.ready, false);
    assert.match(missing.hint, /找不到 Python/);
});

test('faster-whisper 在调用进程前拒绝无效配置、丢失或空音频', async (t) => {
    const file = await audio(t);
    const deps = { runTranscribe: () => assert.fail('不应启动 Python') };
    for (const settings of [{ device: 'metal' }, { computeType: 'oops' }, { localFilesOnly: 'yes' }, { localFilesOnly: true }]) {
        await assert.rejects(provider.transcribe(settings, { file }, deps), { code: 'CONFIG_INVALID' });
        assert.equal((await provider.doctor(settings, deps)).ready, false);
    }
    await assert.rejects(provider.transcribe({}, { file: `${file}.missing` }, deps), { code: 'NOT_FOUND' });
    await fs.writeFile(file, '');
    await assert.rejects(provider.transcribe({}, { file }, deps), { code: 'INVALID_INPUT' });
});

test('faster-whisper 区分缺少环境、超时、输出超限与模型运行错误', async (t) => {
    const file = await audio(t);
    for (const [failure, code, message] of [
        [Object.assign(new Error('missing'), { code: 'ENOENT' }), 'MEDIA_UNAVAILABLE', /找不到 Python/],
        [Object.assign(new Error('timed out'), { killed: true }), 'MEDIA_FAILED', /运行超时/],
        [Object.assign(new Error('overflow'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'MEDIA_FAILED', /超过 32 MiB/],
        [Object.assign(new Error('failed'), { stderr: 'LocalEntryNotFoundError: model cache missing' }), 'MEDIA_FAILED', /model cache missing/],
    ]) {
        await assert.rejects(provider.transcribe({}, { file }, { runTranscribe: async () => { throw failure; } }), (error) => error.code === code && message.test(error.message));
    }
});

test('faster-whisper 拒绝无效输出、负时间和缺少词时间的结果', async (t) => {
    const file = await audio(t);
    for (const stdout of ['not json', '{}', JSON.stringify({ segments: [{ start: -1, end: 1, text: 'hi' }] }), JSON.stringify({ segments: [{ start: 0, end: 1, text: 'hi' }] })]) {
        await assert.rejects(provider.transcribe({}, { file, require: ['word-timestamps'] }, { runTranscribe: async () => ({ stdout }) }), { code: 'MEDIA_FAILED' });
    }
    const silence = { text: '', segments: [] };
    assert.deepEqual(await provider.transcribe({}, { file }, { runTranscribe: async () => JSON.stringify(silence) }), silence);
});

test('Python runner 使用模拟模型遍历惰性分段，保持 JSON 输出；doctor 不创建模型', async (t) => {
    const run = promisify(execFile);
    try { await run('python3', ['-I', '-c', 'import sys'], { timeout: 5000 }); }
    catch (error) {
        if (error.code === 'ENOENT') { t.skip('本机无 Python，跳过纯模拟 runner 测试'); return; }
        throw error;
    }
    const runner = fileURLToPath(new URL('../src/media/providers/faster-whisper-runner.py', import.meta.url));
    const stub = `
import importlib.metadata, json, runpy, sys, types
module = types.ModuleType("faster_whisper")
class FakeModel:
    def __init__(self, model, **kwargs):
        assert sys.argv[1] != "--doctor", "doctor 不应加载模型"
        assert model == "fixture"
        assert kwargs == {"device": "cpu", "compute_type": "int8", "download_root": None, "local_files_only": True}
    def transcribe(self, file, **kwargs):
        assert file == "local.wav"
        assert kwargs == {"language": "zh", "word_timestamps": True}
        print("library log should go to stderr")
        def rows():
            yield types.SimpleNamespace(start=0.25, end=1.5, text="你好", words=[types.SimpleNamespace(start=0.25, end=1.5, word="你好")])
        return rows(), types.SimpleNamespace(language="zh", duration=1.5)
module.WhisperModel = FakeModel
sys.modules["faster_whisper"] = module
importlib.metadata.version = lambda package: "mock-version"
runner = sys.argv[1]
sys.argv = [runner] + sys.argv[2:]
runpy.run_path(runner, run_name="__main__")
`;
    const payload = JSON.stringify({ model: 'fixture', device: 'cpu', computeType: 'int8', localFilesOnly: true, file: 'local.wav', language: 'zh' });
    const result = await run('python3', ['-I', '-c', stub, runner, '--transcribe', payload], { timeout: 5000 });
    assert.deepEqual(JSON.parse(result.stdout), transcript);
    assert.match(result.stderr, /library log/);
    const doctor = await run('python3', ['-I', '-c', stub, runner, '--doctor'], { timeout: 5000 });
    assert.deepEqual(JSON.parse(doctor.stdout), { status: 'ok', version: 'mock-version' });
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { speechOptions, synthesizeCaptionSpeech, synthesizeClonedCaptionSpeech } from '../src/template-speech.js';

const voices = 'Tingting            zh_CN    # 你好\nSamantha            en_US    # Hello\nBad News            en_US    # Hi\nEddy (中文（台湾）)    zh_TW    # 你好\nAlice               it_IT    # Ciao';
async function fixture(t, { durations = [1, 1], onCall } = {}) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'template-speech-test-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const state = { calls: [], texts: [], temporary: new Set(), timeline: null };
    const runSpeechCommand = async (executable, args, options) => {
        state.calls.push({ executable, args, options });
        const intercept = await onCall?.(executable, args, options);
        if (intercept) return intercept;
        if (executable === '/usr/bin/say' && args[1] === '?') return { exitCode: 0, stdout: voices };
        if (args[0] === '-version') return { exitCode: 0, stdout: 'fixture tool' };
        if (executable === '/usr/bin/say') {
            const file = args[args.indexOf('-f') + 1]; state.temporary.add(path.dirname(file));
            state.texts.push(await fs.readFile(file, 'utf8'));
            await fs.writeFile(args[args.indexOf('-o') + 1], 'fixture aiff');
        } else if (executable === 'ffprobe') {
            const index = Number(/sentence-(\d+)/.exec(args.at(-1))[1]);
            return { exitCode: 0, stdout: JSON.stringify({ format: { duration: durations[index] } }) };
        } else if (executable === 'ffmpeg' && args.at(-1).endsWith('.pcm')) {
            const index = Number(/sentence-(\d+)/.exec(args.at(-1))[1]);
            const filter = args[args.indexOf('-af') + 1];
            const speed = [...filter.matchAll(/atempo=([0-9.]+)/g)].reduce((value, item) => value * Number(item[1]), 1);
            const samples = Math.floor(durations[index] / speed * 48000);
            await fs.writeFile(args.at(-1), Buffer.alloc(samples * 2, index + 1));
        } else if (executable === 'ffmpeg') {
            state.timeline = await fs.readFile(args[args.indexOf('-i') + 1]);
            await fs.writeFile(args.at(-1), 'fixture wav');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { config: { workspace, env: {} }, state, deps: { platform: 'darwin', runSpeechCommand }, outputFile: path.join(workspace, 'voice.wav') };
}
const rows = [{ start: 1, end: 3, zh: '我是{{name}}。', en: 'I am {{name}}.' }, { start: 5, end: 7, zh: '第二句。', en: 'Second sentence.' }];

test('system voices are parsed without exposing scripts and provide per-language defaults', async t => {
    const f = await fixture(t);
    const options = await speechOptions(f.config, f.deps);
    assert.equal(options.available, true);
    assert.equal(options.defaultVoice, 'Tingting');
    assert.deepEqual(options.voices.filter(voice => voice.default).map(voice => voice.id), ['Tingting', 'Samantha']);
    assert.ok(options.voices.some(voice => voice.id === 'Bad News'));
    assert.ok(options.voices.some(voice => voice.id === 'Eddy (中文（台湾）)'));
    assert.ok(!options.voices.some(voice => voice.id === 'Alice'));
    assert.equal((await speechOptions(f.config, { platform: 'linux' })).available, false);
});

test('speech fills identity safely and aligns sentences, silent gaps and final duration exactly', async t => {
    const f = await fixture(t); const progress = [];
    const result = await synthesizeCaptionSpeech(f.config, { rows, identity: { name: '小张[[rate 999]]' }, duration: 8, outputFile: f.outputFile }, { ...f.deps, onProgress: event => progress.push(event) });
    assert.equal(result.count, 2); assert.equal(result.adjustedCount, 0); assert.equal(result.firstAt, 1);
    assert.equal(f.state.timeline.length, 8 * 48000 * 2);
    assert.ok(f.state.timeline.subarray(0, 48000 * 2).every(byte => byte === 0));
    assert.ok(f.state.timeline.subarray(48000 * 2, 2 * 48000 * 2).every(byte => byte === 1));
    assert.ok(f.state.timeline.subarray(2 * 48000 * 2, 5 * 48000 * 2).every(byte => byte === 0));
    assert.ok(f.state.timeline.subarray(7 * 48000 * 2).every(byte => byte === 0));
    assert.match(f.state.texts[0], /小张/); assert.doesNotMatch(f.state.texts[0], /\[\[|\]\]|\{\{/);
    assert.ok(!f.state.calls.some(call => call.args.some(arg => arg.includes('小张'))));
    assert.deepEqual(progress.slice(0, 2).map(event => event.captionIndex), [0, 1]);
    for (const dir of f.state.temporary) await assert.rejects(fs.access(dir), { code: 'ENOENT' });
    assert.equal(await fs.readFile(f.outputFile, 'utf8'), 'fixture wav');
});

test('long sentences are accelerated within limit and excessive density reports the exact sentence', async t => {
    const f = await fixture(t, { durations: [4, 1] });
    const result = await synthesizeCaptionSpeech(f.config, { rows, identity: { name: '小张' }, duration: 8, outputFile: f.outputFile }, f.deps);
    assert.equal(result.adjustedCount, 1);
    assert.ok(f.state.calls.some(call => call.args.some(arg => arg.startsWith('atempo=2,atempo='))));
    const excessive = await fixture(t, { durations: [7] });
    await assert.rejects(synthesizeCaptionSpeech(excessive.config, { rows, identity: { name: '小张' }, duration: 8, outputFile: excessive.outputFile }, excessive.deps), /第 1 句.*3 倍/);
    await assert.rejects(fs.access(excessive.outputFile), { code: 'ENOENT' });
    for (const dir of excessive.state.temporary) await assert.rejects(fs.access(dir), { code: 'ENOENT' });
});

test('English blank sentences stay silent, while empty scripts and unknown identity fail explicitly', async t => {
    const f = await fixture(t);
    const result = await synthesizeCaptionSpeech(f.config, { rows: [{ ...rows[0], en: '' }, rows[1]], duration: 8, language: 'en', outputFile: f.outputFile }, f.deps);
    assert.equal(result.voice, 'Samantha'); assert.equal(result.count, 1); assert.equal(result.skippedCount, 1); assert.equal(result.firstAt, 5);
    assert.ok(f.state.timeline.subarray(0, 5 * 48000 * 2).every(byte => byte === 0));
    const other = await fixture(t);
    await assert.rejects(synthesizeCaptionSpeech(other.config, { rows: rows.map(row => ({ ...row, en: '' })), duration: 8, language: 'en', outputFile: other.outputFile }, other.deps), /没有可朗读的英文/);
    await assert.rejects(synthesizeCaptionSpeech(other.config, { rows, duration: 8, outputFile: other.outputFile }, other.deps), /第 1 句.*name/);
});

test('saved voice speaks each caption without the system voice and keeps the timeline', async t => {
    const f = await fixture(t);
    const spoken = [];
    const result = await synthesizeClonedCaptionSpeech(f.config, {
        rows, identity: { name: '小张[[rate 999]]' }, duration: 8, outputFile: f.outputFile,
        reference: '/voices/default.wav', referenceText: '参考原话', voice: 'default',
    }, {
        ...f.deps,
        speak: async (request) => {
            spoken.push(request);
            await fs.writeFile(request.outPath, 'cloned wav');
        },
    });
    assert.equal(result.provider, 'qwen-tts');
    assert.equal(result.voice, 'default');
    assert.equal(result.count, 2);
    assert.equal(result.firstAt, 1);
    assert.equal(spoken.length, 2);
    assert.equal(spoken[0].language, 'Chinese');
    assert.equal(spoken[0].referenceText, '参考原话');
    assert.match(spoken[0].text, /小张/);
    assert.doesNotMatch(spoken[0].text, /\[\[|\]\]|\{\{/);
    assert.equal(f.state.timeline.length, 8 * 48000 * 2);
    assert.ok(f.state.timeline.subarray(48000 * 2, 2 * 48000 * 2).every(byte => byte === 1));
    assert.ok(!f.state.calls.some(call => call.executable === '/usr/bin/say'));
    assert.equal(await fs.readFile(f.outputFile, 'utf8'), 'fixture wav');
});

function pcmWav(seconds = 1.5, rate = 16000) {
    const data = Buffer.alloc(Math.floor(seconds * rate) * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

test('qwen-tts clones each caption from the reference clip and keeps the subtitle timeline', async t => {
    const f = await fixture(t);
    const reference = path.join(f.config.workspace, 'reference.wav');
    await fs.writeFile(reference, pcmWav());
    const spoken = [];
    f.deps.speechProvider = {
        id: 'qwen-tts', label: 'Qwen3 TTS（参考音频克隆，WAV）',
        doctor: async () => ({ ready: true, version: 'qwen3-tts' }),
        synthesize: async (_settings, request) => {
            spoken.push({ text: request.text, reference: request.reference, referenceText: request.referenceText, language: request.language });
            await fs.writeFile(request.outPath, 'sentence wav');
            return { path: request.outPath, provider: 'qwen-tts.speak' };
        },
    };
    f.deps.platform = 'linux';
    const options = await speechOptions(f.config, f.deps);
    assert.equal(options.available, true);
    assert.equal(options.referenceRequired, true);
    assert.equal(options.provider, 'qwen-tts');
    const result = await synthesizeCaptionSpeech(f.config, {
        rows, identity: { name: '小张' }, duration: 8, outputFile: f.outputFile, reference, referenceText: '参考原话',
    }, f.deps);
    assert.equal(result.provider, 'qwen-tts');
    assert.equal(result.voice, 'qwen3-tts');
    assert.equal(result.count, 2);
    assert.deepEqual(spoken.map(item => item.language), ['Chinese', 'Chinese']);
    assert.deepEqual(spoken.map(item => item.text), ['我是小张。', '第二句。']);
    assert.ok(spoken.every(item => item.reference === reference && item.referenceText === '参考原话'));
    assert.ok(!f.state.calls.some(call => call.executable === '/usr/bin/say' && call.args.includes('-f')));
    assert.equal(f.state.timeline.length, 8 * 48000 * 2);
    await assert.rejects(synthesizeCaptionSpeech(f.config, { rows, identity: { name: '小张' }, duration: 8, outputFile: path.join(f.config.workspace, 'missing.wav') }, f.deps), /参考音频/);
});

test('cancellation cleans temporary speech data and existing outputs cannot be overwritten', async t => {
    const controller = new AbortController();
    const f = await fixture(t, { onCall: async (executable, args) => { if (executable === '/usr/bin/say' && args.includes('-f')) { controller.abort(); return { exitCode: null, termination: 'cancelled' }; } } });
    await assert.rejects(synthesizeCaptionSpeech(f.config, { rows, identity: { name: '小张' }, duration: 8, outputFile: f.outputFile }, { ...f.deps, signal: controller.signal }), { code: 'VIDEO_CANCELLED' });
    const temporary = f.state.calls.find(call => call.args.includes('-f')).args;
    await assert.rejects(fs.access(path.dirname(temporary[temporary.indexOf('-f') + 1])), { code: 'ENOENT' });
    await assert.rejects(fs.access(f.outputFile), { code: 'ENOENT' });
    await fs.writeFile(f.outputFile, 'existing');
    await assert.rejects(synthesizeCaptionSpeech(f.config, { rows, duration: 8, outputFile: f.outputFile }, f.deps), /不能覆盖/);
    assert.equal(await fs.readFile(f.outputFile, 'utf8'), 'existing');
});

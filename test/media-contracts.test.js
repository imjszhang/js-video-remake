import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { resolveConfig } from '../src/config.js';
import { transcriptWords } from '../src/captions.js';
import { PROVIDERS, resolveMediaConfig } from '../src/media/config.js';
import { mediaDoctor, mediaImage, mediaLand, mediaPrepare, mediaTranscribe } from '../src/media/index.js';
import { downloadedVideo, run, tempWorkspace } from './helpers.js';

async function emptyWorkspace(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-media-contract-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    return workspace;
}

async function production(t) {
    const workspace = await tempWorkspace(t, { videos: { abcdefghijk: downloadedVideo() } });
    await run(['bind', 'abcdefghijk'], workspace.env);
    await run(['start', 'youtube-abcdefghijk', '--as', 'demo'], workspace.env);
    return { ...workspace, config: resolveConfig({}, workspace.env) };
}

function adapter(task, overrides = {}) {
    return {
        id: `fixture-${task}`,
        task,
        label: '模拟素材工具',
        guide: `providers/fixture-${task}.md`,
        ledgerProviders: [`fixture.${task}`],
        testedVersion: '1',
        execution: 'program',
        capabilities: task === 'image' ? ['text-to-image', 'image-edit'] : ['timed-transcription', 'word-timestamps'],
        fields: {},
        publicSettings: [],
        doctor: async () => ({ ready: true, version: '1', hint: '' }),
        ...overrides,
    };
}

function select(config, provider, settings = {}) {
    const providers = {
        ...PROVIDERS,
        [provider.task]: { ...PROVIDERS[provider.task], [provider.id]: provider },
    };
    const media = resolveMediaConfig({ [provider.task]: { provider: provider.id, ...settings } }, {}, config.workspace, providers);
    return { config: { ...config, media }, deps: { providers } };
}

test('相同图片需求切换适配器后仍通过同一素材入口登记', async (t) => {
    const { config, directory } = await production(t);
    const reference = path.join(directory, 'reference.png');
    const produced = path.join(directory, 'produced.png');
    await fs.writeFile(reference, 'reference-image');
    await fs.writeFile(produced, 'generated-image');
    const flags = { intent: '保留人物身份，背景换成办公室', image: ['reference.png'] };
    const original = select(config, adapter('image', {
        id: 'fixture-original', ledgerProviders: ['fixture.original'],
        generateImage: async () => ({ path: produced, provider: 'fixture.original' }),
    }));
    const first = await mediaImage(original.config, flags, original.deps);
    const calls = [];
    const replacement = adapter('image', {
        generateImage: async (settings, request) => {
            calls.push({ settings, request });
            return { path: produced, provider: 'fixture.image' };
        },
    });
    const selected = select(config, replacement);
    const second = await mediaImage(selected.config, flags, selected.deps);
    for (const [index, result] of [first, second].entries()) {
        const landed = await mediaLand(config, {
            slug: 'demo', kind: 'image', from: result.path, intent: flags.intent,
            provider: result.provider, id: `img-demo-switch-${index}`,
        });
        assert.equal(await fs.readFile(path.join(directory, landed.path), 'utf8'), 'generated-image');
        assert.match(landed.next, /^remake video:add demo --id /);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.intent, flags.intent);
    assert.deepEqual(calls[0].request.images, [reference]);
    const ledger = JSON.parse(await fs.readFile(path.join(directory, 'productions/demo/assets/ledger.json'), 'utf8'));
    assert.deepEqual(ledger.items.map((item) => item.provider), ['fixture.original', 'fixture.image']);
});

test('缺少图片编辑能力时在调用生成器之前失败', async (t) => {
    const workspace = await emptyWorkspace(t);
    await fs.writeFile(path.join(workspace, 'reference.png'), 'image');
    let calls = 0;
    const selected = select({ workspace, env: {} }, adapter('image', {
        capabilities: ['text-to-image'],
        generateImage: async () => { calls += 1; },
    }));
    await assert.rejects(
        mediaImage(selected.config, { intent: '改背景', image: ['reference.png'] }, selected.deps),
        (error) => error.code === 'MEDIA_CAPABILITY_UNSUPPORTED' && /image-edit/.test(error.message),
    );
    assert.equal(calls, 0);
});

test('图片质量参数交给所选适配器校验，不硬编码其他工具的取值限制', async (t) => {
    const workspace = await emptyWorkspace(t);
    const produced = path.join(workspace, 'image.png');
    await fs.writeFile(produced, 'image');
    let checked = false;
    const selected = select({ workspace, env: {} }, adapter('image', {
        validateRequest(request) {
            assert.equal(request.options.quality, 'ultra');
            checked = true;
        },
        async generateImage(settings, request) {
            assert.equal(checked, true);
            assert.equal(request.options.quality, 'ultra');
            return { path: produced, provider: 'fixture.image' };
        },
    }));
    const result = await mediaImage(selected.config, { intent: '办公室', imageQuality: 'ultra' }, selected.deps);
    assert.equal(result.path, produced);
});

test('prepare 和旧图片命令向适配器提供相同的标准化需求', async (t) => {
    const workspace = await emptyWorkspace(t);
    await fs.writeFile(path.join(workspace, 'reference.png'), 'reference');
    const output = path.join(workspace, 'output.png');
    await fs.writeFile(output, 'output');
    await fs.writeFile(path.join(workspace, 'request.json'), JSON.stringify({
        intent: '保留人物身份', images: ['reference.png'], size: '1024x1024', outPath: 'output.png',
        options: { quality: 'ultra' },
        require: ['image-edit'],
    }));
    let actual;
    const selected = select({ workspace, env: {} }, adapter('image', {
        validateRequest() {},
        async generateImage(settings, request) {
            actual = request;
            return { path: output, provider: 'fixture.image' };
        },
    }));
    const prepared = await mediaPrepare(selected.config, { task: 'image', request: 'request.json' }, selected.deps);
    await mediaImage(selected.config, {
        intent: '保留人物身份', image: ['reference.png'], size: '1024x1024', out: 'output.png',
        imageQuality: 'ultra', require: ['image-edit'],
    }, selected.deps);
    assert.deepEqual(actual, prepared.request);
});

test('media:prepare 为 Agent 整理口播需求，不探活、不生成、不创建台账', async (t) => {
    const workspace = await emptyWorkspace(t);
    await fs.writeFile(path.join(workspace, 'person.png'), 'image');
    await fs.writeFile(path.join(workspace, 'speech.wav'), 'audio');
    await fs.writeFile(path.join(workspace, 'request.json'), JSON.stringify({
        intent: '人物按照录音说话', images: ['person.png'], audio: 'speech.wav',
        duration: 5, aspectRatio: '9:16', require: ['audio-driven-video'],
    }));
    const before = await fs.readdir(workspace);
    const result = await execute(parseArgv([
        'media:prepare', '--workspace', workspace, '--task', 'video', '--request', 'request.json',
    ]), {}, {
        fetchImpl: async () => { assert.fail('准备需求不应访问网络'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.command, 'media:prepare');
    assert.equal(result.data.provider, 'comfy-mcp');
    assert.equal(result.data.execution, 'agent');
    assert.equal(result.data.guide, '.agents/skills/remake-media/providers/comfy-mcp.md');
    assert.ok(result.data.capabilities.includes('audio-driven-video'));
    assert.deepEqual(result.data.request.images, [path.join(workspace, 'person.png')]);
    assert.equal(result.data.request.audio, path.join(workspace, 'speech.wav'));
    assert.deepEqual(await fs.readdir(workspace), before);
});

test('准备视频需求时区分图生视频与音频驱动口播', async (t) => {
    const workspace = await emptyWorkspace(t);
    await fs.writeFile(path.join(workspace, 'person.png'), 'image');
    await fs.writeFile(path.join(workspace, 'speech.wav'), 'audio');
    await fs.writeFile(path.join(workspace, 'request.json'), JSON.stringify({
        intent: '人物按照录音说话', images: ['person.png'], audio: 'speech.wav',
    }));
    const selected = select({ workspace, env: {} }, adapter('video', {
        execution: 'agent', capabilities: ['image-to-video'],
        doctor: async () => { assert.fail('准备需求不应探活'); },
    }));
    await assert.rejects(
        mediaPrepare(selected.config, { task: 'video', request: 'request.json' }, selected.deps),
        (error) => error.code === 'MEDIA_CAPABILITY_UNSUPPORTED' && /audio-driven-video/.test(error.message),
    );
});

test('准备入口拒绝拼错的需求、未知能力和缺失文件', async (t) => {
    const workspace = await emptyWorkspace(t);
    const config = { workspace, env: {}, media: resolveMediaConfig({}, {}, workspace) };
    const cases = [
        { request: { intent: '办公室', imagse: [] }, code: 'INVALID_INPUT' },
        { request: { intent: '办公室', require: ['unknown-capability'] }, code: 'INVALID_INPUT' },
        { request: { intent: '办公室', options: { unknownOption: true } }, code: 'INVALID_INPUT' },
        { request: { intent: '办公室', images: ['missing.png'] }, code: 'NOT_FOUND' },
    ];
    for (const [index, entry] of cases.entries()) {
        const request = `request-${index}.json`;
        await fs.writeFile(path.join(workspace, request), JSON.stringify(entry.request));
        await assert.rejects(mediaPrepare(config, { task: 'image', request }), (error) => error.code === entry.code);
    }
});

test('无效图片结果在返回成功之前被拦截', async (t) => {
    const workspace = await emptyWorkspace(t);
    const selected = select({ workspace, env: {} }, adapter('image', {
        generateImage: async () => ({ path: path.join(workspace, 'missing.png'), provider: 'fixture.image' }),
    }));
    await assert.rejects(
        mediaImage(selected.config, { intent: '办公室' }, selected.deps),
        (error) => error.code === 'MEDIA_FAILED',
    );
});

test('转写结果不满足时间或词级要求时不覆盖已有字幕来源', async (t) => {
    const { config, directory } = await production(t);
    await fs.writeFile(path.join(directory, 'speech.wav'), 'audio');
    const target = path.join(directory, 'productions/demo/assets/speech.transcript.json');
    const original = JSON.stringify({ segments: [{ text: '原稿', start: 0, end: 1 }] });
    await fs.writeFile(target, original);
    const cases = [
        { response: { segments: [{ text: '没有时间' }] }, require: [] },
        { response: { segments: [{ text: '时间倒退', start: 2, end: 1 }] }, require: [] },
        { response: { segments: [{ text: '只有段落', start: 0, end: 1 }] }, require: ['word-timestamps'] },
        { response: { words: [{ word: ' ', start: 0, end: 1 }] }, require: ['word-timestamps'] },
    ];
    for (const entry of cases) {
        const selected = select(config, adapter('transcribe', { transcribe: async () => entry.response }));
        await assert.rejects(mediaTranscribe(selected.config, {
            slug: 'demo', from: 'speech.wav', force: true, require: entry.require,
        }, selected.deps), (error) => error.code === 'MEDIA_FAILED');
        assert.equal(await fs.readFile(target, 'utf8'), original);
    }
});

test('替代转写适配器的词级结果保留附加信息并兼容现有字幕读取', async (t) => {
    const { config, directory } = await production(t);
    await fs.writeFile(path.join(directory, 'speech.wav'), 'audio');
    const transcript = {
        text: 'hello world', language: 'en', metadata: { model: 'fixture' },
        segments: [{ text: 'hello world', start: 0, end: 1, words: [
            { word: 'hello', start: 0, end: 0.4, confidence: 0.9 },
            { word: 'world', start: 0.5, end: 1, confidence: 0.8 },
        ] }],
    };
    const selected = select(config, adapter('transcribe', {
        async transcribe(settings, request) {
            assert.equal(request.file, path.join(directory, 'speech.wav'));
            assert.equal(request.language, 'en');
            return transcript;
        },
    }));
    const result = await mediaTranscribe(selected.config, {
        slug: 'demo', from: 'speech.wav', language: 'en', require: ['word-timestamps'],
    }, selected.deps);
    const written = JSON.parse(await fs.readFile(path.join(directory, result.path), 'utf8'));
    assert.deepEqual(written, transcript);
    assert.deepEqual(transcriptWords(written), [
        { text: 'hello', start: 0, end: 0.4 },
        { text: 'world', start: 0.5, end: 1 },
    ]);
    assert.equal(result.provider, 'fixture.transcribe');
    assert.equal(result.next, 'remake captions demo --from assets/speech.transcript.json');
});

test('带有词级文本的分段不必重复提供段落文本', async (t) => {
    const { config, directory } = await production(t);
    await fs.writeFile(path.join(directory, 'speech.wav'), 'audio');
    const transcript = { segments: [{ start: 0, end: 1, words: [{ word: 'hello', start: 0, end: 1 }] }] };
    const selected = select(config, adapter('transcribe', { transcribe: async () => transcript }));
    const result = await mediaTranscribe(selected.config, {
        slug: 'demo', from: 'speech.wav', require: ['word-timestamps'],
    }, selected.deps);
    const written = JSON.parse(await fs.readFile(path.join(directory, result.path), 'utf8'));
    assert.deepEqual(written, transcript);
    assert.deepEqual(transcriptWords(written), [{ text: 'hello', start: 0, end: 1 }]);
});

test('doctor 由适配器声明可展示设置并返回执行方式和能力', async (t) => {
    const workspace = await emptyWorkspace(t);
    const selected = select({ workspace, env: {} }, adapter('image', {
        fields: { region: { type: 'string' }, credential: { type: 'string' } },
        publicSettings: ['region'],
    }), { region: 'fixture-region', credential: 'fixture-secret' });
    const result = await mediaDoctor(selected.config, { task: 'image' }, selected.deps);
    assert.equal(result.media.image.execution, 'program');
    assert.deepEqual(result.media.image.capabilities, ['text-to-image', 'image-edit']);
    assert.deepEqual(result.media.image.settings, { region: 'fixture-region' });
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});

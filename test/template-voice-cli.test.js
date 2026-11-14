import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { readCatalog, writeCatalog } from '../src/catalog.js';
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

test('template:voice 用已保存音色按字幕写成模板口播，且不调用系统语音', async (t) => {
    const workspace = await tempWorkspace(t);
    const catalog = await readCatalog(path.join(workspace.directory, 'catalog.json'));
    catalog.productions.push({ slug: 'demo', title: '模板演示', dir: 'productions/demo', referenceIds: [], status: 'commissioned' });
    await writeCatalog(path.join(workspace.directory, 'catalog.json'), catalog);
    const dir = path.join(workspace.directory, 'productions/demo/videos/demo-v1');
    await fs.mkdir(path.join(dir, 'src/data'), { recursive: true });
    await fs.writeFile(path.join(dir, 'video.json'), `${JSON.stringify({
        schema: 'video-package@1', id: 'demo', version: 1, title: '测试模板',
        frame: { width: 1280, height: 720, fps: 30, frames: 300 },
        entry: 'index.html', output: 'renders/out.mp4',
        template: { format: 'video-template@1', inputs: { voice: { kind: 'audio' }, captions: { kind: 'json', count: 2 }, identity: { kind: 'fields', fields: { name: { default: '你的名字' } } } } },
    }, null, 2)}\n`);
    await fs.writeFile(path.join(dir, 'src/data/captions.json'), `${JSON.stringify([[0, 3, '我是{{name}}。', 'I am here.'], [3, 8, '第二句。', 'Second.']])}\n`);
    await fs.writeFile(path.join(workspace.directory, 'ref.wav'), wav());
    await fs.writeFile(path.join(workspace.directory, 'key'), 'gateway-key\n');
    const saved = await execute(parseArgv(['voice:save', '--from', 'ref.wav', '--text', '参考原话']), workspace.env);
    assert.equal(saved.ok, true);
    const spoken = [];
    const commands = [];
    const env = {
        ...workspace.env,
        VIDEO_REMAKE_MEDIA_SPEECH: 'qwen-tts',
        QWEN_TTS_BASE_URL: 'http://speech.test',
        QWEN_TTS_API_KEY_FILE: path.join(workspace.directory, 'key'),
    };
    const result = await execute(parseArgv(['template:voice', 'demo', '--video', 'demo-v1']), env, {
        fetchImpl: async (_url, init) => {
            spoken.push(JSON.parse(init.body));
            return new Response(wav(), { status: 200 });
        },
        runSpeechCommand: async (executable, args) => {
            commands.push(executable);
            if (args[0] === '-version') return { exitCode: 0, stdout: 'fixture' };
            if (executable === 'ffprobe') return { exitCode: 0, stdout: JSON.stringify({ format: { duration: 1 } }) };
            if (executable === 'ffmpeg' && args.at(-1).endsWith('.pcm')) {
                await fs.writeFile(args.at(-1), Buffer.alloc(48000 * 2, 1));
            } else if (executable === 'ffmpeg') await fs.writeFile(args.at(-1), wav());
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.command, 'template:voice');
    assert.equal(result.data.voiceId, 'default');
    assert.equal(result.data.provider, 'qwen-tts');
    assert.equal(result.data.count, 2);
    assert.equal(spoken.length, 2);
    assert.equal(spoken[0].input, '我是你的名字。');
    assert.equal(spoken[0].ref_text, '参考原话');
    assert.equal(spoken[1].input, '第二句。');
    assert.equal(spoken[0].language, 'Chinese');
    assert.ok(!commands.includes('/usr/bin/say'));
    const inputs = JSON.parse(await fs.readFile(path.join(dir, 'inputs.json'), 'utf8'));
    assert.match(inputs.voice, /^inputs\/uploads\/voice-[a-f0-9-]+\.wav$/);
    const metadata = JSON.parse(await fs.readFile(path.join(dir, `${inputs.voice}.json`), 'utf8'));
    assert.equal(metadata.provider, 'qwen-tts');
    assert.equal(metadata.voice, 'default');
    assert.equal(metadata.count, 2);
});

test('template:voice 在仍使用系统音色时不会念稿', async (t) => {
    const workspace = await tempWorkspace(t);
    await fs.writeFile(path.join(workspace.directory, 'ref.wav'), wav());
    await execute(parseArgv(['voice:save', '--from', 'ref.wav', '--text', '参考原话']), workspace.env);
    await assert.rejects(execute(parseArgv(['template:voice', 'demo']), {
        ...workspace.env, VIDEO_REMAKE_MEDIA_SPEECH: 'macos-say',
    }, { fetchImpl: () => assert.fail('系统音色不得请求克隆服务') }), /qwen-tts/);
});

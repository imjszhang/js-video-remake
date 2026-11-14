import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { loadVoiceProfile } from '../src/voice-profile.js';
import { resolveConfig } from '../src/config.js';
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

test('voice:save 校验参考音频，替换需要 --force，后保存的音色成为默认', async (t) => {
    const workspace = await tempWorkspace(t);
    const reference = path.join(workspace.directory, 'ref.wav');
    await fs.writeFile(reference, wav(0.4));
    await assert.rejects(execute(parseArgv(['voice:save', '--from', 'ref.wav', '--text', '太短']), workspace.env), /1 到 30 秒/);
    await fs.writeFile(reference, wav());
    await assert.rejects(execute(parseArgv(['voice:save', '--from', 'ref.wav', '--text', '   ']), workspace.env), /原话/);
    const saved = await execute(parseArgv(['voice:save', '--from', 'ref.wav', '--text', '第一段原话']), workspace.env);
    assert.equal(saved.data.defaultId, 'default');
    await assert.rejects(execute(parseArgv(['voice:save', '--from', 'ref.wav', '--text', '改口']), workspace.env), { code: 'ALREADY_EXISTS' });
    const replaced = await execute(parseArgv(['voice:save', '--id', 'studio', '--from', 'ref.wav', '--text', '第二段原话', '--force']), workspace.env);
    assert.equal(replaced.data.id, 'studio');
    const listed = await execute(parseArgv(['voice:list']), workspace.env);
    assert.equal(listed.data.defaultId, 'studio');
    assert.deepEqual(listed.data.voices.map(item => item.id), ['default', 'studio']);
    const config = resolveConfig({ workspace: workspace.directory }, workspace.env);
    const profile = await loadVoiceProfile(config);
    assert.equal(profile.id, 'studio');
    assert.equal(profile.text, '第二段原话');
    assert.equal((await fs.readFile(profile.file)).equals(wav()), true);
});

test('音色记录里的文件路径不能逃出 voices 目录', async (t) => {
    const workspace = await tempWorkspace(t);
    await fs.writeFile(path.join(workspace.directory, 'voices.json'), `${JSON.stringify({
        version: 1, defaultId: 'default',
        voices: { default: { text: '你好', file: 'voices/../secret.wav', duration: 1.2, createdAt: '2026-01-01T00:00:00.000Z' } },
    }, null, 2)}\n`);
    const config = resolveConfig({ workspace: workspace.directory }, workspace.env);
    await assert.rejects(loadVoiceProfile(config), /默认音色无效/);
});

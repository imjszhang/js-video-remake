import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importReference } from '../src/references.js';
import { lookReference } from '../src/reference-look.js';
import { parseArgv, HELP } from '../src/args.js';
import { execute } from '../cli/remake.js';
import { printHuman } from '../src/format.js';

async function fixture(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-look-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const assetRoot = path.join(workspace, 'source-files');
    await fs.mkdir(assetRoot);
    const video = path.join(assetRoot, 'video.mp4');
    await fs.writeFile(video, 'video-fixture');
    return {
        workspace,
        catalogPath: path.join(workspace, 'catalog.json'),
        assetRoot,
        source: { provider: 'local' },
        quality: '1080',
        video,
    };
}

function tools(state = {}) {
    const calls = [];
    const api = {
        calls,
        scene: state.scene ?? [1, 1.2, 3, 5, 8, 10],
        sceneError: state.sceneError || null,
        failExtract: false,
        hashes: 0,
        duration: state.duration ?? 12,
        probe: async () => ({ duration: api.duration }),
        hashFile: async () => {
            api.hashes += 1;
            return state.hash || 'c'.repeat(64);
        },
        runFfmpeg: async (args) => {
            calls.push(args);
            if (args.some(arg => String(arg).includes('showinfo'))) {
                if (api.sceneError) throw api.sceneError;
                const stderr = api.scene.map((time, index) => `n:${index} pts_time:${time.toFixed(3)}`).join('\n');
                return { stderr };
            }
            if (api.failExtract) throw new Error('extract failed');
            const output = args.at(-1);
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
            return {};
        },
    };
    return api;
}

async function imported(config, id = 'clip') {
    const result = await importReference(config, { file: config.video, id, title: '原片' });
    return result.references[0];
}

test('reference:look is registered and repeats --at', () => {
    assert.match(HELP, /reference:look <id>/);
    const parsed = parseArgv(['reference:look', 'clip', '--at', '1', '--at', '2', '--width', '512', '--max-frames', '4']);
    assert.deepEqual(parsed.flags.at, ['1', '2']);
    assert.equal(parsed.flags.width, '512');
    assert.equal(parsed.flags.maxFrames, '4');
});

test('look extracts timestamped frames without copying the source or rewriting records', async t => {
    const config = await fixture(t);
    const reference = await imported(config);
    const refDir = path.join(config.workspace, reference.dir);
    const sourcePath = path.join(refDir, 'SOURCE.json');
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    const vtt = path.join(refDir, 'zh.vtt');
    await fs.writeFile(vtt, 'WEBVTT\n\n00:00:03.800 --> 00:00:04.200\n你好\n');
    await fs.writeFile(path.join(refDir, 'transcript.json'), JSON.stringify({
        segments: [{ start: 7.5, end: 8.5, text: '下一段' }],
    }));
    source.absSubs = { zh: vtt };
    await fs.writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    const videoBefore = await fs.readFile(config.video);
    const sourceBefore = await fs.readFile(sourcePath, 'utf8');
    const catalogBefore = await fs.readFile(config.catalogPath, 'utf8');
    const media = tools();
    media.hashFile = async () => { throw new Error('should not hash'); };

    const result = await lookReference(config, { id: 'local-clip', at: ['4'] }, media);

    assert.equal(result.command, 'reference:look');
    assert.equal(result.selection, 'scene');
    assert.equal(result.captions, 'aligned');
    assert.equal(result.sha256, source.sha256);
    assert.deepEqual(await fs.readFile(config.video), videoBefore);
    assert.equal(await fs.readFile(sourcePath, 'utf8'), sourceBefore);
    assert.equal(await fs.readFile(config.catalogPath, 'utf8'), catalogBefore);
    assert.deepEqual((await fs.readdir(refDir)).sort(), ['SOURCE.json', 'look', 'transcript.json', 'zh.vtt']);
    const index = JSON.parse(await fs.readFile(path.join(refDir, 'look', 'index.json'), 'utf8'));
    assert.equal(index.schema, 'video-remake.reference-look@1');
    assert.equal(index.videoPath, source.videoPath);
    assert.equal(index.sha256, source.sha256);
    assert.equal(index.bytes, videoBefore.length);
    assert.deepEqual(index.frames.map(frame => frame.time), [1, 3, 4, 5, 8, 10]);
    const cue = index.frames.find(frame => frame.time === 4);
    assert.equal(cue.cue, true);
    assert.equal(cue.captions[0].text, '你好');
    assert.equal(cue.captions[0].source, 'vtt');
    assert.equal(index.frames.find(frame => frame.time === 8).captions[0].text, '下一段');
    assert.equal(index.frames.some(frame => frame.time === 1.2), false);
    for (const frame of index.frames) {
        const jpeg = await fs.readFile(path.join(refDir, 'look', frame.file));
        assert.equal(jpeg[0], 0xff);
        assert.equal(jpeg[1], 0xd8);
    }
    const scene = media.calls.find(args => args.some(arg => String(arg).includes('showinfo')));
    assert.match(scene.join(' '), /between\(t,0,12\)/);
    const extract = media.calls.find(args => args.includes('-frames:v'));
    assert.ok(extract.indexOf('-ss') > extract.indexOf('-i'));
    assert.ok(extract.includes('scale=1024:-2'));

    await fs.writeFile(path.join(refDir, 'transcript.json'), JSON.stringify({
        segments: [],
        words: [{ start: 8, end: 8.4, word: '词' }],
    }));
    await lookReference(config, { id: 'local-clip', at: ['8'], maxFrames: '4' }, media);
    const worded = JSON.parse(await fs.readFile(path.join(refDir, 'look', 'index.json'), 'utf8'));
    const spoken = worded.frames.find(frame => frame.time === 8);
    assert.equal(spoken.cue, true);
    assert.equal(spoken.captions.some(caption => caption.source === 'transcript' && caption.text === '词'), true);
    assert.equal(await fs.readFile(sourcePath, 'utf8'), sourceBefore);
});

test('unreadable captions warn without dropping frames', async t => {
    const config = await fixture(t);
    const reference = await imported(config);
    const refDir = path.join(config.workspace, reference.dir);
    const sourcePath = path.join(refDir, 'SOURCE.json');
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    const bad = path.join(refDir, 'bad.vtt');
    await fs.writeFile(bad, 'this is not a subtitle');
    source.absSubs = { zh: bad, en: path.join(refDir, 'missing.vtt') };
    await fs.writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    await fs.writeFile(path.join(refDir, 'transcript.json'), '{"nope":true}\n');
    const result = await lookReference(config, { id: reference.id }, tools());
    assert.equal(result.captions, 'none');
    assert.equal(result.frameCount > 0, true);
    assert.ok(result.warnings.some(warning => warning.includes('不是有效的 WebVTT')));
    assert.ok(result.warnings.some(warning => warning.includes('无法读取')));
    assert.ok(result.warnings.some(warning => warning.includes('transcript.json')));
    const index = JSON.parse(await fs.readFile(path.join(refDir, 'look', 'index.json'), 'utf8'));
    assert.equal(index.frames.every(frame => frame.captions.length === 0), true);
});

test('out of range times, unknown references and missing media are rejected', async t => {
    const config = await fixture(t);
    await assert.rejects(lookReference(config, { id: 'missing' }, tools()), { code: 'NOT_FOUND' });
    await assert.rejects(fs.access(config.catalogPath), { code: 'ENOENT' });
    const reference = await imported(config);
    await assert.rejects(lookReference(config, { id: reference.id, start: '100' }, tools()), { code: 'INVALID_INPUT' });
    await assert.rejects(lookReference(config, { id: reference.id, start: '6', end: '2' }, tools()), { code: 'INVALID_INPUT' });
    await assert.rejects(lookReference(config, { id: reference.id, end: '2', at: ['3'] }, tools()), { code: 'INVALID_INPUT' });
    await assert.rejects(lookReference(config, { id: reference.id, width: '100' }, tools()), { code: 'INVALID_INPUT' });
    await assert.rejects(lookReference(config, { id: reference.id, maxFrames: '251' }, tools()), { code: 'INVALID_INPUT' });
    await assert.rejects(lookReference(config, { id: reference.id, at: ['1', '2'], maxFrames: '1' }, tools()), { code: 'INVALID_INPUT' });
    await fs.rm(config.video);
    await assert.rejects(lookReference(config, { id: reference.id }, tools()), { code: 'SOURCE_ASSET_MISSING' });
    await assert.rejects(fs.access(path.join(config.workspace, reference.dir, 'look')), { code: 'ENOENT' });
});

test('a failed extraction keeps the previous look and a later run replaces it', async t => {
    const config = await fixture(t);
    const reference = await imported(config);
    const refDir = path.join(config.workspace, reference.dir);
    const media = tools();
    const first = await lookReference(config, { id: reference.id, maxFrames: '4' }, media);
    assert.equal(first.selection, 'scene');
    const indexPath = path.join(refDir, 'look', 'index.json');
    const firstIndex = await fs.readFile(indexPath, 'utf8');
    await fs.writeFile(path.join(refDir, 'look', 'frames', 'stale.txt'), 'old');
    media.failExtract = true;
    await assert.rejects(lookReference(config, { id: reference.id }, media), /extract failed/);
    assert.equal(await fs.readFile(indexPath, 'utf8'), firstIndex);
    assert.equal(await fs.readFile(path.join(refDir, 'look', 'frames', 'stale.txt'), 'utf8'), 'old');
    assert.equal((await fs.readdir(refDir)).some(name => name.startsWith('.look-staging')), false);
    media.failExtract = false;
    media.scene = [0.5, 2, 4, 6, 9];
    const second = await lookReference(config, { id: reference.id }, media);
    assert.equal(second.frameCount, 5);
    await assert.rejects(fs.access(path.join(refDir, 'look', 'frames', 'stale.txt')), { code: 'ENOENT' });
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    assert.deepEqual(index.frames.map(frame => frame.time), [0.5, 2, 4, 6, 9]);
});

test('scene detection failure and sparse scenes fall back to uniform frames', async t => {
    const config = await fixture(t);
    const reference = await imported(config);
    const failed = tools({ sceneError: new Error('scene failed') });
    const result = await lookReference(config, { id: reference.id, maxFrames: '4' }, failed);
    assert.equal(result.selection, 'uniform');
    assert.ok(result.warnings.some(warning => warning.includes('均匀抽帧')));
    const index = JSON.parse(await fs.readFile(path.join(config.workspace, reference.dir, 'look', 'index.json'), 'utf8'));
    assert.deepEqual(index.frames.map(frame => frame.time), [1.5, 4.5, 7.5, 10.5]);

    const sparse = tools({ scene: [1] });
    const again = await lookReference(config, { id: reference.id, start: '2', end: '6', maxFrames: '4' }, sparse);
    assert.equal(again.selection, 'uniform');
    assert.equal(again.warnings.length, 0);
    assert.deepEqual(again.range, { start: 2, end: 6 });
    const ranged = JSON.parse(await fs.readFile(path.join(config.workspace, reference.dir, 'look', 'index.json'), 'utf8'));
    assert.deepEqual(ranged.frames.map(frame => frame.time), [2.5, 3.5, 4.5, 5.5]);
    const sceneCall = sparse.calls.find(args => args.some(arg => String(arg).includes('showinfo')));
    assert.match(sceneCall.join(' '), /between\(t,2,6\)/);
});

test('a changed file is rehashed without rewriting SOURCE.json', async t => {
    const config = await fixture(t);
    const reference = await imported(config);
    const sourcePath = path.join(config.workspace, reference.dir, 'SOURCE.json');
    const before = await fs.readFile(sourcePath, 'utf8');
    const source = JSON.parse(before);
    const media = tools();
    await lookReference(config, { id: reference.id, maxFrames: '4' }, media);
    assert.equal(media.hashes, 0);
    await fs.writeFile(config.video, 'video-fixture-now-longer');
    const result = await lookReference(config, { id: reference.id, maxFrames: '4' }, media);
    assert.equal(media.hashes, 1);
    assert.equal(result.sha256, 'c'.repeat(64));
    assert.equal(await fs.readFile(sourcePath, 'utf8'), before);
    assert.equal(JSON.parse(before).sha256, source.sha256);
});

test('the command prints the frame directory and does not accept extra arguments', async t => {
    const config = await fixture(t);
    const reference = await imported(config);
    const media = tools();
    media.duration = 120;
    const env = { VIDEO_REMAKE_WORKSPACE: config.workspace };
    const result = await execute(parseArgv(['reference:look', reference.id, '--at', '1:00', '--start', '0:30', '--end', '1:30', '--max-frames', '4']), env, media);
    assert.equal(result.ok, true);
    assert.equal(result.data.range.start, 30);
    assert.equal(result.data.range.end, 90);
    const cue = JSON.parse(await fs.readFile(path.join(config.workspace, result.data.index), 'utf8')).frames.find(frame => frame.cue);
    assert.equal(cue.time, 60);
    const lines = [];
    printHuman(result, line => lines.push(line));
    assert.match(lines.join('\n'), /抽出/);
    assert.match(lines.join('\n'), /ANALYSIS\.md/);
    await assert.rejects(execute(parseArgv(['reference:look']), env, media), { code: 'INVALID_INPUT' });
    await assert.rejects(execute(parseArgv(['reference:look', reference.id, 'extra']), env, media), { code: 'INVALID_INPUT' });
});

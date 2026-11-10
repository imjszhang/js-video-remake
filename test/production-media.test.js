import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cuesFromWhisper, hyperframesTranscript, writeCaptions } from '../src/captions.js';
import { inspectSources, inspectTiming, precheckComposition } from '../src/precheck.js';
import { alphaKeepArgs, hasAlpha, normalizeAsset, normalizePlan, stillVideoArgs } from '../src/normalize.js';
import { mediaSnippet } from '../src/production-template.js';
import { HYPERFRAMES_CLI, rendererEnvironment, runFixedCommand } from '../src/repro/render.js';
import { studioPortOpen } from '../src/studio.js';
import { land } from '../src/media/land.js';

const WHISPER = {
    language: 'zh',
    segments: [{
        start: 0,
        end: 1.2,
        text: '你好世界',
        words: [
            { word: '你', start: 0.01, end: 0.2 },
            { word: '好', start: 0.2, end: 0.45 },
            { word: '世', start: 0.5, end: 0.8 },
            { word: '界', start: 0.8, end: 1.13 },
        ],
    }],
};

test('timing and local assets fail before a render', async () => {
    const html = '<video id="clip" src="./missing.mp4" data-start="0" data-duration="0.1" data-media-start="0"></video>';
    assert.equal(inspectTiming(html, 24).errors.length, 1);
    assert.equal(inspectTiming('<video data-start="0.5" data-duration="1"></video>', 24).errors.length, 0);
    const sources = await inspectSources(html, '/tmp/composition', async () => { throw new Error('missing'); });
    assert.deepEqual(sources.missing, ['./missing.mp4']);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-timing-'));
    await fs.writeFile(path.join(dir, 'index.html'), html);
    const calls = [];
    await assert.rejects(precheckComposition({ dir, entry: 'index.html', fps: 24 }, {
        exists: async () => { throw new Error('missing'); },
        runCommand: (...args) => { calls.push(args); },
    }), (error) => error.code === 'REPRO_PRECHECK_FAILED' && /缺少本地素材/.test(error.message)
        && error.data.warnings.some((warning) => warning.code === 'off_frame_timing'));
    assert.equal(calls.length, 0);
    await fs.rm(dir, { recursive: true, force: true });
});

test('timing accepts clip references and ignores markup inside scripts', () => {
    const html = `<video id="intro" data-start="0" data-duration="1"></video>
<video id="main" data-start="intro + 0.5" data-duration="2"></video>
<div data-start="intro"></div>
<div data-start="0.291667" data-duration="1"></div>
<script>el.innerHTML = '<div data-start="\${x}"></div>';</script>
<!-- <div data-start="oops"></div> -->`;
    assert.deepEqual(inspectTiming(html, 24).errors, []);
    assert.equal(inspectTiming('<div data-start="intro + 0.01"></div>', 24).errors.length, 1);
});

test('nested repro entries resolve assets like the renderer and skip hyperframes check', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-nested-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'assets'));
    await fs.mkdir(path.join(root, 'inputs'));
    await fs.writeFile(path.join(root, 'assets/a.mp4'), 'x');
    await fs.writeFile(path.join(root, 'inputs/voice.m4a'), 'x');
    await fs.writeFile(path.join(root, 'src/index.html'), `<div data-composition-id="main" data-duration="64.448" data-fps="30">
<video src="../assets/a.mp4" data-start="0" data-duration="1"></video><audio src="inputs/voice.m4a" data-start="0" data-duration="1"></audio></div>`);
    const nested = { dir: path.join(root, 'src'), projectRoot: root };
    const passed = await precheckComposition(nested, { runCommand: () => assert.fail('check would serve src/ as the site root') });
    assert.equal(passed.hyperframesCheck, 'skipped');
    assert.ok(passed.warnings.some((warning) => warning.code === 'off_frame_timing'));
    await fs.writeFile(path.join(root, 'src/index.html'), '<audio src="inputs/missing.m4a" data-start="0"></audio>');
    await assert.rejects(precheckComposition(nested), /缺少本地素材/);
    await fs.rm(root, { recursive: true, force: true });
});

test('contrast failures are advisory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-contrast-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<div data-composition-id="main" data-fps="30" data-duration="1"></div>');
    const report = { ok: false, contrast: { errorCount: 1, findings: [{ severity: 'error', code: 'contrast_aa_failure', message: 'low' }] } };
    const passed = await precheckComposition({ dir }, { runCommand: async () => ({ exitCode: 1, stdout: JSON.stringify(report) }) });
    assert.equal(passed.warnings[0].code, 'contrast_aa_failure');
    await fs.rm(dir, { recursive: true, force: true });
});

test('check errors block and warnings do not', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-check-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<div data-composition-id="main" data-fps="30" data-duration="1"></div>');
    const report = (ok, severity) => ({
        exitCode: ok ? 0 : 1,
        stdout: JSON.stringify({
            ok,
            lint: { errorCount: ok ? 0 : 1, findings: [{ severity, code: 'layout', message: 'overflow' }] },
            runtime: { errorCount: 0, findings: [] }, layout: { errorCount: 0, findings: [] },
            motion: { errorCount: 0, findings: [] }, contrast: { errorCount: 0, findings: [] }, craft: { errorCount: 0, findings: [] },
        }),
    });
    await assert.rejects(precheckComposition({ dir, fps: 30 }, { runCommand: async () => report(false, 'error') }), /overflow/);
    const passed = await precheckComposition({ dir, fps: 30, range: '0,1' }, { runCommand: async (_exe, args) => {
        assert.ok(args.includes('--range'));
        return report(true, 'warning');
    } });
    assert.equal(passed.warnings.length, 1);
    await fs.rm(dir, { recursive: true, force: true });
});

test('whisper cues snap to frames and hyperframes keeps them', async () => {
    const cues = cuesFromWhisper(WHISPER, { maxChars: 2, fps: 30 });
    assert.deepEqual(cues.map((cue) => cue.text), ['你好', '世界']);
    assert.equal(cues[0].startFrame, 0);
    assert.equal(cues[0].endFrame, 14);
    const html = `<div class="caption" data-caption="" data-start="${cues[0].start}" data-duration="${cues[0].end - cues[0].start}"></div>`;
    assert.equal(inspectTiming(html, 30).errors.length, 0);
    const english = cuesFromWhisper({ words: [{ word: 'Hello', start: 0, end: 0.4 }, { word: 'there.', start: 0.4, end: 0.8 },
        { word: 'Next', start: 0.81, end: 1 }, { word: 'line', start: 2.5, end: 2.9 }] }, { maxChars: 40, fps: 30 });
    assert.deepEqual(english.map((cue) => cue.text), ['Hello there.', 'Next', 'line']);
    for (let index = 1; index < english.length; index += 1) assert.ok(english[index].startFrame >= english[index - 1].endFrame);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-cues-'));
    const json = path.join(dir, 'cues.json');
    const srt = path.join(dir, 'cues.srt');
    await fs.writeFile(json, JSON.stringify(hyperframesTranscript(cues)));
    const result = await runFixedCommand(process.execPath, [HYPERFRAMES_CLI, 'transcribe', json, '--to', 'srt', '--preserve-cues', '--output', srt], {
        cwd: dir, env: rendererEnvironment(dir), timeoutMs: 30_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const sidecar = await fs.readFile(srt, 'utf8');
    assert.match(sidecar, /你好/);
    assert.match(sidecar, /世界/);
    assert.equal(sidecar.trim().split(/\n\n/).length, 2);
    await fs.rm(dir, { recursive: true, force: true });
});

test('captions writes a pasteable track from a transcript', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-captions-'));
    const production = path.join(root, 'productions', 'demo');
    const pkg = path.join(production, 'videos', 'code-v1');
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'video.json'), JSON.stringify({ schema: 'video-package@1', version: 1, entry: 'index.html', output: 'renders/code-v1.mp4' }));
    await fs.writeFile(path.join(pkg, 'index.html'), '<div data-fps="30" data-duration="2"></div>');
    await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({
        version: 1, references: [], productions: [{ slug: 'demo', dir: 'productions/demo', referenceIds: [], status: 'commissioned' }],
    }));
    await fs.writeFile(path.join(production, 'assets-speech.transcript.json'), JSON.stringify(WHISPER));
    const result = await writeCaptions({ workspace: root, catalogPath: path.join(root, 'catalog.json'), env: process.env }, {
        slug: 'demo', from: 'assets-speech.transcript.json', maxChars: 2,
    }, { runCommand: async (_exe, args) => { await fs.writeFile(args.at(-1), '1\n00:00:00,000 --> 00:00:00,467\n你好\n'); return { exitCode: 0, stdout: '', stderr: '' }; } });
    assert.equal(result.video, 'code-v1');
    assert.equal(result.files.html, 'productions/demo/videos/code-v1/captions/assets-speech.html');
    const html = await fs.readFile(path.join(root, result.files.html), 'utf8');
    assert.match(html, /class="clip caption"/);
    assert.match(html, /id="assets-speech-0"/);
    assert.match(html, /你好/);
    assert.equal(inspectTiming(html, 30).errors.length, 0);
    await fs.rm(root, { recursive: true, force: true });
});

test('normalize plans stills, alpha, and leaves plain video alone', () => {
    const still = normalizePlan({ kind: 'image', probe: { pixFmt: 'rgb24' }, duration: 2, fps: 30 });
    assert.equal(still.mode, 'still-video');
    assert.equal(still.frames, 60);
    const stillArgs = stillVideoArgs({ input: 'in.png', output: 'out.mp4', fps: 30, frames: 60 });
    assert.ok(stillArgs.includes('yuv420p'));
    assert.ok(stillArgs.includes('bt709'));
    const keep = normalizePlan({ kind: 'image', probe: { pixFmt: 'rgba' }, alpha: 'keep', duration: 1, fps: 24 });
    assert.equal(keep.extension, '.mov');
    assert.ok(alphaKeepArgs({ input: 'in.png', output: 'out.mov', fps: 24, frames: 24, still: true }).includes('prores_ks'));
    assert.equal(normalizePlan({ kind: 'video', probe: { pixFmt: 'yuv420p', duration: 3 }, fps: 30 }).action, 'skip');
    assert.equal(normalizePlan({ kind: 'audio' }).action, 'skip');
    for (const pixFmt of ['rgba', 'rgba64be', 'argb', 'ya8', 'yuva420p', 'gbrap']) assert.equal(hasAlpha(pixFmt), true, pixFmt);
    for (const pixFmt of ['rgb24', 'yuv420p', 'gray', 'yuvj420p']) assert.equal(hasAlpha(pixFmt), false, pixFmt);
    assert.throws(() => normalizePlan({ kind: 'image', probe: { pixFmt: 'rgba' }, duration: 1, fps: 30 }), /alpha/);
});

test('normalize lands a still as a ledger video', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-normalize-'));
    await fs.mkdir(path.join(root, 'productions', 'demo', 'composition'), { recursive: true });
    await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({
        version: 1, references: [], productions: [{ slug: 'demo', dir: 'productions/demo', referenceIds: [], status: 'commissioned' }],
    }));
    const source = path.join(root, 'still.png');
    await fs.writeFile(source, 'png');
    land({ workspace: root, slug: 'demo', kind: 'image', from: source, intent: 'still', provider: 'codex-image.generate', id: 'img-demo-still' });
    const result = await normalizeAsset({ workspace: root, catalogPath: path.join(root, 'catalog.json') }, {
        slug: 'demo', id: 'img-demo-still', duration: 1, fps: 24,
    }, { runFfmpeg: async (args) => fs.writeFile(args.at(-1), 'video'), probe: async () => ({ pixFmt: 'rgb24', duration: 0 }) });
    assert.equal(result.status, 'landed');
    assert.equal(result.mode, 'still-video');
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'productions/demo/assets/ledger.json'), 'utf8'));
    const video = ledger.items.find((item) => item.kind === 'video');
    assert.equal(video.provider, 'local.normalize');
    assert.equal(video.sourceId, 'img-demo-still');
    assert.match(result.html, /<video /);
    await fs.rm(root, { recursive: true, force: true });
});

test('media snippets are hyperframes elements and studio occupancy is only a probe', async () => {
    assert.match(mediaSnippet({ kind: 'video', id: 'clip', src: '../assets/video/a.mp4' }), /muted/);
    assert.match(mediaSnippet({ kind: 'audio', id: 'bed', src: '../assets/audio/a.wav' }), /data-volume="1"/);
    const open = await studioPortOpen(9, { connect() {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        queueMicrotask(() => socket.emit('connect'));
        return socket;
    } });
    const closed = await studioPortOpen(9, { connect() {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        queueMicrotask(() => socket.emit('error', new Error('closed')));
        return socket;
    } });
    assert.equal(open, true);
    assert.equal(closed, false);
});

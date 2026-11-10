import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scaffoldProject, snapshotProject } from '../src/repro/project.js';
import { validateSpec } from '../src/repro/schema.js';
import { hashFile } from '../src/repro/evaluate.js';
import { previewStage } from '../src/repro/stage-preview.js';
import { prepareStageReference, stageSamplingPlan, validateStageEvidence } from '../src/repro/stage-evidence.js';
import { resolveInstalledBrowser } from '../src/repro/execution-environment.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=', 'base64');
const PROTOCOL = 'c'.repeat(64);
function specFor({ audio = 'forbidden', durationSec = 2, evidence = {} } = {}) {
    return validateSpec({ schema: 'video-remake.reproduction@2', title: 'Stage fixture', objective: 'Check host preview evidence.',
        preserve: ['Timing'], replace: ['Title'], inputs: { title: { type: 'text' } },
        acceptance: { media: { file: 'outputs/final.mp4', width: 160, height: 120, durationSec, audio }, evidence,
            review: [{ id: 'layout', description: 'Compare layout.' }] } });
}
function pcmWav(durationSec) {
    const bytes = Buffer.alloc(44 + Math.ceil(durationSec * 16000) * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
    bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    return bytes;
}
async function fixture(t, options = {}) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-stage-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const workspace = path.join(base, 'project'), spec = specFor(options);
    await scaffoldProject(workspace, { spec, inputs: { title: 'Fixture' } });
    await fs.writeFile(path.join(workspace, 'src/index.html'), '<html><body>Draft scene</body></html>');
    await fs.writeFile(path.join(workspace, 'src/scene.js'), 'export const scene = 1;');
    await fs.writeFile(path.join(workspace, 'outputs/final.mp4'), 'keep existing final output');
    const referenceFile = path.join(base, 'reference.mp4');
    await fs.writeFile(referenceFile, 'reference media');
    const references = [{ id: 'reference-main', source: { videoPath: referenceFile, ...(await hashFile(referenceFile)) } }];
    const config = { env: { SECRET_API_KEY: 'hidden', NODE_OPTIONS: '--import=bad' } };
    const f = { base, workspace, spec, references, referenceFile, config, calls: [], frames: [] };
    f.deps = {
        async runCommand(executable, args, processOptions) {
            f.calls.push({ executable, args, options: processOptions });
            if (args[1] === 'check') {
                return { exitCode: 0, stdout: JSON.stringify({ ok: true, lint: { errorCount: 0, findings: [] }, runtime: { errorCount: 0, findings: [] }, layout: { errorCount: 0, findings: [] }, motion: { errorCount: 0, findings: [] }, contrast: { errorCount: 0, findings: [] }, craft: { errorCount: 0, findings: [] } }), stderr: '' };
            }
            await fs.writeFile(args[args.indexOf('--output') + 1], 'candidate media');
            if (f.duringRender) await f.duringRender();
            return f.processResult || { exitCode: 0, stdout: '', stderr: '' };
        },
        async probeMedia(file) {
            return { width: 160, height: 120, durationSec: spec.acceptance.media.durationSec,
                audioStreams: f.noCandidateAudio && file !== referenceFile ? 0 : options.audio && options.audio !== 'forbidden' ? 1 : 0 };
        },
        async extractFrame(file, output, timeSec) {
            f.frames.push({ file, output, timeSec });
            await fs.writeFile(output, PNG);
            if (f.duringFrame) await f.duringFrame();
            return { timeSec: f.fallback && timeSec > 0.25 ? timeSec - 0.25 : timeSec };
        },
        async extractAudio(_file, output, _time, duration) { await fs.writeFile(output, pcmWav(duration)); },
    };
    f.preview = options => previewStage(config, { workspace, spec, references, stageId: 'shots',
        evidenceRoot: path.join(base, 'host-evidence'), protocolHash: PROTOCOL, ...options }, f.deps);
    f.reference = options => prepareStageReference({ workspace, spec, references, evidenceRoot: path.join(base, 'host-evidence'), protocolHash: PROTOCOL, ...options }, f.deps);
    return f;
}

test('draft preview uses fixed CLI, frozen runtime inputs and host paired evidence without publishing final media', async t => {
    const f = await fixture(t);
    const result = await f.preview({ inputsHash: 'a'.repeat(64), assetLockHash: 'b'.repeat(64) });
    assert.equal(result.status, 'completed');
    assert.equal(result.strategy, 'full-render-and-sample');
    assert.equal(result.renderCalls, 1);
    assert.equal(result.previewJobs, 1);
    assert.equal(result.qualityStatus, 'not-evaluated');
    assert.equal(result.sourceTreeHash, (await snapshotProject(f.workspace, { includeInputs: true })).treeHash);
    assert.equal(result.artifact.path, 'media/subject.mp4');
    assert.ok(!result.artifact.file.startsWith(f.workspace));
    assert.equal(await fs.readFile(path.join(f.workspace, 'outputs/final.mp4'), 'utf8'), 'keep existing final output');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.workspace, 'reproduction.json'))).status, 'draft');
    const call = f.calls[0];
    assert.equal(call.args[1], 'render');
    assert.ok(call.args.includes('--strict'));
    assert.equal(result.precheck.status, 'skipped');
    assert.equal(call.executable, process.execPath);
    assert.match(call.args[0], /node_modules\/hyperframes\/bin\/hyperframes\.mjs$/);
    assert.ok(!call.args[0].startsWith(f.workspace));
    assert.equal(call.args[call.args.indexOf('--composition') + 1], 'src/index.html');
    assert.equal(call.args[call.args.indexOf('--variables-file') + 1], path.join(f.workspace, 'inputs/values.json'));
    assert.equal(call.options.env.SECRET_API_KEY, undefined);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 600000);
    assert.equal(result.items.length, result.scope.samples.length * 2);
    for (const item of result.items) {
        assert.equal(item.framePtsSec, null);
        assert.equal(item.timeSec, Math.min(item.requestedTimeSec, 1.96));
        assert.equal(item.timing.fallbackOffsetSec, 0);
    }
    assert.ok(result.manifest.sources.every(source => source.file === undefined));
    assert.deepEqual(await validateStageEvidence(result, { workspace: f.workspace, protocolHash: PROTOCOL }), result.manifest);
});

test('host reference evidence freezes late anchors and transition samples without exposing host paths', async t => {
    const f = await fixture(t, { durationSec: 100, evidence: { timestampsSec: [1.234567, 99, 100], boundariesSec: [10, 90] } });
    const result = await f.reference();
    assert.equal(result.previewJobs, 0);
    assert.equal(f.calls.length, 0);
    assert.ok(result.items.some(item => item.requestedTimeSec === 99));
    assert.ok(result.items.some(item => item.requestedTimeSec === 1.234567));
    assert.ok(result.items.some(item => item.requestedTimeSec === 100 && item.timeSec === 99.96));
    assert.ok(result.items.some(item => item.requestedTimeSec === 90.08));
    assert.equal(result.scope.sourceTimeBasis, 'absolute-root-timeline');
    assert.ok(!JSON.stringify(result.manifest).includes(f.base));
    await validateStageEvidence(result, { protocolHash: PROTOCOL });
});

test('analysis receives full frozen source videos for observations between fixed host samples', async t => {
    const f = await fixture(t, { durationSec: 20, evidence: { timestampsSec: [4, 7] } });
    const second = path.join(f.base, 'second-reference.mp4');
    await fs.writeFile(second, 'second frozen reference media');
    f.references.push({ id: 'reference-second', source: { videoPath: second, ...(await hashFile(second)) } });
    const result = await f.reference();
    const frames = result.items.filter(item => item.kind === 'frame');
    assert.ok(!frames.some(item => item.requestedTimeSec === 4.8));
    const video = result.items.find(item => item.kind === 'video');
    assert.equal(video.id, 'reference-main:video');
    assert.equal(video.sourceId, 'reference-main');
    assert.equal(video.path, 'videos/source-0.mp4');
    assert.equal(video.sha256, f.references[0].source.sha256);
    assert.equal(video.bytes, f.references[0].source.bytes);
    assert.equal(video.durationSec, 20);
    assert.equal(video.startSec, 0); assert.equal(video.endSec, 20);
    assert.ok(4.8 >= video.startSec && 4.8 <= video.endSec, 'the full-source citation covers an unsampled short shot');
    assert.equal(video.requestedTimeSec, undefined); assert.equal(video.timeSec, undefined);
    assert.equal(video.sourceTimeBasis, 'absolute-root-timeline');
    assert.equal(video.purpose, 'reference-observation-only');
    assert.deepEqual(await fs.readFile(path.join(result.evidenceRoot, video.path)), await fs.readFile(f.referenceFile));
    assert.equal(result.manifest.sources[0].bytes, video.bytes);
    const secondVideo = result.items.find(item => item.id === 'reference-second:video');
    assert.equal(result.items.filter(item => item.kind === 'video').length, 2);
    assert.equal(secondVideo.path, 'videos/source-1.mp4');
    assert.equal(secondVideo.sha256, f.references[1].source.sha256);
    assert.deepEqual(await fs.readFile(path.join(result.evidenceRoot, secondVideo.path)), await fs.readFile(second));
    assert.ok(!JSON.stringify(result.manifest).includes(f.base));
    await validateStageEvidence(result, { protocolHash: PROTOCOL });
    const preview = await f.preview();
    assert.ok(preview.items.every(item => item.kind !== 'video'), 'full-source video citations are analysis-only');
});

test('full reference video validation rejects tampering, forged source bindings and invalid scopes', async t => {
    for (const mutation of ['file', 'symlink', 'sha256', 'bytes', 'duration', 'start', 'end', 'sourceId', 'path', 'preview-kind']) {
        const f = await fixture(t), result = await f.reference();
        const video = result.items.find(item => item.kind === 'video');
        const file = path.join(result.evidenceRoot, video.path);
        if (mutation === 'file') await fs.appendFile(file, 'tampered');
        else if (mutation === 'symlink') { await fs.unlink(file); await fs.symlink(f.referenceFile, file); }
        else {
            if (mutation === 'sha256') video.sha256 = '0'.repeat(64);
            if (mutation === 'bytes') video.bytes++;
            if (mutation === 'duration') video.durationSec++;
            if (mutation === 'start') video.startSec = 0.1;
            if (mutation === 'end') video.endSec--;
            if (mutation === 'sourceId') video.sourceId = 'unknown';
            if (mutation === 'path') video.path = '../reference.mp4';
            if (mutation === 'preview-kind') { result.manifest.kind = 'stage-preview'; result.protocolHash = result.manifest.protocolHash; }
            // Re-sign only this synthetic receipt to test semantic validation,
            // independently of the manifest hash/tamper gate.
            await fs.writeFile(path.join(result.evidenceRoot, 'manifest.json'), JSON.stringify(result.manifest));
            result.evidenceManifestSha256 = (await hashFile(path.join(result.evidenceRoot, 'manifest.json'))).sha256;
        }
        await assert.rejects(validateStageEvidence(result, { protocolHash: PROTOCOL }), undefined, mutation);
    }
});

test('host sampling includes five phases, adjacent cuts and frozen anchors; overflow rejects instead of truncating', () => {
    const spec = specFor({ durationSec: 100, evidence: { timestampsSec: [2.22, 99], boundariesSec: [3, 99.5] } });
    const plan = stageSamplingPlan(spec, { shots: [{ id: 'a', startSec: 0, endSec: 3 }, { id: 'b', startSec: 3, endSec: 100 }], shotIds: ['a'] });
    for (const time of [0, 0.74, 1.48, 2.22, 2.96, 3, 3.08]) assert.ok(plan.samples.some(item => item.requestedTimeSec === time), String(time));
    assert.ok(!plan.samples.some(item => item.requestedTimeSec === 99));
    assert.throws(() => stageSamplingPlan(spec, { shotIds: ['unknown'] }));
    assert.throws(() => stageSamplingPlan(spec, { shots: [{ id: 'a', startSec: 0, endSec: 3 }], shotIds: ['unknown'] }));
    assert.throws(() => stageSamplingPlan(spec, { shots: Array.from({ length: 100 }, (_, i) => ({ id: `shot${i}`, startSec: i, endSec: i + 1 })) }), /超过.*上限/);
});

test('fallback metadata reports actual seek and keeps decoder PTS explicitly unknown', async t => {
    const f = await fixture(t); f.fallback = true;
    const result = await f.preview();
    const item = result.items.find(item => item.requestedTimeSec > 0.25);
    assert.equal(item.timeSec, item.requestedTimeSec - 0.25);
    assert.equal(item.timing.fallbackOffsetSec, 0.25);
    assert.equal(item.timing.requestOffsetSec, 0.25);
    assert.equal(item.framePtsSec, null);
});

test('imported source, assets or inputs changing during capture reject the complete evidence', async t => {
    for (const mutation of ['src/scene.js', 'assets/new.txt', 'inputs/values.json']) {
        const f = await fixture(t);
        f.duringFrame = async () => fs.writeFile(path.join(f.workspace, mutation), 'changed');
        await assert.rejects(f.preview(), error => {
            assert.equal(error.data.preview.status, 'failed');
            assert.match(error.message, /变化/);
            assert.equal(error.data.preview.previewJobs, 1);
            return true;
        });
    }
    const f = await fixture(t);
    const snapshot = await snapshotProject(f.workspace, { includeInputs: true });
    await fs.appendFile(path.join(f.workspace, 'src/scene.js'), '// changed');
    await assert.rejects(f.preview({ sourceSnapshot: snapshot }), /提交后源码已变化/);
    assert.equal(f.calls.length, 0);
});

test('receipt validation rejects changed frames, source media, metadata, protocol and source tree', async t => {
    for (const mutation of ['frame', 'reference', 'candidate', 'metadata', 'protocol', 'source', 'manifest']) {
        const f = await fixture(t), result = await f.preview();
        if (mutation === 'frame') await fs.appendFile(path.join(result.evidenceRoot, result.items[0].path), 'changed');
        if (mutation === 'reference') await fs.appendFile(f.referenceFile, 'changed');
        if (mutation === 'candidate') await fs.appendFile(result.artifact.file, 'changed');
        if (mutation === 'metadata') result.items = result.items.map((item, index) => index ? item : { ...item, timeSec: 99 });
        if (mutation === 'source') await fs.appendFile(path.join(f.workspace, 'src/scene.js'), '// changed');
        if (mutation === 'manifest') await fs.appendFile(path.join(result.evidenceRoot, 'manifest.json'), ' ');
        await assert.rejects(validateStageEvidence(result, { workspace: f.workspace, protocolHash: mutation === 'protocol' ? 'other' : PROTOCOL }), undefined, mutation);
    }
});

test('unsafe entry, unpinned CLI, .env, blank draft and workspace evidence destinations reject before render', async t => {
    for (const invalid of ['entry-symlink', 'pin', 'env', 'blank', 'evidence-in-workspace']) {
        const f = await fixture(t);
        if (invalid === 'entry-symlink') { await fs.unlink(path.join(f.workspace, 'src/index.html')); await fs.symlink(f.referenceFile, path.join(f.workspace, 'src/index.html')); }
        if (invalid === 'pin') {
            const file = path.join(f.workspace, 'package.json'), pkg = JSON.parse(await fs.readFile(file));
            pkg.dependencies.hyperframes = '^0.8.191'; await fs.writeFile(file, JSON.stringify(pkg));
        }
        if (invalid === 'env') await fs.writeFile(path.join(f.workspace, '.env'), 'SECRET=hidden');
        if (invalid === 'blank') await fs.writeFile(path.join(f.workspace, 'src/index.html'), '<!-- REPRODUCTION_DRAFT -->');
        await assert.rejects(f.preview(invalid === 'evidence-in-workspace' ? { evidenceRoot: path.join(f.workspace, 'outputs/evidence') } : {}));
        assert.equal(f.calls.length, 0, invalid);
    }
});

test('cancelled or timed-out host render records actual attempted job and never completed evidence', async t => {
    for (const termination of ['cancelled', 'timeout']) {
        const f = await fixture(t); f.processResult = { exitCode: null, termination, stdout: '', stderr: '' };
        await assert.rejects(f.preview(), error => {
            assert.equal(error.data.preview.status, termination === 'timeout' ? 'timed-out' : 'cancelled');
            assert.equal(error.data.preview.previewJobs, 1);
            assert.equal(error.data.preview.renderCalls, 1);
            assert.equal(error.data.preview.hostToolCalls, 1);
            assert.ok(error.data.preview.elapsedMs >= 0);
            return true;
        });
        assert.equal(f.frames.length, 0);
    }
    const f = await fixture(t), controller = new AbortController(); controller.abort();
    await assert.rejects(f.preview({ signal: controller.signal }), error => error.data.preview.status === 'cancelled');
    assert.equal(f.calls.length, 0);
});

test('integration evidence includes real paired PCM clips and rejects missing required audio', async t => {
    const f = await fixture(t, { audio: 'required', durationSec: 12, evidence: { audioClipSec: 2 } });
    const result = await f.preview({ stageId: 'integration' });
    const clips = result.items.filter(item => item.kind === 'audio');
    assert.equal(clips.length, 6);
    assert.deepEqual(clips.filter(item => item.sourceId === 'subject').map(item => item.requestedTimeSec), [0, 5, 10]);
    assert.ok(clips.every(item => item.durationSec === 2 && item.sampleRate === 16000 && item.channels === 1));
    await validateStageEvidence(result, { workspace: f.workspace, protocolHash: PROTOCOL });
    f.noCandidateAudio = true;
    await assert.rejects(f.preview({ stageId: 'integration' }), /缺少要求的音轨/);
    const optional = await fixture(t, { audio: 'optional' }); optional.noCandidateAudio = true;
    assert.equal((await optional.preview({ stageId: 'integration' })).status, 'completed');
});

test('the whole evidence deadline is checked after the final frame, before any completed receipt', async t => {
    const f = await fixture(t);
    const frameCount = stageSamplingPlan(f.spec).samples.length * 2;
    f.duringFrame = async () => {
        if (f.frames.length === frameCount) await new Promise(resolve => setTimeout(resolve, 550));
    };
    await assert.rejects(f.preview({ timeoutMs: 500 }), error => {
        assert.equal(error.code, 'REPRO_STAGE_TIMEOUT');
        assert.equal(error.data.preview.status, 'timed-out');
        assert.equal(f.frames.length, frameCount, 'the fault must happen in the final sample, not an earlier operation');
        return true;
    });
});

test('native pinned renderer previews a draft with local media and paired reference evidence', {
    skip: process.env.REPRO_NATIVE_PREVIEW_TEST !== '1', timeout: 180000,
}, async t => {
    const f = await fixture(t, { audio: 'required', evidence: { timestampsSec: [1.5], audioClipSec: 0.5 } });
    const exec = promisify(execFile);
    const browser = await resolveInstalledBrowser({ ownerWorkspace: process.cwd() });
    assert.ok(browser, 'An already installed pinned browser is required; this test never downloads one.');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=30:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f.referenceFile]);
    const audio = path.join(f.workspace, 'assets/tone.wav');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', f.referenceFile, '-vn', '-c:a', 'pcm_s16le', audio]);
    f.references[0].source = { videoPath: f.referenceFile, ...(await hashFile(f.referenceFile)) };
    await fs.writeFile(path.join(f.workspace, 'src/index.html'), `<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0;width:100%;height:100%;background:#14253a}#root{width:100%;height:100%;position:relative;overflow:hidden}.box{position:absolute;left:30px;top:30px;width:100px;height:60px;background:#e8b44d}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="160" data-height="120" data-no-timeline="true"><div class="clip" data-start="0" data-duration="2"><div class="box"></div></div><audio id="tone" src="../assets/tone.wav" data-start="0" data-duration="2"></audio></div></body></html>`);
    const result = await previewStage({ env: { HYPERFRAMES_BROWSER_PATH: browser.executable } }, { workspace: f.workspace,
        spec: f.spec, references: f.references, stageId: 'integration', evidenceRoot: path.join(f.base, 'native-evidence'),
        protocolHash: PROTOCOL, timeoutMs: 150000 });
    assert.equal(result.status, 'completed');
    assert.equal(result.version, '0.8.191');
    assert.ok(result.items.some(item => item.sourceId === 'subject' && item.kind === 'audio'));
    assert.ok(result.items.some(item => item.sourceId === 'reference-main' && item.kind === 'audio'));
    await validateStageEvidence(result, { workspace: f.workspace, protocolHash: PROTOCOL });
    const centerPixel = async sourceId => {
        const item = result.items.find(item => item.sourceId === sourceId && item.kind === 'frame');
        const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(result.evidenceRoot, item.path),
            '-vf', 'format=rgb24,crop=1:1:80:60', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
        return [...stdout];
    };
    const candidatePixel = await centerPixel('subject'), referencePixel = await centerPixel('reference-main');
    assert.ok(candidatePixel.every((value, index) => Math.abs(value - [232, 180, 77][index]) < 20), `Candidate must contain the gold rectangle: ${candidatePixel}`);
    assert.ok(referencePixel.every((value, index) => Math.abs(value - [0, 0, 255][index]) < 20), `Reference must contain the blue original: ${referencePixel}`);
    t.diagnostic(JSON.stringify({ strategy: result.strategy, frames: result.items.filter(item => item.kind === 'frame').length,
        audioClips: result.items.filter(item => item.kind === 'audio').length, elapsedMs: result.elapsedMs, hostToolCalls: result.hostToolCalls,
        media: result.artifact.media, candidatePixel, referencePixel, renderSummary: result.process.stdout.slice(-1000) }));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluateArtifacts, hashFile, validateEvidenceReport } from '../src/repro/evaluate.js';

const exec = promisify(execFile);
const metadata = { width: 160, height: 120, durationSec: 2, audioStreams: 1 };
function spec() {
    return {
        schema: 'video-remake.reproduction@2', title: 'Fixture', objective: 'Replace a title while preserving rhythm.',
        preserve: ['Rhythm'], replace: ['Title'], inputs: {},
        acceptance: {
            media: { file: 'outputs/final.mp4', width: 160, height: 120, durationSec: 2, audio: 'required' },
            requiredFiles: ['src/index.html'], evidence: { boundariesSec: [1] },
            review: [{ id: 'layout', description: 'Match the layout.' }],
        },
    };
}
async function fixture(t) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-evaluate-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const workspace = path.join(base, 'project');
    const evidenceRoot = path.join(base, 'checks');
    await fs.mkdir(path.join(workspace, 'outputs'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'src'));
    const media = path.join(workspace, 'outputs/final.mp4');
    const reference = path.join(base, 'reference.mp4');
    await fs.writeFile(media, 'subject media');
    await fs.writeFile(reference, 'reference media');
    await fs.writeFile(path.join(workspace, 'src/index.html'), '<html/>');
    const options = {
        evidenceRoot, references: [{ id: 'reference', source: { videoPath: reference, sha256: (await hashFile(reference)).sha256 } }],
        probeMedia: async () => metadata,
        extractFrame: async (file, output, time) => fs.writeFile(output, `${file}:frame:${time}`),
        extractAudio: async (file, output, time, duration) => fs.writeFile(output, `${file}:audio:${time}:${duration}`),
    };
    return { base, workspace, evidenceRoot, media, reference, options, spec: spec() };
}

test('technical evaluation hashes actual media and freezes paired frames around specified cuts plus audio', async t => {
    const f = await fixture(t);
    const result = await evaluateArtifacts(f.workspace, f.spec, f.options);
    assert.equal(result.passed, true);
    assert.equal(result.artifact.sha256, (await hashFile(f.media)).sha256);
    assert.ok(result.evidenceRoot.startsWith(`${f.evidenceRoot}/evidence_`));
    const manifest = await validateEvidenceReport(result, { spec: f.spec });
    assert.match(result.evaluatorSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.evaluatorSha256, result.evaluatorSha256);
    assert.equal(manifest.sources.length, 2);
    assert.deepEqual(manifest.items.filter(item => item.source === 'subject' && item.kind === 'frame' && item.timeSec > 0.9 && item.timeSec < 1.1).map(item => item.timeSec), [0.92, 1, 1.08]);
    assert.ok(manifest.items.some(item => item.source === 'subject' && item.kind === 'audio'));
    assert.ok(manifest.items.some(item => item.source === 'reference' && item.kind === 'audio'));
    assert.equal(new Set(manifest.items.map(item => item.id)).size, manifest.items.length);
    assert.equal((await fs.readdir(f.workspace)).includes('evidence'), false);
});

test('technical failures and missing files cannot be masked by fabricated metadata', async t => {
    const f = await fixture(t);
    const dimensions = await evaluateArtifacts(f.workspace, f.spec, { probeMedia: async () => ({ ...metadata, width: 320, audioStreams: 0 }) });
    assert.equal(dimensions.passed, false);
    assert.equal(dimensions.checks.find(check => check.id === 'media:width').passed, false);
    assert.equal(dimensions.checks.find(check => check.id === 'media:audio').passed, false);
    await fs.rm(path.join(f.workspace, 'src/index.html'));
    const missing = await evaluateArtifacts(f.workspace, f.spec, { probeMedia: async () => metadata });
    assert.equal(missing.passed, false);
    assert.equal(missing.checks[0].passed, false);
    await fs.rm(f.media);
    assert.equal((await evaluateArtifacts(f.workspace, f.spec, f.options)).artifact, null);
});

test('frame evidence distinguishes requested samples, duration clamping and fallback seeks from unknown decoded PTS', async t => {
    const f = await fixture(t);
    const result = await evaluateArtifacts(f.workspace, f.spec, {
        ...f.options,
        probeMedia: async file => ({ ...metadata, durationSec: file === f.reference ? 1.8 : 2 }),
        extractFrame: async (file, output, initialSeek) => {
            const timeSec = file === f.reference && initialSeek > 1.5 ? initialSeek - 0.25 : initialSeek;
            await fs.writeFile(output, `${file}:frame at unknown PTS after seek ${timeSec}`);
            return { timeSec };
        },
    });
    assert.equal(result.passed, true);
    const final = result.evidence.items.filter(item => item.kind === 'frame' && item.source === 'reference').at(-1);
    assert.equal(final.sampleTimeSec, 1.92);
    assert.equal(final.timing.requestedTimeSec, 1.92);
    assert.equal(final.timing.initialSeekTimeSec, 1.76);
    assert.equal(final.timeSec, 1.51);
    assert.equal(final.timing.seekTimeSec, 1.51);
    assert.equal(final.timing.fallbackOffsetSec, -0.25);
    assert.ok(Math.abs(final.timing.requestOffsetSec + 0.41) < 1e-9);
    assert.equal(final.timing.fallbackApplied, true);
    assert.equal(final.timing.framePtsSec, null);
    assert.equal(final.timing.basis, 'decoder-seek');
    await validateEvidenceReport(result, { spec: f.spec });

    // Even a self-consistent manifest hash cannot turn an unknown decoded PTS
    // into an exact timestamp or hide a recorded fallback offset.
    const manifestFile = path.join(result.evidenceRoot, 'manifest.json');
    for (const mutate of [item => { item.timing.framePtsSec = item.timeSec; }, item => { item.timing.fallbackOffsetSec = 0; }]) {
        const forged = structuredClone(result);
        mutate(forged.evidence.items.find(item => item.id === final.id));
        await fs.chmod(manifestFile, 0o600);
        await fs.writeFile(manifestFile, JSON.stringify(forged.evidence));
        forged.evidenceManifestSha256 = (await hashFile(manifestFile)).sha256;
        await assert.rejects(validateEvidenceReport(forged, { spec: f.spec }), /seek\/fallback timing metadata/);
    }
});

test('evaluation rejects media mutation during probing, symlinks, and in-project evidence', async t => {
    const f = await fixture(t);
    const changed = await evaluateArtifacts(f.workspace, f.spec, { probeMedia: async () => { await fs.writeFile(f.media, 'tampered'); return metadata; } });
    assert.equal(changed.passed, false);
    assert.match(changed.checks.at(-1).message, /changed/);
    await fs.unlink(f.media);
    await fs.symlink(f.reference, f.media);
    assert.equal((await evaluateArtifacts(f.workspace, f.spec, f.options)).passed, false);
    await fs.unlink(f.media);
    await fs.writeFile(f.media, 'restored subject');
    const inside = await evaluateArtifacts(f.workspace, f.spec, { ...f.options, evidenceRoot: path.join(f.workspace, 'checks') });
    assert.equal(inside.passed, false);
    assert.match(inside.checks.at(-1).message, /outside the mutable/);
});

test('evidence is revalidated against files, source hashes, manifest hash, specification and in-memory report', async t => {
    const f = await fixture(t);
    const result = await evaluateArtifacts(f.workspace, f.spec, f.options);
    const forged = structuredClone(result);
    forged.evidence.items[0].id = 'invented';
    await assert.rejects(validateEvidenceReport(forged), /does not match/);
    const differentSpec = structuredClone(f.spec);
    differentSpec.acceptance.review[0].description = 'Different criterion';
    await assert.rejects(validateEvidenceReport(result, { spec: differentSpec }), /different frozen specification/);
    const evidenceFile = path.join(result.evidenceRoot, result.evidence.items[0].path);
    await fs.chmod(evidenceFile, 0o600);
    await fs.writeFile(evidenceFile, 'changed evidence');
    await assert.rejects(validateEvidenceReport(result), /changed/);
    const fresh = await evaluateArtifacts(f.workspace, f.spec, f.options);
    await fs.writeFile(f.reference, 'changed reference');
    await assert.rejects(validateEvidenceReport(fresh), /changed/);
});

test('media mutation during evidence extraction prevents an accepted report', async t => {
    const f = await fixture(t);
    let tampered = false;
    const result = await evaluateArtifacts(f.workspace, f.spec, {
        ...f.options,
        extractFrame: async (...args) => {
            await f.options.extractFrame(...args);
            if (!tampered) { tampered = true; await fs.writeFile(f.media, 'changed mid-extraction'); }
        },
    });
    assert.equal(result.passed, false);
    assert.equal(result.evidence, undefined);
});

test('real ffmpeg produces inspectable frame and audio evidence from tiny media', { timeout: 60_000 }, async t => {
    try { await exec('ffmpeg', ['-version']); await exec('ffprobe', ['-version']); }
    catch { t.skip('ffmpeg and ffprobe are required for the media integration test.'); return; }
    const f = await fixture(t);
    await fs.unlink(f.media);
    await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=160x120:r=10:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f.media]);
    await fs.copyFile(f.media, f.reference);
    const result = await evaluateArtifacts(f.workspace, f.spec, {
        evidenceRoot: f.evidenceRoot,
        references: [{ id: 'reference', source: { videoPath: f.reference, sha256: (await hashFile(f.reference)).sha256 } }],
    });
    assert.equal(result.passed, true, JSON.stringify(result.checks));
    await validateEvidenceReport(result, { spec: f.spec });
    for (const item of result.evidence.items) {
        const data = await fs.readFile(path.join(result.evidenceRoot, item.path));
        if (item.kind === 'frame') assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        else assert.equal(data.toString('ascii', 0, 4), 'RIFF');
    }
});

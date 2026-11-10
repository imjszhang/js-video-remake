import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateArtifacts, hashFile } from '../src/repro/evaluate.js';
import { judgeArtifacts, validateReview } from '../src/repro/judge.js';
import { REVIEW_PROTOCOL } from '../src/repro/review-protocol.js';

async function fixture(t, { fallback = false } = {}) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-judge-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const project = path.join(base, 'host');
    const agentHome = path.join(base, 'state');
    const workspace = path.join(agentHome, 'repro/runs/r_test/workspace');
    await fs.mkdir(project);
    await fs.mkdir(path.join(workspace, 'outputs'), { recursive: true });
    const media = path.join(workspace, 'outputs/final.mp4');
    const reference = path.join(base, 'reference.mp4');
    await fs.writeFile(media, 'subject media');
    await fs.writeFile(reference, 'reference media');
    await fs.writeFile(path.join(workspace, 'private-teacher-code.js'), 'private implementation');
    const spec = {
        schema: 'video-remake.reproduction@2', title: 'Fixture', objective: 'Replace title.',
        preserve: ['Rhythm'], replace: ['Title'], inputs: { title: { type: 'text' } },
        acceptance: {
            media: { file: 'outputs/final.mp4', width: 160, height: 120, durationSec: 2, audio: 'required' },
            review: [{ id: 'layout', description: 'Match layout.', modality: 'visual' }, { id: 'rhythm', description: 'Match sound.', modality: 'audio' }],
        },
    };
    const references = [{ id: 'reference', source: { videoPath: reference, sha256: (await hashFile(reference)).sha256 } }];
    const technical = await evaluateArtifacts(workspace, spec, {
        evidenceRoot: path.join(agentHome, 'repro/runs/r_test/checks'), references,
        probeMedia: async () => ({ width: 160, height: 120, durationSec: 2, audioStreams: 1 }),
        extractFrame: async (file, output, time) => {
            const timeSec = fallback && file === reference ? Math.max(0, time - 0.25) : time;
            await fs.writeFile(output, `${file}:${timeSec}`);
            return { timeSec };
        },
        extractAudio: async (file, output, time) => fs.writeFile(output, `${file}:${time}`),
    });
    assert.equal(technical.passed, true);
    const state = { id: 'r_test', workspace, spec, references, technical, inputs: { title: { type: 'text', value: 'New title' } },
        review: { notes: 'OLD REVIEW MUST NOT LEAK' }, attempts: [{ prompt: 'PRIVATE TEACHER PROMPT' }] };
    const review = {
        schema: 'video-remake.reproduction-review@2', protocolVersion: REVIEW_PROTOCOL.version, reviewer: 'model', artifactSha256: technical.artifact.sha256,
        evidenceManifestSha256: technical.evidenceManifestSha256,
        checks: [
            { id: 'layout', status: 'pass', observationStatus: 'observed', modalities: ['visual'], notes: 'The compared frames have matching title alignment.', evidenceIds: ['subject:frame:0', 'reference:frame:0'] },
            { id: 'rhythm', status: 'pass', observationStatus: 'observed', modalities: ['audio'], notes: 'Both clips contain the same beat timing.', evidenceIds: ['subject:audio:0', 'reference:audio:0'] },
        ],
    };
    const config = { workspace: project, env: { VIDEO_REMAKE_AGENT_HOME: agentHome } };
    const agent = { status: 'completed', model: 'requested-reviewer', responseModel: 'observed-reviewer' };
    const f = { base, project, agentHome, workspace, media, reference, state, config, review, agent };
    f.runner = async (_config, options) => {
        f.judgeWorkspace = options.workspace;
        f.call = options;
        await fs.writeFile(path.join(options.workspace, 'REVIEW.json'), JSON.stringify(f.review));
        return f.agent;
    };
    f.run = (runner = f.runner) => judgeArtifacts(config, { state, target: 'reviewer', agentConfig: 'targets.json', timeoutMs: 5000 }, { runProjectAgent: runner });
    return f;
}

test('independent reviewer receives copied frozen evidence and declared inputs without maker sources or prior reviews', async t => {
    const f = await fixture(t);
    const result = await f.run(async (config, options) => {
        assert.equal(config, f.config);
        assert.equal(options.role, 'reviewer');
        assert.equal(options.target, 'reviewer');
        assert.equal(options.agentConfig, 'targets.json');
        assert.equal(options.timeoutMs, 5000);
        assert.ok(options.workspace.startsWith(path.join(f.agentHome, 'repro/judges/j_')));
        assert.deepEqual((await fs.readdir(options.workspace)).sort(), ['EVIDENCE.json', 'INPUTS.json', 'SUBJECT.json', 'TASK.json', 'evidence', 'media']);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.workspace, 'INPUTS.json'), 'utf8')), { title: 'New title' });
        const viewText = await fs.readFile(path.join(options.workspace, 'EVIDENCE.json'), 'utf8');
        assert.ok(!viewText.includes(f.workspace));
        assert.ok(!options.instruction.includes('PRIVATE TEACHER PROMPT'));
        assert.ok(!options.instruction.includes('OLD REVIEW MUST NOT LEAK'));
        assert.match(options.instruction, /unobserved/);
        assert.match(options.instruction, /evidenceIds/);
        assert.match(options.instruction, /fallbackOffsetSec/);
        assert.match(options.instruction, /不是已测量的画面 PTS/);
        return f.runner(config, options);
    });
    assert.equal(result.review.passed, true);
    assert.equal(result.review.reviewer, 'model:observed-reviewer');
    assert.equal(result.agent, f.agent);
    assert.deepEqual(result.modelAttribution, { requested: 'requested-reviewer', observed: 'observed-reviewer', source: 'runtime-response' });
    assert.equal(f.state.review.notes, 'OLD REVIEW MUST NOT LEAK');
});

test('unknown observed model stays unknown and unobserved criteria never pass', async t => {
    const f = await fixture(t);
    f.agent.responseModel = null;
    f.review.checks[1] = { id: 'rhythm', status: 'unobserved', observationStatus: 'unobserved', modalities: [], notes: 'Audio inspection tool is unavailable.', evidenceIds: [] };
    const result = await f.run();
    assert.equal(result.review.passed, false);
    assert.equal(result.review.checks[1].passed, false);
    assert.equal(result.review.reviewer, 'model:unknown');
    assert.deepEqual(result.modelAttribution, { requested: 'requested-reviewer', observed: null, source: 'unavailable' });
});

test('review rejects invented evidence IDs, stale hashes, timestamps alone, modality mismatch and contradictory pass status', async t => {
    const f = await fixture(t);
    const original = structuredClone(f.review);
    for (const mutate of [
        r => { r.checks[0].evidenceIds = ['imaginary']; },
        r => { r.checks[0].evidenceIds = ['subject:frame:0']; },
        r => { r.checks[0].evidenceIds = []; r.checks[0].notes = 'Looks good at 00:02.'; },
        r => { r.checks[1].evidenceIds = ['subject:frame:0', 'reference:frame:0']; },
        r => { r.checks[0].observationStatus = 'unobserved'; },
        r => { r.checks[0].modalities = []; },
        r => { delete r.checks[0].observationStatus; },
        r => { r.checks[0].passed = false; },
        r => { r.checks[0].id = 'invented'; },
        r => { r.checks.pop(); },
        r => { r.evidenceManifestSha256 = 'b'.repeat(64); },
        r => { r.artifactSha256 = 'a'.repeat(64); },
        r => { r.approved = true; },
    ]) {
        const raw = structuredClone(original);
        mutate(raw);
        assert.throws(() => validateReview(raw, f.state.spec, f.state.technical.artifact.sha256, f.state.technical), { code: 'REPRO_INVALID' });
    }
    const validated = validateReview(original, f.state.spec, f.state.technical.artifact.sha256, f.state.technical);
    assert.deepEqual(validateReview(validated, f.state.spec, f.state.technical.artifact.sha256, f.state.technical), validated);
});

test('tampered subject and evidence are rejected before review launches', async t => {
    const f = await fixture(t);
    let calls = 0;
    const counted = async (...args) => { calls += 1; return f.runner(...args); };
    await fs.writeFile(f.media, 'changed before review');
    await assert.rejects(f.run(counted), /changed/);
    assert.equal(calls, 0);
    await fs.writeFile(f.media, 'subject media');
    const item = f.state.technical.evidence.items[0];
    const file = path.join(f.state.technical.evidenceRoot, item.path);
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, 'changed evidence');
    await assert.rejects(f.run(counted), /changed/);
    assert.equal(calls, 0);
});

test('visual evidence needs a common requested anchor while fallback frames remain usable for layout', async t => {
    const f = await fixture(t, { fallback: true });
    const frames = f.state.technical.evidence.items.filter(item => item.kind === 'frame');
    const subject = frames.filter(item => item.source === 'subject').at(-1);
    const reference = frames.filter(item => item.source === 'reference').at(-1);
    assert.equal(subject.sampleTimeSec, reference.sampleTimeSec);
    assert.notEqual(subject.timeSec, reference.timeSec);
    f.review.checks[0].evidenceIds = [subject.id, reference.id];
    const result = await f.run();
    assert.equal(result.review.checks[0].passed, true, 'layout comparison does not demand equal seek times');
    f.review.checks[0].evidenceIds = ['subject:frame:0', reference.id];
    assert.throws(() => validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical), /common requested sample anchor/);

    const legacy = structuredClone(f.state.technical);
    for (const item of legacy.evidence.items) { delete item.sampleTimeSec; delete item.timing; }
    f.review.checks[0].evidenceIds = ['subject:frame:0', 'reference:frame:0'];
    assert.equal(validateReview(f.review, f.state.spec, legacy.artifact.sha256, legacy).passed, true, 'old evidence may pair using its recorded seek time');
    for (const item of legacy.evidence.items.filter(item => item.kind === 'frame')) delete item.timeSec;
    assert.throws(() => validateReview(f.review, f.state.spec, legacy.artifact.sha256, legacy), /common requested sample anchor/);
});

test('original media, supplied inputs and reviewer copies stay frozen during review', async t => {
    const f = await fixture(t);
    await assert.rejects(f.run(async (...args) => {
        const result = await f.runner(...args);
        await fs.writeFile(f.reference, 'changed reference');
        return result;
    }), /changed/);
    await fs.writeFile(f.reference, 'reference media');
    await assert.rejects(f.run(async (config, options) => {
        const result = await f.runner(config, options);
        await fs.chmod(path.join(options.workspace, 'TASK.json'), 0o600);
        await fs.writeFile(path.join(options.workspace, 'TASK.json'), '{}');
        return result;
    }), /changed/);
    f.state.spec.inputs.logo = { type: 'file' };
    // Changing the spec after evidence extraction is deliberately rejected.
    await assert.rejects(f.run(), /different frozen specification/);
});

test('failed execution, stale technical checks and symlinked reviews never yield acceptance', async t => {
    const f = await fixture(t);
    f.state.technical.passed = false;
    await assert.rejects(f.run(), { code: 'REPRO_NOT_READY' });
    f.state.technical.passed = true;
    f.agent.status = 'failed';
    await assert.rejects(f.run(), { code: 'REPRO_JUDGE_FAILED' });
    f.agent.status = 'completed';
    const outside = path.join(f.base, 'outside-review.json');
    await fs.writeFile(outside, JSON.stringify(f.review));
    await assert.rejects(f.run(async (_config, options) => {
        await fs.symlink(outside, path.join(options.workspace, 'REVIEW.json'));
        return f.agent;
    }), { code: 'REPRO_INVALID' });
    await assert.rejects(f.run(async () => { throw Object.assign(new Error('Cancelled'), { code: 'AGENT_CANCELLED' }); }), { code: 'AGENT_CANCELLED' });
});

 test('legacy negative findings retain backward-compatible interpretation', async t => {
    const f = await fixture(t);
    f.review.schema = 'video-remake.reproduction-review@1';
    delete f.review.protocolVersion;
    f.review.checks[0].notes = '实际查看配对字幕，未观察到字幕裁切、遮住关键动作或漏掉结尾。';
    assert.equal(validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical).checks[0].passed, true);
    for (const notes of ['未观察画面', '未观察到原片画面', '无法查看图像']) {
        f.review.checks[0].notes = notes;
        assert.throws(() => validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical), /Unobserved criterion/);
    }
});

 test('legacy visual review may explicitly exclude source-code inspection', async t => {
    const f = await fixture(t);
    f.review.schema = 'video-remake.reproduction-review@1';
    delete f.review.protocolVersion;
    f.review.checks[0].notes = '实际查看全部配对成片画面，场景顺序齐全。未检查制作源码或推断其可编辑性。';
    assert.equal(validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical).checks[0].passed, true);
    f.review.checks[0].notes = '未检查原片画面。';
    assert.throws(() => validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical), /Unobserved criterion/);
});


test('structured observation avoids negation heuristics and rejects missing observation declarations', async t => {
    const f = await fixture(t);
    for (const notes of ['未观察到幻觉重复或缺尾。', 'No repetition was observed in either video.']) {
        f.review.checks[0].notes = notes;
        assert.equal(validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical).passed, true);
    }
    f.review.checks[0].observationStatus = 'unobserved';
    assert.throws(() => validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical), /observation status/);
    f.review.checks[0].status = 'unobserved';
    assert.equal(validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical).passed, false);
});

test('new calls cannot silently downgrade to the legacy unstructured protocol', async t => {
    const f = await fixture(t);
    f.review.schema = 'video-remake.reproduction-review@1';
    delete f.review.protocolVersion;
    await assert.rejects(f.run(), /structured review schema @2/);
    assert.equal(validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical).passed, true);
});

test('structured motion judgement needs a sequence, not one paired still', async t => {
    const f = await fixture(t);
    f.state.spec.acceptance.review[0].id = 'motion-timing';
    f.review.checks[0].id = 'motion-timing';
    assert.throws(() => validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical), /three paired temporal samples/);
    f.review.checks[0].evidenceIds = f.state.technical.evidence.items.filter(item => item.kind === 'frame').map(item => item.id);
    assert.equal(validateReview(f.review, f.state.spec, f.state.technical.artifact.sha256, f.state.technical).passed, true);
});

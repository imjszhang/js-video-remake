import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, hash, read, write } from './fixtures/repro-fixture.js';
import { createStagedWorkflow } from '../src/repro/config.js';
import { scaffoldMethodRecipe, freezeMethodRecipe } from '../src/repro/method-store.js';
import { snapshotProject } from '../src/repro/project.js';
import { exampleShotPlan, validateShotPlan, shotPlanHash } from '../src/repro/stages.js';
import { PLAN_FILE } from '../src/repro/stage-project.js';
import { stageSamplingPlan } from '../src/repro/stage-evidence.js';
import { previewStage, prepareStageReference, validateStageEvidence } from '../src/repro/stage-preview.js';
import { renderProject } from '../src/repro/render.js';
import { resolveInstalledBrowser } from '../src/repro/execution-environment.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=', 'base64');

async function stagedFixture(t, { policy = {}, execution = {}, realMedia = false, retainArtifacts = false } = {}) {
    const f = await fixture(retainArtifacts ? { after() {} } : t, { realMedia });
    await write(f.workspace, 'reproduction-workflow.json', createStagedWorkflow({
        roles: { teacher: 'high', extractor: 'high', executor: 'small', reviewer: 'reviewer' }, policy, execution,
    }));
    const source = path.join(f.workspace, 'method-source');
    await scaffoldMethodRecipe(source, { title: 'General staged production method', contentReview: {
        reviewer: 'fixture-reviewer', notes: 'Methods only, no implementation.', containsTargetImplementation: false,
    } });
    f.method = await freezeMethodRecipe(f.config, { directory: source, name: 'staged-method', version: 1 });
    f.makers = []; f.previews = []; f.referenceEvidence = null; f.selfCheckFailures = {};
    const agent = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (config, payload) => {
        if (payload.role !== 'executor') return agent(config, payload);
        f.makers.push(payload);
        if (payload.stageId === 'analysis') {
            let plan = exampleShotPlan({ durationSec: f.spec.acceptance.media.durationSec, evidenceIds: f.referenceEvidence.items.map(item => item.id) });
            for (const shot of plan.shots) {
                const frame = f.referenceEvidence.items.find(item => item.kind === 'frame' && item.timeSec >= shot.startSec && item.timeSec < shot.endSec);
                assert.ok(frame, 'The deterministic analysis fixture needs a genuine host reference sample in each shot.');
                shot.observations[0].evidenceId = frame.id;
                shot.observations[0].timeSec = frame.timeSec;
            }
            if (f.transformAnalysisPlan) plan = await f.transformAnalysisPlan(plan, f.referenceEvidence);
            await write(payload.workspace, PLAN_FILE, plan);
            await write(payload.workspace, 'ANALYSIS.md', 'Reference observed: staged fixture.');
            await write(payload.workspace, 'TIMELINE.md', 'Two sequential independently generated shots.');
        } else if (payload.selfCheck) {
            const evidence = f.previews.at(-1);
            const plan = validateShotPlan(await read(payload.workspace, PLAN_FILE), { durationSec: f.spec.acceptance.media.durationSec });
            const fail = (f.selfCheckFailures[payload.stageId] || 0) > 0;
            if (fail) f.selfCheckFailures[payload.stageId]--;
            const report = { schema: 'video-remake.stage-self-check@1', stageId: payload.stageId,
                sourceTreeHash: evidence.sourceTreeHash, planHash: shotPlanHash(plan), shotIds: payload.shotIds,
                checks: payload.shotIds.flatMap(shotId => ['framing', 'action', 'motion'].map(id => {
                    const shot = plan.shots.find(value => value.id === shotId);
                    const pair = evidence.items.filter(item => item.requestedTimeSec >= shot.startSec && item.requestedTimeSec <= shot.endSec);
                    return { id, shotId, status: fail ? 'fail' : 'pass', observationStatus: 'observed',
                        evidenceIds: pair.map(item => item.id), notes: fail ? 'Subject is too large; repair needed.' : 'Compared paired start and motion frames.' };
                })), unresolved: fail ? ['Subject scale differs.'] : [] };
            if (f.forgeSelfCheckPass) report.passed = true;
            await write(payload.workspace, payload.reportFile, report);
            if (f.selfCheckMutation) await f.selfCheckMutation(payload.workspace);
        } else {
            await write(payload.workspace, 'src/index.html', `<!doctype html><html><body><main>Independent ${payload.stageId} implementation ${f.makers.length}</main></body></html>`);
            if (payload.stageId === 'integration') {
                const manifest = await read(payload.workspace, 'reproduction.json');
                await write(payload.workspace, 'reproduction.json', { ...manifest, status: 'ready' });
                await write(payload.workspace, 'RENDER.md', 'Implementation ready for host render and independent review.');
            }
        }
        return { runId: `staged-maker-${f.makers.length}`, status: 'completed', role: 'executor', target: 'small', targetHash: hash('small'),
            requestedModel: 'fixture-low-model', observedModel: 'fixture-low-model', harness: 'fixture-harness', contextMode: 'native-project',
            usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, costUsd: 0.001, toolCalls: 2, renderCalls: 0 };
    };
    async function fakeEvidence({ evidenceRoot, scope, references, workspace, stageId, protocolHash, inputsHash, assetLockHash }) {
        const id = `evidence_${randomUUID()}`, root = path.join(evidenceRoot, id), items = [];
        const sourceIds = [...(workspace ? ['subject'] : []), ...references.map(ref => ref.id)];
        for (const [sourceIndex, sourceId] of sourceIds.entries()) for (const [index, sample] of scope.samples.entries()) {
            const relative = `frames/source-${sourceIndex}/frame-${index}.png`;
            await write(root, relative, PNG);
            items.push({ id: `${sourceId}:frame:${index}`, sourceId, kind: 'frame', path: relative, sha256: hash(PNG),
                requestedTimeSec: sample.requestedTimeSec, sampleTimeSec: sample.requestedTimeSec, timeSec: sample.requestedTimeSec, reasons: sample.reasons });
        }
        const sourceTreeHash = workspace ? (await snapshotProject(workspace, { includeInputs: true })).treeHash : undefined;
        const record = { id, stageId, status: 'completed', evidenceRoot: root, items, sourceTreeHash, scope, protocolHash, inputsHash, assetLockHash,
            previewJobs: workspace ? 1 : 0, renderCalls: workspace ? 1 : 0, hostToolCalls: 2, elapsedMs: 1,
            checks: [{ id: 'fixture:host-evidence', passed: true }], qualityStatus: 'not-evaluated' };
        if (workspace) {
            const media = await write(root, 'media/candidate.mp4', `host stage preview ${id}`);
            record.artifact = { file: media, sha256: hash(await fs.readFile(media)) };
        }
        record.manifest = { id, scope, items };
        await write(root, 'manifest.json', record.manifest);
        record.evidenceManifestSha256 = hash(await fs.readFile(path.join(root, 'manifest.json')));
        return record;
    }
    f.deps.prepareStageReference = async args => {
        f.referenceEvidence = await fakeEvidence({ ...args, scope: { ranges: [{ id: 'whole', startSec: 0, endSec: 2 }],
            samples: [{ requestedTimeSec: 0, reasons: ['reference'] }, { requestedTimeSec: 1, reasons: ['reference'] }] } });
        return f.referenceEvidence;
    };
    f.deps.previewStage = async (_config, args) => {
        const result = await fakeEvidence({ ...args, scope: stageSamplingPlan(args.spec, { shots: args.shots, shotIds: args.shotIds }) });
        f.previews.push(result); return result;
    };
    f.deps.validateStageEvidence = async (record, { workspace } = {}) => {
        if (workspace && record.sourceTreeHash !== (await snapshotProject(workspace, { includeInputs: true })).treeHash) {
            throw Object.assign(new Error('Fixture evidence source is stale.'), { code: 'REPRO_STAGE_EVIDENCE_INVALID' });
        }
        for (const item of record.items) assert.equal(hash(await fs.readFile(path.join(record.evidenceRoot, item.path))), item.sha256);
        return record.manifest;
    };
    f.deps.renderProject = async (_config, { workspace }) => {
        const file = await write(workspace, 'outputs/final.mp4', `final candidate ${f.previews.length}`);
        return { status: 'completed', provider: 'fixture', renderCalls: 1, artifact: { file: 'outputs/final.mp4', sha256: hash(await fs.readFile(file)) } };
    };
    f.generate = (slug = 'staged-trial') => f.execute('generate', f.method.id, { as: slug, ref: 'youtube-fixture', spec: 'spec.json', inputs: 'student-inputs.json' });
    return f;
}

test('staged generation rechecks changed sources, keeps self checks separate and requires two final reviews', async t => {
    const f = await stagedFixture(t);
    const prepared = await f.generate();
    assert.equal(prepared.run.schema, 'video-remake.reproduction-run@3');
    assert.equal(prepared.run.attempts.length, 0);
    const submitted = await f.execute('run', 'staged-trial');
    assert.equal(submitted.run.status, 'external-review');
    assert.equal(submitted.run.attempts.length, 1);
    assert.equal(submitted.run.finalSubmissions.length, 1);
    assert.equal(submitted.run.technical.passed, true);
    assert.equal(f.calls.filter(call => call.role === 'reviewer').length, 0, 'self checks cannot invoke reviewers or grant acceptance');
    assert.ok(submitted.run.stageSubmissions.some(item => item.status === 'stale'), 'changed shared source preserves obsolete evidence in history');
    const source = (await snapshotProject(submitted.run.workspace, { includeInputs: true })).treeHash;
    for (const stage of submitted.run.stageState.stages.filter(stage => ['prototypes', 'shots', 'integration'].includes(stage.id))) {
        assert.equal(stage.status, 'evidence-complete');
        assert.equal(stage.sourceTreeHash, source);
    }
    assert.ok(f.previews.filter(preview => preview.stageId === 'prototypes').length > 1, 'prototype evidence is renewed after downstream source changes');
    const reviewed = await f.execute('judge', 'staged-trial');
    assert.equal(reviewed.run.status, 'passed');
    assert.equal(reviewed.run.reviewSource.votes.length, 2);
    const reviewers = f.calls.filter(call => call.role === 'reviewer');
    assert.equal(reviewers.length, 2);
    assert.notEqual(reviewers[0].workspace, reviewers[1].workspace);
    assert.ok(reviewers.every(call => !call.filesBefore.some(file => file.startsWith('src/') || file.startsWith('method/'))));
});

test('a single-shot operation stops after its scope and cannot turn a pending narrow preview into whole-stage evidence', async t => {
    const f = await stagedFixture(t); await f.generate();
    await f.execute('run', 'staged-trial', { step: true });
    const partial = await f.execute('run', 'staged-trial', { shot: 'shot-01' });
    assert.equal(f.previews.length, 1);
    assert.notEqual(partial.run.stageState.stages.find(stage => stage.id === 'prototypes').status, 'evidence-complete');
    assert.deepEqual(partial.run.stageSubmissions.at(-1).shotIds, ['shot-01']);
    assert.equal(partial.run.attempts.length, 0);
    await f.execute('render', 'staged-trial', { stage: 'prototypes', shot: 'shot-02' });
    const before = f.previews.length;
    const checked = await f.execute('run', 'staged-trial', { step: true });
    const last = checked.run.stageSubmissions.at(-1);
    if (f.previews.length === before) assert.deepEqual(last.shotIds, ['shot-02'], 'existing narrow evidence may only cover its actual scope');
    else assert.deepEqual(last.preview.scope.ranges.map(range => range.id), last.shotIds, 'wider scope requires a fresh host preview');
});

test('stage repairs consume revision and model budget without consuming a final submission', async t => {
    const f = await stagedFixture(t); await f.generate(); f.selfCheckFailures.prototypes = 1;
    const first = await f.execute('run', 'staged-trial');
    assert.equal(first.run.status, 'needs-revision');
    assert.equal(first.run.attempts.length, 0);
    const beforeCalls = first.run.budget.calls;
    const repaired = await f.execute('repair', 'staged-trial', { step: true });
    assert.equal(repaired.run.stageState.stages.find(stage => stage.id === 'prototypes').revision, 2);
    assert.equal(repaired.run.attempts.length, 0);
    assert.ok(repaired.run.budget.calls > beforeCalls);
    assert.ok(repaired.run.stageSubmissions.some(item => item.status === 'needs-revision'));
    const submitted = await f.execute('run', 'staged-trial');
    assert.equal(submitted.run.attempts.length, 1);
    assert.equal(submitted.run.status, 'external-review');
});

test('upstream plan repair carries the failed observation and requires new downstream production', async t => {
    for (const scenario of [{ pending: false, rename: false }, { pending: true, rename: false }, { pending: false, rename: true }]) {
        await t.test(`pending preview ${scenario.pending}; new shot ID ${scenario.rename}`, async t => {
            const f = await stagedFixture(t);
            f.selfCheckFailures.prototypes = 1;
            const runAgent = f.deps.runProjectAgent;
            f.deps.runProjectAgent = async (config, payload) => {
                const result = await runAgent(config, payload);
                if (payload.stageId === 'prototypes' && payload.selfCheck) {
                    const report = await read(payload.workspace, payload.reportFile);
                    if (report.unresolved.length) {
                        report.unresolved = ['The observed cut does not match the shot plan. Request a separate analysis revision.'];
                        for (const check of report.checks) check.notes = report.unresolved[0];
                        await write(payload.workspace, payload.reportFile, report);
                    }
                }
                return result;
            };
            await f.generate();
            const failed = await f.execute('run', 'staged-trial');
            assert.equal(failed.run.stageState.stages.find(stage => stage.id === 'prototypes').status, 'needs-revision');
            if (scenario.pending) {
                f.forgeSelfCheckPass = true;
                await assert.rejects(f.execute('repair', 'staged-trial', { stage: 'prototypes', step: true }), { code: 'REPRO_STAGE_INVALID' });
                f.forgeSelfCheckPass = false;
            }
            const before = await f.load('staged-trial');
            const priorStage = before.stageState.stages.find(stage => stage.id === 'prototypes');
            const failedSubmission = structuredClone(before.stageSubmissions.findLast(item => item.stageId === 'prototypes'));
            const productionCount = f.makers.filter(call => call.stageId === 'prototypes' && !call.selfCheck).length;
            f.transformAnalysisPlan = plan => {
                plan.shots[0].endSec = 0.8; plan.shots[1].startSec = 0.8;
                if (scenario.rename) plan.shots[1].id = 'shot-revised';
                return plan;
            };
            const repaired = await f.execute('repair', 'staged-trial', { stage: 'analysis', step: true });
            const state = await f.load('staged-trial');
            assert.notEqual(state.planHash, before.planHash);
            assert.equal(state.feedback.origin.stageId, 'prototypes');
            assert.equal(state.feedback.target.stageId, 'analysis');
            assert.deepEqual(state.feedback.origin.selfCheck, priorStage.selfCheck);
            assert.equal(state.feedback.origin.source.submissionId, failedSubmission.id);
            assert.equal(state.feedback.origin.source.sourceTreeHash, failedSubmission.sourceTreeHash);
            assert.equal(state.feedback.origin.source.planHash, before.planHash);
            assert.equal(state.feedback.origin.source.evidenceManifestSha256, failedSubmission.evidenceManifestSha256);
            assert.equal(state.repairHistory.at(-1).id, state.feedback.id);
            assert.ok(f.makers.at(-1).instruction.includes(priorStage.selfCheck.unresolved[0]));
            assert.equal(state.budget.calls, before.budget.calls + 1);
            assert.deepEqual(state.stageSubmissions.find(item => item.id === failedSubmission.id), failedSubmission, 'failed history must remain byte-equivalent');
            const nextStage = repaired.run.stageState.stages.find(stage => stage.id === 'prototypes');
            assert.equal(nextStage.status, 'pending');
            assert.equal(nextStage.producedShotIds, undefined);
            assert.equal(nextStage.implementationExecutionId, undefined);
            assert.equal(nextStage.pendingPreview, undefined);
            assert.deepEqual(nextStage.shotRevisions, priorStage.shotRevisions);
            assert.equal(nextStage.revision, priorStage.revision);
            assert.equal(state.attempts.length, before.attempts.length);
            await f.execute('run', 'staged-trial', { step: true });
            const after = await f.load('staged-trial');
            const productions = f.makers.filter(call => call.stageId === 'prototypes' && !call.selfCheck);
            assert.equal(productions.length, productionCount + 1, 'changed plan must call the producer, not merely recheck old source');
            assert.match(productions.at(-1).instruction, /本阶段不得修改planning\/镜头计划/);
            const produced = after.stageState.stages.find(stage => stage.id === 'prototypes');
            assert.equal(produced.shotRevisions['shot-01'], priorStage.shotRevisions['shot-01'] + 1);
            assert.equal(produced.shotRevisions['shot-02'], priorStage.shotRevisions['shot-02'] + (scenario.rename ? 0 : 1));
            if (scenario.rename) assert.equal(produced.shotRevisions['shot-revised'], 1);
            assert.equal(after.budget.calls, state.budget.calls + 2, 'new shot IDs cannot reset the cumulative call budget');
        });
    }
});

test('an unchanged analysis plan retains production markers and only rechecks existing implementation', async t => {
    const f = await stagedFixture(t);
    await f.generate();
    await f.execute('run', 'staged-trial', { until: 'prototypes' });
    const before = await f.load('staged-trial');
    const stageBefore = before.stageState.stages.find(stage => stage.id === 'prototypes');
    const productionCount = f.makers.filter(call => call.stageId === 'prototypes' && !call.selfCheck).length;
    await f.execute('repair', 'staged-trial', { stage: 'analysis', step: true });
    const repaired = await f.load('staged-trial');
    assert.equal(repaired.planHash, before.planHash);
    const stage = repaired.stageState.stages.find(item => item.id === 'prototypes');
    assert.deepEqual(stage.producedShotIds, stageBefore.producedShotIds);
    assert.equal(stage.implementationExecutionId, stageBefore.implementationExecutionId);
    assert.deepEqual(stage.shotRevisions, stageBefore.shotRevisions);
    await f.execute('run', 'staged-trial', { step: true });
    assert.equal(f.makers.filter(call => call.stageId === 'prototypes' && !call.selfCheck).length, productionCount);
});

test('stage jumps and early judging never call the maker or reviewer', async t => {
    for (const [action, options] of [['run', { stage: 'integration' }], ['judge', {}]]) {
        const f = await stagedFixture(t); await f.generate();
        await assert.rejects(f.execute(action, 'staged-trial', options), { code: 'REPRO_NOT_READY' });
        assert.equal(f.makers.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.previews.length, 0);
    }
});

test('analysis of a short shot between fixed host frames can cite the frozen whole-video evidence', async t => {
    const f = await stagedFixture(t); await f.generate();
    f.deps.prepareStageReference = async (args, deps) => {
        f.referenceEvidence = await prepareStageReference(args, { ...deps,
            probeMedia: async () => ({ width: 160, height: 120, durationSec: 2, audioStreams: 0 }),
            extractFrame: async (_file, output, timeSec) => { await fs.writeFile(output, PNG); return { timeSec }; },
        });
        return f.referenceEvidence;
    };
    f.deps.validateStageEvidence = validateStageEvidence;
    f.transformAnalysisPlan = (plan, evidence) => {
        const video = evidence.items.find(item => item.kind === 'video');
        assert.ok(video, 'analysis must receive a host-copied complete source video');
        assert.ok(!evidence.items.some(item => item.kind === 'frame' && item.timeSec >= 1.2 && item.timeSec <= 1.3));
        return { ...plan, shots: [[0, 1.2], [1.2, 1.3], [1.3, 2]].map(([startSec, endSec], index) => ({
            ...plan.shots[Math.min(index, 1)], id: `shot-0${index + 1}`, startSec, endSec,
            observations: [{ timeSec: (startSec + endSec) / 2, evidenceId: video.id, claim: 'Observed this time by seeking the complete frozen original.', certainty: 'observed' }],
            riskTags: index === 0 ? ['character-interaction'] : index === 1 ? ['complex-motion'] : [], dependencies: index ? [`shot-0${index}`] : [],
        })) };
    };
    const result = await f.execute('run', 'staged-trial', { step: true });
    assert.equal(result.run.stageState.stages.find(stage => stage.id === 'analysis').status, 'evidence-complete');
    assert.equal(result.run.shotPlan.shots.length, 3);
    assert.equal(result.run.shotPlan.shots[1].observations[0].timeSec, 1.25);
    assert.equal(result.run.shotPlan.shots[1].observations[0].evidenceId, 'youtube-fixture:video');
    assert.equal(result.run.attempts.length, 0);
    const video = f.referenceEvidence.items.find(item => item.kind === 'video');
    assert.deepEqual(await fs.readFile(path.join(result.run.workspace, '.work/stage-evidence', f.referenceEvidence.id, video.path)),
        await fs.readFile(path.join(f.referenceEvidence.evidenceRoot, video.path)));
});

test('mandatory final review reserves stop production before the next maker call', async t => {
    const f = await stagedFixture(t, { policy: { maxCalls: 3 } }); await f.generate();
    await f.execute('run', 'staged-trial', { step: true });
    assert.equal(f.makers.length, 1);
    await assert.rejects(f.execute('run', 'staged-trial'), { code: 'REPRO_BUDGET_EXHAUSTED' });
    assert.equal(f.makers.length, 1);
    const state = await f.load('staged-trial');
    assert.equal(state.budget.calls, 1); assert.equal(state.attempts.length, 0); assert.equal(state.status, 'budget-exhausted');
});

test('self-check cannot change source or grant itself an independent pass', async t => {
    for (const fault of ['source-change', 'forged-pass']) {
        const f = await stagedFixture(t); await f.generate();
        if (fault === 'source-change') f.selfCheckMutation = root => fs.appendFile(path.join(root, 'src/index.html'), '<p>Forbidden self-check edit</p>');
        else f.forgeSelfCheckPass = true;
        await assert.rejects(f.execute('run', 'staged-trial'), { code: 'REPRO_STAGE_INVALID' });
        const state = await f.load('staged-trial');
        assert.notEqual(state.status, 'passed'); assert.equal(state.attempts.length, 0);
        assert.equal(f.calls.filter(call => call.role === 'reviewer').length, 0);
    }
});

test('retry creates a blank episode while preserving cumulative budgets and prior project/evidence bytes', async t => {
    const f = await stagedFixture(t); await f.generate(); f.selfCheckFailures.prototypes = 1;
    await f.execute('run', 'staged-trial');
    const before = await f.load('staged-trial');
    const priorEpisode = before.episodes.at(-1).id;
    const priorSource = await fs.readFile(path.join(before.workspace, 'src/index.html'));
    const priorEvidence = f.previews.at(-1);
    const evidenceBytes = await fs.readFile(path.join(priorEvidence.evidenceRoot, 'manifest.json'));
    const makerCount = f.makers.length;
    await f.execute('retry', 'staged-trial', { step: true });
    const after = await f.load('staged-trial');
    assert.equal(after.id, before.id);
    assert.equal(after.episodes.length, 2);
    assert.notEqual(after.episodes.at(-1).id, priorEpisode);
    assert.deepEqual(after.budget, before.budget, 'resetting the project must not reset any spent budget');
    assert.equal(f.makers.length, makerCount, 'step retry only prepares its fresh episode');
    assert.match(await fs.readFile(path.join(after.workspace, 'src/index.html'), 'utf8'), /REPRODUCTION_DRAFT/);
    const archived = after.episodes.find(episode => episode.id === priorEpisode).archivedProject;
    assert.deepEqual(await fs.readFile(path.join(archived, 'src/index.html')), priorSource);
    assert.deepEqual(await fs.readFile(path.join(priorEvidence.evidenceRoot, 'manifest.json')), evidenceBytes);
    assert.equal(after.stageSubmissions.length, before.stageSubmissions.length);
    assert.equal(after.attempts.length, 0);
    const submitted = await f.execute('run', 'staged-trial');
    assert.equal(submitted.run.status, 'external-review');
    assert.ok(submitted.run.budget.calls > before.budget.calls);
    assert.equal(submitted.run.attempts.length, 1);
    assert.equal(submitted.run.attempts[0].episodeId, after.episodes.at(-1).id);
});

test('missing or corrupted host evidence cannot advance to self-check or final submission', async t => {
    for (const fault of ['missing', 'changed']) {
        const f = await stagedFixture(t); await f.generate();
        const preview = f.deps.previewStage;
        f.deps.previewStage = async (...args) => {
            const record = await preview(...args);
            const file = path.join(record.evidenceRoot, record.items[0].path);
            if (fault === 'missing') await fs.unlink(file); else await fs.appendFile(file, 'corrupted');
            return record;
        };
        await assert.rejects(f.execute('run', 'staged-trial'));
        const state = await f.load('staged-trial');
        assert.equal(state.attempts.length, 0);
        assert.notEqual(state.status, 'passed');
        assert.equal(f.makers.filter(call => call.selfCheck).length, 0);
        assert.ok(!state.stageSubmissions.some(record => record.kind === 'stage-preview' && record.status === 'evidence-complete'));
    }
});

test('an initial partial prototype invokes production again for the other unmade shot', async t => {
    const f = await stagedFixture(t); await f.generate();
    await f.execute('run', 'staged-trial', { step: true });
    await f.execute('run', 'staged-trial', { shot: 'shot-01' });
    const before = f.makers.filter(call => call.stageId === 'prototypes' && !call.selfCheck);
    assert.equal(before.length, 1); assert.deepEqual(before[0].shotIds, ['shot-01']);
    await f.execute('run', 'staged-trial', { shot: 'shot-02' });
    const after = f.makers.filter(call => call.stageId === 'prototypes' && !call.selfCheck);
    assert.equal(after.length, 2, 'stale evidence for shot A does not mean shot B was ever implemented');
    assert.deepEqual(after.at(-1).shotIds, ['shot-02']);
    assert.equal((await f.load('staged-trial')).attempts.length, 0);
});

test('retrying a failed host final render reuses its source submission and does not consume another formal attempt', async t => {
    const f = await stagedFixture(t); await f.generate();
    const render = f.deps.renderProject; let renderCalls = 0;
    f.deps.renderProject = async (...args) => {
        renderCalls++;
        if (renderCalls === 1) throw Object.assign(new Error('Fixture transient host rendering failure.'), {
            code: 'REPRO_RENDER_FAILED', data: { render: { status: 'failed', renderCalls: 1, error: 'fixture transient failure' } },
        });
        return render(...args);
    };
    await assert.rejects(f.execute('run', 'staged-trial'), { code: 'REPRO_RENDER_FAILED' });
    const before = await f.load('staged-trial'), makers = f.makers.length;
    assert.equal(before.attempts.length, 1);
    const submitted = await f.execute('render', 'staged-trial');
    assert.equal(submitted.run.status, 'external-review');
    assert.equal(renderCalls, 2); assert.equal(f.makers.length, makers);
    assert.equal(submitted.run.attempts.length, 1, 'host process retry must not consume a new source submission');
    assert.equal(submitted.run.attempts[0].id, before.attempts[0].id);
    assert.equal(submitted.run.attempts[0].sourceSnapshot.treeHash, before.attempts[0].sourceSnapshot.treeHash);
    assert.equal(submitted.run.attempts[0].renders.length, 2);
});

test('native staged wiring renders true host evidence and final media with explicitly synthetic observers', {
    skip: process.env.REPRO_NATIVE_STAGED_TEST !== '1', timeout: 600000,
}, async t => {
    // This is a host integration test, not an independent model/quality trial.
    // Keep its new temporary directory so the printed report is inspectable.
    const f = await stagedFixture(t, { realMedia: true, retainArtifacts: true });
    const browser = await resolveInstalledBrowser({ ownerWorkspace: process.cwd() });
    assert.ok(browser, 'An installed pinned browser is required; this test never installs one.');
    f.config.env.HYPERFRAMES_BROWSER_PATH = browser.executable;
    let gsap;
    if (process.env.REPRO_NATIVE_GSAP) gsap = await fs.readFile(process.env.REPRO_NATIVE_GSAP);
    else {
        const response = await fetch('https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js', { signal: AbortSignal.timeout(20000) });
        assert.equal(response.ok, true); gsap = Buffer.from(await response.arrayBuffer());
    }
    assert.match(gsap.toString('utf8'), /GSAP 3\.14\.2/);
    const maker = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (config, payload) => {
        const result = await maker(config, payload);
        if (payload.role === 'executor' && payload.stageId !== 'analysis' && !payload.selfCheck) {
            await write(payload.workspace, 'assets/gsap.min.js', gsap);
            await write(payload.workspace, 'src/index.html', `<!doctype html><html lang="en"><head><meta charset="UTF-8"><script src="../assets/gsap.min.js"></script><style>html,body{margin:0;width:100%;height:100%;background:#14253a}#root{width:100%;height:100%;position:relative;overflow:hidden}.clip{position:absolute;inset:0}.box{position:absolute;left:20px;top:30px;width:100px;height:60px;background:#e8b44d}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="160" data-height="120"><section class="clip" data-start="0" data-duration="2"><div class="box"></div></section></div><script>const tl=gsap.timeline({paused:true});tl.fromTo('.box',{x:0},{x:20,duration:2,ease:'none'},0);window.__timelines['main']=tl;</script></body></html>`);
        }
        return result;
    };
    f.deps.prepareStageReference = async (args, deps) => {
        f.referenceEvidence = await prepareStageReference(args, deps); return f.referenceEvidence;
    };
    f.deps.previewStage = async (config, args, deps) => {
        const record = await previewStage(config, args, deps); f.previews.push(record);
        t.diagnostic(`Host ${args.stageId} preview: ${record.elapsedMs} ms, ${record.items.length} real frames`);
        return record;
    };
    f.deps.validateStageEvidence = validateStageEvidence;
    f.deps.renderProject = renderProject;
    f.reviewStatus = 'unobserved';
    await f.generate('native-staged-fixture');
    const submitted = await f.execute('run', 'native-staged-fixture');
    assert.equal(submitted.run.status, 'external-review');
    assert.equal(submitted.run.technical.passed, true);
    assert.equal(submitted.run.attempts.length, 1);
    const reviewed = await f.execute('judge', 'native-staged-fixture');
    assert.equal(reviewed.run.status, 'needs-revision', 'synthetic unobserved votes must not certify visual fidelity');
    assert.equal(reviewed.run.reviewSource.votes.length, 2);
    assert.equal(f.calls.filter(call => call.role === 'reviewer').length, 2);
    const state = await f.load('native-staged-fixture');
    const report = { schema: 'video-remake.native-staged-validation@1', validation: 'host-wiring-only',
        qualityStatus: 'not-evaluated', observers: 'deterministic fixture executor/self-checks; final reviewers explicitly unobserved; no paid models',
        runId: state.id, directory: f.directory, workspace: state.workspace, hyperframesVersion: '0.8.191', browser,
        gsapVersion: '3.14.2', gsapSha256: hash(gsap), finalStatus: state.status, technicalPassed: state.technical.passed,
        finalArtifact: state.technical.artifact, finalEvidenceRoot: state.technical.evidenceRoot, reviewVotes: state.reviewSource.votes.length,
        previews: f.previews.map(record => ({ stageId: record.stageId, sourceTreeHash: record.sourceTreeHash, evidenceRoot: record.evidenceRoot,
            items: record.items.length, elapsedMs: record.elapsedMs, hostToolCalls: record.hostToolCalls })), budget: state.budget };
    const reportFile = await write(f.directory, 'NATIVE-STAGED-VALIDATION.json', report);
    t.diagnostic(JSON.stringify({ reportFile, directory: f.directory, runId: state.id, finalStatus: state.status, qualityStatus: report.qualityStatus,
        previews: f.previews.length, finalEvidenceRoot: state.technical.evidenceRoot, finalArtifact: state.technical.artifact, budget: state.budget }));
});

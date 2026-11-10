import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAGE_IDS, STAGE_PROTOCOL, stageProtocolFingerprint, exampleShotPlan, validateShotPlan, requiredShotSamples,
    selectPrototypeShots, validateSelfCheck, createStageState, recordStageSubmission, invalidateStages, stageRequirements, allowedStageActions } from '../src/repro/stages.js';

const h = char => char.repeat(64);
const plan = () => exampleShotPlan({ durationSec: 10, evidenceIds: ['ref:first', 'ref:second'] });
const validate = value => validateShotPlan(value, { durationSec: 10, evidenceIds: ['ref:first', 'ref:second'], requiredAnchors: [1.5, 5, 8.75, 10] });
const submit = (stageId, revision = 1) => ({ id: `stage-${stageId}-${revision}`, stageId, shotIds: ['shot-01'], revision,
    episodeId: 'episode-1', sourceTreeHash: h('a'), planHash: h('b'), evidenceRoot: '/host/evidence', items: [],
    hostChecks: [{ id: 'evidence-integrity', kind: 'evidence', passed: true }], selfCheck: null, status: 'evidence-complete', createdAt: '2026-10-25T00:00:00Z' });

test('shot plan covers exact task and host adds missing motion samples and public anchors', () => {
    const input = plan();
    const value = validate(input);
    assert.deepEqual(input.shots[0].sampleTimesSec, [], 'normalization must not modify executor input');
    assert.deepEqual(value.shots[0].sampleTimesSec, [0, 1.5, 2.5, 4.96]);
    assert.deepEqual(value.shots[1].sampleTimesSec, [5, 7.5, 8.75, 9.96, 10]);
    assert.deepEqual(requiredShotSamples(value)['shot-02'], value.shots[1].sampleTimesSec);
    assert.equal(value.shots[0].observations[0].certainty, 'uncertain', 'host-added samples must not invent observation');
    assert.deepEqual(selectPrototypeShots(value), ['shot-01', 'shot-02']);
    const precise = 1.234567890123;
    assert.ok(validateShotPlan(input, { requiredAnchors: [precise] }).shots[0].sampleTimesSec.includes(precise));
});

test('analysis rejects gaps, overlaps, duplicate IDs, changed duration and unknown reference evidence', () => {
    for (const mutate of [
        p => { p.shots[1].startSec = 5.1; }, p => { p.shots[1].startSec = 4.9; },
        p => { p.shots[1].id = p.shots[0].id; }, p => { p.durationSec = 11; },
        p => { p.shots[1].observations[0].evidenceId = 'invented'; },
        p => { p.shots[0].sampleTimesSec = [-1]; }, p => { p.shots[0].dependencies = ['shot-02']; },
        p => { p.shots[1].dependencies = ['missing']; }, p => { p.shots[0].passed = true; },
    ]) {
        const value = plan(); mutate(value); assert.throws(() => validate(value), { code: 'REPRO_STAGE_INVALID' });
    }
    const valid = plan(); valid.shots[1].dependencies = ['shot-01'];
    assert.equal(validate(valid).shots[1].dependencies[0], 'shot-01');
    assert.doesNotThrow(() => validateShotPlan(plan(), { requiredAnchors: [5, 5] }));
});

test('prototype requirements cannot all be satisfied by a single claimed shot', () => {
    const value = validate(plan());
    value.shots[0].riskTags = ['character-interaction', 'complex-motion'];
    value.shots[1].riskTags = [];
    assert.throws(() => selectPrototypeShots(value), /Distinct prototype/);
    value.shots[1].riskTags = ['character-interaction'];
    assert.deepEqual(selectPrototypeShots(value), ['shot-02', 'shot-01'], 'matching must not depend on a greedy first choice');
    assert.deepEqual(selectPrototypeShots({ shots: [value.shots[0]] }, { requirements: [], minShots: 1 }), ['shot-01']);
});

test('self-check citations bind each shot to paired host samples and motion needs all three phases', () => {
    const shots = [{ id: 'shot-01', startSec: 0, endSec: 5 }, { id: 'shot-02', startSec: 5, endSec: 10 }];
    const pair = (time, kind = 'frame') => ['subject', 'reference'].map(sourceId => ({
        id: `${sourceId}:${kind}:${time}`, sourceId, kind, requestedTimeSec: time, timeSec: time,
        timing: { requestedTimeSec: time, seekTimeSec: time, fallbackOffsetSec: 0 },
    }));
    const evidenceItems = [0, 2.5, 4.96, 6, 8].flatMap(time => pair(time));
    evidenceItems.push(...pair(0, 'audio'));
    const raw = { schema: 'video-remake.stage-self-check@1', stageId: 'prototypes', sourceTreeHash: h('a'), planHash: h('b'), shotIds: ['shot-01'],
        checks: [{ id: 'framing', shotId: 'shot-01', status: 'pass', observationStatus: 'observed', evidenceIds: pair(2.5).map(item => item.id), notes: 'Paired framing observation.' }], unresolved: [] };
    const options = { stageId: 'prototypes', shotIds: ['shot-01'], evidenceItems, shots };
    assert.doesNotThrow(() => validateSelfCheck(raw, options), 'framing need not cite every frame');
    const check = (id, ids) => ({ ...raw, checks: [{ ...raw.checks[0], id, evidenceIds: ids }] });
    assert.throws(() => validateSelfCheck(check('framing', ['subject:frame:0', 'reference:frame:2.5']), options), /common requested time/);
    assert.throws(() => validateSelfCheck(check('framing', pair(6).map(item => item.id)), options), /declared shot/);
    assert.throws(() => validateSelfCheck(check('motion', pair(2.5).map(item => item.id)), options), /beginning, middle and end/);
    const motion = check('motion', [0, 2.5, 4.96].flatMap(time => pair(time).map(item => item.id)));
    assert.doesNotThrow(() => validateSelfCheck(motion, options));
    const misaligned = structuredClone(evidenceItems); misaligned[2].timeSec += 0.01;
    assert.throws(() => validateSelfCheck(motion, { ...options, evidenceItems: misaligned }), /beginning, middle and end/);
    const fallback = structuredClone(evidenceItems); fallback[0].timing.fallbackOffsetSec = 0.1;
    assert.throws(() => validateSelfCheck(motion, { ...options, evidenceItems: fallback }), /beginning, middle and end/);
    assert.throws(() => validateSelfCheck(check('sound', pair(0).map(item => item.id)), options), /paired audio excerpt/);
    assert.doesNotThrow(() => validateSelfCheck(check('sound', pair(0, 'audio').map(item => item.id)), options));
    assert.throws(() => validateSelfCheck(check('sound', ['subject:audio:0']), options), /paired audio excerpt/);
});

test('self-check is bound to exact source, plan, shots and host evidence without promoting its pass claim', () => {
    const raw = { schema: 'video-remake.stage-self-check@1', stageId: 'prototypes', sourceTreeHash: h('a'), planHash: h('b'), shotIds: ['shot-01'],
        checks: [{ id: 'composition', shotId: 'shot-01', status: 'pass', observationStatus: 'observed', evidenceIds: ['candidate:frame:1', 'reference:frame:1'], notes: 'I compared the supplied pair.' }], unresolved: [] };
    const options = { stageId: 'prototypes', shotIds: ['shot-01'], sourceTreeHash: h('a'), planHash: h('b'), evidenceIds: ['candidate:frame:1', 'reference:frame:1'], requiredCheckIds: ['composition'] };
    const result = validateSelfCheck(raw, options);
    assert.equal(result.passed, undefined);
    assert.equal(result.qualityPassed, undefined);
    for (const change of [
        r => { r.sourceTreeHash = h('c'); }, r => { r.planHash = h('d'); }, r => { r.stageId = 'integration'; },
        r => { r.checks[0].evidenceIds = ['stale']; }, r => { r.checks[0].observationStatus = 'unobserved'; },
        r => { r.checks = []; }, r => { r.shotIds.push('shot-02'); }, r => { r.passed = true; },
        r => { r.checks.push(structuredClone(r.checks[0])); },
    ]) { const altered = structuredClone(raw); change(altered); assert.throws(() => validateSelfCheck(altered, options), { code: 'REPRO_STAGE_INVALID' }); }
    const unseen = structuredClone(raw);
    Object.assign(unseen.checks[0], { status: 'unobserved', observationStatus: 'unobserved', evidenceIds: [], notes: 'No actual observation.' });
    assert.equal(validateSelfCheck(unseen, options).checks[0].status, 'unobserved');
});

test('host stage transitions reject jumps and forged visual gates, remain idempotent and retain stale history', async () => {
    const fingerprint = await stageProtocolFingerprint();
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    const initial = createStageState({ protocolHash: fingerprint, episodeId: 'episode-1' });
    assert.equal(initial.protocol, STAGE_PROTOCOL.id);
    assert.deepEqual(initial.stages.map(s => s.id), STAGE_IDS);
    assert.equal(initial.stages[0].status, 'complete');
    assert.throws(() => recordStageSubmission(initial, submit('freeze', 2)), /frozen record/);
    assert.throws(() => recordStageSubmission(initial, submit('shots')), /prerequisites/);
    const forged = submit('analysis'); forged.hostChecks[0].kind = 'visual-quality';
    assert.throws(() => recordStageSubmission(initial, forged), /visual quality/);
    const analysis = submit('analysis');
    analysis.selfCheck = { passed: true, claims: 'This has no authority to grant quality.' };
    const next = recordStageSubmission(initial, analysis);
    assert.equal(initial.stages[1].revision, 0);
    assert.equal(next.stages[1].qualityStatus, 'not-evaluated');
    assert.equal(next.currentStage, 'prototypes');
    assert.deepEqual(recordStageSubmission(next, analysis), next);
    const changed = structuredClone(analysis); changed.sourceTreeHash = h('c');
    assert.throws(() => recordStageSubmission(next, changed), /cannot change/);
    const prototype = recordStageSubmission(next, submit('prototypes'));
    const stale = invalidateStages(prototype, { fromStage: 'analysis', reason: 'Observation changed', sourceTreeHash: h('e') });
    assert.equal(stale.stages[1].status, 'stale'); assert.equal(stale.stages[2].status, 'stale');
    assert.equal(stale.stages[2].submissions.length, 1);
    assert.equal(prototype.stages[2].status, 'evidence-complete');
    assert.equal(stageRequirements(stale, 'submission').ready, false);
    assert.ok(allowedStageActions(stale).allowedActions.includes('repair'));
    assert.deepEqual(allowedStageActions(stale, { active: true }).allowedActions, ['status', 'logs', 'cancel']);
    const bad = submit('analysis', 2); bad.hostChecks[0].passed = false;
    assert.throws(() => recordStageSubmission(stale, bad), /must follow host checks/);
    bad.status = 'needs-revision';
    const needsRepair = recordStageSubmission(stale, bad);
    assert.equal(needsRepair.currentStage, 'analysis');
    const repaired = recordStageSubmission(needsRepair, submit('analysis', 3));
    assert.equal(repaired.stages[1].revision, 3);
    assert.throws(() => recordStageSubmission(repaired, submit('analysis', 4)), { code: 'REPRO_BUDGET_EXHAUSTED' });
});

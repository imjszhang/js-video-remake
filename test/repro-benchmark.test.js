import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { jsonHash } from '../src/repro/store.js';
import { REVIEW_PROTOCOL } from '../src/repro/review-protocol.js';
import { summarizeBenchmark, runBenchmark } from '../src/repro/benchmark.js';

function run(id, { kind = 'trial', pass = true, cost = 2, assisted = false, attempts = 1 } = {}) {
    return { id, production: id, kind, status: pass ? 'passed' : 'needs-revision', assisted,
        specHash: 'same-spec', inputsHash: 'same-inputs', targetHash: 'same-target',
        references: [{ id: 'ref', source: { sha256: 'same-ref' } }],
        workflow: { policy: { maxCalls: 3, maxDurationMs: 10000 } },
        ...(kind === 'trial' ? { template: { id: 'demo@1', treeHash: 'same-template' } } : {}),
        technical: { passed: true }, review: { checks: [{ id: 'layout', status: pass ? 'pass' : 'fail' }] },
        attempts: Array.from({ length: attempts }, (_, index) => ({ number: index + 1, executionCompleted: true,
            technical: { passed: true }, review: { passed: pass && index === attempts - 1 },
            agents: [{ runId: `${id}-agent-${index}`, status: 'completed', targetHash: 'same-target', contextMode: 'explicit-context',
                requestedModel: 'low-model', observedModel: null, harness: { adapter: 'codex' }, toolVersions: { runtime: '0.1.0', cli: 'fixture' },
                usage: { totalTokens: 100 }, elapsedMs: 1000, cost: cost === null ? null : { total: cost, currency: 'USD' } }],
        })),
    };
}

test('benchmark reports all retries, assistance and paired quality without hiding failures', () => {
    const report = summarizeBenchmark([
        { id: 'normal', baseline: run('b1', { kind: 'baseline', pass: false }), template: run('t1') },
        { id: 'long-text', baseline: run('b2', { kind: 'baseline' }), template: run('t2', { attempts: 2, assisted: true }) },
    ]);
    assert.equal(report.comparableCases, 2);
    assert.equal(report.arms.baseline.successRate, 0.5);
    assert.equal(report.arms.template.successRate, 1);
    assert.equal(report.arms.template.independentSuccessRate, 0);
    assert.equal(report.arms.template.unassistedSuccessfulRuns, 1);
    assert.equal(report.arms.template.firstPassRate, 0.5);
    assert.equal(report.arms.template.attempts, 3);
    assert.equal(report.arms.template.retries, 1);
    assert.equal(report.arms.template.assistedRuns, 1);
    assert.equal(report.comparison.successRateDelta, 0.5);
    assert.equal(report.comparison.independentSuccessRateDelta, 0);
    assert.equal(report.cases[1].template.attemptResults.length, 2);
});

test('non-equivalent spec, inputs, executor or budgets remain visible and are excluded from lift', () => {
    const baseline = run('baseline', { kind: 'baseline' }), template = run('template');
    template.inputsHash = 'different-inputs';
    template.workflow.policy.maxCalls = 50;
    template.targetHash = 'changed-target';
    const report = summarizeBenchmark([{ id: 'invalid', baseline, template }]);
    assert.equal(report.comparableCases, 0);
    assert.equal(report.excludedCases, 1);
    assert.equal(report.comparison.successRateDelta, null);
    assert.equal(report.arms.template.runs, 1);
    assert.ok(report.cases[0].comparison.reasons.some(reason => reason.includes('inputsHash')));
    assert.ok(report.cases[0].comparison.reasons.some(reason => reason.includes('target')));
    assert.ok(report.cases[0].comparison.reasons.some(reason => reason.includes('policy')));
});

test('unknown costs remain null while observed subtotals and construction amortization are separate', () => {
    const teacher = run('teacher', { kind: 'teacher', cost: 10 });
    const incomplete = summarizeBenchmark([{ id: 'unknown', baseline: run('b', { kind: 'baseline' }), template: run('t', { cost: null }) }], { teacher, amortizeUses: 5 });
    assert.equal(incomplete.arms.template.cost.totalUsd, null);
    assert.equal(incomplete.arms.template.cost.complete, false);
    assert.equal(incomplete.arms.template.cost.unknownCalls, 1);
    assert.equal(incomplete.amortization.buildCostPerUseUsd, 2);
    assert.equal(incomplete.amortization.estimatedTotalPerUseUsd, null);
    const complete = summarizeBenchmark([{ id: 'known', baseline: run('b', { kind: 'baseline' }), template: run('t', { cost: 1 }) }], { teacher, amortizeUses: 5 });
    assert.equal(complete.construction.costUsd, 10);
    assert.equal(complete.arms.template.cost.totalUsd, 1);
    assert.equal(complete.amortization.estimatedTotalPerUseUsd, 3);
});

test('identical target aliases cannot hide changed actual models or unresolved configured identity', () => {
    const baseline = run('b', { kind: 'baseline' }), template = run('t');
    baseline.attempts[0].agents[0].requestedModel = 'configured';
    template.attempts[0].agents[0].requestedModel = 'configured';
    assert.equal(summarizeBenchmark([{ id: 'alias', baseline, template }]).comparableCases, 0);
    baseline.attempts[0].agents[0].observedModel = 'actual-model-one';
    template.attempts[0].agents[0].observedModel = 'actual-model-two';
    assert.equal(summarizeBenchmark([{ id: 'alias', baseline, template }]).comparableCases, 0);
    template.attempts[0].agents[0].observedModel = 'actual-model-one';
    assert.equal(summarizeBenchmark([{ id: 'alias', baseline, template }]).comparableCases, 1);
});

test('mere runtime completion or unobserved review never counts as a successful reproduction', () => {
    const template = run('t');
    template.review.checks[0].status = 'unobserved';
    template.attempts[0].review = { passed: false };
    const report = summarizeBenchmark([{ id: 'unobserved', baseline: run('b', { kind: 'baseline' }), template }]);
    assert.equal(report.arms.template.successfulRuns, 0);
    assert.equal(report.arms.template.firstPassRuns, 0);
});

test('Skill ablation must be explicitly recorded against the same template and independent runs cannot be reused', () => {
    const pair = { id: 'ablation', baseline: run('b', { kind: 'baseline' }), template: run('t'), withoutSkills: run('a') };
    assert.equal(summarizeBenchmark([pair]).cases[0].ablation.comparable, false);
    pair.withoutSkills.ablation = 'without-skills';
    assert.equal(summarizeBenchmark([pair]).cases[0].ablation.comparable, true);
    pair.withoutSkills.template.treeHash = 'changed';
    assert.equal(summarizeBenchmark([pair]).cases[0].ablation.comparable, false);
    assert.throws(() => summarizeBenchmark([{ id: 'same-run', baseline: pair.baseline, template: pair.baseline }]), /distinct independent run/);
});

test('benchmark file resolves every named run through the authoritative loader without triggering execution', async t => {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-benchmark-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await fs.writeFile(path.join(workspace, 'experiment.json'), JSON.stringify({ cases: [{ id: 'case', baseline: 'baseline', template: 'template' }], teacher: 'teacher', amortizeUses: 10 }));
    const loaded = [];
    const result = await runBenchmark({ workspace }, 'experiment.json', { loadRun: async (_config, id) => { loaded.push(id); return run(id, { kind: id === 'baseline' ? 'baseline' : id === 'teacher' ? 'teacher' : 'trial' }); } });
    assert.equal(result.command, 'repro:benchmark');
    assert.equal(result.report.comparableCases, 1);
    assert.deepEqual(loaded, ['baseline', 'template', 'teacher']);
});

test('generic Agent provenance includes failed reviewer and extractor calls exactly once', () => {
    const template = run('t');
    const maker = template.attempts[0].agents[0];
    const failedReview = { runId: 'review', role: 'reviewer', status: 'failed', cost: { usd: 0.5 }, usage: { totalTokens: 30 }, elapsedMs: 400, toolCalls: 0, renderCalls: 0 };
    const failedExtraction = { ...failedReview, runId: 'extract', role: 'extractor', cost: null, usage: null, elapsedMs: 200 };
    template.reviewRuns = [failedReview];
    template.agentRuns = [maker, failedReview, failedExtraction];
    const report = summarizeBenchmark([{ id: 'recorded', baseline: run('b', { kind: 'baseline' }), template }]);
    const totals = report.cases[0].template.accounting;
    assert.equal(totals.calls, 3);
    assert.equal(totals.elapsedMs, 1600);
    assert.equal(totals.observedCostUsd, 2.5);
    assert.equal(totals.costUsd, null);
    assert.equal(totals.observedTokens, 130);
    assert.equal(totals.unknownCostCalls, 1);
});

test('incomplete elapsed and tool observations remain lower bounds in per-run and aggregate reports', () => {
    const template = run('t');
    template.budget = { calls: 2, elapsedMs: 1500, elapsedComplete: false,
        toolCalls: 3, toolCallsComplete: false, renderCalls: 1, renderCallsComplete: false,
        tokens: 100, usageComplete: false, costUsd: 2, costComplete: false };
    const report = summarizeBenchmark([{ id: 'partial', baseline: run('b', { kind: 'baseline' }), template }]);
    const totals = report.cases[0].template.accounting;
    assert.equal(totals.calls, 2);
    assert.equal(totals.elapsedMs, null);
    assert.equal(totals.observedElapsedMs, 1500);
    assert.equal(totals.toolCalls, null);
    assert.equal(totals.observedToolCalls, 3);
    assert.equal(totals.renderCalls, null);
    assert.equal(totals.observedRenderCalls, 1);
    assert.equal(report.arms.template.meanElapsedMs, null);
    assert.equal(report.arms.template.unknownTimeRuns, 1);
    assert.deepEqual(report.arms.template.elapsed, { observedSubtotalMs: 1500, totalMs: null, complete: false, unknownCalls: 1 });
    assert.equal(report.arms.template.tools.totalCalls, null);
    assert.equal(report.arms.template.renders.totalCalls, null);
});

test('native tool counts remain known while unmanaged shell renders stay unobservable', () => {
    const template = run('t');
    Object.assign(template.attempts[0].agents[0], { toolCalls: 4, renderCalls: 0, observability: { renderCalls: 'unobservable-native-shell' } });
    const report = summarizeBenchmark([{ id: 'native', baseline: run('b', { kind: 'baseline' }), template }]);
    assert.equal(report.cases[0].template.accounting.toolCalls, 4);
    assert.equal(report.cases[0].template.accounting.renderCalls, null);
    assert.equal(report.arms.template.tools.totalCalls, 4);
    assert.equal(report.arms.template.renders.observedSubtotalCalls, 0);
    assert.equal(report.arms.template.renders.complete, false);
});

function generationRun(id, { baseline = false, enforced = false } = {}) {
    const value = run(id, { kind: baseline ? 'baseline' : 'trial' });
    delete value.template;
    value.generationMode = 'method-generation';
    value.method = { id: 'method@1', treeHash: 'method-hash' };
    value.methodApplied = !baseline;
    value.generation = { schema: 'video-remake.generation-baseline@1', generationMode: 'method-generation', startingPoint: 'blank-scaffold',
        identity: { assetLockHash: 'assets', scaffoldHash: 'blank', toolProfileHash: 'tools' }, isolation: { level: 'context-only' } };
    value.generation.baselineHash = jsonHash(value.generation);
    value.generationAudit = { schema: 'video-remake.generation-audit@1', baselineHash: value.generation.baselineHash,
        passed: true, processVerified: true, strictIndependent: enforced, checks: [{ id: 'fixture', passed: true }],
        isolation: enforced ? { readIsolation: 'enforced', probe: { id: 'probe', verified: true, outsideReadDenied: true, outsideWriteDenied: true, symlinkEscapeDenied: true, networkRestricted: true } } : {} };
    value.spec = { schema: 'video-remake.reproduction@2', title: 'Test', objective: 'Match reference', preserve: ['layout'], replace: [], inputs: {},
        acceptance: { media: { file: 'outputs/final.mp4', width: 160, height: 120, durationSec: 2, audio: 'forbidden' }, review: [{ id: 'layout', description: 'Match layout', modality: 'visual' }] } };
    value.technical = { passed: true, artifact: { sha256: 'a'.repeat(64) }, evidenceManifestSha256: 'b'.repeat(64), evidence: { items: [
        { id: 'subject:frame:0', source: 'subject', kind: 'frame', sampleTimeSec: 0 },
        { id: 'reference:frame:0', source: 'reference', kind: 'frame', sampleTimeSec: 0 },
    ] } };
    value.review = { schema: 'video-remake.reproduction-review@2', protocolVersion: REVIEW_PROTOCOL.version, reviewer: 'model:consensus',
        artifactSha256: value.technical.artifact.sha256, evidenceManifestSha256: value.technical.evidenceManifestSha256,
        checks: [{ id: 'layout', status: 'pass', observationStatus: 'observed', modalities: ['visual'], notes: 'Observed matching layout.', evidenceIds: ['subject:frame:0', 'reference:frame:0'] }] };
    value.reviewSource = { kind: 'model', samples: 2, requestedModel: 'reviewer', protocol: REVIEW_PROTOCOL.version, implementationHash: 'implementation-hash',
        votes: [1, 2].map(i => ({ runId: `${id}-review-${i}`, review: structuredClone(value.review) })) };
    return value;
}

test('blank-generation comparison separates process evidence from enforced independence and replay', () => {
    const baseline = generationRun('b', { baseline: true }), template = generationRun('t');
    let report = summarizeBenchmark([{ id: 'method', baseline, template }]);
    assert.equal(report.comparableCases, 1);
    assert.equal(report.arms.template.processGenerationSuccessRate, 1);
    assert.equal(report.arms.template.independentSuccessRate, 0);
    report = summarizeBenchmark([{ id: 'enforced', baseline: generationRun('b2', { baseline: true, enforced: true }), template: generationRun('t2', { enforced: true }) }]);
    assert.equal(report.arms.template.independentSuccessRate, 1);
    report = summarizeBenchmark([{ id: 'replay', baseline: run('old', { kind: 'baseline' }), template }]);
    assert.equal(report.comparableCases, 0);
    assert.ok(report.cases[0].comparison.reasons.some(reason => reason.includes('generation modes')));
});

test('method metrics reject single/human votes and non-equivalent tool, asset or review configurations', () => {
    const baseline = generationRun('b', { baseline: true }), template = generationRun('t');
    for (const mutate of [value => { value.reviewSource.kind = 'human'; }, value => { value.reviewSource.votes.pop(); },
        value => { value.reviewSource.votes[1].review.artifactSha256 = 'c'.repeat(64); }]) {
        const candidate = structuredClone(template);
        mutate(candidate);
        assert.equal(summarizeBenchmark([{ id: 'invalid', baseline, template: candidate }]).arms.template.successRate, 0);
    }
    for (const mutate of [value => { value.generation.identity.assetLockHash = 'other'; }, value => { delete value.generation.identity.toolProfileHash; },
        value => { value.reviewSource.implementationHash = 'changed'; }, value => { value.reviewSource.requestedModel = 'different'; }]) {
        const candidate = structuredClone(template);
        mutate(candidate);
        assert.equal(summarizeBenchmark([{ id: 'mismatched', baseline, template: candidate }]).comparableCases, 0);
    }
});

function stagedIdentity(value, protocol = 'staged') {
    Object.assign(value, { schema: 'video-remake.reproduction-run@3', stageState: { stages: [], currentStage: 'review' },
        executionProtocolHash: protocol, stagePolicyHash: `${protocol}-policy`, feedbackMode: 'independent',
        checkerProfileHash: 'same-checkers', budgetPolicyHash: 'same-budget', baseScaffoldHash: 'same-base', executionOverlayHash: `${protocol}-overlay` });
    value.stageExecutions = [{}, {}, {}]; value.stageSubmissions = [{}, {}];
    value.finalSubmissions = [value.attempts[0]];
    return value;
}

test('staged method comparisons require execution, feedback, checker and budget identities', () => {
    const baseline = stagedIdentity(generationRun('b', { baseline: true })), template = stagedIdentity(generationRun('t'));
    assert.equal(summarizeBenchmark([{ id: 'same', baseline, template }]).comparableCases, 1);
    for (const field of ['executionProtocolHash', 'stagePolicyHash', 'feedbackMode', 'checkerProfileHash', 'budgetPolicyHash']) {
        const changed = structuredClone(template); changed[field] = 'different';
        const report = summarizeBenchmark([{ id: field, baseline, template: changed }]);
        assert.equal(report.comparableCases, 0, field);
        assert.ok(report.cases[0].comparison.reasons.some(reason => reason.includes(field)));
    }
    const unknown = structuredClone(template); delete unknown.checkerProfileHash;
    assert.equal(summarizeBenchmark([{ id: 'unknown', baseline, template: unknown }]).comparableCases, 0);
    const metric = summarizeBenchmark([{ id: 'same', baseline, template }]).cases[0].template;
    assert.equal(metric.attempts, 1); assert.equal(metric.stageExecutions, 3); assert.equal(metric.finalSubmissions, 1);
});

test('explicit workflow ablation holds method, base scaffold, tools and budgets fixed', () => {
    const baseline = stagedIdentity(generationRun('old'), 'whole-project'), template = stagedIdentity(generationRun('staged'));
    baseline.generation.identity.scaffoldHash = 'old-with-overlay'; template.generation.identity.scaffoldHash = 'new-with-overlay';
    const entry = { id: 'flow', comparisonType: 'workflow-ablation', baseline, template };
    let report = summarizeBenchmark([entry]);
    assert.equal(report.comparableCases, 1);
    assert.match(report.comparisonMeaning, /not a method recipe lift/);
    for (const mutate of [run => { run.method.treeHash = 'new-method'; }, run => { run.baseScaffoldHash = 'different'; },
        run => { run.generation.identity.assetLockHash = 'other-assets'; }, run => { run.generation.identity.toolProfileHash = 'other-tools'; },
        run => { run.workflow.policy.maxCalls += 1; }, run => { run.assisted = true; }]) {
        const changed = structuredClone(template); mutate(changed);
        assert.equal(summarizeBenchmark([{ ...entry, template: changed }]).comparableCases, 0);
    }
    report = summarizeBenchmark([{ ...entry, comparisonType: 'method-presence' }]);
    assert.equal(report.comparableCases, 0);
});

test('method-version comparison isolates new recipe contents and does not mix experiment types', () => {
    const baseline = stagedIdentity(generationRun('v1')), template = stagedIdentity(generationRun('v2'));
    template.method = { id: 'method@2', treeHash: 'new-method-hash' };
    const entry = { id: 'version', comparisonType: 'method-version', baseline, template };
    assert.equal(summarizeBenchmark([entry]).comparableCases, 1);
    const changed = structuredClone(template); changed.executionProtocolHash = 'other';
    assert.equal(summarizeBenchmark([{ ...entry, template: changed }]).comparableCases, 0);
    assert.throws(() => summarizeBenchmark([entry, { id: 'presence', baseline: generationRun('b', { baseline: true }), template: generationRun('t') }]), /one explicit comparison type/);
});

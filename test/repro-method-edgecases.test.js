import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, hash, read, write } from './fixtures/repro-fixture.js';
import { scaffoldMethodRecipe, freezeMethodRecipe, freezeAssetPack } from '../src/repro/method-store.js';
import { summarizeBenchmark } from '../src/repro/benchmark.js';
import { snapshotProject } from '../src/repro/project.js';
import { storage } from '../src/repro/store.js';

async function setup(t, { assets = false } = {}) {
    const f = await fixture(t);
    const workflow = await read(f.workspace, 'reproduction-workflow.json'); workflow.policy.reviewSamples = 2;
    await write(f.workspace, 'reproduction-workflow.json', workflow);
    if (assets) {
        const directory = path.join(f.workspace, 'generic-source');
        await write(directory, 'pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhuQAAAAASUVORK5CYII=', 'base64'));
        await write(directory, 'asset-pack.json', { schema: 'video-remake.asset-pack@1', title: 'Generic fixture texture',
            contentReview: { reviewer: 'fixture', notes: 'A single generic texture.', targetScene: false, targetTimeline: false },
            assets: [{ id: 'pixel', file: 'pixel.png', type: 'texture', scope: 'generic', source: 'Fixture author', license: 'CC0-1.0' }] });
        f.pack = await freezeAssetPack(f.config, { directory, name: 'generic', version: 1 });
    }
    const directory = path.join(f.workspace, 'method-source');
    await scaffoldMethodRecipe(directory, { title: 'Generation method fixture', assetPacks: f.pack ? [f.pack.id] : [],
        contentReview: { reviewer: 'fixture', notes: 'Reviewed method prose only.', containsTargetImplementation: false } });
    f.method = await freezeMethodRecipe(f.config, { directory, name: 'edge-method', version: 1 });
    const original = f.deps.runProjectAgent;
    f.executorCalls = 0;
    f.deps.runProjectAgent = async (config, options) => {
        if (options.role !== 'executor') return original(config, options);
        f.executorCalls += 1; f.calls.push(options);
        await write(options.workspace, 'src/index.html', `<!doctype html><html><body><main>Generated own composition ${f.executorCalls}</main></body></html>`);
        const manifest = await read(options.workspace, 'reproduction.json');
        await write(options.workspace, 'reproduction.json', { ...manifest, status: 'ready' });
        await write(options.workspace, 'outputs/final.mp4', `generated ${f.executorCalls}`);
        return { runId: `executor-${f.executorCalls}`, status: 'completed', role: 'executor', target: 'small', targetHash: hash('small'),
            requestedModel: f.model, observedModel: f.model, harness: 'fixture-harness', contextMode: 'explicit-context',
            usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, costUsd: 0.001, toolCalls: 2, renderCalls: 1 };
    };
    f.generate = (slug = 'method-edge', options = {}) => f.execute('generate', f.method.id,
        { as: slug, spec: 'spec.json', ref: 'youtube-fixture', inputs: 'student-inputs.json', run: true, ...options });
    return f;
}

test('one malformed review is retained and charged before two valid independent votes complete', async t => {
    const f = await setup(t); await f.generate();
    const original = f.deps.runProjectAgent; let reviewers = 0;
    f.deps.runProjectAgent = async (config, options) => {
        const result = await original(config, options);
        if (options.role === 'reviewer' && ++reviewers === 1) await write(options.workspace, 'REVIEW.json', { passed: true });
        return result;
    };
    const result = await f.execute('judge', 'method-edge');
    const state = await f.load('method-edge');
    assert.equal(result.run.status, 'passed'); assert.equal(reviewers, 3);
    assert.equal(state.budget.calls, 4, 'maker plus rejected report plus two valid reviews');
    assert.equal(state.budget.tokens, 160);
    assert.equal(state.reviewFailures.length, 1);
    assert.equal(state.reviewFailures[0].vote, 1); assert.equal(state.reviewFailures[0].retry, 0);
    assert.deepEqual(await read(state.reviewFailures[0].workspace, 'REVIEW.json'), { passed: true });
    assert.equal(state.reviewSource.votes.length, 2);
    assert.ok(state.reviewSource.votes.every(vote => vote.runId !== state.reviewFailures[0].runId));
    assert.equal(new Set(f.calls.filter(call => call.role === 'reviewer').map(call => call.workspace)).size, 3);
    const cached = await f.execute('judge', 'method-edge'); assert.equal(cached.cached, true); assert.equal(reviewers, 3);
});

test('persistent invalid reviews stop at the bounded retry and cannot acquire acceptance', async t => {
    const f = await setup(t); await f.generate();
    const original = f.deps.runProjectAgent; let reviewers = 0;
    f.deps.runProjectAgent = async (config, options) => {
        const result = await original(config, options);
        if (options.role === 'reviewer') { reviewers += 1; await write(options.workspace, 'REVIEW.json', { passed: true }); }
        return result;
    };
    await assert.rejects(f.execute('judge', 'method-edge'), error => error.reviewReportInvalid === true);
    const state = await f.load('method-edge');
    assert.equal(reviewers, 2); assert.equal(state.budget.calls, 3);
    assert.equal(state.status, 'review-incomplete'); assert.equal(state.review, undefined);
    assert.equal(state.reviewFailures.length, 2);
    assert.deepEqual(state.reviewFailures.map(item => item.retry), [0, 1]);
    assert.equal(state.reviewSource, undefined);
    assert.ok(!state.reviewSession?.votes?.length);
    await assert.rejects(f.execute('publish', f.method.id, { production: 'method-edge' }), { code: 'REPRO_NOT_READY' });
    assert.equal(reviewers, 2, 'publication never starts another reviewer');
});

test('a valid unfavorable review is not retried or discarded in favor of a later desired verdict', async t => {
    const f = await setup(t); await f.generate(); f.reviewStatus = 'fail';
    const result = await f.execute('judge', 'method-edge');
    const state = await f.load('method-edge');
    assert.equal(result.run.status, 'needs-revision'); assert.equal(state.budget.calls, 3);
    assert.equal(state.reviewSource.votes.length, 2);
    assert.ok(state.reviewSource.votes.every(vote => vote.review.checks[0].status === 'fail'));
    assert.ok(!state.reviewFailures?.length);
    f.reviewStatus = 'pass';
    const cached = await f.execute('judge', 'method-edge'); assert.equal(cached.cached, true);
    assert.equal(cached.run.status, 'needs-revision');
    assert.equal(f.calls.filter(call => call.role === 'reviewer').length, 2);
});

test('failed asset verification during retry preserves the active project and prior attempt without launching a model', async t => {
    const f = await setup(t, { assets: true }); await f.generate();
    const before = await f.load('method-edge');
    const snapshot = await snapshotProject(before.workspace, { includeInputs: true, includeOutputs: true });
    await fs.appendFile(path.join(f.pack.root, 'pixel.png'), 'corrupt frozen pack');
    await assert.rejects(f.execute('retry', 'method-edge'), { code: 'REPRO_CHANGED' });
    const after = await f.load('method-edge');
    assert.equal(after.attempts.length, before.attempts.length);
    assert.equal(after.generation.baselineHash, before.generation.baselineHash);
    assert.equal((await snapshotProject(after.workspace, { includeInputs: true, includeOutputs: true })).treeHash, snapshot.treeHash);
    assert.equal(f.executorCalls, 1);
    await assert.rejects(fs.access(path.join(storage(f.config), 'runs', before.id, 'attempt-1/project')), { code: 'ENOENT' });
    const siblings = await fs.readdir(path.dirname(before.workspace));
    assert.ok(!siblings.some(file => file.startsWith(`${path.basename(before.workspace)}.prepared-`)), 'staging debris is removed');
});

test('real baseline and treatment ledgers preserve equal tools/assets and are comparable only while their identities match', async t => {
    const f = await setup(t, { assets: true });
    await f.generate('without-method', { baseline: true }); await f.execute('judge', 'without-method');
    await f.generate('with-method'); await f.execute('judge', 'with-method');
    const baseline = await f.load('without-method'), treatment = await f.load('with-method');
    assert.equal(baseline.kind, 'baseline'); assert.equal(baseline.methodApplied, false);
    assert.equal(treatment.kind, 'trial'); assert.equal(treatment.methodApplied, true);
    assert.deepEqual(baseline.method, treatment.method);
    for (const key of ['assetLockHash', 'scaffoldHash', 'toolProfileHash']) assert.equal(baseline.generation.identity[key], treatment.generation.identity[key], key);
    assert.equal(baseline.generation.identity.methodApplied, false); assert.equal(treatment.generation.identity.methodApplied, true);
    await assert.rejects(fs.access(path.join(baseline.workspace, 'method')), { code: 'ENOENT' });
    await fs.access(path.join(treatment.workspace, 'method/recipe.json'));
    const paired = summarizeBenchmark([{ id: 'same-task', baseline, template: treatment }]);
    assert.equal(paired.comparableCases, 1, JSON.stringify(paired.cases[0].comparison.reasons));
    assert.equal(paired.arms.baseline.successfulRuns, 1); assert.equal(paired.arms.template.successfulRuns, 1);
    const changed = structuredClone(treatment); changed.generation.identity.toolProfileHash = hash('other toolkit');
    const excluded = summarizeBenchmark([{ id: 'changed-tool', baseline, template: changed }]);
    assert.equal(excluded.comparableCases, 0);
    assert.ok(excluded.cases[0].comparison.reasons.includes('Different generation toolProfileHash.'));
});

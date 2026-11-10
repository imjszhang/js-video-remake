import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, teacher, template, hash, read, write } from './fixtures/repro-fixture.js';
import { executeRepro } from '../src/repro/workflow.js';

test('frozen spec, workflow and input ledger changes are rejected independently of mutable project content', async t => {
    const f = await fixture(t);
    await f.init();
    const state = await f.load(teacher);
    const relative = `repro/runs/${state.id}/state.json`;
    const original = await read(f.agentHome, relative);
    for (const mutate of [
        value => { value.spec.acceptance.media.width = 1; },
        value => { value.workflow.roles.teacher = 'different-target'; },
        value => { value.inputs.title.value = 'Changed input'; },
    ]) {
        const changed = structuredClone(original);
        mutate(changed);
        await write(f.agentHome, relative, changed);
        await assert.rejects(f.execute('status', teacher), { code: 'REPRO_INVALID' });
    }
    await write(f.agentHome, relative, original);
    assert.equal((await f.execute('status', teacher)).run.spec.title, state.spec.title);
});

test('agent cannot pass by modifying public acceptance or frozen text/file input', async t => {
    for (const relative of ['task/acceptance.json', 'inputs/values.json', 'inputs/files/logo/logo.svg']) {
        const f = await fixture(t, { fileInput: true });
        f.mutate = workspace => write(workspace, relative, relative.endsWith('.json') ? {} : 'changed input');
        const result = await f.make();
        assert.equal(result.run.status, 'needs-revision');
        assert.equal(result.run.technical.passed, false);
        assert.equal(result.run.technical.checks.find(check => check.id === `frozen:${relative}`).passed, false);
        await assert.rejects(f.execute('judge', teacher), { code: 'REPRO_NOT_READY' });
    }
});

test('changed reference and stale media invalidate acceptance before extraction or publication', async t => {
    const f = await fixture(t);
    await f.candidate();
    await f.acceptTrial();
    const trial = await f.load('student-demo');
    await write(trial.workspace, 'outputs/final.mp4', 'new media after approval');
    await f.execute('check', 'student-demo');
    await assert.rejects(f.execute('publish', template, { production: 'student-demo' }), { code: 'REPRO_NOT_READY' });
    const updated = await f.load('student-demo');
    assert.equal(updated.review, undefined);
    const teacherState = await f.load(teacher);
    await fs.writeFile(teacherState.references[0].source.videoPath, 'changed reference');
    await assert.rejects(f.execute('extract', teacher, { name: 'demo', version: 2 }), { code: 'REPRO_INVALID' });
});

test('tampered evidence files cannot be reused to extract or publish', async t => {
    const f = await fixture(t);
    await f.candidate();
    const state = await f.load(teacher);
    const evidence = path.join(state.technical.evidenceRoot, state.technical.evidence.items[0].path);
    await fs.chmod(evidence, 0o600);
    await fs.writeFile(evidence, 'changed frame evidence');
    await assert.rejects(f.execute('extract', teacher, { name: 'demo', version: 2 }), { code: 'REPRO_NOT_READY' });
    const failedTeacher = await f.load(teacher);
    assert.equal(failedTeacher.technical.checks.find(check => check.id === 'evidence:integrity').passed, false);
    assert.equal(failedTeacher.technical.evidence, undefined);
    await f.acceptTrial();
    const trial = await f.load('student-demo');
    const trialEvidence = path.join(trial.technical.evidenceRoot, trial.technical.evidence.items[0].path);
    await fs.chmod(trialEvidence, 0o600);
    await fs.writeFile(trialEvidence, 'changed trial evidence');
    await assert.rejects(f.execute('check', 'student-demo'), { code: 'REPRO_CHECK_FAILED' });
    await assert.rejects(f.execute('publish', template, { production: 'student-demo' }), { code: 'REPRO_NOT_READY' });
    const failedTrial = await f.load('student-demo');
    assert.equal(failedTrial.technical.checks.find(check => check.id === 'evidence:integrity').passed, false);
});

test('editing or deleting completed source invalidates its review and blocks publication', async t => {
    for (const mutation of ['edit', 'delete', 'add']) {
        const f = await fixture(t);
        await f.candidate();
        await f.acceptTrial();
        const trial = await f.load('student-demo');
        if (mutation === 'edit') await write(trial.workspace, 'src/index.html', '<html>Different approved source</html>');
        else if (mutation === 'delete') await fs.rm(path.join(trial.workspace, 'scripts/render.mjs'));
        else await write(trial.workspace, 'src/extra.js', 'console.log("unexecuted code");');
        await assert.rejects(f.execute('check', 'student-demo'), { code: 'REPRO_CHECK_FAILED' });
        const invalidated = await f.load('student-demo');
        assert.equal(invalidated.technical.checks.find(check => check.id === 'source:checkpoint').passed, false);
        assert.equal(invalidated.review, undefined);
        await assert.rejects(f.execute('publish', template, { production: 'student-demo' }), { code: 'REPRO_NOT_READY' });
        await assert.rejects(fs.access(path.join(f.workspace, 'reproductions/releases/demo/v1.json')), { code: 'ENOENT' });
    }
});

test('a completed execution without its source snapshot fails closed despite an older checkpoint', async t => {
    const f = await fixture(t);
    await f.make();
    await f.execute('judge', teacher);
    const state = await f.load(teacher);
    const attempt = state.attempts.at(-1);
    assert.ok(attempt.sourceSnapshot?.treeHash);
    attempt.checkpoint = structuredClone(attempt.sourceSnapshot);
    delete attempt.sourceSnapshot;
    await write(f.agentHome, `repro/runs/${state.id}/state.json`, state);
    await assert.rejects(f.execute('check', teacher), { code: 'REPRO_CHECK_FAILED' });
    const invalidated = await f.load(teacher);
    assert.equal(invalidated.technical.checks.find(check => check.id === 'source:checkpoint').passed, false);
    assert.equal(invalidated.review, undefined);
    await assert.rejects(f.execute('extract', teacher, { name: 'demo', version: 1 }), { code: 'REPRO_NOT_READY' });
});

test('malformed reviewer output retains charged usage and agent provenance without accepting the run', async t => {
    const f = await fixture(t);
    await f.make();
    const runner = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (...args) => {
        const result = await runner(...args);
        if (args[1].role === 'reviewer') await write(args[1].workspace, 'REVIEW.json', { passed: true });
        return result;
    };
    await assert.rejects(f.execute('judge', teacher), { code: 'REPRO_INVALID' });
    const state = await f.load(teacher);
    assert.equal(state.review, undefined);
    assert.notEqual(state.status, 'passed');
    assert.equal(state.budget.calls, 2);
    assert.equal(state.budget.tokens, 80);
    assert.equal(state.agentRuns.at(-1).runId, 'agent-2');
    assert.equal(state.agentRuns.at(-1).role, 'reviewer');
    assert.equal(state.agentRuns.at(-1).observedModel, f.model);
    await assert.rejects(f.execute('extract', teacher, { name: 'demo', version: 1 }), { code: 'REPRO_NOT_READY' });
});

test('saved reviews with empty criteria or forged evidence IDs cannot authorize publication', async t => {
    for (const mutation of ['empty', 'forged']) {
        const f = await fixture(t);
        await f.candidate();
        await f.acceptTrial();
        const trial = await f.load('student-demo');
        if (mutation === 'empty') trial.review.checks = [];
        else trial.review.checks[0].evidenceIds = ['subject:frame:invented', 'reference:frame:invented'];
        await write(f.agentHome, `repro/runs/${trial.id}/state.json`, trial);
        const checked = await f.execute('check', 'student-demo');
        assert.equal(checked.run.review, undefined);
        await assert.rejects(f.execute('publish', template, { production: 'student-demo' }), error => ['REPRO_INVALID', 'REPRO_NOT_READY'].includes(error.code));
        await assert.rejects(fs.access(path.join(f.workspace, 'reproductions/releases/demo/v1.json')), { code: 'ENOENT' });
    }
});

test('extraction cannot weaken the public acceptance contract', async t => {
    const f = await fixture(t);
    await f.make();
    await f.execute('judge', teacher);
    f.extractMutation = async workspace => {
        await write(workspace, 'task/acceptance.json', { media: { width: 1 }, review: [] });
    };
    await assert.rejects(f.execute('extract', teacher, { name: 'demo', version: 1 }), { code: 'REPRO_INVALID' });
});

test('cumulative call budget stops further agent requests and preserves consumed usage', async t => {
    const f = await fixture(t, { maxCalls: 1 });
    await f.make();
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.execute('judge', teacher), { code: 'REPRO_BUDGET_EXHAUSTED' });
    await assert.rejects(f.execute('retry', teacher), { code: 'REPRO_BUDGET_EXHAUSTED' });
    const state = await f.load(teacher);
    assert.equal(state.budget.calls, 1);
    assert.equal(state.budget.tokens, 40);
    assert.equal(state.budget.costUsd, 0.001);
    assert.equal(state.attempts.length, 1);
    assert.equal(f.calls.length, 1);
});

test('failed executions cannot pass using leftover media and can resume only an unchanged checkpoint', async t => {
    const f = await fixture(t);
    await f.init();
    f.fail = true;
    await assert.rejects(f.execute('teacher', teacher), { code: 'REPRO_NOT_READY' });
    const failed = await f.load(teacher);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts[0].executionCompleted, false);
    assert.ok(failed.attempts[0].checkpoint.treeHash);
    await assert.rejects(f.execute('check', teacher), { code: 'REPRO_CHECK_FAILED' });
    await assert.rejects(f.execute('judge', teacher), { code: 'REPRO_NOT_READY' });
    f.fail = false;
    const resumed = await f.execute('resume', teacher);
    assert.equal(resumed.run.status, 'external-review');
    assert.equal(resumed.run.attempts.length, 1);
    assert.equal(resumed.run.attempts[0].resumptions, 1);
    assert.equal(resumed.run.attempts[0].agents.length, 2);
    assert.equal(resumed.run.budget.calls, 2);
});

test('failed or cancelled managed renders cannot pass using media left by the model', async t => {
    for (const [code, status] of [['REPRO_RENDER_FAILED', 'failed'], ['REPRO_RENDER_CANCELLED', 'cancelled']]) {
        const f = await fixture(t, { renderProvider: 'local' });
        f.deps.renderProject = async () => {
            throw Object.assign(new Error('Incomplete managed rendering'), { code, data: { render: { provider: 'local-hyperframes', status } } });
        };
        await assert.rejects(f.make(), { code });
        const failed = await f.load(teacher);
        assert.equal(failed.attempts[0].executionCompleted, true);
        await fs.access(path.join(failed.workspace, 'outputs/final.mp4'));
        await assert.rejects(f.execute('check', teacher), { code: 'REPRO_CHECK_FAILED' });
        const checked = await f.load(teacher);
        assert.equal(checked.technical.checks.find(check => check.id === 'render:completed').passed, false);
        await assert.rejects(f.execute('judge', teacher), { code: 'REPRO_NOT_READY' });
        assert.equal(f.calls.length, 1, 'a rejected technical gate never starts a reviewer');
    }
});

test('changed checkpoints require a fresh retry and target identity stays frozen across attempts', async t => {
    const f = await fixture(t);
    await f.init();
    f.fail = true;
    await assert.rejects(f.execute('teacher', teacher, { target: 'high' }));
    const state = await f.load(teacher);
    await write(state.workspace, 'src/index.html', '<html>Manual change</html>');
    f.fail = false;
    await assert.rejects(f.execute('resume', teacher), { code: 'REPRO_NOT_READY' });
    await assert.rejects(f.execute('retry', teacher, { target: 'another' }), { code: 'REPRO_INVALID' });
    const retried = await f.execute('retry', teacher);
    assert.equal(retried.run.attempts.length, 2);
    assert.equal(retried.run.status, 'external-review');
    assert.ok(f.calls.at(-1).expectedTargetHash);
    f.targetHash = 'a'.repeat(64);
    await assert.rejects(f.execute('retry', teacher), { code: 'CONFIG_CHANGED' });
});

test('a method imports as unverified without original runtime state or receipts', async t => {
    const f = await fixture(t);
    await f.make(); await f.execute('judge', teacher);
    await f.execute('extract', teacher, { name: 'demo', version: 1 });
    const exported = await f.execute('export', template, { to: 'detached/template' });
    const other = path.join(f.directory, 'fresh-host');
    await fs.mkdir(other);
    const otherConfig = { workspace: other, env: { VIDEO_REMAKE_AGENT_HOME: path.join(f.directory, 'fresh-agent-state') } };
    await fs.rm(f.agentHome, { recursive: true, force: true });
    const imported = await executeRepro(otherConfig, 'import', exported.root, { name: 'copied', version: 1 });
    assert.equal(imported.name, 'copied');
    assert.equal(imported.status, 'candidate');
    assert.equal(imported.provenance.verification, 'unverified');
    assert.equal(imported.provenance.importedTreeHash, exported.treeHash);
    await assert.rejects(fs.access(path.join(other, 'reproductions/releases/copied/v1.json')), { code: 'ENOENT' });
});

test('method revisions retain all development inputs and reference lineage', async t => {
    const f = await fixture(t);
    const workflow = await read(f.workspace, 'reproduction-workflow.json'); workflow.policy.reviewSamples = 2;
    await write(f.workspace, 'reproduction-workflow.json', workflow);
    const original = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (config, options) => {
        if (options.role !== 'executor') return original(config, options);
        f.calls.push(options);
        const inputs = await read(options.workspace, 'inputs/values.json');
        await write(options.workspace, 'src/index.html', `<html><body><main>Generated composition for ${inputs.title}</main></body></html>`);
        const manifest = await read(options.workspace, 'reproduction.json');
        await write(options.workspace, 'reproduction.json', { ...manifest, status: 'ready' });
        await write(options.workspace, 'outputs/final.mp4', `Candidate ${inputs.title}`);
        return { runId: `agent-${f.calls.length}`, status: 'completed', role: 'executor', target: 'small', targetHash: hash('small'),
            requestedModel: f.model, observedModel: f.model, harness: 'fixture-harness', contextMode: 'explicit-context',
            usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, costUsd: 0.001, toolCalls: 2, renderCalls: 1 };
    };
    await f.make(); await f.execute('judge', teacher);
    await f.execute('extract', teacher, { name: 'demo', version: 1 });
    const generate = (version, slug, inputs) => f.execute('generate', `demo@${version}`, { as: slug, spec: 'spec.json', ref: 'youtube-fixture', inputs, run: true });
    await generate(1, 'first-feedback', 'student-inputs.json');
    f.reviewStatus = 'fail'; await f.execute('judge', 'first-feedback');
    const first = await f.load('first-feedback');
    await f.execute('extract', teacher, { name: 'demo', version: 2, feedback: 'first-feedback' });
    await write(f.workspace, 'second-feedback.json', { title: 'Second development case' });
    await generate(2, 'second-feedback', 'second-feedback.json');
    await f.execute('judge', 'second-feedback');
    const second = await f.load('second-feedback');
    await f.execute('extract', teacher, { name: 'demo', version: 3, feedback: 'second-feedback' });
    const record = await read(f.workspace, 'reproductions/methods/demo/v3/method-record.json');
    assert.ok(record.provenance.developmentInputs.includes(first.inputsHash), 'ancestor development inputs remain visible');
    assert.ok(record.provenance.developmentInputs.includes(second.inputsHash));
    assert.ok(record.provenance.references.some(ref => ref.sha256 === first.references[0].source.sha256));
    assert.equal(record.provenance.feedback.runId, second.id);
    f.reviewStatus = 'pass';
    await generate(3, 'reused-development', 'student-inputs.json');
    await f.execute('judge', 'reused-development');
    await assert.rejects(f.execute('publish', 'demo@3', { production: 'reused-development' }), { code: 'REPRO_NOT_READY' });
});

test('a historical exported template can explicitly replay with local bindings on a host without archive access', async t => {
    const f = await fixture(t);
    await f.candidate();
    const exported = await f.execute('export', template, { to: 'detached/template' });
    const other = path.join(f.directory, 'fresh-host');
    await fs.mkdir(other);
    const catalogPath = await write(other, 'catalog.json', { version: 1, references: [], productions: [] });
    const original = (await f.load(teacher)).references[0].source.videoPath;
    await write(other, 'assets/reference.mp4', await fs.readFile(original));
    await write(other, 'bindings.json', { 'youtube-fixture': 'assets/reference.mp4' });
    await write(other, 'fresh-inputs.json', { title: 'Fresh host input' });
    await write(other, 'reproduction-workflow.json', { schemaVersion: 1, roles: { teacher: 'high', extractor: 'high', executor: 'small', reviewer: 'reviewer' }, policy: { renderProvider: 'agent' } });
    const config = { workspace: other, catalogPath, assetRoot: other, env: { VIDEO_REMAKE_AGENT_HOME: path.join(f.directory, 'fresh-agent-state') } };
    const history = path.join(other, 'reproductions/templates/demo/v1');
    await fs.mkdir(path.dirname(history), { recursive: true });
    await fs.cp(exported.root, history, { recursive: true });
    const trial = await executeRepro(config, 'replay', template, { as: 'fresh-trial', run: true, inputs: 'fresh-inputs.json', references: 'bindings.json' }, f.deps);
    assert.equal(trial.run.status, 'external-review');
    const reviewed = await executeRepro(config, 'judge', 'fresh-trial', {}, f.deps);
    assert.equal(reviewed.run.status, 'passed');
    assert.equal(reviewed.run.generationMode, 'project-replay');
    await assert.rejects(executeRepro(config, 'publish', template, { production: 'fresh-trial' }, f.deps), { code: 'REPRO_NOT_READY' });
});

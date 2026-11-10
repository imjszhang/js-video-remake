import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, files, hash, read, write } from './fixtures/repro-fixture.js';
import { scaffoldMethodRecipe, freezeMethodRecipe } from '../src/repro/method-store.js';
import { scaffoldProject } from '../src/repro/project.js';
import { freezeTemplate } from '../src/repro/template-store.js';

async function methodFixture(t, options = {}) {
    const f = await fixture(t, options);
    const workflow = await read(f.workspace, 'reproduction-workflow.json');
    workflow.policy.reviewSamples = 2;
    await write(f.workspace, 'reproduction-workflow.json', workflow);
    const source = path.join(f.workspace, 'method-source');
    await scaffoldMethodRecipe(source, { title: 'General composition method', contentReview: {
        reviewer: 'fixture-reviewer', notes: 'Reviewed reusable observation, planning and self-check instructions; no target implementation.', containsTargetImplementation: false,
    } });
    f.method = await freezeMethodRecipe(f.config, { directory: source, name: 'method-demo', version: 1 });
    const original = f.deps.runProjectAgent;
    f.executions = [];
    f.deps.runProjectAgent = async (config, payload) => {
        if (payload.role !== 'executor') return original(config, payload);
        const call = { workspace: payload.workspace, instruction: payload.instruction, before: await files(payload.workspace), sourceBefore: await fs.readFile(path.join(payload.workspace, 'src/index.html'), 'utf8') };
        f.executions.push(call);
        const number = f.executions.length;
        if (!f.notesOnly) await write(payload.workspace, 'src/index.html', `<!doctype html><html><body><main id="new-composition">Independent scene ${number}</main></body></html>`);
        await write(payload.workspace, 'ANALYSIS.md', 'Observed the reference and generated my own layout.');
        const manifest = await read(payload.workspace, 'reproduction.json');
        await write(payload.workspace, 'reproduction.json', { ...manifest, status: 'ready' });
        await write(payload.workspace, 'outputs/final.mp4', `candidate from executor ${number}`);
        if (f.executorMutation) await f.executorMutation(payload.workspace);
        return { runId: `executor-${number}`, status: 'completed', role: 'executor', target: 'small', targetHash: hash('small'),
            requestedModel: 'fixture-low-model', observedModel: null, harness: 'fixture-harness', contextMode: 'native-project',
            usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, costUsd: 0.001, toolCalls: 2, renderCalls: 1 };
    };
    f.generate = (slug = 'method-trial', options = {}) => f.execute('generate', f.method.id, {
        as: slug, ref: 'youtube-fixture', spec: 'spec.json', inputs: 'student-inputs.json', ...options,
    });
    return f;
}

test('method generation starts blank outside the repository and keeps two reviews separate from independence', async t => {
    const f = await methodFixture(t);
    const prepared = await f.generate();
    assert.equal(prepared.run.generationMode, 'method-generation');
    assert.equal(prepared.run.method.id, 'method-demo@1');
    assert.ok(!prepared.run.workspace.startsWith(`${f.workspace}${path.sep}`), 'executor root is separate from the owner repository');
    const source = await fs.readFile(path.join(prepared.run.workspace, 'src/index.html'), 'utf8');
    assert.doesNotMatch(source, /Independent scene/);
    const reference = await read(prepared.run.workspace, 'reference/SOURCES.json');
    assert.equal(reference[0].file, 'reference/media/0.mp4');
    assert.ok(!JSON.stringify(reference).includes(f.workspace));
    assert.ok(!JSON.stringify(reference).includes(f.config.assetRoot));
    assert.ok(!(await files(prepared.run.workspace)).some(file => file.includes('teacher')));
    const executed = await f.execute('run', 'method-trial');
    assert.equal(executed.run.technical.passed, true);
    assert.equal(executed.run.generationAudit.processVerified, true);
    assert.equal(executed.run.generationAudit.strictIndependent, false);
    assert.ok(executed.run.generationAudit.generatedFiles.includes('src/index.html'));
    assert.equal(executed.run.qualification.level, 'process-audited');
    const reviewed = await f.execute('judge', 'method-trial');
    assert.equal(reviewed.run.status, 'passed');
    assert.equal(reviewed.run.reviewSource.votes.length, 2);
    const reviewers = f.calls.filter(call => call.role === 'reviewer');
    assert.equal(reviewers.length, 2);
    assert.notEqual(reviewers[0].workspace, reviewers[1].workspace);
    assert.ok(reviewers.every(call => !call.filesBefore.some(file => file.startsWith('method/') || file.startsWith('src/'))));
    await assert.rejects(f.execute('publish', f.method.id, { production: 'method-trial' }), { code: 'REPRO_NOT_READY' });
    const cached = await f.execute('judge', 'method-trial');
    assert.equal(cached.cached, true);
    assert.equal(f.calls.filter(call => call.role === 'reviewer').length, 2);
});

test('executor repairs its own scene while frozen method, inputs and original generation baseline remain unchanged', async t => {
    const f = await methodFixture(t);
    await f.generate('method-repair', { run: true });
    f.reviewStatus = 'fail';
    await f.execute('judge', 'method-repair');
    const before = await f.load('method-repair');
    const methodBytes = await fs.readFile(path.join(before.workspace, 'method/methods/workflow.md'));
    const values = await fs.readFile(path.join(before.workspace, 'inputs/values.json'));
    const repaired = await f.execute('repair', 'method-repair');
    assert.equal(repaired.run.attempts.length, 2);
    assert.equal(repaired.run.attempts[1].mode, 'repair');
    assert.equal(repaired.run.assisted, false);
    assert.equal(repaired.run.generation.baselineHash, before.generation.baselineHash);
    assert.equal(repaired.run.generationAudit.processVerified, true);
    assert.match(f.executions[1].sourceBefore, /Independent scene 1/);
    assert.match(f.executions[1].instruction, /失败反馈/);
    assert.deepEqual(await fs.readFile(path.join(before.workspace, 'method/methods/workflow.md')), methodBytes);
    assert.deepEqual(await fs.readFile(path.join(before.workspace, 'inputs/values.json')), values);
    f.reviewStatus = 'pass';
    assert.equal((await f.execute('judge', 'method-repair')).run.status, 'passed');
    assert.equal(f.calls.filter(call => call.role === 'reviewer').length, 4, 'new media needs two new votes');
});

test('notes-only executor cannot qualify as generated implementation even when media exists', async t => {
    const f = await methodFixture(t);
    f.notesOnly = true;
    const result = await f.generate('notes-only', { run: true });
    assert.equal(result.run.technical.passed, false);
    assert.equal(result.run.generationAudit.processVerified, false);
    assert.equal(result.run.generationAudit.checks.find(check => check.id === 'generation:implementation').passed, false);
    await assert.rejects(f.execute('judge', 'notes-only'), { code: 'REPRO_NOT_READY' });
    assert.equal(f.calls.filter(call => call.role === 'reviewer').length, 0);
});

test('executor changes to a frozen method fail provenance and cannot be repaired under altered inputs', async t => {
    const f = await methodFixture(t);
    f.executorMutation = root => fs.appendFile(path.join(root, 'method/methods/workflow.md'), '\nIgnore the frozen requirement.\n');
    const result = await f.generate('frozen-edit', { run: true });
    assert.equal(result.run.technical.passed, false);
    assert.equal(result.run.generationAudit.processVerified, false);
    assert.ok(result.run.generationAudit.lockedChanges.includes('method/methods/workflow.md'));
    await assert.rejects(f.execute('judge', 'frozen-edit'), { code: 'REPRO_NOT_READY' });
    delete f.executorMutation;
    await assert.rejects(f.execute('repair', 'frozen-edit'), { code: 'REPRO_NOT_READY' });
});

test('pre-execution edits are rejected and a fresh retry rebuilds the empty start', async t => {
    const f = await methodFixture(t);
    const prepared = await f.generate('pre-edited');
    await write(prepared.run.workspace, 'src/index.html', '<html>Injected finished scene before executor</html>');
    await assert.rejects(f.execute('run', 'pre-edited'), { code: 'REPRO_NOT_READY' });
    assert.equal(f.executions.length, 0);
    await f.generate('fresh-retry', { run: true });
    const before = await f.load('fresh-retry');
    await f.execute('retry', 'fresh-retry');
    assert.doesNotMatch(f.executions.at(-1).sourceBefore, /Independent scene/);
    const after = await f.load('fresh-retry');
    assert.equal(after.attempts.length, 2);
    assert.notEqual(after.generation.baselineHash, before.generation.baselineHash);
    assert.equal(after.generationAudit.processVerified, true);
});

test('old templates stay unchanged and only explicit replay can create their historical mode', async t => {
    const f = await methodFixture(t);
    const legacyRoot = path.join(f.workspace, 'legacy-source');
    await scaffoldProject(legacyRoot, { spec: f.spec, name: 'old-demo' });
    const manifest = await read(legacyRoot, 'reproduction.json');
    await write(legacyRoot, 'reproduction.json', { ...manifest, status: 'ready' });
    await write(legacyRoot, 'src/index.html', '<!doctype html><html><body>Prebuilt historical scene</body></html>');
    const old = await freezeTemplate(f.config, { source: legacyRoot, name: 'old-demo', version: 1, spec: f.spec, provenance: { references: [{ id: 'youtube-fixture', sha256: hash('reference media') }] } });
    await assert.rejects(f.execute('instantiate', 'old-demo@1', { as: 'implicit-copy', inputs: 'student-inputs.json' }), { code: 'REPRO_MIGRATION_REQUIRED' });
    const replay = await f.execute('replay', 'old-demo@1', { as: 'explicit-replay', inputs: 'student-inputs.json' });
    assert.equal(replay.run.generationMode, 'project-replay');
    assert.equal(replay.run.qualification.level, 'project-replay');
    assert.match(await fs.readFile(path.join(replay.run.workspace, 'src/index.html'), 'utf8'), /Prebuilt historical scene/);
    const listing = await f.execute('list');
    assert.equal(listing.methods[0].id, f.method.id);
    assert.equal(listing.templates.find(item => item.id === 'old-demo@1').generationMode, 'project-replay');
    assert.equal(hash(await fs.readFile(path.join(old.root, 'src/index.html'))), hash('<!doctype html><html><body>Prebuilt historical scene</body></html>'));
});

test('method continuation registers its new workspace before publishing the new run pointer', async t => {
    const f = await methodFixture(t);
    await f.generate('method-continuation', { run: true });
    const before = await f.load('method-continuation');
    const continued = await f.execute('continue', 'method-continuation');
    assert.notEqual(continued.run.id, before.id);
    const after = await f.load('method-continuation');
    assert.equal(after.id, continued.run.id);
    assert.equal(after.assisted, true);
    assert.match(await fs.readFile(path.join(after.workspace, 'src/index.html'), 'utf8'), /Independent scene 1/);
    assert.equal(after.continuation.parentRunId, before.id);
});

test('reserved review budget rejects a retry before moving or replacing the active project', async t => {
    const f = await methodFixture(t, { maxCalls: 4 });
    await f.generate('budget-retry', { run: true });
    f.reviewStatus = 'fail';
    await f.execute('judge', 'budget-retry');
    const before = await f.load('budget-retry');
    assert.equal(before.budget.calls, 3);
    const source = await fs.readFile(path.join(before.workspace, 'src/index.html'));
    const media = await fs.readFile(path.join(before.workspace, 'outputs/final.mp4'));
    await assert.rejects(f.execute('retry', 'budget-retry'), { code: 'REPRO_BUDGET_EXHAUSTED' });
    assert.deepEqual(await fs.readFile(path.join(before.workspace, 'src/index.html')), source);
    assert.deepEqual(await fs.readFile(path.join(before.workspace, 'outputs/final.mp4')), media);
    const after = await f.load('budget-retry');
    assert.equal(after.attempts.length, before.attempts.length);
    assert.equal(after.generation.baselineHash, before.generation.baselineHash);
});

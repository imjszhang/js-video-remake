import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, teacher, template, files, hash, read, write } from './fixtures/repro-fixture.js';
import { loadTemplate, instantiateTemplate } from '../src/repro/template-store.js';
import { loadMethodRecipe } from '../src/repro/method-store.js';
import { validateEvidenceReport } from '../src/repro/evaluate.js';

const exec = promisify(execFile);

test('historical full projects remain replayable, reviewable and portable without acquiring independent-generation certification', { timeout: 60_000 }, async t => {
    try { await exec('ffmpeg', ['-version']); await exec('ffprobe', ['-version']); }
    catch { t.skip('ffmpeg and ffprobe required.'); return; }
    const f = await fixture(t, { realMedia: true, fileInput: true });
    const archived = await f.candidate();
    const made = await f.load(teacher);
    assert.equal(made.status, 'passed');
    await validateEvidenceReport(made.technical, { spec: made.spec });
    const projectFiles = await files(archived.path);
    for (const expected of ['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json', '.agents/skills/reproduce/SKILL.md', '.claude/skills/reproduce/SKILL.md', 'src/index.html', 'scripts/render.mjs', 'template.json']) assert.ok(projectFiles.includes(expected), expected);
    assert.ok(!projectFiles.includes('outputs/final.mp4'));
    assert.ok(!projectFiles.includes('inputs/values.json'));
    assert.ok(!projectFiles.includes('reference/SOURCES.json'));
    const trial = await f.trial();
    assert.equal(trial.run.status, 'external-review');
    assert.equal(trial.run.generationMode, 'project-replay');
    assert.equal(trial.run.attempts[0].agents.length, 1);
    assert.notEqual(trial.run.workspace, made.workspace);
    assert.notEqual(trial.run.technical.artifact.sha256, made.technical.artifact.sha256);
    const executor = f.calls.find(call => call.role === 'executor');
    assert.ok(executor.filesBefore.includes('.agents/skills/reproduce/SKILL.md'));
    assert.ok(!executor.filesBefore.includes('outputs/final.mp4'));
    assert.equal(executor.inputs.title, 'Student product');
    assert.equal(executor.inputs.logo, 'inputs/files/logo/logo.svg');
    await f.execute('judge', 'student-demo');
    await assert.rejects(f.execute('publish', template, { production: 'student-demo' }), { code: 'REPRO_NOT_READY' });
    const listed = await f.execute('list');
    assert.equal(listed.templates.find(item => item.id === template).generationMode, 'project-replay');
    assert.equal(listed.templates.find(item => item.id === template).status, 'candidate');
    const exported = await f.execute('export', template, { to: 'exports/demo' });
    assert.equal(exported.treeHash, archived.treeHash);
    const moved = path.join(f.directory, 'moved-template');
    await fs.rename(path.join(f.workspace, 'exports/demo'), moved);
    const otherHost = path.join(f.directory, 'other-host'); await fs.mkdir(otherHost);
    const otherConfig = { ...f.config, workspace: otherHost };
    assert.equal((await loadTemplate(otherConfig, moved)).treeHash, archived.treeHash);
    const destination = path.join(f.directory, 'standalone-production');
    await instantiateTemplate(otherConfig, moved, { destination, inputs: { title: 'Moved project' } });
    await exec(process.execPath, ['scripts/render.mjs'], { cwd: destination });
    await exec(process.execPath, ['scripts/check.mjs'], { cwd: destination });
    assert.equal((await read(destination, 'outputs/self-check.json')).ok, true);
});

test('teacher extraction begins with method documents and cannot carry teacher implementation into its frozen result', async t => {
    const f = await fixture(t); await f.make(); await f.execute('judge', teacher);
    const before = await fs.readFile(path.join((await f.load(teacher)).workspace, 'src/index.html'));
    const extracted = await f.execute('extract', teacher, { name: 'demo', version: 1 });
    assert.equal(extracted.method, template);
    const call = f.calls.find(call => call.role === 'extractor');
    assert.equal(call.teacherMediaPresent, false); assert.equal(call.teacherInputPresent, false);
    assert.ok(!call.filesBefore.includes('src/index.html'));
    assert.ok(!call.filesBefore.includes('package.json'));
    const recipe = await loadMethodRecipe(f.config, template);
    assert.equal(recipe.provenance.references[0].sha256.length, 64);
    const frozen = await files(recipe.root);
    assert.ok(frozen.includes('method-record.json'));
    assert.ok(!frozen.includes('src/index.html'));
    assert.deepEqual(await fs.readFile(path.join((await f.load(teacher)).workspace, 'src/index.html')), before);
});

test('human review requires current externally generated evidence and exact criterion IDs', async t => {
    const f = await fixture(t);
    await f.make();
    const checked = await f.execute('check', teacher, { evidence: true });
    const technical = checked.run.technical;
    const review = { schema: 'video-remake.reproduction-review@1', reviewer: 'Human fixture reviewer',
        artifactSha256: technical.artifact.sha256, evidenceManifestSha256: technical.evidenceManifestSha256,
        checks: [{ id: 'layout', status: 'pass', notes: 'Title anchoring matches in observed paired frames.',
            evidenceIds: ['subject:frame:0', 'youtube-fixture:frame:0'] }] };
    const accepted = await f.execute('review', teacher, { reviewValue: review });
    assert.equal(accepted.run.status, 'passed');
    assert.equal(accepted.run.reviewSource.kind, 'human');
    assert.equal(accepted.run.technical.evidenceManifestSha256, technical.evidenceManifestSha256, 'rechecking does not invalidate evidence when media is unchanged');
    await assert.rejects(f.execute('review', teacher, { reviewValue: { ...review, artifactSha256: 'a'.repeat(64) } }), { code: 'REPRO_INVALID' });
});

test('model identity and identical bytes remain recorded honestly for a legacy replay', async t => {
    const f = await fixture(t);
    f.sameMedia = true;
    await f.candidate();
    const teacherState = await f.load(teacher);
    await f.acceptTrial();
    const trialState = await f.load('student-demo');
    assert.equal(trialState.technical.artifact.sha256, teacherState.technical.artifact.sha256);
    assert.equal(trialState.attempts[0].agents[0].observedModel, teacherState.attempts[0].agents[0].observedModel);
    assert.equal(trialState.generationMode, 'project-replay');
    await assert.rejects(f.execute('publish', template, { production: 'student-demo' }), { code: 'REPRO_NOT_READY' });
});

test('unobserved review cannot approve a teacher or a trial', async t => {
    const f = await fixture(t);
    await f.make();
    f.reviewStatus = 'unobserved';
    const result = await f.execute('judge', teacher);
    assert.equal(result.run.status, 'needs-revision');
    assert.equal(result.run.review.passed, false);
    await assert.rejects(f.execute('extract', teacher, { name: 'demo', version: 1 }), { code: 'REPRO_NOT_READY' });
});

test('historical replay remains uncertified and source mutation prevents further replay', async t => {
    const f = await fixture(t);
    await f.candidate();
    await f.acceptTrial('student-demo', { inputs: 'teacher-inputs.json' });
    await assert.rejects(f.execute('publish', template, { production: 'student-demo' }), { code: 'REPRO_NOT_READY' });
    await assert.rejects(f.execute('trial', template, { as: 'new-default', inputs: 'student-inputs.json' }), { code: 'REPRO_MIGRATION_REQUIRED' });
    const before = await loadTemplate(f.config, template);
    await write(before.root, 'src/index.html', '<html>mutated template</html>');
    await assert.rejects(f.trial('another-student'), { code: 'REPRO_CHANGED' });
});

test('managed rendering runs after agent source preparation and records its separate budget/provenance', async t => {
    const f = await fixture(t);
    const workflow = await read(f.workspace, 'reproduction-workflow.json');
    workflow.policy.renderProvider = 'local';
    await write(f.workspace, 'reproduction-workflow.json', workflow);
    const runner = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (...args) => {
        const result = await runner(...args);
        if (args[1].role === 'teacher' || args[1].role === 'executor') {
            await fs.unlink(path.join(args[1].workspace, 'outputs/final.mp4'));
            result.renderCalls = 0;
        }
        return result;
    };
    let renders = 0;
    f.deps.renderProject = async (_config, options) => {
        renders += 1;
        assert.ok((await read(options.workspace, 'reproduction.json')).status === 'ready');
        await write(options.workspace, options.spec.acceptance.media.file, 'host rendered prepared source');
        return { provider: 'local-hyperframes', version: '0.8.191', status: 'completed', renderCalls: 1, elapsedMs: 1,
            artifact: { file: options.spec.acceptance.media.file, sha256: hash('host rendered prepared source') } };
    };
    const result = await f.make();
    assert.equal(result.run.technical.passed, true);
    assert.equal(result.run.status, 'external-review');
    assert.equal(result.run.budget.calls, 1);
    assert.equal(result.run.budget.renderCalls, 1);
    assert.equal(result.run.attempts[0].renders[0].provider, 'local-hyperframes');
    assert.equal(renders, 1);
    const second = await f.execute('render', teacher);
    assert.equal(second.run.budget.calls, 1, 'rerendering does not start another model');
    assert.equal(second.run.budget.renderCalls, 2);
    assert.equal(renders, 2);
});

test('two isolated reviews retain disagreement and reuse the bound result without rerolling', async t => {
    const f=await fixture(t);
    const w=await read(f.workspace,'reproduction-workflow.json');w.policy.reviewSamples=2;await write(f.workspace,'reproduction-workflow.json',w);
    await f.make();
    const original=f.deps.runProjectAgent;let reviews=0;
    f.deps.runProjectAgent=async(c,o)=>{if(o.role==='reviewer'){reviews++;f.reviewStatus=reviews===1?'pass':'fail';}return original(c,o);};
    const result=await f.execute('judge',teacher);
    assert.equal(reviews,2);assert.equal(result.run.status,'needs-revision');
    assert.equal(result.run.reviewSource.votes.length,2);
    assert.equal(result.run.reviewSource.disagreements.length,result.run.review.checks.length);
    const repeated=await f.execute('judge',teacher);assert.equal(repeated.cached,true);assert.equal(reviews,2);
    f.targetHash=hash('changed-reviewer');
    await f.execute('judge',teacher);assert.equal(reviews,4,'changed model configuration invalidates cache');
});

test('consensus resumes the missing vote after interruption rather than rerolling completed evidence',async t=>{
    const f=await fixture(t);const w=await read(f.workspace,'reproduction-workflow.json');w.policy.reviewSamples=2;await write(f.workspace,'reproduction-workflow.json',w);await f.make();
    const original=f.deps.runProjectAgent;let calls=0;
    f.deps.runProjectAgent=async(c,o)=>{if(o.role==='reviewer'&&++calls===2)throw Error('temporary unavailable');return original(c,o);};
    await assert.rejects(f.execute('judge',teacher),/temporary unavailable/);
    assert.equal((await f.load(teacher)).reviewSession.votes.length,1);
    const result=await f.execute('judge',teacher);assert.equal(calls,3);assert.equal(result.run.status,'passed');
});

test('frozen review protocol mismatch blocks model calls',async t=>{
 const f=await fixture(t);const w=await read(f.workspace,'reproduction-workflow.json');w.policy.reviewProtocolHash='0'.repeat(64);await write(f.workspace,'reproduction-workflow.json',w);await f.make();
 await assert.rejects(f.execute('judge',teacher),/冻结评审协议已改变/);assert.equal(f.calls.filter(x=>x.role==='reviewer').length,0);
});

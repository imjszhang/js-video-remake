import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureGenerationBaseline, auditGeneration, generationQualification, isolationEvidence } from '../src/repro/generation-audit.js';

async function fixture(t, isolation) {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'generation-audit-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    for (const dir of ['src', 'task', 'assets', 'reference']) await fs.mkdir(path.join(workspace, dir));
    await fs.writeFile(path.join(workspace, 'src/index.html'), '<html><body><div>Empty stage</div></body></html>');
    await fs.writeFile(path.join(workspace, 'task/spec.json'), '{"objective":"rebuild"}');
    await fs.writeFile(path.join(workspace, 'assets/font.woff2'), 'generic font');
    await fs.writeFile(path.join(workspace, 'reference/source.mp4'), 'reference only video');
    const baseline = await captureGenerationBaseline(workspace, { identity: { scaffoldHash: 'blank' }, lockedPaths: ['task', 'assets', 'reference'], isolation });
    const options = { baseline, executionCompleted: true, executionRecords: [{ runId: 'executor-1', status: 'completed' }] };
    const generate = () => fs.writeFile(path.join(workspace, 'src/scene.js'), 'export function renderScene(t) { return { subject: "person", camera: { zoom: 1 + t / 100 } }; }');
    return { workspace, baseline, options, generate };
}

test('notes-only and comment-only execution cannot be mistaken for generated implementation', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.workspace, 'ANALYSIS.md'), 'I rebuilt everything.');
    await fs.appendFile(path.join(f.workspace, 'src/index.html'), '\n<!-- changed documentation only -->');
    const audit = await auditGeneration(f.workspace, f.options);
    assert.equal(audit.processVerified, false);
    assert.deepEqual(audit.generatedFiles, []);
    assert.equal(audit.checks.find(check => check.id === 'generation:implementation').passed, false);
});

test('generated implementation is process-audited without inventing native read isolation', async t => {
    const f = await fixture(t, { readIsolation: 'enforced' });
    await f.generate();
    const audit = await auditGeneration(f.workspace, f.options);
    assert.equal(audit.passed, true);
    assert.equal(audit.strictIndependent, false);
    const state = { generationMode: 'method-generation', generation: f.baseline, generationAudit: audit };
    assert.equal(generationQualification(state).level, 'process-audited');
    state.assisted = true;
    assert.equal(generationQualification(state).processVerified, false);
    assert.equal(generationQualification(state).level, 'assisted');
});

test('locked changes, additions, assistance and missing execution attribution fail the audit', async t => {
    const f = await fixture(t);
    await f.generate();
    for (const overrides of [{ assisted: true }, { executionCompleted: false }, { executionRecords: [] }]) {
        assert.equal((await auditGeneration(f.workspace, { ...f.options, ...overrides })).passed, false);
    }
    await fs.writeFile(path.join(f.workspace, 'assets/target-scene.js'), 'hidden implementation');
    let audit = await auditGeneration(f.workspace, f.options);
    assert.deepEqual(audit.lockedChanges, ['assets/target-scene.js']);
    await fs.rm(path.join(f.workspace, 'assets/target-scene.js'));
    await fs.writeFile(path.join(f.workspace, 'task/spec.json'), '{"objective":"weakened"}');
    audit = await auditGeneration(f.workspace, f.options);
    assert.equal(audit.passed, false);
    assert.deepEqual(audit.lockedChanges, ['task/spec.json']);
});

test('baseline tampering, direct reference reuse, copying and symlink escapes are rejected', async t => {
    const f = await fixture(t);
    await f.generate();
    const changed = structuredClone(f.baseline);
    changed.lockedPaths = [];
    await assert.rejects(auditGeneration(f.workspace, { ...f.options, baseline: changed }), /baseline/);
    await fs.writeFile(path.join(f.workspace, 'src/reuse.js'), 'export const texture = "../reference/frame.png"; export const time = 100;');
    let audit = await auditGeneration(f.workspace, f.options);
    assert.equal(audit.passed, false);
    assert.deepEqual(audit.sourceLeaks, ['src/reuse.js']);
    await fs.rm(path.join(f.workspace, 'src/reuse.js'));
    await fs.copyFile(path.join(f.workspace, 'reference/source.mp4'), path.join(f.workspace, 'src/background.mp4'));
    audit = await auditGeneration(f.workspace, f.options);
    assert.deepEqual(audit.copiedReferenceFiles, ['src/background.mp4']);
    await fs.symlink(path.join(f.workspace, 'task/spec.json'), path.join(f.workspace, 'src/escape.json'));
    await assert.rejects(auditGeneration(f.workspace, f.options), /符号链接/);
});

test('enforcement requires a complete host probe and replay never becomes independent generation', async t => {
    const isolation = { readIsolation: 'enforced', probe: { id: 'host-probe-1', verified: true,
        outsideReadDenied: true, symlinkEscapeDenied: true, outsideWriteDenied: true, networkRestricted: true } };
    assert.equal(isolationEvidence(isolation).probeVerified, true);
    assert.equal(isolationEvidence({ ...isolation, probe: { ...isolation.probe, symlinkEscapeDenied: false } }).probeVerified, false);
    const f = await fixture(t, isolation);
    await f.generate();
    const audit = await auditGeneration(f.workspace, f.options);
    assert.equal(audit.strictIndependent, true);
    assert.equal(generationQualification({ generation: f.baseline, generationAudit: audit }).strictIndependent, true);
    assert.equal(generationQualification({ template: { id: 'old@6' }, assisted: false }).level, 'project-replay');
    assert.equal(generationQualification({ template: { id: 'old@6' }, assisted: false }).strictIndependent, false);
});

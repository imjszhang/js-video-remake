import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { digest } from '../src/repro/store.js';
import { migrateLegacy } from '../src/repro/migrate.js';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-migrate-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'project'), storage = path.join(root, 'state');
    const legacy = path.join(workspace, 'packages/harnesses/demo/v1');
    await fs.mkdir(path.join(legacy, 'templates'), { recursive: true });
    const source = '<!doctype html><html><body>Editable composition</body></html>\n';
    await fs.writeFile(path.join(legacy, 'templates/index.html'), source);
    const manifest = { schema: 'video-remake.harness@1', name: 'demo', version: 1,
        spec: { schema: 'video-remake.reproduction@1', title: 'Legacy demo', objective: 'Replace text', preserve: ['Timing'], replace: ['Headline'], inputs: { headline: { type: 'text', required: true } }, acceptance: { media: { file: 'outputs/final.mp4', width: 320, height: 240, durationSec: 2, audio: 'forbidden' }, requiredFiles: ['src/index.html'], review: [{ id: 'layout', description: 'Layout matches reference' }] }, maxAttempts: 2 },
        recipe: { schema: 'video-remake.harness-recipe@1', steps: [{ id: 'adapt', instruction: 'Replace the headline, preserving timing.', outputs: ['src/index.html'] }], templates: [{ from: 'templates/index.html', to: 'src/index.html' }], repairs: [{ when: 'Text overflows', instruction: 'Wrap text and recheck the layout.' }] },
        files: { 'templates/index.html': digest(source) }, references: [{ id: 'ref-demo', source: { videoPath: '/old-machine/video.mp4', assetRoot: '/old-machine', sha256: 'a'.repeat(64) } }],
        teacher: { model: 'historical-model', artifactSha256: 'b'.repeat(64) }, extraction: { runDir: '/old-machine/logs' },
    };
    await fs.writeFile(path.join(legacy, 'manifest.json'), JSON.stringify(manifest));
    await fs.mkdir(path.join(workspace, 'productions/history'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'productions/history/HARNESS.json'), '{"id":"old-run"}');
    return { root, workspace, storage, legacy, manifest, source, config: { workspace, env: { VIDEO_REMAKE_AGENT_HOME: storage } } };
}

test('migration dry run finds dependencies and pointers without writing or requiring the original receipt', async t => {
    const f = await fixture(t);
    const before = await fs.readdir(f.workspace);
    const result = await migrateLegacy(f.config, 'demo@1', { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.report.files[0].status, 'verified');
    assert.equal(result.report.receipt.status, 'missing');
    assert.equal(result.report.references[0].requiresBinding, true);
    assert.equal(result.report.absolutePaths.length, 3);
    assert.deepEqual(result.report.legacyPointers, ['productions/history/HARNESS.json']);
    assert.deepEqual(await fs.readdir(f.workspace), before);
    assert.equal((await migrateLegacy(f.config)).reports.length, 1);
});

test('legacy project-copy migration is disabled and leaves historical bytes and pointers intact', async t => {
    const f = await fixture(t);
    const before = await fs.readFile(path.join(f.legacy, 'manifest.json'));
    await assert.rejects(migrateLegacy(f.config, 'demo@1'), { code: 'REPRO_MIGRATION_REQUIRED' });
    await assert.rejects(migrateLegacy(f.config, 'demo@1', { to: 'new-project' }), { code: 'REPRO_MIGRATION_REQUIRED' });
    assert.deepEqual(await fs.readFile(path.join(f.legacy, 'manifest.json')), before);
    assert.equal(await fs.readFile(path.join(f.legacy, 'templates/index.html'), 'utf8'), f.source);
    await fs.access(path.join(f.workspace, 'productions/history/HARNESS.json'));
    await assert.rejects(fs.access(path.join(f.workspace, 'new-project')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.workspace, 'reproductions')), { code: 'ENOENT' });
});

test('migration detects source corruption, missing files, symlinks and mismatching historical receipts', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.legacy, 'templates/index.html'), 'tampered');
    assert.equal((await migrateLegacy(f.config, 'demo@1', { dryRun: true })).report.blockers[0].type, 'file-integrity');
    await assert.rejects(migrateLegacy(f.config, 'demo@1'), { code: 'REPRO_MIGRATION_REQUIRED' });
    await fs.rm(path.join(f.legacy, 'templates/index.html'));
    assert.equal((await migrateLegacy(f.config, 'demo@1', { dryRun: true })).report.files[0].status, 'missing');
    await fs.symlink(path.join(f.workspace, 'productions/history/HARNESS.json'), path.join(f.legacy, 'templates/index.html'));
    assert.equal((await migrateLegacy(f.config, 'demo@1', { dryRun: true })).report.files[0].status, 'invalid');
    await fs.unlink(path.join(f.legacy, 'templates/index.html'));
    await fs.writeFile(path.join(f.legacy, 'templates/index.html'), f.source);
    await fs.mkdir(path.join(f.storage, 'harness/packages'), { recursive: true });
    await fs.writeFile(path.join(f.storage, 'harness/packages/demo-v1.json'), '{"manifestHash":"incorrect"}');
    assert.equal((await migrateLegacy(f.config, 'demo@1', { dryRun: true })).report.receipt.status, 'mismatch');
    await assert.rejects(migrateLegacy(f.config, 'demo@1'), { code: 'REPRO_MIGRATION_REQUIRED' });
});

test('legacy package script conflicts remain visible in inspection without copying or executing the script', async t => {
    const f = await fixture(t);
    const text = '{"scripts":{"render":"node /old-machine/render.js"}}';
    await fs.writeFile(path.join(f.legacy, 'templates/package.json'), text);
    f.manifest.files['templates/package.json'] = digest(text);
    f.manifest.recipe.templates.push({ from: 'templates/package.json', to: 'package.json' });
    await fs.writeFile(path.join(f.legacy, 'manifest.json'), JSON.stringify(f.manifest));
    const result = await migrateLegacy(f.config, 'demo@1', { dryRun: true });
    assert.ok(result.report.warnings.some(warning => warning.type === 'contract-conflict'));
    assert.equal(result.report.certification, 'not-validated');
    assert.equal(result.historyRetained, true);
    assert.equal(await fs.readFile(path.join(f.legacy, 'templates/package.json'), 'utf8'), text);
    await assert.rejects(fs.access(path.join(f.workspace, 'reproductions')), { code: 'ENOENT' });
});

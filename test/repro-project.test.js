import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { scaffoldProject, validateProject, copyProject, snapshotProject, syncSkills } from '../src/repro/project.js';
import { freezeTemplate, loadTemplate, instantiateTemplate, exportTemplate, importTemplate } from '../src/repro/template-store.js';

const exec = promisify(execFile);
const spec = {
    schema: 'video-remake.reproduction@1', title: 'Portable fixture', objective: 'Replace title in a reference composition',
    preserve: ['Scene timing'], replace: ['Title'], inputs: { title: { type: 'text', required: true }, logo: { type: 'file', required: false } },
    acceptance: { media: { file: 'outputs/final.mp4', width: 320, height: 240, durationSec: 1, toleranceSec: 0.2, audio: 'forbidden' }, requiredFiles: ['src/index.html'], review: [{ id: 'layout', description: 'Matches the reference layout' }] },
    maxAttempts: 2,
};

async function setup(t) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-project-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, 'authoring');
    const config = { workspace: directory };
    await scaffoldProject(source, { spec, name: 'portable-fixture', inputs: { title: 'Teacher private title' } });
    return { directory, source, config };
}

async function ready(root) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'reproduction.json'), 'utf8'));
    manifest.status = 'ready';
    await fs.writeFile(path.join(root, 'reproduction.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.writeFile(path.join(root, 'src/index.html'), '<!doctype html><html><body><div data-composition-id="fixture" data-width="320" data-height="240" data-duration="1">Fixture</div></body></html>\n');
}

test('standalone scaffold declares draft and generates portable pinned lock and native skill copies', async t => {
    const { source } = await setup(t);
    const result = await validateProject(source);
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.equal((await validateProject(source, { requireReady: true })).ok, false);
    const lock = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/hyperframes'].version, '0.8.191');
    assert.equal(lock.packages['node_modules/js-agent-runtime'], undefined);
    assert.equal(lock.packages['node_modules/@hypit/hypit'], undefined);
    assert.equal(await fs.readFile(path.join(source, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    await assert.rejects(exec(process.execPath, ['scripts/render.mjs'], { cwd: source }), /Draft scaffold/);
    const canonical = path.join(source, '.agents/skills/reproduce/SKILL.md');
    await fs.appendFile(canonical, '\nReference-specific replacement mapping.\n');
    assert.equal((await validateProject(source)).checks.find(c => c.id === 'skills').passed, false);
    await syncSkills(source);
    assert.equal((await validateProject(source)).ok, true);
});

test('portable snapshots include binary assets and exclude actual inputs, output and reference bindings', async t => {
    const { source, directory } = await setup(t);
    await fs.writeFile(path.join(source, 'assets/logo.bin'), Buffer.from([0, 255, 8, 0, 42]));
    await fs.mkdir(path.join(source, 'reference'));
    await fs.writeFile(path.join(source, 'reference/SOURCES.json'), JSON.stringify({ localPath: '/private/reference.mp4' }));
    await fs.writeFile(path.join(source, 'outputs/final.mp4'), 'private final');
    await fs.mkdir(path.join(source, '.hyperframes'), { recursive: true });
    await fs.writeFile(path.join(source, '.hyperframes/render-outputs.json'), JSON.stringify({ version: 1, paths: ['preview.mp4'] }));
    await fs.writeFile(path.join(source, '.hyperframes/video-state.json'), JSON.stringify({ source: '/Users/local/machine/video.mp4' }));
    await fs.writeFile(path.join(source, '.hyperframes/studio-motion.json'), JSON.stringify({ overrides: [] }));
    await fs.writeFile(path.join(source, 'preview.mp4'), 'preview');
    const snapshot = await copyProject(source, path.join(directory, 'relocated'));
    const names = snapshot.files.map(file => file.path);
    assert.ok(names.includes('assets/logo.bin'));
    assert.ok(!names.includes('inputs/values.json'));
    assert.ok(!names.includes('reference/SOURCES.json'));
    assert.ok(!names.includes('outputs/final.mp4'));
    assert.ok(!names.includes('preview.mp4'));
    assert.ok(!names.includes('.hyperframes/video-state.json'));
    assert.ok(names.includes('.hyperframes/studio-motion.json'));
    assert.equal((await snapshotProject(source, { includeInputs: true, includeOutputs: true })).files.some(file => file.path === 'reference/SOURCES.json'), true);
    assert.deepEqual(await fs.readFile(path.join(directory, 'relocated/assets/logo.bin')), Buffer.from([0, 255, 8, 0, 42]));
});

test('template directory travels independently, verifies tampering and instantiates fresh inputs', async t => {
    const { source, directory, config } = await setup(t);
    await assert.rejects(freezeTemplate(config, { source, name: 'fixture', version: 1, spec }), /冻结条件/);
    await ready(source);
    const template = await freezeTemplate(config, { source, name: 'fixture', version: 1, spec, provenance: { runId: 'teacher-1', workspace: source, model: 'high' } });
    assert.equal(template.id, 'fixture@1');
    assert.equal(template.provenance.workspace, undefined);
    await assert.rejects(freezeTemplate(config, { source, name: 'fixture', version: 1, spec }), /已存在/);
    assert.equal((await loadTemplate(config, 'fixture@1')).treeHash, template.treeHash);
    const exported = await exportTemplate(config, template, { destination: path.join(directory, 'exported') });
    await fs.rm(path.join(directory, 'reproductions'), { recursive: true });
    assert.equal((await loadTemplate(config, exported.root)).treeHash, template.treeHash);
    const instance = await instantiateTemplate(config, exported.root, { destination: path.join(directory, 'instance'), inputs: { title: 'New title' } });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(instance.root, 'inputs/values.json'), 'utf8')), { title: 'New title' });
    const imported = await importTemplate(config, exported.root, { name: 'imported', version: 1 });
    assert.equal(imported.provenance.verification, 'unverified');
    await fs.appendFile(path.join(exported.root, 'src/index.html'), '<!-- changed -->');
    await assert.rejects(loadTemplate(config, exported.root), /冻结清单不一致/);
});

test('project validation rejects symlinks, credentials and nonportable dependencies', async t => {
    const { source, directory } = await setup(t);
    await fs.writeFile(path.join(source, '.env.local'), 'API_KEY=secret');
    assert.equal((await validateProject(source)).checks.find(c => c.id === 'portable-files').passed, false);
    await fs.rm(path.join(source, '.env.local'));
    await fs.writeFile(path.join(source, '.env.example'), 'API_KEY=real-secret\n');
    assert.equal((await validateProject(source)).ok, false);
    await fs.writeFile(path.join(source, '.env.example'), 'API_KEY=<provided-at-runtime>\n');
    await fs.symlink(directory, path.join(source, 'assets/escape'));
    await assert.rejects(snapshotProject(source), /符号链接/);
    await fs.unlink(path.join(source, 'assets/escape'));
    await fs.appendFile(path.join(source, 'docs/workflow.md'), '\nRead the reference at /Users/author/private/reference.mp4\n');
    assert.equal((await validateProject(source)).checks.find(c => c.id === 'source-references').passed, false);
    await fs.writeFile(path.join(source, 'docs/workflow.md'), '# Portable workflow\n');
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    pkg.dependencies.parent = 'file:../../video-remake';
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(pkg));
    assert.equal((await validateProject(source)).checks.find(c => c.id === 'dependencies').passed, false);
});

test('portable capability declarations reject machine bindings and cannot drift from template metadata', async t => {
    const { source, config } = await setup(t);
    await ready(source);
    const file = path.join(source, 'reproduction.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest.capabilities = [{ id: 'asset.search', url: 'https://example.com', token: 'inline-credential' }];
    await fs.writeFile(file, JSON.stringify(manifest));
    assert.equal((await validateProject(source)).checks.find(check => check.id === 'manifest').passed, false);
    await assert.rejects(freezeTemplate(config, { source, name: 'caps', version: 1, spec }), /冻结条件/);
    manifest.capabilities = ['asset.search']; await fs.writeFile(file, JSON.stringify(manifest));
    await assert.rejects(freezeTemplate(config, { source, name: 'caps', version: 1, spec, capabilities: ['image.generate'] }), /能力需求与项目声明不一致/);
    const template = await freezeTemplate(config, { source, name: 'caps', version: 1, spec });
    assert.deepEqual(template.capabilities, [{ id: 'asset.search', required: true }]);
    const record = JSON.parse(await fs.readFile(path.join(template.root, 'template.json'), 'utf8'));
    record.capabilities = [{ id: 'image.generate', required: true }];
    delete record.metadataHash;
    record.metadataHash = createHash('sha256').update(JSON.stringify(record, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
    await fs.writeFile(path.join(template.root, 'template.json'), JSON.stringify(record));
    await assert.rejects(loadTemplate(config, template.root), /能力需求与项目声明不一致/);
});

test('a source edit between validation and copying cannot consume an immutable template version', async t => {
    const { source, config } = await setup(t);
    await ready(source);
    const destination = path.join(config.workspace, 'reproductions/templates/race/v1');
    const original = fs.access;
    let changed = false;
    fs.access = async (file, ...args) => {
        try { return await original(file, ...args); }
        catch (error) {
            if (!changed && file === destination && error.code === 'ENOENT') {
                changed = true;
                await fs.appendFile(path.join(source, 'src/index.html'), '\n<!-- concurrent source edit -->');
            }
            throw error;
        }
    };
    try { await assert.rejects(freezeTemplate(config, { source, name: 'race', version: 1, spec }), { code: 'REPRO_CHANGED' }); }
    finally { fs.access = original; }
    assert.equal(changed, true);
    await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.dirname(destination)), []);
    assert.equal((await freezeTemplate(config, { source, name: 'race', version: 1, spec })).id, 'race@1');
});

test('relocated generated entry points resolve local tools and self-check actual media', async t => {
    const { source, directory } = await setup(t);
    await ready(source);
    const relocated = path.join(directory, 'relocated');
    await copyProject(source, relocated, { includeInputs: true });
    // An isolated local CLI fixture exercises path resolution without network or
    // pretending to test HyperFrames visual rendering in the unit suite.
    await fs.mkdir(path.join(relocated, 'node_modules/hyperframes/bin'), { recursive: true });
    await fs.writeFile(path.join(relocated, 'node_modules/hyperframes/package.json'), JSON.stringify({ version: '0.8.191' }));
    await fs.writeFile(path.join(relocated, 'node_modules/hyperframes/bin/hyperframes.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
    const rendered = await exec(process.execPath, ['scripts/render.mjs', '--plan'], { cwd: relocated });
    const plan = JSON.parse(rendered.stdout);
    assert.ok(plan.args[0].startsWith(relocated));
    assert.ok(!rendered.stdout.includes(source));
    assert.equal(plan.args[2], relocated);
    assert.equal(plan.args[plan.args.indexOf('--composition') + 1], 'src/index.html');
    assert.equal(plan.args[plan.args.indexOf('--variables-file') + 1], path.join(relocated, 'inputs/values.json'));
    const actual = await exec(process.execPath, ['scripts/render.mjs'], { cwd: relocated });
    assert.deepEqual(JSON.parse(actual.stdout), plan.args.slice(1));
    await fs.appendFile(path.join(relocated, '.agents/skills/repair/SKILL.md'), '\nRecord newly observed input overflow fixes.\n');
    await exec(process.execPath, ['scripts/sync-skills.mjs'], { cwd: relocated });
    assert.equal((await validateProject(relocated)).ok, true);
    // The self-check must reject missing media, never report an unobserved
    // visual requirement as passed.
    await assert.rejects(exec(process.execPath, ['scripts/check.mjs'], { cwd: relocated }));
    const report = JSON.parse(await fs.readFile(path.join(relocated, 'outputs/self-check.json'), 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(report.review[0].result, 'unobserved');
    assert.equal(report.externalAcceptanceRequired, true);
});

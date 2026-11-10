import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scaffoldProject, validateProject, snapshotProject } from '../src/repro/project.js';
import { freezeTemplate } from '../src/repro/template-store.js';
import { scaffoldMethodRecipe, freezeMethodRecipe, loadMethodRecipe, listMethodRecipes, freezeAssetPack, loadAssetPack,
    instantiateMethodRecipe, exportMethodRecipe, importMethodRecipe, inspectMethodMigration } from '../src/repro/method-store.js';

const spec = {
    schema: 'video-remake.reproduction@2', title: 'Blank generation fixture', objective: 'Generate a scene matching the reference.',
    preserve: ['Composition and timing'], replace: [], inputs: { title: { type: 'text', required: true } },
    acceptance: { media: { file: 'outputs/final.mp4', width: 320, height: 240, durationSec: 2, toleranceSec: 0.2, audio: 'forbidden' },
        requiredFiles: ['src/index.html'], review: [{ id: 'layout', description: 'Matches the reference composition.', modality: 'visual' }] }, maxAttempts: 2,
};
const review = { reviewer: 'fixture-reviewer', notes: 'Reviewed isolated prop and texture, no scene or timeline.', targetScene: false, targetTimeline: false };
const methodReview = { reviewer: 'fixture-reviewer', notes: 'Methods and observation guidance only.', containsTargetImplementation: false };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhuQAAAAASUVORK5CYII=', 'base64');

async function setup(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'method-store-')));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    return { root, config: { workspace: root }, source: path.join(root, 'draft') };
}
async function method(source, assetPacks = []) {
    return scaffoldMethodRecipe(source, { title: 'Method fixture', assetPacks, contentReview: methodReview });
}
async function asset(directory, overrides = {}) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'texture.png'), png);
    await fs.writeFile(path.join(directory, 'asset-pack.json'), JSON.stringify({ schema: 'video-remake.asset-pack@1', title: 'Generic texture', contentReview: review,
        assets: [{ id: 'texture', file: 'texture.png', type: 'texture', scope: 'generic', source: 'Fixture author', license: 'CC0-1.0', ...overrides }] }));
}

test('method generation creates a real blank project with locked documents and separate generic assets', async t => {
    const { config, source, root } = await setup(t);
    const assetSource = path.join(root, 'generic'); await asset(assetSource);
    await freezeAssetPack(config, { directory: assetSource, name: 'generic', version: 1 });
    await method(source, ['generic@1']);
    const frozen = await freezeMethodRecipe(config, { directory: source, name: 'fixture', version: 1 });
    const result = await instantiateMethodRecipe(config, frozen.id, path.join(root, 'instance'), { spec, name: 'trial', inputs: { title: 'New input' } });
    assert.equal(result.generationMode, 'method-generation');
    assert.equal(result.independence.readIsolationVerified, false);
    assert.match(await fs.readFile(path.join(result.root, 'src/index.html'), 'utf8'), /REPRODUCTION_DRAFT/);
    assert.equal((await validateProject(result.root)).ok, true);
    assert.equal((await validateProject(result.root, { requireReady: true })).ok, false);
    assert.ok(result.lockedFiles['method/recipe.json']);
    assert.ok(result.lockedFiles['.agents/skills/reproduce/SKILL.md']);
    assert.ok(result.lockedFiles['ASSET-LOCK.json']);
    assert.ok(result.lockedFiles['assets/packs/generic/v1/texture.png']);
    assert.equal(result.lockedFiles['src/index.html'], undefined);
    assert.equal(result.lockedFiles['reproduction.json'], undefined);
    assert.equal(result.assetLock.packs[0].assets[0].path, 'assets/packs/generic/v1/texture.png');
    assert.equal(result.initialSnapshot.files.filter(file => file.path.startsWith('src/')).length, 1);
    assert.equal((await listMethodRecipes(config))[0].treeHash, frozen.treeHash);
    const second = await instantiateMethodRecipe(config, frozen.id, path.join(root, 'instance-2'), { spec, name: 'trial', inputs: { title: 'New input' } });
    assert.equal(second.scaffoldHash, result.scaffoldHash);
    assert.equal(second.initialSnapshot.treeHash, result.initialSnapshot.treeHash);
    await assert.rejects(instantiateMethodRecipe(config, frozen.id, result.root, { spec }), /不是空目录/);
});

test('method stores are immutable and detect extra, changed and symlinked files', async t => {
    const { config, source, root } = await setup(t); await method(source);
    const recipe = await freezeMethodRecipe(config, { directory: source, name: 'fixture', version: 1 });
    await assert.rejects(freezeMethodRecipe(config, { directory: source, name: 'fixture', version: 1 }), /已存在/);
    assert.equal((await loadMethodRecipe(config, recipe.id)).treeHash, recipe.treeHash);
    await fs.appendFile(path.join(recipe.root, 'methods/workflow.md'), '\nUnreviewed instruction.');
    await assert.rejects(loadMethodRecipe(config, recipe.id), /冻结清单不一致/);
    await fs.writeFile(path.join(source, 'scene.js'), 'target implementation');
    await assert.rejects(freezeMethodRecipe(config, { directory: source, name: 'extra', version: 1 }), /显式允许清单/);
    await fs.rm(path.join(source, 'scene.js'));
    await fs.symlink(root, path.join(source, 'methods/escape'));
    await assert.rejects(freezeMethodRecipe(config, { directory: source, name: 'escape', version: 1 }), /符号链接/);
});

test('no-method baseline preserves scaffold, inputs and assets while omitting every recipe instruction', async t => {
    const { config, source, root } = await setup(t);
    const assetSource = path.join(root, 'generic'); await asset(assetSource);
    await freezeAssetPack(config, { directory: assetSource, name: 'generic', version: 1 });
    await method(source, ['generic@1']);
    const marker = 'METHOD_ONLY_GUIDANCE_MARKER';
    await fs.appendFile(path.join(source, '.agents/skills/reproduce/SKILL.md'), `\n${marker}\n`);
    await fs.appendFile(path.join(source, 'methods/workflow.md'), `\n${marker}\n`);
    await freezeMethodRecipe(config, { directory: source, name: 'fixture', version: 1 });
    const baseline = await instantiateMethodRecipe(config, 'fixture@1', path.join(root, 'baseline'), { spec, name: 'baseline-run', inputs: { title: 'Same input' }, applyMethod: false });
    const treatment = await instantiateMethodRecipe(config, 'fixture@1', path.join(root, 'treatment'), { spec, name: 'treatment-run', inputs: { title: 'Same input' } });
    assert.equal(baseline.methodApplied, false); assert.equal(treatment.methodApplied, true);
    assert.deepEqual(baseline.recipe, treatment.recipe);
    assert.equal(baseline.scaffoldHash, treatment.scaffoldHash, 'run labels do not change the scaffold identity');
    assert.equal(baseline.assetLockHash, treatment.assetLockHash);
    assert.deepEqual(await fs.readFile(path.join(baseline.root, 'src/index.html')), await fs.readFile(path.join(treatment.root, 'src/index.html')));
    assert.deepEqual(await fs.readFile(path.join(baseline.root, 'task/spec.json')), await fs.readFile(path.join(treatment.root, 'task/spec.json')));
    assert.deepEqual(await fs.readFile(path.join(baseline.root, 'inputs/values.json')), await fs.readFile(path.join(treatment.root, 'inputs/values.json')));
    assert.ok(!baseline.initialSnapshot.files.some(file => file.path.startsWith('method/')));
    for (const file of baseline.initialSnapshot.files.filter(file => file.path.endsWith('.md'))) {
        assert.ok(!(await fs.readFile(path.join(baseline.root, file.path), 'utf8')).includes(marker), file.path);
    }
    assert.match(await fs.readFile(path.join(treatment.root, '.claude/skills/reproduce/SKILL.md'), 'utf8'), new RegExp(marker));
    assert.match(await fs.readFile(path.join(baseline.root, 'AGENTS.md'), 'utf8'), /blank src/);
    assert.equal((await validateProject(baseline.root)).ok, true);
});

test('method admission rejects hidden implementation formats and requires an explicit review', async t => {
    const { config, source } = await setup(t); await scaffoldMethodRecipe(source);
    await assert.rejects(freezeMethodRecipe(config, { directory: source, name: 'pending', version: 1 }), /尚未完成/);
    const manifestFile = path.join(source, 'recipe.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); manifest.contentReview = methodReview;
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await fs.appendFile(path.join(source, 'methods/workflow.md'), '\n<script>completeTargetScene()</script>');
    await assert.rejects(freezeMethodRecipe(config, { directory: source, name: 'hidden', version: 1 }), /可执行画面/);
    await fs.writeFile(path.join(source, 'methods/workflow.md'), 'Inspect frame occupancy before choosing camera position.');
    manifest.files.push('examples/trajectory.json');
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await fs.writeFile(path.join(source, 'examples/trajectory.json'), '[]').catch(async error => {
        if (error.code !== 'ENOENT') throw error; await fs.mkdir(path.join(source, 'examples')); await fs.writeFile(path.join(source, 'examples/trajectory.json'), '[]');
    });
    await assert.rejects(freezeMethodRecipe(config, { directory: source, name: 'trajectory', version: 1 }), /只允许文档/);
});

test('asset admission rejects scripts, archives, cameras and undeclared resource references', async t => {
    const { config, root } = await setup(t); const source = path.join(root, 'assets'); await asset(source);
    const frozen = await freezeAssetPack(config, { directory: source, name: 'generic', version: 1 });
    await fs.appendFile(path.join(frozen.root, 'texture.png'), 'changed');
    await assert.rejects(loadAssetPack(config, frozen.id), /冻结清单不一致/);
    await fs.writeFile(path.join(source, 'texture.png'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
    await assert.rejects(freezeAssetPack(config, { directory: source, name: 'archive', version: 1 }), /归档/);
    const model = path.join(root, 'model'); await fs.mkdir(model);
    const data = { asset: { version: '2.0' }, cameras: [{ type: 'perspective' }] };
    await fs.writeFile(path.join(model, 'prop.gltf'), JSON.stringify(data));
    const entry = { id: 'prop', file: 'prop.gltf', type: 'prop', scope: 'generic', source: 'Fixture', license: 'CC0-1.0', units: 'meters', scale: 1, pivot: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
    const manifest = { schema: 'video-remake.asset-pack@1', title: 'Prop', contentReview: review, assets: [entry] };
    await fs.writeFile(path.join(model, 'asset-pack.json'), JSON.stringify(manifest));
    await assert.rejects(freezeAssetPack(config, { directory: model, name: 'camera', version: 1 }), /禁止相机/);
    await fs.writeFile(path.join(model, 'prop.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: '../../teacher/scene.bin' }] }));
    await assert.rejects(freezeAssetPack(config, { directory: model, name: 'escape', version: 1 }), /traversal/);
    await fs.writeFile(path.join(model, 'prop.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin' }] }));
    await assert.rejects(freezeAssetPack(config, { directory: model, name: 'missing', version: 1 }), /未声明资源/);
    manifest.assets[0].file = 'scene.js';
    await fs.writeFile(path.join(model, 'asset-pack.json'), JSON.stringify(manifest));
    await assert.rejects(freezeAssetPack(config, { directory: model, name: 'script', version: 1 }), /不允许脚本/);
});

test('method export carries only reviewed documents and assets and imports without teacher workspace', async t => {
    const { config, source, root } = await setup(t); const assetSource = path.join(root, 'generic'); await asset(assetSource);
    await freezeAssetPack(config, { directory: assetSource, name: 'generic', version: 1 }); await method(source, ['generic@1']);
    const original = await freezeMethodRecipe(config, { directory: source, name: 'fixture', version: 1, provenance: { teacher: 'legacy@6', workspace: source } });
    assert.equal(original.provenance.workspace, undefined);
    const bundle = await exportMethodRecipe(config, original.id, { destination: path.join(root, 'bundle') });
    const relocated = path.join(root, 'relocated'); await fs.mkdir(relocated);
    const imported = await importMethodRecipe({ workspace: relocated }, bundle.root);
    assert.equal(imported.treeHash, original.treeHash);
    assert.equal(imported.provenance.verification, 'unverified');
    assert.equal((await loadAssetPack({ workspace: relocated }, 'generic@1')).manifest.title, 'Generic texture');
    await assert.rejects(fs.access(path.join(imported.root, 'src')), { code: 'ENOENT' });
    const instance = await instantiateMethodRecipe({ workspace: relocated }, imported.id, path.join(relocated, 'trial'), { spec });
    assert.match(await fs.readFile(path.join(instance.root, 'src/index.html'), 'utf8'), /REPRODUCTION_DRAFT/);
});

test('legacy migration inspection preserves historical implementation and does not inherit its score', async t => {
    const { config, root } = await setup(t); const teacher = path.join(root, 'teacher'); await scaffoldProject(teacher, { spec, name: 'teacher' });
    const manifest = JSON.parse(await fs.readFile(path.join(teacher, 'reproduction.json'), 'utf8')); manifest.status = 'ready';
    await fs.writeFile(path.join(teacher, 'reproduction.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(teacher, 'src/index.html'), '<html><body>Teacher completed composition</body></html>');
    await fs.writeFile(path.join(teacher, 'assets/texture.png'), png);
    const legacy = await freezeTemplate(config, { source: teacher, name: 'legacy', version: 1, spec });
    const before = await snapshotProject(legacy.root);
    const report = await inspectMethodMigration(config, legacy.id);
    assert.equal(report.copiesImplementation, false); assert.equal(report.inheritsValidation, false);
    assert.equal(report.generationMode, 'project-replay');
    assert.equal(report.candidates.find(file => file.path === 'src/index.html').action, 'archive-implementation');
    assert.equal(report.candidates.find(file => file.path === 'assets/texture.png').action, 'review-generic-asset');
    assert.equal((await snapshotProject(legacy.root)).treeHash, before.treeHash);
    assert.equal((await listMethodRecipes(config)).length, 0);
});

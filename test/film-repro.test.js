import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { scaffoldProject, validateProject } from '../src/repro/project.js';
import { renderProject } from '../src/repro/render.js';
import { FILM_ENGINE } from '../src/film/engine.js';
import { FILM_RUNTIME_DIR } from '../src/film/constants.js';
import { validateSpec } from '../src/repro/schema.js';
import { scaffoldMethodRecipe, validateMethodManifest } from '../src/repro/method-store.js';

const spec = {
    schema: 'video-remake.reproduction@1', title: 'Film fixture', objective: 'Render a film project',
    preserve: ['Timing'], replace: ['Title'], inputs: { title: { type: 'text', required: true } },
    acceptance: { media: { file: 'outputs/final.mp4', width: 320, height: 240, durationSec: 1, toleranceSec: 0.2, audio: 'forbidden' }, requiredFiles: ['src/index.html'], review: [{ id: 'layout', description: 'Matches' }] },
};

test('a film reproduction project scaffolds without HyperFrames and validates', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-film-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const manifest = await scaffoldProject(root, { spec, name: 'film-fixture', inputs: { title: 'x' }, engine: 'film' });
    assert.equal(manifest.engine, FILM_ENGINE);
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies, undefined);
    assert.ok(await fs.readFile(path.join(root, 'tools/render.mjs')).then(() => true, () => false));
    const result = await validateProject(root);
    assert.equal(result.ok, true, JSON.stringify(result.checks));
});

test('a film project renders through the hash-checked local-film provider', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-film-render-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await scaffoldProject(root, { spec, name: 'film-fixture', inputs: { title: 'x' }, engine: 'film' });
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'reproduction.json'), 'utf8'));
    manifest.status = 'ready';
    await fs.writeFile(path.join(root, 'reproduction.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'src/index.html'), '<!doctype html><html><body>ready</body></html>\n');

    // The fake child has no pid on purpose: runFixedCommand signals the process group
    // (-pid) on timeout, and a fake pid such as 1 would signal every process of the user.
    const calls = [];
    const deps = { spawn: (_executable, args) => {
        calls.push(args);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const out = args.indexOf('--out');
        const work = out < 0 ? Promise.resolve() : fs.writeFile(args[out + 1], 'mp4');
        work.then(() => child.emit('close', 0, null), (error) => child.emit('error', error));
        return child;
    } };
    const record = await renderProject({ workspace: root, env: {} }, { workspace: root, spec, timeoutMs: 5_000 }, deps);
    assert.equal(record.provider, 'local-film');
    assert.equal(record.precheck.status, 'film-check-passed');
    // Both steps run the host's runtime against the project root, not the project's copies.
    const host = path.join(FILM_RUNTIME_DIR, 'tools');
    assert.deepEqual(calls.map((args) => args[0]), [path.join(host, 'check.mjs'), path.join(host, 'render.mjs')]);
    assert.deepEqual(calls.map((args) => args[args.indexOf('--root') + 1]), [root, root]);
    assert.ok(record.runtime.files['runtime/film.js']);
});

test('a managed film render refuses a project whose page runtime was edited', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-film-tamper-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await scaffoldProject(root, { spec, name: 'film-fixture', inputs: { title: 'x' }, engine: 'film' });
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'reproduction.json'), 'utf8'));
    manifest.status = 'ready';
    await fs.writeFile(path.join(root, 'reproduction.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.appendFile(path.join(root, 'runtime/film.js'), '\nwindow.__leak = 1;\n');
    const spawn = () => { throw new Error('nothing may run for a tampered runtime'); };
    await assert.rejects(renderProject({ workspace: root, env: {} }, { workspace: root, spec, timeoutMs: 5_000 }, { spawn }),
        (error) => error.code === 'REPRO_RENDER_VERSION' && /runtime\/film\.js/.test(error.message));
});

test('a reproduction spec carries the film engine and rejects unknown engines', () => {
    assert.equal(validateSpec({ ...spec, engine: 'film' }).engine, 'film');
    assert.equal(validateSpec(spec).engine, undefined);
    assert.throws(() => validateSpec({ ...spec, engine: 'webgl' }), /spec\.engine/);
});

test('a film method recipe ships the frame contract and passes recipe validation', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repro-film-method-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { manifest } = await scaffoldMethodRecipe(root, { engine: 'film', contentReview: { reviewer: 'fixture', notes: 'Method prose only.', containsTargetImplementation: false } });
    assert.ok(manifest.files.includes('methods/film-contract.md'));
    assert.match(await fs.readFile(path.join(root, 'methods/workflow.md'), 'utf8'), /film engine/);
    assert.doesNotThrow(() => validateMethodManifest(manifest));
    await assert.rejects(scaffoldMethodRecipe(path.join(root, 'other'), { engine: 'webgl' }), /engine/);
});

test('the film checker sees clock reads inside template literals but not inside plain strings or comments', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'film-check-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'src'));
    const check = async (source) => {
        await fs.writeFile(path.join(root, 'src/page.js'), source);
        const { spawnSync } = await import('node:child_process');
        return spawnSync(process.execPath, [path.join(FILM_RUNTIME_DIR, 'tools/check.mjs'), '--root', root], { encoding: 'utf8' });
    };
    const clean = await check('const a = "Date.now()"; // Math.random()\n/* performance.now() */\nconst b = `at ${t.toFixed(2)}`;\n');
    assert.equal(clean.status, 0, clean.stderr);
    for (const source of ['const s = `time ${Date.now()}`;', 'const s = `a ${`b ${Math.random()}`}`;', 'const s = `${JSON.stringify({ a: 1 })} ${requestAnimationFrame(f)}`;']) {
        const result = await check(`${source}\n`);
        assert.equal(result.status, 1, source);
    }
});

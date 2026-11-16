import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgv } from '../src/args.js';
import { execute } from '../cli/remake.js';
import { downloadedVideo, run, tempWorkspace } from './helpers.js';
import { FILM_ENGINE } from '../src/film/engine.js';

async function production(t) {
    const workspace = await tempWorkspace(t, { videos: { abcdefghijk: downloadedVideo() } });
    await run(['bind', 'abcdefghijk'], workspace.env);
    await run(['start', 'youtube-abcdefghijk', '--as', 'demo'], workspace.env);
    return { ...workspace, prod: path.join(workspace.directory, 'productions', 'demo') };
}

const exec = (argv, env, deps) => execute(parseArgv(argv), env, deps);

test('video:new --engine film scaffolds a package with no HyperFrames dependency', async (t) => {
    const w = await production(t);
    const calls = [];
    const deps = { runCommand: async (...args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '' }; } };
    const created = await exec(['video:new', 'demo', '--engine', 'film', '--width', '1280', '--height', '720', '--fps', '30', '--duration', '2'], w.env, deps);
    assert.equal(created.data.engine, FILM_ENGINE);
    assert.equal(created.data.installed, null);
    assert.equal(calls.length, 0, 'a film package installs nothing');

    const pkg = path.join(w.prod, 'videos/code-v1');
    const pkgJson = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8'));
    assert.equal(pkgJson.dependencies, undefined);
    assert.match(pkgJson.scripts.render, /^node tools\/render\.mjs --out /);
    const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'video.json'), 'utf8'));
    assert.equal(manifest.engine, FILM_ENGINE);
    assert.equal(manifest.frame.frames, 60);
    const film = JSON.parse(await fs.readFile(path.join(pkg, 'film.json'), 'utf8'));
    assert.equal(film.duration, 2);
    // film.json is the author's beat sheet; the runtime integrity record lives in video.json.
    assert.equal(film.runtime, undefined);
    assert.ok(manifest.runtime.files['tools/render.mjs']);
    for (const relative of Object.keys(manifest.runtime.files)) assert.ok(await fs.readFile(path.join(pkg, relative)).then(() => true, () => false), relative);
    for (const file of ['index.html', 'package.json', 'video.json']) {
        assert.doesNotMatch(await fs.readFile(path.join(pkg, file), 'utf8'), /\.\.\//, file);
    }

    const listed = await exec(['video:list', 'demo'], w.env, deps);
    assert.equal(listed.data.videos[0].engine, FILM_ENGINE);
    assert.equal(listed.data.videos[0].installed, true);

    await assert.rejects(exec(['video:new', 'demo', '--engine', 'other', '--skip-install'], w.env, deps), { code: 'INVALID_INPUT' });
});

test('check and timeline on a film package use the copied runtime, not HyperFrames', async (t) => {
    const w = await production(t);
    const calls = [];
    const deps = { runCommand: async (executable, args, opts) => { calls.push({ executable, args, cwd: opts.cwd }); return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }; } };
    await exec(['video:new', 'demo', '--engine', 'film', '--skip-install'], w.env, deps);
    const checked = await exec(['check', 'demo'], w.env, deps);
    assert.equal(checked.data.filmCheck, 'passed');
    assert.equal(checked.data.fps, 30);
    // Same two steps as the package's `npm run check`: static rules, then the determinism sample.
    assert.deepEqual(calls.map((call) => call.args[0]), ['tools/check.mjs', 'tools/render.mjs']);
    assert.ok(calls[1].args.includes('--check'));
    assert.equal(calls[0].cwd, path.join(w.prod, 'videos/code-v1'));
    await fs.appendFile(path.join(w.prod, 'videos/code-v1/tools/render.mjs'), '\n// edited\n');
    await assert.rejects(exec(['check', 'demo'], w.env, deps), { code: 'VIDEO_NOT_INSTALLED' });
    const timeline = await exec(['timeline', 'demo', '--json'], w.env, deps);
    assert.equal(timeline.data.engine, FILM_ENGINE);
    assert.match(timeline.data.output, /"beats"/);
});

test('film packages are refused by video:template and by template-editing actions', async (t) => {
    const w = await production(t);
    const deps = { runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
    await exec(['video:new', 'demo', '--engine', 'film', '--skip-install'], w.env, deps);
    await assert.rejects(exec(['video:template', 'demo', '--skip-install'], w.env, deps), (error) => error.code === 'VIDEO_INVALID' && /film/.test(error.message));
    const manifestFile = path.join(w.prod, 'videos/code-v1/video.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.template = { format: 'video-template@1', inputs: {} };
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const { runTemplateAction } = await import('../src/videos.js');
    const { resolveConfig } = await import('../src/config.js');
    const config = resolveConfig({ workspace: w.directory });
    await assert.rejects(runTemplateAction(config, { slug: 'demo', name: 'code-v1', action: 'compose' }, deps), (error) => error.code === 'VIDEO_INVALID' && /film/.test(error.message));
});

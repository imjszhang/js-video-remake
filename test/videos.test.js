import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgv } from '../src/args.js';
import { execute } from '../cli/remake.js';
import { runFixedCommand } from '../src/repro/render.js';
import { land } from '../src/media/land.js';
import { downloadedVideo, run, tempWorkspace } from './helpers.js';

const ROOT_PKG = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const exists = (file) => fs.access(file).then(() => true, () => false);

async function production(t) {
    const workspace = await tempWorkspace(t, { videos: { abcdefghijk: downloadedVideo() } });
    await run(['bind', 'abcdefghijk'], workspace.env);
    await run(['start', 'youtube-abcdefghijk', '--as', 'demo'], workspace.env);
    return { ...workspace, prod: path.join(workspace.directory, 'productions', 'demo') };
}

/** Stands in for npm and the package's HyperFrames; records every call. */
function fakeRunner({ checkReport } = {}) {
    const calls = [];
    const runCommand = async (executable, args, opts) => {
        calls.push({ executable, args, cwd: opts.cwd, env: opts.env });
        if (executable === 'npm' && ['ci', 'install'].includes(args[0])) {
            await fs.writeFile(path.join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/hyperframes': { version: ROOT_PKG.dependencies.hyperframes } } }));
            await fs.mkdir(path.join(opts.cwd, 'node_modules/hyperframes/bin'), { recursive: true });
            await fs.writeFile(path.join(opts.cwd, 'node_modules/hyperframes/bin/hyperframes.mjs'), '');
        }
        if (executable === 'npm' && args.join(' ') === 'run render') {
            const manifest = JSON.parse(await fs.readFile(path.join(opts.cwd, 'video.json'), 'utf8'));
            await fs.mkdir(path.dirname(path.join(opts.cwd, manifest.output)), { recursive: true });
            await fs.writeFile(path.join(opts.cwd, manifest.output), `mp4:${calls.length}`);
        }
        if (executable === process.execPath && args[1] === 'check') return { exitCode: 0, stdout: JSON.stringify(checkReport), stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { calls, runCommand };
}

const PROBE = async () => ({ duration: 10, width: 1080, height: 1920, frameRate: '30/1', frames: 300, audioStreams: 0 });
const exec = (argv, env, deps) => execute(parseArgv(argv), env, deps);

test('video:new creates a standalone package that pins its own HyperFrames', async (t) => {
    const w = await production(t);
    const fake = fakeRunner();
    const created = await exec(['video:new', 'demo', '--width', '1280', '--height', '720', '--fps', '30', '--duration', '2'], w.env, fake);
    assert.equal(created.data.video, 'code-v1');
    assert.equal(created.data.installed, 'install');
    const pkg = path.join(w.prod, 'videos/code-v1');
    assert.deepEqual(fake.calls.map((c) => [c.executable, c.args[0], c.cwd]), [['npm', 'install', pkg]]);

    const pkgJson = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8'));
    assert.equal(pkgJson.dependencies.hyperframes, ROOT_PKG.dependencies.hyperframes);
    assert.equal(pkgJson.scripts.render, 'hyperframes render -o renders/code-v1.mp4');
    const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'video.json'), 'utf8'));
    assert.equal(manifest.schema, 'video-package@1');
    assert.deepEqual(manifest.frame, { width: 1280, height: 720, fps: 30, frames: 60 });
    assert.equal(manifest.source.title, 'Fixture video');
    const html = await fs.readFile(path.join(pkg, 'index.html'), 'utf8');
    assert.match(html, /data-width="1280"/);
    assert.match(html, /url\("\.\/fonts\//);
    assert.ok((await fs.readdir(path.join(pkg, 'fonts'))).length > 0);
    for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore']) assert.ok(await exists(path.join(pkg, file)), file);
    for (const file of ['package.json', 'video.json', 'index.html']) assert.doesNotMatch(await fs.readFile(path.join(pkg, file), 'utf8'), /\.\.\//, file);
    for (const file of ['package.json', 'video.json', 'index.html', 'README.md', 'AGENTS.md']) {
        assert.doesNotMatch(await fs.readFile(path.join(pkg, file), 'utf8'), /video-remake|productions\//, file);
    }

    await assert.rejects(exec(['video:new', 'demo', '--as', 'code-v1', '--skip-install'], w.env, fake), { code: 'ALREADY_EXISTS' });
    await assert.rejects(exec(['video:new', 'demo', '--as', 'final', '--skip-install'], w.env, fake), { code: 'INVALID_INPUT' });
    const second = await exec(['video:new', 'demo', '--skip-install'], w.env, fake);
    assert.equal(second.data.video, 'code-v2');
    assert.equal(second.data.installed, null);
});

test('commands pick the only package and ask for --video when there are several', async (t) => {
    const w = await production(t);
    const fake = fakeRunner();
    await assert.rejects(exec(['check', 'demo'], w.env, fake), (error) => error.code === 'NOT_FOUND' && /video:new/.test(error.message));
    await exec(['video:new', 'demo', '--skip-install'], w.env, fake);
    await assert.rejects(exec(['check', 'demo'], w.env, fake), { code: 'VIDEO_NOT_INSTALLED' });
    await exec(['video:new', 'demo', '--as', 'alt-v1', '--skip-install'], w.env, fake);
    await assert.rejects(exec(['check', 'demo'], w.env, fake), (error) => error.code === 'INVALID_INPUT' && /code-v1/.test(error.message) && /alt-v1/.test(error.message));
    await assert.rejects(exec(['check', 'demo', '--video', 'nope-v1'], w.env, fake), { code: 'NOT_FOUND' });
    const listed = await exec(['video:list', 'demo'], w.env, fake);
    assert.deepEqual(listed.data.videos.map((v) => [v.name, v.installed, v.rendered, v.imported]), [['alt-v1', false, false, false], ['code-v1', false, false, false]]);
});

test('check uses the package CLI, keeps reference-faithful contrast as a warning, and parses a large report', async (t) => {
    const w = await production(t);
    const findings = Array.from({ length: 400 }, (_, i) => ({ code: 'line_unread', severity: 'warning', message: `long warning ${i} `.repeat(4) }));
    const report = {
        ok: false,
        contrast: { ok: false, errorCount: 2, findings: [
            { code: 'contrast_aa_failure', severity: 'error', message: 'Contrast is 3.06:1' },
            { code: 'contrast_aa_failure', severity: 'error', message: 'Contrast is 3.06:1' },
        ] },
        craft: { ok: true, errorCount: 0, findings },
    };
    assert.ok(JSON.stringify(report).length > 32 * 1024);
    const fake = fakeRunner({ checkReport: report });
    await exec(['video:new', 'demo'], w.env, fake);
    const result = await exec(['check', 'demo'], w.env, fake);
    assert.equal(result.ok, true);
    assert.equal(result.data.video, 'code-v1');
    assert.equal(result.data.hyperframesCheck, 'passed');
    assert.equal(result.data.warnings.filter((item) => item.code === 'contrast_aa_failure').length, 2);
    const check = fake.calls.find((c) => c.args[1] === 'check');
    assert.equal(check.args[0], path.join(w.prod, 'videos/code-v1/node_modules/hyperframes/bin/hyperframes.mjs'));
    assert.equal(check.cwd, path.join(w.prod, 'videos/code-v1'));
});

test('runFixedCommand keeps the tail by default and the whole output when asked', async () => {
    const script = "process.stdout.write('x'.repeat(100000) + 'END')";
    const short = await runFixedCommand(process.execPath, ['-e', script], { cwd: process.cwd(), env: process.env, timeoutMs: 20_000 });
    assert.equal(short.stdout.length, 32 * 1024);
    assert.ok(short.stdout.endsWith('END'));
    const full = await runFixedCommand(process.execPath, ['-e', script], { cwd: process.cwd(), env: process.env, timeoutMs: 20_000, maxOutputBytes: 1024 * 1024 });
    assert.equal(full.stdout.length, 100003);
});
test('render, import, freeze after import, and fork into the next version', async (t) => {
    const w = await production(t);
    const fake = fakeRunner();
    const deps = { ...fake, probe: PROBE };
    await exec(['video:new', 'demo'], w.env, deps);
    const pkg = path.join(w.prod, 'videos/code-v1');

    await assert.rejects(exec(['video:import', 'demo'], w.env, deps), { code: 'NOT_FOUND' });
    const rendered = await exec(['video:render', 'demo'], w.env, deps);
    assert.deepEqual(rendered.data.steps, ['render']);
    assert.equal(rendered.data.output, 'productions/demo/videos/code-v1/renders/code-v1.mp4');
    assert.ok(fake.calls.every((c) => c.executable !== 'npm' || c.cwd === pkg));

    const imported = await exec(['video:import', 'demo'], w.env, deps);
    assert.equal(imported.data.renderVerified, true);
    assert.equal(imported.data.draft, 'productions/demo/drafts/code-v1/code-v1.mp4');
    const draftManifest = JSON.parse(await fs.readFile(path.join(w.prod, 'drafts/code-v1/MANIFEST.json'), 'utf8'));
    assert.equal(draftManifest.package.name, 'code-v1');
    assert.equal(draftManifest.renders[0].file, 'code-v1.mp4');
    assert.equal(draftManifest.renders[0].frames, 300);
    let entry = (await run(['get', 'demo'], w.env)).data.production;
    assert.equal(entry.drafts.dir, 'productions/demo/drafts/code-v1');
    assert.equal(entry.drafts.activeVersion, 'code-v1');

    // Re-importing an unchanged package is allowed; editing it afterwards is not.
    assert.equal((await exec(['video:import', 'demo'], w.env, deps)).data.reimport, true);
    await fs.appendFile(path.join(pkg, 'index.html'), '<!-- edit -->');
    await exec(['video:render', 'demo'], w.env, deps);
    await assert.rejects(exec(['video:import', 'demo'], w.env, deps), { code: 'VIDEO_FROZEN' });
    const listed = await exec(['video:list', 'demo'], w.env, deps);
    assert.deepEqual(listed.data.videos.map((v) => [v.name, v.rendered, v.imported, v.frozen]), [['code-v1', true, true, true]]);

    const forked = await exec(['video:fork', 'demo'], w.env, deps);
    assert.equal(forked.data.video, 'code-v2');
    assert.equal(forked.data.installed, 'ci');
    const next = path.join(w.prod, 'videos/code-v2');
    assert.equal(await exists(path.join(next, 'renders')), false);
    assert.equal(JSON.parse(await fs.readFile(path.join(next, 'package.json'), 'utf8')).scripts.render, 'hyperframes render -o renders/code-v2.mp4');
    const nextManifest = JSON.parse(await fs.readFile(path.join(next, 'video.json'), 'utf8'));
    assert.equal(nextManifest.version, 2);
    assert.equal(nextManifest.output, 'renders/code-v2.mp4');
    assert.equal(nextManifest.source.forkedFrom.video, 'code-v1');
    assert.match(nextManifest.source.forkedFrom.treeHash, /^[0-9a-f]{64}$/);
    assert.match(await fs.readFile(path.join(next, 'index.html'), 'utf8'), /<!-- edit -->/);

    await exec(['video:render', 'demo', '--video', 'code-v2'], w.env, deps);
    await exec(['video:import', 'demo', '--video', 'code-v2'], w.env, deps);
    entry = (await run(['get', 'demo'], w.env)).data.production;
    assert.equal(entry.drafts.dir, 'productions/demo/drafts/code-v1');
    assert.deepEqual(entry.drafts.versions.map((v) => v.version), ['code-v2']);
    assert.equal(entry.drafts.activeVersion, 'code-v2');
});

test('import refuses a render that video:render did not produce unless forced', async (t) => {
    const w = await production(t);
    const fake = fakeRunner();
    const deps = { ...fake, probe: PROBE };
    await exec(['video:new', 'demo'], w.env, deps);
    const pkg = path.join(w.prod, 'videos/code-v1');
    await fs.mkdir(path.join(pkg, 'renders'));
    await fs.writeFile(path.join(pkg, 'renders/code-v1.mp4'), 'external render');
    await assert.rejects(exec(['video:import', 'demo'], w.env, deps), { code: 'VIDEO_UNVERIFIED' });
    const forced = await exec(['video:import', 'demo', '--force'], w.env, deps);
    assert.equal(forced.data.renderVerified, false);

    await exec(['video:render', 'demo', '--video', 'code-v1'], w.env, deps);
    await fs.writeFile(path.join(pkg, 'renders/code-v1.mp4'), 'replaced after render');
    await assert.rejects(exec(['video:import', 'demo'], w.env, deps), { code: 'VIDEO_UNVERIFIED' });
});

test('video:add copies a ledger asset into the package and timeline uses the package CLI', async (t) => {
    const w = await production(t);
    const fake = fakeRunner();
    await exec(['video:new', 'demo'], w.env, fake);
    const still = path.join(w.directory, 'look.png');
    await fs.writeFile(still, 'png');
    land({ workspace: w.directory, slug: 'demo', kind: 'image', from: still, intent: 'look', provider: 'codex-image.generate', id: 'img-demo-look' });

    const added = await exec(['video:add', 'demo', '--id', 'img-demo-look'], w.env, fake);
    assert.equal(added.data.status, 'copied');
    assert.equal(added.data.path, 'productions/demo/videos/code-v1/assets/image/img-demo-look.png');
    assert.match(added.data.html, /src="\.\/assets\/image\/img-demo-look\.png"/);
    assert.equal((await exec(['video:add', 'demo', '--id', 'img-demo-look'], w.env, fake)).data.status, 'unchanged');
    await fs.writeFile(path.join(w.prod, 'videos/code-v1/assets/image/img-demo-look.png'), 'edited');
    await assert.rejects(exec(['video:add', 'demo', '--id', 'img-demo-look'], w.env, fake), { code: 'ALREADY_EXISTS' });
    assert.equal((await exec(['video:add', 'demo', '--id', 'img-demo-look', '--force'], w.env, fake)).data.status, 'copied');
    await assert.rejects(exec(['video:add', 'demo', '--id', 'img-missing'], w.env, fake), { code: 'NOT_FOUND' });

    const timeline = await exec(['timeline', 'demo', '--json'], w.env, fake);
    assert.equal(timeline.data.video, 'code-v1');
    const call = fake.calls.at(-1);
    assert.deepEqual(call.args.slice(1), ['timeline', path.join(w.prod, 'videos/code-v1'), '--json']);
    assert.equal(call.args[0], path.join(w.prod, 'videos/code-v1/node_modules/hyperframes/bin/hyperframes.mjs'));
});

test('video:pack zips a template package without inputs, generated files or private paths', async (t) => {
    const w = await production(t);
    const fake = fakeRunner();
    await exec(['video:new', 'demo', '--skip-install'], w.env, fake);
    const pkg = path.join(w.prod, 'videos/code-v1');
    await assert.rejects(exec(['video:pack', 'demo'], w.env, fake), (error) => error.code === 'VIDEO_INVALID' && /template/.test(error.message));

    const manifestFile = path.join(pkg, 'video.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.source.forkedFrom = { video: 'code-v0', version: 0, treeHash: 'f'.repeat(64) };
    manifest.template = { format: 'video-template@1', inputs: {}, pack: { exclude: ['SCRIPT.md', 'assets/voice/'] } };
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await fs.writeFile(path.join(pkg, 'inputs.json'), '{"voice":"inputs/me.wav"}');
    await fs.mkdir(path.join(pkg, 'inputs'));
    await fs.writeFile(path.join(pkg, 'inputs/me.wav'), 'private voice');
    await fs.mkdir(path.join(pkg, 'assets/voice'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'assets/voice/v.wav'), 'private');
    await fs.writeFile(path.join(pkg, 'SCRIPT.md'), 'generated');
    await fs.mkdir(path.join(pkg, 'node_modules/x'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'node_modules/x/index.js'), '');
    await fs.writeFile(path.join(pkg, 'notes.md'), 'see /Users/someone/secret/file.mp4');

    await assert.rejects(exec(['video:pack', 'demo'], w.env, fake), (error) => error.code === 'VIDEO_PRIVATE' && /notes\.md/.test(error.message));
    await fs.writeFile(path.join(pkg, 'notes.md'), 'clean');
    const packed = await exec(['video:pack', 'demo'], w.env, fake);
    assert.equal(packed.data.output, `deliverables/demo/templates/${manifest.id}-v1.video`);
    assert.equal(packed.data.registered, true);
    const listed = (await run(['get', 'demo'], w.env)).data.production.templates;
    assert.deepEqual(listed.map((item) => [item.file, item.video]), [[packed.data.output, 'code-v1']]);
    const { readZip } = await import('../src/zip.js');
    const entries = readZip(await fs.readFile(path.join(w.directory, packed.data.output)));
    const names = entries.map((e) => e.name);
    const top = `${manifest.id}-v1/`;
    assert.ok(names.every((n) => n.startsWith(top)), 'one top-level folder');
    const inside = names.map((n) => n.slice(top.length));
    for (const want of ['video.json', 'package.json', 'index.html', 'notes.md', 'inputs/README.md', '.agents/skills/video-template/SKILL.md', '.claude/skills/video-template/SKILL.md']) {
        assert.ok(inside.includes(want), want);
    }
    for (const gone of ['inputs.json', 'inputs/me.wav', 'assets/voice/v.wav', 'SCRIPT.md', 'node_modules/x/index.js']) assert.ok(!inside.includes(gone), gone);
    const packedManifest = JSON.parse(entries.find((e) => e.name === `${top}video.json`).data);
    assert.equal(packedManifest.packed.format, 'video-pack@1');
    assert.match(packedManifest.packed.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(packedManifest.source.forkedFrom, undefined);
    // the package itself is untouched
    assert.ok(JSON.parse(await fs.readFile(manifestFile, 'utf8')).source.forkedFrom);
    await assert.rejects(exec(['video:pack', 'demo'], w.env, fake), { code: 'ALREADY_EXISTS' });
    const elsewhere = await exec(['video:pack', 'demo', '--force', '--out', 'out/t.video'], w.env, fake);
    assert.equal(elsewhere.data.output, 'out/t.video');
    assert.equal(elsewhere.data.registered, false, 'only files under deliverables/<slug>/templates/ are listed');
    await assert.rejects(exec(['video:pack', 'demo', '--out', 'out/t.zip'], w.env, fake), { code: 'INVALID_INPUT' });
});

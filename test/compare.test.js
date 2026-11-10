import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compareProduction } from '../src/compare.js';
import { writeComparisonProject } from '../src/compare-template.js';
import { readCatalog, writeCatalog } from '../src/catalog.js';

const inputMedia = (overrides = {}) => ({
    width: 1280, height: 720, fps: 24, duration: 16, frames: 384,
    hasAudio: true, videoStreams: 1, audioStreams: 1, ...overrides,
});

async function fixture(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-compare-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const config = { workspace, catalogPath: path.join(workspace, 'catalog.json'), assetRoot: '/archive' };
    await writeCatalog(config.catalogPath, {
        version: 1, references: [], productions: [{
            slug: 'demo', dir: 'productions/demo', referenceIds: [], status: 'draft',
            deliverable: { version: 'v3', file: 'film.mp4' },
        }],
    });
    const top = path.join(workspace, 'new take.mp4');
    const bottom = path.join(workspace, 'baseline.mp4');
    await Promise.all([fs.writeFile(top, 'top-video'), fs.writeFile(bottom, 'bottom-video')]);
    const media = new Map([[top, inputMedia()], [bottom, inputMedia()]]);
    const calls = [];
    const projects = new Map();
    const options = { slug: 'demo', top, bottom };
    const deps = {
        progress() {},
        async probeMedia(file) {
            if (media.has(file)) return media.get(file);
            const project = projects.get(path.dirname(file));
            assert.ok(project, `unknown media ${file}`);
            return inputMedia({ width: 1080, height: 1920, fps: project.fps, frames: project.frames, duration: project.frames / project.fps });
        },
        async writeComparisonProject(args) {
            projects.set(args.dir, args);
            return writeComparisonProject(args);
        },
        async writeSilence(file) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, 'silence');
        },
        async renderComparison(args) {
            calls.push(args);
            await fs.writeFile(args.outputFile, 'rendered-comparison');
            return { provider: 'local-hyperframes', version: '0.8.191' };
        },
    };
    return { config, options, deps, media, calls, projects, workspace, top, bottom };
}

test('compare renders a preserved project and registers independently from delivery', async (t) => {
    const f = await fixture(t);
    const result = await compareProduction(f.config, { ...f.options, topLabel: '最新合成', bottomLabel: '原版预览' }, f.deps);
    assert.equal(result.version, 'v1');
    assert.equal(result.manifest.render.audio, 'top');
    assert.equal(result.manifest.render.frames, 384);
    assert.equal(result.manifest.render.duration, 16);
    assert.equal(result.manifest.inputs.top.path, f.top);
    assert.equal(result.manifest.inputs.top.sha256, createHash('sha256').update('top-video').digest('hex'));
    assert.equal(result.manifest.inputs.bottom.label, '原版预览');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].fps, '24');
    assert.equal(result.manifest.render.provider, 'local-hyperframes');
    assert.equal(result.manifest.render.version, '0.8.191');
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(result.file), 'MANIFEST.json'), 'utf8'));
    assert.deepEqual(manifest, result.manifest);
    const composition = path.join(path.dirname(result.file), manifest.project.composition);
    const html = await fs.readFile(composition, 'utf8');
    assert.match(html, /left:28px;top:352px;width:1024px;height:576px/);
    assert.match(html, /left:28px;top:1072px;width:1024px;height:576px/);
    assert.match(html, /#A7F3D0/);
    assert.match(html, /最新合成/);
    assert.match(html, /原版预览/);
    const production = (await readCatalog(f.config.catalogPath)).productions[0];
    assert.equal(production.status, 'draft');
    assert.deepEqual(production.deliverable, { version: 'v3', file: 'film.mp4' });
    assert.deepEqual(production.comparison, {
        version: 'v1', dir: 'productions/demo/drafts/comparisons/v1', file: 'comparison.mp4', manifest: 'MANIFEST.json',
    });
});

test('later comparisons reuse the fixed bottom hash, and reject changed implicit baselines', async (t) => {
    const f = await fixture(t);
    await compareProduction(f.config, { ...f.options, bottomLabel: '固定基准' }, f.deps);
    const options = { slug: 'demo', top: f.top };
    const second = await compareProduction(f.config, options, f.deps);
    assert.equal(second.version, 'v2');
    assert.equal(second.manifest.inputs.bottom.path, f.bottom);
    assert.equal(second.manifest.inputs.bottom.label, '固定基准');
    await fs.writeFile(f.bottom, 'changed-bottom');
    const previousCalls = f.calls.length;
    await assert.rejects(compareProduction(f.config, options, f.deps), /SHA256 已变化/);
    assert.equal(f.calls.length, previousCalls);
    const third = await compareProduction(f.config, f.options, f.deps);
    assert.equal(third.version, 'v3');
    assert.notEqual(third.manifest.inputs.bottom.sha256, second.manifest.inputs.bottom.sha256);
});

test('time selection is explicit, bounded, and normalized to the top frame clock', async (t) => {
    const f = await fixture(t);
    f.media.set(f.bottom, inputMedia({ fps: 30, duration: 20, frames: 600 }));
    await assert.rejects(compareProduction(f.config, f.options, f.deps), /显式指定 duration/);
    await assert.rejects(compareProduction(f.config, { ...f.options, duration: '17' }, f.deps), /超出输入视频/);
    await assert.rejects(compareProduction(f.config, { ...f.options, topStart: '16', duration: '1' }, f.deps), /起始秒数超出/);
    for (const duration of ['nope', '', '-1', '0', Infinity]) {
        await assert.rejects(compareProduction(f.config, { ...f.options, duration }, f.deps), { code: 'COMPARE_INVALID' });
    }
    assert.equal(f.calls.length, 0);
    const result = await compareProduction(f.config, { ...f.options, topStart: '1', bottomStart: '2', duration: '12.5', audio: 'bottom' }, f.deps);
    assert.equal(result.version, 'v1');
    assert.equal(result.manifest.render.frames, 300);
    assert.equal(result.manifest.render.fps, 24);
    assert.equal(result.manifest.inputs.top.startFrame, 24);
    assert.equal(result.manifest.inputs.bottom.startFrame, 48);
    const project = f.projects.get(path.dirname(result.file));
    assert.equal(project.audio, 'bottom');
    assert.equal(project.bottomStartFrame, 48);
    const source = await fs.readFile(path.join(path.dirname(result.file), result.manifest.project.composition), 'utf8');
    assert.match(source, /id="bottom-picture"[^>]*data-media-start="2"/);
    assert.match(source, /id="sound"[^>]*data-media-start="2"/);
});

test('selected audio must exist; none produces a silent-audio comparison without input audio', async (t) => {
    const f = await fixture(t);
    f.media.set(f.top, inputMedia({ hasAudio: false, audioStreams: 0 }));
    f.media.set(f.bottom, inputMedia({ hasAudio: false, audioStreams: 0 }));
    for (const audio of ['top', 'bottom']) {
        await assert.rejects(compareProduction(f.config, { ...f.options, audio }, f.deps), /没有音轨/);
    }
    await assert.rejects(compareProduction(f.config, { ...f.options, audio: 'both' }, f.deps), /audio 必须是/);
    const result = await compareProduction(f.config, { ...f.options, audio: 'none' }, f.deps);
    assert.equal(result.manifest.render.audio, 'none');
    assert.equal(result.manifest.verification.audioStreams, 1);
    const source = await fs.readFile(path.join(path.dirname(result.file), result.manifest.project.composition), 'utf8');
    assert.match(source, /id="sound" src="\.\/silence\.m4a"/);
    assert.match(source, /muted playsinline/);
    await fs.access(path.join(path.dirname(result.file), 'composition/silence.m4a'));
});

test('failed media verification retains the failed version without advancing the catalog', async (t) => {
    const f = await fixture(t);
    const good = await compareProduction(f.config, f.options, f.deps);
    const originalProbe = f.deps.probeMedia;
    f.deps.probeMedia = async (file) => {
        const media = await originalProbe(file);
        return file.endsWith('comparison.mp4') ? { ...media, frames: 383 } : media;
    };
    await assert.rejects(compareProduction(f.config, f.options, f.deps), { code: 'COMPARE_VERIFY_FAILED' });
    const failure = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(good.file)), 'v2/FAILED.json'), 'utf8'));
    assert.equal(failure.stage, 'verify');
    assert.equal(failure.buildId, undefined);
    assert.equal(failure.version, 'v2');
    const production = (await readCatalog(f.config.catalogPath)).productions[0];
    assert.equal(production.comparison.version, 'v1');
    await fs.access(good.file);
    f.deps.probeMedia = originalProbe;
    assert.equal((await compareProduction(f.config, f.options, f.deps)).version, 'v3');
});

test('a failed render is recorded without publishing the comparison', async (t) => {
    const f = await fixture(t);
    f.deps.renderComparison = async () => {
        throw Object.assign(new Error('render crashed'), { code: 'COMPARE_RENDER_FAILED' });
    };
    await assert.rejects(compareProduction(f.config, f.options, f.deps), /render crashed/);
    assert.equal(f.calls.length, 0);
    const failure = JSON.parse(await fs.readFile(path.join(f.workspace, 'productions/demo/drafts/comparisons/v1/FAILED.json'), 'utf8'));
    assert.equal(failure.stage, 'render');
    assert.equal(failure.buildId, undefined);
    assert.equal((await readCatalog(f.config.catalogPath)).productions[0].comparison, undefined);
});

test('publication preserves production edits and does not move a newer comparison backwards', async (t) => {
    const f = await fixture(t);
    const originalRender = f.deps.renderComparison;
    f.deps.renderComparison = async (args) => {
        const catalog = await readCatalog(f.config.catalogPath);
        catalog.productions[0].status = 'reviewed';
        catalog.productions[0].note = 'edited during build';
        catalog.productions[0].comparison = { version: 'v9', dir: 'newer-comparison', file: 'comparison.mp4' };
        await writeCatalog(f.config.catalogPath, catalog);
        return originalRender(args);
    };
    const result = await compareProduction(f.config, f.options, f.deps);
    assert.equal(result.version, 'v1');
    assert.equal(result.production.status, 'reviewed');
    assert.equal(result.production.comparison.version, 'v9');
    assert.equal(result.production.note, 'edited during build');
    await fs.access(path.join(path.dirname(result.file), 'MANIFEST.json'));
});

test('overlapping builds reserve different versions and an older completion preserves the newer pointer', async (t) => {
    const f = await fixture(t);
    let releaseFirst;
    let firstStarted;
    const waiting = new Promise((resolve) => { firstStarted = resolve; });
    const hold = new Promise((resolve) => { releaseFirst = resolve; });
    const originalWrite = f.deps.writeComparisonProject;
    f.deps.writeComparisonProject = async (args) => {
        if (path.basename(args.dir) === 'v1') {
            firstStarted();
            await hold;
        }
        return originalWrite(args);
    };
    const firstPromise = compareProduction(f.config, f.options, f.deps);
    await waiting;
    const second = await compareProduction(f.config, f.options, f.deps);
    assert.equal(second.version, 'v2');
    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.version, 'v1');
    assert.notEqual(first.file, second.file);
    assert.equal((await readCatalog(f.config.catalogPath)).productions[0].comparison.version, 'v2');
});

test('simultaneous completions wait for the short publication lock and keep the greatest version', async (t) => {
    const f = await fixture(t);
    const lock = `${f.config.catalogPath}.compare-lock`;
    await fs.mkdir(lock);
    let exportsDone = 0;
    let notifyExports;
    const bothExported = new Promise((resolve) => { notifyExports = resolve; });
    const originalRender = f.deps.renderComparison;
    f.deps.renderComparison = async (args) => {
        const result = await originalRender(args);
        if (++exportsDone === 2) notifyExports();
        return result;
    };
    const first = compareProduction(f.config, f.options, f.deps);
    const second = compareProduction(f.config, f.options, f.deps);
    await bothExported;
    assert.equal((await readCatalog(f.config.catalogPath)).productions[0].comparison, undefined);
    await fs.rmdir(lock);
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.version).sort(), ['v1', 'v2']);
    assert.equal((await readCatalog(f.config.catalogPath)).productions[0].comparison.version, 'v2');
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

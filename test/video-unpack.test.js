import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { packVideo, unpackVideo } from '../src/videos.js';
import { readZip, writeZip } from '../src/zip.js';
import { parseArgv } from '../src/args.js';
import { execute } from '../cli/remake.js';

const rootPackage = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const hyperframes = rootPackage.dependencies.hyperframes;
const missing = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });

function templateFiles() {
    return {
        'video.json': { schema: 'video-package@1', id: 'demo', version: 1, title: '导入测试模板', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, entry: 'index.html', output: 'renders/out.mp4', template: { format: 'video-template@1', inputs: {} } },
        'package.json': { dependencies: { hyperframes }, scripts: { inputs: 'node never-run.mjs', build: 'node never-run.mjs', compose: 'node never-run.mjs', render: 'node never-run.mjs', postinstall: 'node never-run.mjs' } },
        'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes } }, 'node_modules/hyperframes': { version: hyperframes } } },
        'never-run.mjs': 'throw new Error("Import must never execute me");\n',
        'assets/data.bin': Buffer.from([0, 255, 34, 128]),
    };
}
function archive(files) {
    return writeZip(Object.entries(files).map(([name, data]) => ({ name: `demo-v1/${name}`, data: Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data) })));
}
async function fixture(t, files = templateFiles()) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-unpack-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const file = path.join(root, 'download.video');
    const buffer = archive(files);
    await fs.writeFile(file, buffer);
    const config = { workspace, catalogPath: path.join(workspace, 'catalog.json') };
    return { root, file, buffer, config, workspace };
}

test('unpack creates an offline production, preserves archive bytes and records only relative provenance', async t => {
    const files = templateFiles();
    const f = await fixture(t, files);
    let calls = 0;
    const result = await unpackVideo(f.config, { file: f.file }, { runCommand: () => { calls++; throw new Error('Must not run'); }, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(calls, 0);
    assert.equal(result.command, 'video:unpack');
    assert.equal(result.slug, 'demo');
    assert.equal(result.dir, 'productions/demo/videos/demo-v1');
    assert.equal(result.installed, false);
    assert.equal(result.sha256, createHash('sha256').update(f.buffer).digest('hex'));
    assert.deepEqual(await fs.readFile(f.file), f.buffer);
    for (const [name, value] of Object.entries(files)) {
        const data = Buffer.isBuffer(value) || typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
        assert.deepEqual(await fs.readFile(path.join(f.workspace, result.dir, name)), data, name);
    }
    const catalogText = await fs.readFile(f.config.catalogPath, 'utf8');
    assert.ok(!catalogText.includes(f.root));
    const catalog = JSON.parse(catalogText);
    assert.deepEqual(catalog.references, []);
    assert.equal(catalog.productions[0].templateImport.importedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(catalog.productions[0].status, 'commissioned');
    await missing(path.join(f.workspace, result.dir, 'node_modules'));
    await missing(`${f.config.catalogPath}.template-import.lock`);
});

test('CLI unpack routes file and --as, and leaves existing catalog entries intact', async t => {
    const f = await fixture(t);
    const prior = { version: 1, references: [{ id: 'ref', title: '参考' }], productions: [{ slug: 'existing', dir: 'productions/existing', drafts: { version: 'v1' } }] };
    await fs.writeFile(f.config.catalogPath, JSON.stringify(prior));
    const result = await execute(parseArgv(['video:unpack', f.file, '--as', 'my-template', '--workspace', f.workspace]), {});
    assert.equal(result.data.slug, 'my-template');
    const catalog = JSON.parse(await fs.readFile(f.config.catalogPath, 'utf8'));
    assert.deepEqual(catalog.references, prior.references);
    assert.deepEqual(catalog.productions[0], prior.productions[0]);
    assert.equal(catalog.productions[1].slug, 'my-template');
    await assert.rejects(execute(parseArgv(['video:unpack', '--workspace', f.workspace]), {}), { code: 'INVALID_INPUT' });
});

test('duplicates never overwrite catalog or existing directories, and explicit new names work', async t => {
    const f = await fixture(t);
    const first = await unpackVideo(f.config, { file: f.file });
    const catalog = await fs.readFile(f.config.catalogPath);
    await assert.rejects(unpackVideo(f.config, { file: f.file }), { code: 'ALREADY_EXISTS' });
    assert.deepEqual(await fs.readFile(f.config.catalogPath), catalog);
    await fs.mkdir(path.join(f.workspace, 'productions/orphan'));
    await fs.writeFile(path.join(f.workspace, 'productions/orphan/keep'), 'keep');
    await assert.rejects(unpackVideo(f.config, { file: f.file, slug: 'orphan' }), { code: 'ALREADY_EXISTS' });
    assert.equal(await fs.readFile(path.join(f.workspace, 'productions/orphan/keep'), 'utf8'), 'keep');
    assert.deepEqual(await fs.readFile(f.config.catalogPath), catalog);
    assert.equal((await unpackVideo(f.config, { file: f.file, slug: 'second' })).video, first.video);
});

test('invalid archive and malformed template contracts do not create catalog or production', async t => {
    const cases = [
        ['not zip', () => Buffer.from('broken')],
        ['missing manifest', files => { delete files['video.json']; }],
        ['missing lock', files => { delete files['package-lock.json']; }],
        ['wrong schema', files => { files['video.json'].schema = 'other'; }],
        ['wrong template format', files => { files['video.json'].template.format = 'other'; }],
        ['wrong package version', files => { files['video.json'].version = 2; }],
        ['wrong renderer', files => { files['package.json'].dependencies.hyperframes = '0.0.1'; }],
        ['wrong lock renderer', files => { files['package-lock.json'].packages['node_modules/hyperframes'].version = '0.0.1'; }],
        ['wrong root lock renderer', files => { files['package-lock.json'].packages[''].dependencies.hyperframes = '0.0.1'; }],
        ['missing render script', files => { delete files['package.json'].scripts.render; }],
        ['invalid frame', files => { files['video.json'].frame.frames = 0; }],
        ['outside entry', files => { files['video.json'].entry = '../index.html'; }],
        ['outside output', files => { files['video.json'].output = '/tmp/out.mp4'; }],
    ];
    for (const [label, mutate] of cases) {
        await t.test(label, async child => {
            const files = templateFiles();
            const buffer = mutate(files);
            const f = await fixture(child, files);
            if (Buffer.isBuffer(buffer)) await fs.writeFile(f.file, buffer);
            await assert.rejects(unpackVideo(f.config, { file: f.file }), { code: 'VIDEO_INVALID' });
            await missing(f.config.catalogPath);
            await missing(path.join(f.workspace, 'productions'));
        });
    }
});

test('failed extraction rolls back production and releases import lock while preserving catalog', async t => {
    const files = templateFiles();
    files['x'.repeat(300)] = 'cannot be written on supported filesystems';
    const f = await fixture(t, files);
    const catalog = JSON.stringify({ version: 1, references: [], productions: [{ slug: 'existing', dir: 'productions/existing' }] });
    await fs.writeFile(f.config.catalogPath, catalog);
    await assert.rejects(unpackVideo(f.config, { file: f.file }), { code: 'ENAMETOOLONG' });
    await missing(path.join(f.workspace, 'productions/demo'));
    await missing(`${f.config.catalogPath}.template-import.lock`);
    await missing(`${f.config.catalogPath}.template-import.lock.json`);
    assert.equal(await fs.readFile(f.config.catalogPath, 'utf8'), catalog);
    await fs.writeFile(f.file, archive(templateFiles()));
    assert.equal((await unpackVideo(f.config, { file: f.file })).slug, 'demo');
});

test('invalid slug and an existing import lock leave the workspace unchanged', async t => {
    const f = await fixture(t);
    await assert.rejects(unpackVideo(f.config, { file: f.file, slug: '../outside' }), { code: 'INVALID_INPUT' });
    await missing(f.config.catalogPath);
    await fs.writeFile(`${f.config.catalogPath}.template-import.lock`, 'another import');
    await assert.rejects(unpackVideo(f.config, { file: f.file }), { code: 'ALREADY_EXISTS' });
    assert.equal(await fs.readFile(`${f.config.catalogPath}.template-import.lock`, 'utf8'), 'another import');
    await missing(f.config.catalogPath);
});

test('import leaves a preexisting legacy temporary symlink and its target untouched', async t => {
    const f = await fixture(t);
    const outside = path.join(f.root, 'important.json');
    await fs.writeFile(outside, 'private content');
    const legacyTemp = `${f.config.catalogPath}.template-import.lock.json`;
    await fs.symlink(outside, legacyTemp);
    assert.equal((await unpackVideo(f.config, { file: f.file })).slug, 'demo');
    assert.equal(await fs.readFile(outside, 'utf8'), 'private content');
    assert.equal(await fs.readlink(legacyTemp), outside);
    await missing(`${f.config.catalogPath}.template-import.lock`);
    assert.deepEqual((await fs.readdir(f.workspace)).filter(name => name.startsWith('.template-catalog-')), []);
});

test('imported templates can be repacked with exactly one refreshed copy of each bundled skill', async t => {
    const files = templateFiles();
    files['.agents/skills/video-template/SKILL.md'] = 'old bundled skill';
    files['.claude/skills/video-template/SKILL.md'] = 'old bundled skill';
    const f = await fixture(t, files);
    await unpackVideo(f.config, { file: f.file });
    const packed = await packVideo(f.config, { slug: 'demo' });
    const entries = readZip(await fs.readFile(path.join(f.workspace, packed.output)));
    for (const prefix of ['.agents', '.claude']) {
        const skillEntries = entries.filter(entry => entry.name === `demo-v1/${prefix}/skills/video-template/SKILL.md`);
        assert.equal(skillEntries.length, 1);
        assert.notEqual(skillEntries[0].data.toString('utf8'), 'old bundled skill');
    }
    const second = await unpackVideo(f.config, { file: packed.output, slug: 'roundtrip' });
    assert.equal(second.video, 'demo-v1');
    assert.deepEqual(await fs.readFile(path.join(f.workspace, second.dir, 'assets/data.bin')), files['assets/data.bin']);
});

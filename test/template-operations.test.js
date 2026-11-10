import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getTemplateEditor, saveTemplateInputs, storeTemplateAsset, runTemplateAction } from '../src/videos.js';

async function fixture(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'template-editor-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const dir = path.join(workspace, 'productions/demo/videos/demo-v1');
    const config = { workspace, catalogPath: path.join(workspace, 'catalog.json') };
    const options = { slug: 'demo', name: 'demo-v1' };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(config.catalogPath, JSON.stringify({ version: 1, references: [], productions: [{ slug: 'demo', dir: 'productions/demo', referenceIds: [] }] }));
    await fs.writeFile(path.join(dir, 'video.json'), JSON.stringify({ schema: 'video-package@1', id: 'demo', version: 1, title: '模板', entry: 'index.html', output: 'renders/demo-v1.mp4', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, template: { format: 'video-template@1', inputs: { presenter: { objectPosition: '50% 30%' }, voice: {}, music: {}, identity: { fields: { name: { default: '你的名字' }, badge: { default: 'YOU' } } }, captions: { count: 1 }, texts: {} } } }));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'build', inputs: 'inputs', render: 'render' } }));
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    const write = async (relative, contents) => { await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true }); await fs.writeFile(path.join(dir, relative), contents); };
    return { workspace, dir, config, options, write };
}

function runner(f, { report = { ok: true, errors: [], warnings: ['使用默认配乐'], info: [] }, cancel = false } = {}) {
    const calls = [];
    return { calls, runCommand: async (executable, args, opts) => {
        calls.push({ executable, args, opts });
        if (cancel) return { exitCode: null, termination: 'cancelled', stdout: '', stderr: '' };
        if (args[0] === 'ci') await f.write('node_modules/hyperframes/bin/hyperframes.mjs', '');
        if (args.includes('--init')) await f.write('inputs.json', '{}');
        if (args.includes('build')) { await f.write('SCRIPT.md', '# 录制稿\n'); await f.write('index.html', '<html></html>'); }
        if (args.includes('--json')) return { exitCode: report.ok ? 0 : 1, stdout: JSON.stringify(report), stderr: '' };
        if (args.includes('snapshot')) await f.write('.work/preview/contact-sheet.jpg', 'image');
        if (args.includes('render')) await f.write('renders/demo-v1.mp4', 'film');
        return { exitCode: 0, stdout: '', stderr: '' };
    }, probe: async () => ({ duration: 10, frames: 300, width: 1280, height: 720, frameRate: '30/1', audioStreams: 1 }) };
}

test('editor defaults are readable without executing or writing; identity and uploaded inputs persist', async t => {
    const f = await fixture(t);
    const initial = await getTemplateEditor(f.config, f.options);
    assert.equal(initial.installed, false);
    assert.equal(initial.frozen, false);
    assert.equal(initial.inputs.identity.name, '你的名字');
    await assert.rejects(fs.stat(path.join(f.dir, 'inputs.json')), { code: 'ENOENT' });
    const source = path.join(f.workspace, 'video.mp4'); await fs.writeFile(source, 'media');
    const asset = await storeTemplateAsset(f.config, { ...f.options, file: source, kind: 'presenter', filename: 'my video.mp4' });
    assert.match(asset.path, /^inputs\/uploads\/presenter-[a-f0-9-]+\.mp4$/);
    const saved = await saveTemplateInputs(f.config, { ...f.options, inputs: { ...initial.inputs, presenter: { ...initial.inputs.presenter, src: asset.path }, voice: asset.path, identity: { name: '小林' } } });
    assert.equal(saved.inputs.identity.badge, 'YOU');
    assert.equal((await getTemplateEditor(f.config, f.options)).inputs.voice, asset.path);
    await assert.rejects(saveTemplateInputs(f.config, { ...f.options, inputs: { identity: { unknown: 'no' } } }), { code: 'INVALID_INPUT' });
    await assert.rejects(saveTemplateInputs(f.config, { ...f.options, inputs: { unrelated: 'no' } }), { code: 'INVALID_INPUT' });
});

test('editor rejects external and symlink asset paths and invalid JSON before writing', async t => {
    const f = await fixture(t);
    for (const voice of ['/tmp/private.wav', 'inputs/../secret.wav', 'assets/voice.wav']) await assert.rejects(saveTemplateInputs(f.config, { ...f.options, inputs: { voice } }));
    await fs.mkdir(path.join(f.dir, 'inputs'));
    const external = path.join(f.workspace, 'private.wav'); await fs.writeFile(external, 'private');
    await fs.symlink(external, path.join(f.dir, 'inputs/link.wav'));
    await assert.rejects(saveTemplateInputs(f.config, { ...f.options, inputs: { voice: 'inputs/link.wav' } }), { code: 'VIDEO_INVALID' });
    const source = path.join(f.workspace, 'captions.json'); await fs.writeFile(source, '[]');
    await assert.rejects(storeTemplateAsset(f.config, { ...f.options, file: source, kind: 'captions', filename: 'captions.json' }), { code: 'VIDEO_INVALID' });
    await fs.writeFile(source, '[{"zh":"中文","en":"English"}]');
    const asset = await storeTemplateAsset(f.config, { ...f.options, file: source, kind: 'captions', filename: 'captions.json' });
    assert.equal((await saveTemplateInputs(f.config, { ...f.options, inputs: { captions: asset.path } })).inputs.captions, asset.path);
});

test('prepare installs only once and preserves inputs; preview uses bounded numeric moments and fixed output', async t => {
    const f = await fixture(t), deps = runner(f), stages = [];
    deps.onProgress = state => stages.push(state.stage);
    await saveTemplateInputs(f.config, { ...f.options, inputs: { identity: { name: '我的名字' } } });
    const prepared = await runTemplateAction(f.config, { ...f.options, action: 'prepare' }, deps);
    assert.equal(prepared.installed, true); assert.equal(prepared.inputs.identity.name, '我的名字');
    assert.match(prepared.script, /录制稿/);
    await runTemplateAction(f.config, { ...f.options, action: 'prepare' }, deps);
    assert.equal(deps.calls.filter(call => call.args[0] === 'ci').length, 1);
    await f.write('.work/preview/old-frame.png', 'old preview');
    const preview = await runTemplateAction(f.config, { ...f.options, action: 'preview', at: [1, 5, 8] }, deps);
    assert.deepEqual(preview.previewFiles, ['contact-sheet.jpg']);
    assert.ok(stages.includes('preview'));
    assert.equal(deps.calls.find(call => call.args.includes('snapshot')).args.at(-1), '.work/preview');
    await assert.rejects(runTemplateAction(f.config, { ...f.options, action: 'preview', at: [-1] }, deps), { code: 'INVALID_INPUT' });
});

test('check returns errors; compose blocks invalid inputs and propagates cancellation', async t => {
    const f = await fixture(t), deps = runner(f, { report: { ok: false, errors: ['口播太短'], warnings: [], info: [] } });
    const checked = await runTemplateAction(f.config, { ...f.options, action: 'check' }, deps);
    assert.equal(checked.report.ok, false);
    await assert.rejects(runTemplateAction(f.config, { ...f.options, action: 'compose' }, deps), error => error.code === 'VIDEO_INPUTS_INVALID' && error.data.report.errors[0] === '口播太短');
    assert.ok(!deps.calls.some(call => call.args.includes('render')));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runTemplateAction(f.config, { ...f.options, action: 'compose' }, { ...deps, signal: controller.signal }), { code: 'VIDEO_CANCELLED' });
    await assert.rejects(runTemplateAction(f.config, { ...f.options, action: 'prepare' }, runner(f, { cancel: true })), { code: 'VIDEO_CANCELLED' });
});

test('compose renders and registers a verified frozen draft; only fork permits subsequent edits', async t => {
    const f = await fixture(t), deps = runner(f), signal = new AbortController().signal;
    const composed = await runTemplateAction(f.config, { ...f.options, action: 'compose' }, { ...deps, signal });
    assert.equal(composed.imported.renderVerified, true);
    assert.equal((await getTemplateEditor(f.config, f.options)).frozen, true);
    assert.ok(deps.calls.every(call => call.opts.signal === signal));
    for (const action of ['prepare', 'preview', 'compose']) await assert.rejects(runTemplateAction(f.config, { ...f.options, action }, deps), { code: 'VIDEO_FROZEN' });
    await assert.rejects(saveTemplateInputs(f.config, { ...f.options, inputs: {} }), { code: 'VIDEO_FROZEN' });
    await assert.rejects(storeTemplateAsset(f.config, { ...f.options, kind: 'voice', filename: 'voice.wav' }), { code: 'VIDEO_FROZEN' });
    const fork = await runTemplateAction(f.config, { ...f.options, action: 'fork' }, deps);
    assert.match(fork.video, /^template-[a-f0-9]{12}-v1$/);
    assert.equal((await getTemplateEditor(f.config, { ...f.options, name: fork.video })).frozen, false);
});

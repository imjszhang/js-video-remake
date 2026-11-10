import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateTemplate, templateAgentOptions } from '../src/template-agent.js';
import { treeHash } from '../src/videos.js';
import { executeAgent } from '../src/agent.js';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).dependencies.hyperframes;
async function fixture(t) {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'template-agent-test-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'template-agent-records-'));
    t.after(() => fs.rm(storage, { recursive: true, force: true }));
    const dir = path.join(workspace, 'productions/demo/videos/demo-v1');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    const config = { workspace, catalogPath: path.join(workspace, 'catalog.json'), env: { VIDEO_REMAKE_AGENT_HOME: storage } };
    const manifest = { schema: 'video-package@1', id: 'demo', version: 1, title: '原模板', entry: 'index.html', output: 'renders/demo-v1.mp4', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, template: { format: 'video-template@1', inputs: { identity: { fields: { name: { default: '你的名字' } } } }, pack: { exclude: ['index.html', 'SCRIPT.md', 'slots.json', 'assets/audio/'] } } };
    const pkg = { dependencies: { hyperframes: version }, scripts: { inputs: 'node inputs.mjs', build: 'node build.mjs', compose: 'node compose.mjs', render: 'hyperframes render -o renders/demo-v1.mp4' } };
    const files = {
        'video.json': manifest, 'package.json': pkg,
        'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: pkg.dependencies }, 'node_modules/hyperframes': { version } } },
        'src/shared.css': ':root { --bg: #101010; --ink: #fafafa; --blue: #4488ff; --gold: #ffaa44; }\n#root {}\n.cap-zh {}\n.slot {}',
        'build.mjs': "const read = () => ''; read('src/shared.css');\n",
        'inputs.json': { identity: { name: 'PRIVATE NAME' } },
    };
    for (const [relative, value] of Object.entries(files)) await fs.writeFile(path.join(dir, relative), typeof value === 'string' ? value : JSON.stringify(value));
    await fs.writeFile(config.catalogPath, JSON.stringify({ version: 1, references: [], productions: [{ slug: 'demo', dir: 'productions/demo', referenceIds: [] }] }));
    await fs.writeFile(path.join(workspace, 'agent-runtime.json'), JSON.stringify({ schemaVersion: 1, defaultTarget: 'fixture', targets: [{ name: 'fixture', enabled: true, harness: { adapter: 'codex', executable: process.execPath, permission: 'workspace-write' }, backend: { auth: 'chatgpt', model: 'fixture' } }] }));
    const calls = [];
    const deps = {
        executeAgent: async (child, action, options) => {
            calls.push({ child, action, options });
            assert(!child.workspace.startsWith(workspace));
            assert.equal(action, 'run');
            await fs.appendFile(path.join(child.workspace, 'src/shared.css'), '\n.k-title { letter-spacing: 2px; }');
            return { run: { id: `fixture-${calls.length}`, status: 'completed', execution: { text: '已调整标题排版。', responseModel: 'verified-model' } } };
        },
        runTemplateAction: async (child, options) => {
            if (options.action === 'preview') {
                const output = path.join(child.workspace, 'productions/demo/videos', options.name, '.work/preview');
                await fs.mkdir(output, { recursive: true });
                await fs.writeFile(path.join(output, 'frame.png'), 'preview');
                return { previewFiles: ['frame.png'], report: { ok: true, errors: [], warnings: [], info: [] } };
            }
            return { report: { ok: true, errors: [], warnings: [], info: [] } };
        },
        checkVideo: async () => ({ ok: true }),
    };
    return { config, dir, calls, deps, options: { slug: 'demo', name: 'demo-v1', title: '新版', prompt: '调整标题布局并增加留白。' } };
}

test('prompt generation actually runs an isolated Agent, validates source edits, and preserves the original', async t => {
    const f = await fixture(t);
    const before = await treeHash(f.dir);
    const result = await generateTemplate(f.config, f.options, f.deps);
    assert.equal(result.command, 'video:generate');
    assert.match(result.video, /^template-[a-f0-9]{12}-v1$/);
    assert.equal(result.agentRunId, 'fixture-1');
    assert.equal(await treeHash(f.dir), before);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].options.instruction, /调整标题布局并增加留白/);
    const next = path.join(f.config.workspace, result.dir);
    assert.match(await fs.readFile(path.join(next, 'src/shared.css'), 'utf8'), /letter-spacing/);
    const record = JSON.parse(await fs.readFile(path.join(next, '.work/generation.json')));
    assert.equal(record.prompt, f.options.prompt);
    assert.equal(record.agentLabel, 'Codex CLI · OpenAI / ChatGPT · verified-model（最近返回）');
    assert.equal(record.provider, 'OpenAI / ChatGPT');
    assert.equal(record.configuredModel, 'fixture');
    assert.equal(record.actualModel, 'verified-model');
    assert.equal(record.harness, 'Codex CLI');
    assert.equal(record.model, 'fixture');
    assert.equal(result.agentLabel, record.agentLabel);
    await assert.rejects(fs.access(path.join(next, 'inputs.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(next, '.work/preview/frame.png'), 'utf8'), 'preview');
    await assert.rejects(fs.access(f.calls[0].child.workspace), { code: 'ENOENT' });
});

test('a failed independent validation is fed back to the Agent once before publishing', async t => {
    const f = await fixture(t);
    let checks = 0;
    const result = await generateTemplate(f.config, f.options, { ...f.deps, checkVideo: async () => ({ ok: ++checks > 1, errors: ['overlap'] }) });
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].options.instruction, /没有通过宿主检查/);
    assert.equal(result.agentRunId, 'fixture-2');
});

test('no-op and dependency-changing Agent results never publish a new template', async t => {
    for (const kind of ['noop', 'lock', 'lineage']) {
        const f = await fixture(t);
        let attempts = 0;
        await assert.rejects(generateTemplate(f.config, f.options, { ...f.deps, executeAgent: async child => {
            attempts++;
            if (kind === 'lock') await fs.writeFile(path.join(child.workspace, 'package-lock.json'), '{}');
            if (kind === 'lineage') {
                const file = path.join(child.workspace, 'video.json');
                const manifest = JSON.parse(await fs.readFile(file));
                manifest.template.lineage.id = 'tampered';
                await fs.writeFile(file, JSON.stringify(manifest));
                await fs.appendFile(path.join(child.workspace, 'src/shared.css'), '\n.title {color:red}');
            }
            return { run: { id: 'noop', status: 'completed' } };
        } }), { code: 'VIDEO_GENERATION_INVALID' });
        assert.equal(attempts, 2);
        assert.deepEqual(await fs.readdir(path.join(f.config.workspace, 'productions/demo/videos')), ['demo-v1']);
    }
});

test('cancelled and failed Agent execution roll back the reserved version', async t => {
    const f = await fixture(t);
    const abort = new AbortController();
    await assert.rejects(generateTemplate(f.config, f.options, { ...f.deps, signal: abort.signal, executeAgent: async () => {
        abort.abort();
        return { run: { id: 'cancelled-run', status: 'completed' } };
    } }), { code: 'VIDEO_CANCELLED' });
    assert.deepEqual(await fs.readdir(path.join(f.config.workspace, 'productions/demo/videos')), ['demo-v1']);
    await assert.rejects(generateTemplate(f.config, f.options, { ...f.deps, executeAgent: async () => { throw new Error('provider offline'); } }), /provider offline/);
    assert.deepEqual(await fs.readdir(path.join(f.config.workspace, 'productions/demo/videos')), ['demo-v1']);
});

test('Agent options contain safe harness and model display metadata and inputs are validated first', async t => {
    const f = await fixture(t);
    assert.deepEqual(await templateAgentOptions(f.config), { available: true, targets: [{ name: 'fixture', harness: 'Codex CLI', model: 'fixture', label: 'Codex CLI · OpenAI / ChatGPT · fixture（配置）', provider: 'OpenAI / ChatGPT', providerUrl: null, configuredModel: 'fixture', configurationSource: '项目执行配置', available: true, unavailableReason: null }], providers: [{ baseURL: '', protocol: 'responses', managed: false, hasApiKey: false, id: 'fixture', names: ['fixture'], models: ['fixture'], label: 'OpenAI / ChatGPT', providerUrl: null, compatibleTargets: ['fixture'] }], defaultTarget: 'fixture', error: null });
    await assert.rejects(generateTemplate(f.config, { ...f.options, prompt: '' }, f.deps), { code: 'INVALID_INPUT' });
    await assert.rejects(generateTemplate(f.config, { ...f.options, target: 'missing' }, f.deps), { code: 'CONFIG_INVALID' });
    assert.equal(f.calls.length, 0);
});

test('Agent logs are retained in host storage after the temporary workspace is removed', async t => {
    const f = await fixture(t);
    const original = f.deps.executeAgent;
    f.deps.executeAgent = async (...args) => {
        const result = await original(...args);
        const runDir = path.join(args[0].workspace, '.work/mock-run');
        await fs.mkdir(path.join(runDir, 'runtime'), { recursive: true });
        await fs.writeFile(path.join(runDir, 'runtime/stdout.log'), 'Agent log');
        return { run: { ...result.run, workspace: args[0].workspace, runDir } };
    };
    const result = await generateTemplate(f.config, f.options, f.deps);
    const logs = await executeAgent(f.config, 'logs', { runId: result.agentRunId });
    assert.equal(logs.text, 'Agent log');
    assert.equal((await executeAgent(f.config, 'status', { runId: result.agentRunId })).run.status, 'completed');
});

test('cancellation before publication commits removes the new template', async t => {
    const f = await fixture(t);
    const abort = new AbortController();
    await assert.rejects(generateTemplate(f.config, f.options, { ...f.deps, signal: abort.signal, onProgress: ({ stage }) => { if (stage === 'publish') abort.abort(); } }), { code: 'VIDEO_CANCELLED' });
    assert.deepEqual(await fs.readdir(path.join(f.config.workspace, 'productions/demo/videos')), ['demo-v1']);
});

test('validation catches changes introduced by build or preview scripts before publication', async t => {
    const f = await fixture(t);
    const action = f.deps.runTemplateAction;
    f.deps.runTemplateAction = async (...args) => {
        const result = await action(...args);
        if (args[1].action === 'preview') await fs.writeFile(path.join(args[0].workspace, 'productions/demo/videos', args[1].name, 'package-lock.json'), '{}');
        return result;
    };
    await assert.rejects(generateTemplate(f.config, f.options, f.deps), { code: 'VIDEO_GENERATION_INVALID' });
    assert.deepEqual(await fs.readdir(path.join(f.config.workspace, 'productions/demo/videos')), ['demo-v1']);
});

test('missing Harness is rejected before copying templates or invoking tools', async t => {
    const f = await fixture(t);
    const file = path.join(f.config.workspace, 'agent-runtime.json');
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    settings.targets[0].harness.executable = path.join(f.config.workspace, 'missing-private-cli');
    await fs.writeFile(file, JSON.stringify(settings));
    const before = await treeHash(f.dir);
    await assert.rejects(generateTemplate(f.config, f.options, f.deps), error => error.code === 'AGENT_NOT_READY' && /Codex CLI 启动程序不存在/.test(error.message) && !error.message.includes(f.config.workspace));
    assert.deepEqual(await fs.readdir(path.join(f.config.workspace, 'productions/demo/videos')), ['demo-v1']);
    assert.equal(await treeHash(f.dir), before);
    assert.equal(f.calls.length, 0);
});

test('a supplied subtitle manuscript changes default captions with a new count and is retained verbatim', async t => {
    const f = await fixture(t);
    const source = path.join(f.dir, 'src/data/captions.json');
    await fs.mkdir(path.dirname(source), { recursive: true });
    const originalRows = [[0, 2, '原句一', 'Old one'], [2, 4, '原句二', 'Old two']];
    await fs.writeFile(source, JSON.stringify(originalRows));
    const manifest = JSON.parse(await fs.readFile(path.join(f.dir, 'video.json')));
    manifest.template.inputs.captions = { kind: 'json', count: 2 };
    await fs.writeFile(path.join(f.dir, 'video.json'), JSON.stringify(manifest));
    const subtitleScript = '\n  新的开场。\nNew opening.\n第二个观点。\n最后总结。  \n';
    const originalAgent = f.deps.executeAgent;
    f.deps.executeAgent = async (config, action, options) => {
        assert.ok(options.instruction.includes(subtitleScript));
        assert.match(options.instruction, /增减字幕条数/);
        assert.match(options.instruction, /不能只写进个人 inputs/);
        assert.match(options.instruction, /只有修改要求明确授权精炼时才可删减/);
        assert.match(options.instruction, /停止生成并明确说明需要缩短原稿或允许调整总时长/);
        const changed = JSON.parse(await fs.readFile(path.join(config.workspace, 'video.json')));
        changed.template.inputs.captions.count = 3;
        await fs.writeFile(path.join(config.workspace, 'video.json'), JSON.stringify(changed));
        await fs.writeFile(path.join(config.workspace, 'src/data/captions.json'), JSON.stringify([[0, 1, '新的开场', 'New opening'], [1, 2, '第二个观点', 'Second point'], [2, 3, '最后总结', 'Summary']]));
        return originalAgent(config, action, options);
    };
    const result = await generateTemplate(f.config, { ...f.options, subtitleScript }, f.deps);
    assert.equal(result.subtitleScript, subtitleScript);
    const next = path.join(f.config.workspace, result.dir);
    const saved = JSON.parse(await fs.readFile(path.join(next, '.work/generation.json')));
    assert.equal(saved.subtitleScript, subtitleScript);
    const generated = JSON.parse(await fs.readFile(path.join(next, 'video.json')));
    assert.equal(generated.template.inputs.captions.count, 3);
    assert.deepEqual(JSON.parse(await fs.readFile(source)), originalRows);
});

test('new manuscript cannot be declared complete without changing known default captions', async t => {
    const f = await fixture(t);
    const source = path.join(f.dir, 'src/data/captions.json');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, JSON.stringify([[0, 1, '原字幕', 'Original']]));
    await assert.rejects(generateTemplate(f.config, { ...f.options, subtitleScript: '新的内容' }, f.deps), /没有修改模板默认字幕/);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(await fs.readdir(path.dirname(f.dir)), ['demo-v1']);
});

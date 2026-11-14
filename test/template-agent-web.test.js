import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWebServer } from '../src/web-server.js';
import { treeHash, unpackVideo } from '../src/videos.js';
import { writeZip } from '../src/zip.js';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).dependencies.hyperframes;
const css = ':root { --bg: #101010; --ink: #fafafa; --blue: #4488ff; --gold: #ffaa44; }\n#root {}\n.cap-zh {}\n.slot {}\n';
const requestBody = { action: 'generate', title: '提示词新模板', prompt: '增加标题留白并重排开场卡片，保持原时间轴。', target: 'fixture-agent' };
async function fixture(t, { frozen = false, configured = true } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-agent-web-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { workspace: root, catalogPath: path.join(root, 'catalog.json'), env: {} };
    const manifest = { schema: 'video-package@1', id: 'demo', version: 1, title: '原模板', entry: 'index.html', output: 'renders/demo-v1.mp4', frame: { width: 1280, height: 720, fps: 30, frames: 300 }, template: { format: 'video-template@1', inputs: { identity: { fields: { name: { default: '你的名字' } } }, voice: {}, presenter: {}, music: {} }, pack: { exclude: ['index.html', 'SCRIPT.md', 'slots.json', 'assets/audio/'] } } };
    const files = {
        'video.json': manifest,
        'package.json': { dependencies: { hyperframes: version }, scripts: { inputs: 'node tools/inputs.mjs', build: 'node build.mjs', compose: 'node tools/compose.mjs', render: 'hyperframes render -o renders/demo-v1.mp4' } },
        'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { hyperframes: version } }, 'node_modules/hyperframes': { version } } },
        'src/shared.css': css,
        'build.mjs': "const read = () => ''; read('src/shared.css');\n",
    };
    const archive = path.join(root, 'original.video');
    await fs.writeFile(archive, writeZip(Object.entries(files).map(([name, value]) => ({ name: `demo-v1/${name}`, data: typeof value === 'string' ? value : JSON.stringify(value) }))));
    const imported = await unpackVideo(config, { file: archive });
    const dir = path.join(root, imported.dir);
    if (configured) await fs.writeFile(path.join(root, 'agent-runtime.json'), JSON.stringify({ schemaVersion: 1, defaultTarget: 'fixture-agent', targets: [{ name: 'fixture-agent', enabled: true, harness: { adapter: 'codex', executable: process.execPath, permission: 'workspace-write' }, backend: { auth: 'chatgpt', model: 'fixture' } }] }));
    if (frozen) {
        const draft = path.join(root, 'productions/demo/drafts/demo-v1');
        await fs.mkdir(draft, { recursive: true });
        await fs.writeFile(path.join(draft, 'MANIFEST.json'), JSON.stringify({ package: { treeHash: await treeHash(dir) }, renders: [] }));
    }
    return { root, dir, config };
}
function mocks() {
    const calls = [];
    return {
        calls,
        executeAgent: async (config, action, options, deps) => {
            calls.push({ config, action, options });
            await deps.onEvent?.({ type: 'started', runId: 'fixture-run' });
            await fs.appendFile(path.join(config.workspace, 'src/shared.css'), '\n#root .title { margin-top: 40px; }\n');
            return { run: { id: 'fixture-run', status: 'completed', execution: { text: '已增大标题留白并重新排列开场。' } } };
        },
        runTemplateAction: async (config, options) => {
            if (options.action === 'check') return { report: { ok: true, errors: [], warnings: [], info: [] } };
            if (options.action === 'preview') {
                const dir = path.join(config.workspace, 'productions', options.slug, 'videos', options.name, '.work/preview');
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(path.join(dir, 'frame.png'), 'fixture image');
                return { previewFiles: ['frame.png'], report: { ok: true, errors: [], warnings: [], info: [] } };
            }
            return {};
        },
        checkVideo: async () => ({ ok: true }),
    };
}
async function web(t, f, deps = {}) {
    const server = createWebServer({ root: f.root, templateDeps: deps });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await server.shutdownTasks(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, { method = 'GET', data, headers = {}, video = 'demo-v1' } = {}) => fetch(`${base}/api/projects/demo/templates/${video}/${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'template', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const wait = async initial => {
        const until = Date.now() + 5000;
        while (Date.now() < until) {
            const job = await (await request(`jobs/${initial.id}`)).json();
            if (job.status !== 'running') return job;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Generation job did not finish');
    };
    return { request, wait, base };
}

test('generation API rejects cross-site and empty prompts before invoking an Agent', async t => {
    const f = await fixture(t), deps = mocks(), api = await web(t, f, deps);
    assert.equal((await api.request('jobs', { method: 'POST', data: requestBody, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    for (const prompt of ['', '   ', null, 'x'.repeat(16001)]) {
        assert.equal((await api.request('jobs', { method: 'POST', data: { ...requestBody, prompt } })).status, 400);
    }
    assert.equal(deps.calls.length, 0);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'productions/demo/videos')), ['demo-v1']);
});

test('frozen template generation persists prompt, result, new preview and history for refresh', async t => {
    const f = await fixture(t, { frozen: true }), deps = mocks(), api = await web(t, f, deps);
    const original = await treeHash(f.dir);
    const response = await api.request('jobs', { method: 'POST', data: requestBody });
    assert.equal(response.status, 202, await response.clone().text());
    const initial = await response.json();
    assert.equal(initial.prompt, requestBody.prompt);
    const job = await api.wait(initial);
    assert.equal(job.status, 'succeeded', job.error);
    assert.match(job.result.video, /^template-[a-f0-9]{12}-v1$/);
    assert.equal(job.result.agentRunId, 'fixture-run');
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0].action, 'run');
    assert.equal(deps.calls[0].options.target, requestBody.target);
    assert.ok(deps.calls[0].options.instruction.includes(requestBody.prompt));
    assert.ok(!deps.calls[0].config.workspace.startsWith(f.root));
    assert.equal(await treeHash(f.dir), original);
    const refreshed = await (await api.request('editor')).json();
    assert.equal(refreshed.job.id, initial.id);
    assert.equal(refreshed.job.status, 'succeeded');
    const next = await (await api.request('editor', { video: job.result.video })).json();
    assert.equal(next.generation.prompt, requestBody.prompt);
    assert.equal(next.generation.agentRunId, 'fixture-run');
    assert.equal(next.generation.summary, job.result.summary);
    assert.deepEqual(next.previewFiles, ['frame.png']);
    assert.equal(next.lineage.version, 1);
    assert.equal(next.lineage.kind, 'derived');
    assert.equal(next.lineage.origin.id, 'demo');
    assert.equal(next.frozen, false);
});

test('running Agent generation locks mutations and cancellation removes incomplete new version', async t => {
    const f = await fixture(t), deps = mocks();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    deps.executeAgent = async (config, action, options, { signal }) => {
        entered();
        await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('fixture cancelled');
    };
    const api = await web(t, f, deps);
    const response = await api.request('jobs', { method: 'POST', data: requestBody });
    assert.equal(response.status, 202);
    const initial = await response.json();
    await started;
    const library = await (await fetch(`${api.base}/api/projects`)).json();
    assert.deepEqual(library.projects[0].templatePackages.map(item => item.name), ['demo-v1']);
    assert.equal((await api.request('inputs', { method: 'PUT', data: { inputs: {} }, video: 'demo-v2' })).status, 409);
    assert.equal((await api.request('inputs', { method: 'PUT', data: { inputs: {} } })).status, 409);
    assert.equal((await api.request('jobs', { method: 'POST', data: requestBody })).status, 409);
    assert.equal((await fetch(`${api.base}/api/projects/demo/templates/demo-v1`, { method: 'POST', headers: { 'X-Remake-Action': 'pack' } })).status, 409);
    await api.request(`jobs/${initial.id}/cancel`, { method: 'POST', data: {} });
    assert.equal((await api.wait(initial)).status, 'cancelled');
    assert.deepEqual(await fs.readdir(path.join(f.root, 'productions/demo/videos')), ['demo-v1']);
    assert.equal((await api.request('inputs', { method: 'PUT', data: { inputs: {} } })).status, 200);
});

test('terminal job states are published only after persistence and package unlock', async t => {
    for (const outcome of ['succeeded', 'failed', 'cancelled']) {
        await t.test(outcome, { timeout: 5000 }, async t => {
            const f = await fixture(t), deps = mocks();
            if (outcome === 'failed') deps.executeAgent = async () => { throw new Error('fixture failed'); };
            if (outcome === 'cancelled') deps.executeAgent = async (config, action, options, { signal }) => {
                await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
                throw new Error('fixture cancelled');
            };
            let release, reached, intercepted = false;
            const gate = new Promise(resolve => { release = resolve; });
            const pending = new Promise(resolve => { reached = resolve; });
            const originalRename = fs.rename;
            const jobFile = path.join(await fs.realpath(f.root), 'productions/demo/drafts/.template-jobs/demo-v1.json');
            t.mock.method(fs, 'rename', async (source, destination) => {
                if (!intercepted && destination === jobFile) {
                    const saved = JSON.parse(await fs.readFile(source, 'utf8'));
                    if (['succeeded', 'failed', 'cancelled'].includes(saved.status)) {
                        intercepted = true;
                        reached();
                        await gate;
                    }
                }
                return originalRename(source, destination);
            });
            const api = await web(t, f, deps);
            try {
                const response = await api.request('jobs', { method: 'POST', data: requestBody });
                assert.equal(response.status, 202);
                const initial = await response.json();
                if (outcome === 'cancelled') await api.request(`jobs/${initial.id}/cancel`, { method: 'POST', data: {} });
                await pending;
                const visible = await (await api.request(`jobs/${initial.id}`)).json();
                assert.equal(visible.status, 'running', 'persisting a terminal snapshot must not publish it early');
                assert.equal((await api.request('inputs', { method: 'PUT', data: { inputs: {} } })).status, 409);
                release();
                assert.equal((await api.wait(initial)).status, outcome);
                assert.equal((await api.request('inputs', { method: 'PUT', data: { inputs: {} } })).status, 200);
            } finally { release(); }
        });
    }
});

test('missing Agent configuration is visible while template inputs remain available', async t => {
    const f = await fixture(t, { configured: false }), api = await web(t, f);
    const response = await api.request('editor');
    assert.equal(response.status, 200);
    const editor = await response.json();
    assert.equal(editor.agent.available, false);
    assert.deepEqual(editor.agent.targets, []);
    assert.match(editor.agent.error, /配置/);
    assert.equal(editor.inputs.identity.name, '你的名字');
});

test('CLI video:generate forwards natural language and selected Agent to the real generation flow', async t => {
    const f = await fixture(t, { frozen: true }), deps = mocks();
    const result = await execute(parseArgv(['video:generate', 'demo', '--video', 'demo-v1', '--title', requestBody.title, '--prompt', requestBody.prompt, '--target', requestBody.target, '--workspace', f.root]), {}, deps);
    assert.equal(result.data.command, 'video:generate');
    assert.equal(result.data.title, requestBody.title);
    assert.match(result.data.video, /^template-[a-f0-9]{12}-v1$/);
    assert.equal(deps.calls[0].options.target, requestBody.target);
    assert.ok(deps.calls[0].options.instruction.includes(requestBody.prompt));
    await assert.rejects(execute(parseArgv(['video:generate', 'demo', '--video', 'demo-v1', '--title', requestBody.title, '--workspace', f.root]), {}, deps), { code: 'INVALID_INPUT' });
});


test('CLI revise preserves the generated template family while derive starts another', async t => {
    const f = await fixture(t), deps = mocks();
    const invoke = (video, mode) => execute(parseArgv(['video:generate', 'demo', '--video', video, '--title', requestBody.title, '--prompt', requestBody.prompt, '--mode', mode, '--workspace', f.root]), {}, deps);
    const first = (await invoke('demo-v1', 'derive')).data;
    const next = (await invoke(first.video, 'revise')).data;
    const separate = (await invoke(first.video, 'derive')).data;
    const manifest = async result => JSON.parse(await fs.readFile(path.join(f.root, result.dir, 'video.json')));
    const a = await manifest(first), b = await manifest(next), c = await manifest(separate);
    assert.equal(a.version, 1);
    assert.equal(b.id, a.id);
    assert.equal(b.version, 2);
    assert.notEqual(c.id, a.id);
    assert.equal(c.version, 1);
});

test('disconnecting and reopening the page keeps the Agent running and restores persisted logs', async t => {
    const f = await fixture(t), deps = mocks();
    const original = deps.executeAgent;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    deps.executeAgent = async (config, action, options, runtime) => {
        await runtime.onEvent({ type: 'tool', data: { name: 'Read', input: { file_path: 'src/shared.css' } } });
        await runtime.onEvent({ type: 'raw', data: { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 503, retry_delay_ms: 1000 } });
        entered();
        await gate;
        assert.equal(runtime.signal.aborted, false);
        return original(config, action, options, runtime);
    };
    const api = await web(t, f, deps);
    const response = await api.request('jobs', { method: 'POST', data: requestBody, headers: { Connection: 'close' } });
    const initial = await response.json();
    await ready;
    const refreshed = await (await api.request('editor', { headers: { Connection: 'close' } })).json();
    assert.equal(refreshed.job.id, initial.id);
    assert.equal(refreshed.job.status, 'running');
    assert.ok(refreshed.job.logs.some(line => line.kind === 'tool' && line.text.includes('src/shared.css')));
    assert.ok(refreshed.job.logs.some(line => line.kind === 'retry'));
    const disk = JSON.parse(await fs.readFile(path.join(f.root, 'productions/demo/drafts/.template-jobs/demo-v1.json'), 'utf8'));
    assert.ok(disk.logs.some(line => line.kind === 'retry'));
    release();
    const finished = await api.wait(initial);
    assert.equal(finished.status, 'succeeded', finished.error);
    const generated = await (await api.request('editor', { video: finished.result.video })).json();
    assert.equal(generated.job.id, initial.id);
    assert.ok(generated.job.logs.some(line => line.kind === 'tool'));
});

test('web model choice reaches the actual execution config without rewriting project defaults', async t => {
    const f = await fixture(t), deps = mocks();
    const before = await fs.readFile(path.join(f.root, 'agent-runtime.json'), 'utf8');
    const original = deps.executeAgent;
    deps.executeAgent = async (config, action, options, runtime) => {
        const execution = JSON.parse(await fs.readFile(options.agentConfig, 'utf8'));
        assert.equal(execution.targets[0].backend.model, 'custom-model-v2');
        return original(config, action, options, runtime);
    };
    const api = await web(t, f, deps);
    const initial = await (await api.request('jobs', { method: 'POST', data: { ...requestBody, providerTarget: 'fixture-agent', model: 'custom-model-v2' } })).json();
    const result = await api.wait(initial);
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(result.result.configuredModel, 'custom-model-v2');
    assert.equal(await fs.readFile(path.join(f.root, 'agent-runtime.json'), 'utf8'), before);
});

test('web Provider create/edit is same-origin protected and selected credentials reach execution only', async t => {
    const f = await fixture(t), deps = mocks(), api = await web(t, f, deps);
    const provider = { label: '网页 Provider', baseURL: 'https://api.example.invalid/v1', protocol: 'responses', models: ['web-model'], apiKey: 'web-private-key' };
    assert.equal((await api.request('providers', { method: 'PUT', data: provider, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const saved = await (await api.request('providers', { method: 'PUT', data: provider })).json();
    assert.equal(saved.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(saved), /web-private-key/);
    const editor = await (await api.request('editor')).json();
    assert.ok(editor.agent.providers.some(item => item.id === saved.id && item.compatibleTargets.includes('fixture-agent')));
    assert.doesNotMatch(JSON.stringify(editor), /web-private-key|REMAKE_PROVIDER_/);
    const edited = await (await api.request('providers', { method: 'PUT', data: { ...provider, id: saved.id, label: '已编辑', apiKey: undefined, models: ['web-model-2'] } })).json();
    assert.equal(edited.label, '已编辑');
    const original = deps.executeAgent;
    deps.executeAgent = async (config, action, options, runtime) => {
        const execution = JSON.parse(await fs.readFile(options.agentConfig, 'utf8'));
        const backend = execution.targets[0].backend;
        assert.equal(backend.baseURL, provider.baseURL);
        assert.equal(backend.model, 'web-model-2');
        assert.equal(config.env[backend.apiKeyEnv], provider.apiKey);
        assert.doesNotMatch(JSON.stringify(execution), /web-private-key/);
        return original(config, action, options, runtime);
    };
    const initial = await (await api.request('jobs', { method: 'POST', data: { ...requestBody, providerTarget: saved.id, model: 'web-model-2' } })).json();
    const result = await api.wait(initial);
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(result.result.provider, '已编辑');
    assert.doesNotMatch(JSON.stringify(result), /web-private-key/);
});

test('Provider connection and model endpoints reject cross-site calls and accept unsaved drafts', async t => {
    const f = await fixture(t); let calls = 0;
    const api = await web(t, f, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'remote-model' }] })); } });
    const data = { baseURL: 'https://api.example.invalid/v1', protocol: 'responses', apiKey: 'probe-key' };
    for (const route of ['providers/test', 'providers/models']) {
        assert.equal((await api.request(route, { method: 'POST', data, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
        assert.equal((await api.request(route)).status, 405);
        const response = await api.request(route, { method: 'POST', data });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.deepEqual(result.models, ['remote-model']);
        assert.doesNotMatch(JSON.stringify(result), /probe-key/);
    }
    assert.equal(calls, 2);
    await assert.rejects(fs.access(path.join(f.root, '.env.agent.providers.json')));
});

test('new subtitle manuscript is validated, forwarded and retained across job/editor refresh', async t => {
    const f = await fixture(t), deps = mocks(), api = await web(t, f, deps);
    for (const subtitleScript of [true, {}, 'x'.repeat(30001), 'bad\0text']) {
        assert.equal((await api.request('jobs', { method: 'POST', data: { ...requestBody, subtitleScript } })).status, 400);
    }
    assert.equal(deps.calls.length, 0);
    const subtitleScript = '\n全新讲述内容。\nNew narration.\n不限原模板的分句数量。\n';
    const response = await api.request('jobs', { method: 'POST', data: { ...requestBody, subtitleScript } });
    assert.equal(response.status, 202);
    const initial = await response.json();
    assert.equal(initial.subtitleScript, subtitleScript);
    const finished = await api.wait(initial);
    assert.equal(finished.status, 'succeeded', finished.error);
    assert.equal(finished.result.subtitleScript, subtitleScript);
    assert.ok(deps.calls[0].options.instruction.includes(subtitleScript));
    const refreshed = await (await api.request('editor', { video: finished.result.video })).json();
    assert.equal(refreshed.generation.subtitleScript, subtitleScript);
    assert.equal(refreshed.job.subtitleScript, subtitleScript);
});

test('CLI video:generate accepts a separate new subtitle manuscript', async t => {
    const f = await fixture(t), deps = mocks();
    const subtitleScript = '新的中文稿\nA new English script';
    const result = await execute(parseArgv(['video:generate', 'demo', '--workspace', f.root, '--video', 'demo-v1', '--title', '新字幕模板', '--prompt', '以新稿重新安排内容', '--subtitle-script', subtitleScript, '--target', 'fixture-agent']), {}, deps);
    assert.equal(result.data.subtitleScript, subtitleScript);
    assert.ok(deps.calls[0].options.instruction.includes(subtitleScript));
});

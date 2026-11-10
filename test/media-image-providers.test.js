import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { PROVIDERS, resolveMediaConfig, DEFAULT_PROVIDERS } from '../src/media/config.js';
import { mediaImage, mediaPrepare, mediaDoctor } from '../src/media/index.js';
import { transport, decodeImage, saveImage } from '../src/media/providers/image-common.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=', 'base64');
const ids = ['openai-image', 'gemini-image', 'aliyun-image', 'comfyui-image'];
function profile(edit = false) {
    return { workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'old' } },
        '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
        '3': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
        '4': { class_type: 'SaveImage', inputs: { images: ['2', 0] } } },
    prompt: { node: '1', input: 'text' }, width: { node: '2', input: 'width' }, height: { node: '2', input: 'height' },
    images: edit ? [{ node: '3', input: 'image' }] : [], outputNode: '4' };
}
async function fixture(t, id) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-image-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'key'), 'fixture-secret\nignored');
    await fs.writeFile(path.join(dir, 'reference.png'), png);
    const workflows = { generate: profile(), edit: profile(true) };
    await fs.writeFile(path.join(dir, 'workflow.json'), JSON.stringify(workflows));
    const section = { provider: id, apiKeyFile: 'key', ...(id === 'comfyui-image' ? { workflowFile: 'workflow.json' } : {}) };
    await fs.writeFile(path.join(dir, 'video-remake.json'), JSON.stringify({ media: { image: section } }));
    return { dir, workflows, config: { workspace: dir, env: {}, media: resolveMediaConfig({ image: section }, {}, dir) } };
}
function api(id, edit, calls, broken = false) {
    return async (url, init) => {
        calls.push({ url, init });
        if (id === 'openai-image') {
            assert.equal(init.headers.Authorization, 'Bearer fixture-secret');
            assert.match(url, new RegExp(`/images/${edit ? 'edits' : 'generations'}$`));
            if (edit) { assert.equal(init.body.get('prompt'), '画一棵树'); assert.equal(init.body.getAll('image[]').length, 1); }
            else assert.equal(JSON.parse(init.body).n, 1);
            return Response.json(broken ? {} : { data: [{ b64_json: png.toString('base64') }] });
        }
        if (id === 'gemini-image') {
            assert.equal(init.headers['x-goog-api-key'], 'fixture-secret');
            assert.equal(url.includes('fixture-secret'), false);
            const body = JSON.parse(init.body);
            assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
            assert.equal(body.contents[0].parts.length, edit ? 2 : 1);
            return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: broken ? [{ text: 'no image' }] : [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] });
        }
        if (id === 'aliyun-image') {
            if (url.includes('/generation')) {
                const body = JSON.parse(init.body);
                assert.equal(body.input.messages[0].content.length, edit ? 2 : 1);
                assert.equal(body.parameters.n, 1);
                assert.equal(init.headers.Authorization, 'Bearer fixture-secret');
                return Response.json(broken ? {} : { output: { choices: [{ message: { content: [{ image: 'https://download.example/image.png?signature=private' }] } }] } });
            }
            assert.equal(init.headers, undefined);
            return new Response(png);
        }
        if (url.endsWith('/upload/image')) {
            assert.equal(await init.body.get('image').arrayBuffer().then((b) => Buffer.from(b).equals(png)), true);
            return Response.json({ name: 'upload.png', subfolder: 'test', type: 'input' });
        }
        if (url.endsWith('/prompt')) {
            const graph = JSON.parse(init.body).prompt;
            assert.equal(graph['1'].inputs.text, '画一棵树');
            if (edit) assert.equal(graph['3'].inputs.image, 'test/upload.png');
            return Response.json({ prompt_id: 'test-task' });
        }
        if (url.includes('/history/')) return Response.json({ 'test-task': { status: { completed: true, status_str: broken ? 'error' : 'success' }, outputs: { '4': { images: [{ filename: 'image.png', subfolder: '', type: 'output' }] } } } });
        assert.match(url, /\/view\?/);
        return new Response(png);
    };
}

test('图片六种工具注册且默认保持 codex-image', () => {
    assert.equal(DEFAULT_PROVIDERS.image, 'codex-image');
    assert.deepEqual(Object.keys(PROVIDERS.image).sort(), [...ids, 'codex-image'].sort());
    assert.equal(resolveMediaConfig({}, {}, '/tmp').image.provider, 'codex-image');
});
for (const id of ids) {
    test(`${id} 文生图和编辑通过通用入口保存真实文件字节，保留来源`, async (t) => {
        const { config, dir, workflows } = await fixture(t, id);
        for (const edit of [false, true]) {
            const calls = [];
            const out = path.join(dir, `${edit}.png`);
            const result = (await execute(parseArgv(['media:image', '--workspace', dir, '--intent', '画一棵树', '--out', out, ...(edit ? ['--image', 'reference.png'] : [])]), {}, { fetchImpl: api(id, edit, calls) })).data;
            assert.equal(result.provider, `${id}.${edit ? 'edit' : 'generate'}`);
            assert.deepEqual(await fs.readFile(out), png);
            assert.equal(JSON.stringify(result).includes('private'), false);
            const count = calls.length;
            await assert.rejects(mediaImage(config, { intent: '画一棵树', out }, { fetchImpl: api(id, false, calls) }), { code: 'ALREADY_EXISTS' });
            assert.equal(calls.length, count);
        }
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'workflow.json'), 'utf8')), workflows);
    });
    test(`${id} prepare/doctor 不联网，失败响应不落地也不重试`, async (t) => {
        const { config, dir } = await fixture(t, id);
        const offline = { fetchImpl: () => assert.fail('不应请求服务') };
        const doctor = await mediaDoctor(config, { task: 'image' }, offline);
        assert.equal(doctor.media.image.ready, true);
        assert.equal(JSON.stringify(doctor).includes('fixture-secret'), false);
        await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify({ intent: '画一棵树' }));
        assert.equal((await mediaPrepare(config, { task: 'image', request: 'request.json' }, offline)).provider, id);
        const calls = [];
        const out = path.join(dir, 'failed.png');
        await assert.rejects(mediaImage(config, { intent: '画一棵树', out }, { fetchImpl: api(id, false, calls, true) }), { code: 'MEDIA_FAILED' });
        await assert.rejects(fs.access(out));
        assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 1);
        await assert.rejects(mediaImage(config, { intent: 'x', session: 'unsupported' }, offline), { code: 'INVALID_INPUT' });
    });
}

test('ComfyUI 不完整绑定和缺少编辑工作流在上传前失败，prepare 同样检查', async (t) => {
    const { config, dir, workflows } = await fixture(t, 'comfyui-image');
    delete workflows.edit;
    await fs.writeFile(path.join(dir, 'workflow.json'), JSON.stringify(workflows));
    const offline = { fetchImpl: () => assert.fail('不得上传') };
    await assert.rejects(mediaImage(config, { intent: 'x', image: ['reference.png'] }, offline), { code: 'MEDIA_CAPABILITY_UNSUPPORTED' });
    workflows.generate.prompt.node = 'missing';
    await fs.writeFile(path.join(dir, 'workflow.json'), JSON.stringify(workflows));
    await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify({ intent: 'x' }));
    await assert.rejects(mediaPrepare(config, { task: 'image', request: 'request.json' }, offline), { code: 'INVALID_INPUT' });
});

test('ComfyUI 轮询有界且错误保留任务 ID，不重新提交', async (t) => {
    const { config } = await fixture(t, 'comfyui-image');
    let posts = 0;
    await assert.rejects(mediaImage(config, { intent: 'x' }, {
        timeoutMs: 10000, pollIntervalMs: 5000, sleep: async () => {},
        fetchImpl: async (url, init) => {
            if (init.method === 'POST') { posts++; return Response.json({ prompt_id: 'pending-task' }); }
            return Response.json({});
        },
    }), (error) => error.code === 'MEDIA_FAILED' && error.data.promptId === 'pending-task');
    assert.equal(posts, 1);
});

test('图片传输拒绝错误、超大响应、非图片内容；不回显敏感信息', async (t) => {
    for (const response of [new Response('secret', { status: 401 }), new Response('secret', { headers: { 'content-length': '999999999' } }), new Response('not-json')]) {
        const { request } = transport({ fetchImpl: async () => response });
        await assert.rejects(request('https://example.test'), (error) => error.code === 'MEDIA_FAILED' && !error.message.includes('secret'));
    }
    assert.throws(() => decodeImage('invalid!'), { code: 'MEDIA_FAILED' });
    const { dir } = await fixture(t, 'openai-image');
    await assert.rejects(saveImage(Buffer.from('<html>error</html>'), { outPath: path.join(dir, 'bad.png') }, 'openai-image'), { code: 'MEDIA_FAILED' });
    await assert.rejects(fs.access(path.join(dir, 'bad.png')));
});

test('OpenAI 错误质量类型和尺寸在提交前拒绝', () => {
    const provider = PROVIDERS.image['openai-image'];
    for (const request of [{ options: { quality: false } }, { options: {}, size: '0x0' }]) {
        assert.throws(() => provider.validateRequest(request), { code: 'INVALID_INPUT' });
    }
});

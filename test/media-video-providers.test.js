import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { DEFAULT_PROVIDERS, PROVIDERS, resolveMediaConfig } from '../src/media/config.js';
import { MAX_VIDEO_BYTES } from '../src/media/providers/video-common.js';

const ids = ['runway-video', 'aliyun-video', 'minimax-video'];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=', 'base64');
// 模拟 MP4 容器头，不调用编码器或真实生成服务。
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const baseResp = { status_code: 0, status_msg: 'success' };
async function fixture(t, id, edit = false, extra = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-video-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'key'), 'fixture-secret\nignored');
    await fs.writeFile(path.join(dir, 'reference.png'), png);
    await fs.writeFile(path.join(dir, 'video-remake.json'), JSON.stringify({ media: { video: { provider: id, apiKeyFile: 'key', ...extra } } }));
    const request = { intent: '树叶在风中轻轻摇动', duration: 6, images: edit ? ['reference.png'] : [],
        ...(!edit && id !== 'minimax-video' ? { aspectRatio: '9:16' } : {}) };
    await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify(request));
    return { dir, request };
}
function mock(id, { pending = false, state, invalidDownload = false, downloadError = false, noUrl = false, oversize = false } = {}) {
    const calls = [];
    let polls = 0;
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        if (url.startsWith('https://download.example/')) {
            assert.equal(init.headers, undefined, '下载不能发送 API 密钥');
            if (downloadError) throw new Error('secret-signed-url');
            return new Response(invalidDownload ? '<html>not a video</html>' : mp4,
                oversize ? { headers: { 'content-length': String(MAX_VIDEO_BYTES + 1) } } : {});
        }
        assert.equal(init.headers.Authorization, 'Bearer fixture-secret');
        if (id === 'runway-video') assert.equal(init.headers['X-Runway-Version'], '2024-11-06');
        if (init.method === 'POST') {
            if (id === 'runway-video') return Response.json({ id: 'test-task' });
            if (id === 'aliyun-video') return Response.json({ output: { task_id: 'test-task', task_status: 'PENDING' } });
            return Response.json({ task_id: 'test-task', base_resp: baseResp });
        }
        if (url.includes('/files/retrieve')) return Response.json({ file: { download_url: 'https://download.example/result.mp4?secret-signature' }, base_resp: baseResp });
        polls++;
        const waiting = pending || polls === 1;
        if (id === 'runway-video') return Response.json({ id: 'test-task', status: state || (waiting ? 'PENDING' : 'SUCCEEDED'), output: noUrl ? [] : ['https://download.example/result.mp4?secret-signature'] });
        if (id === 'aliyun-video') return Response.json({ output: { task_status: state || (waiting ? 'RUNNING' : 'SUCCEEDED'), ...(noUrl ? {} : { video_url: 'https://download.example/result.mp4?secret-signature' }) } });
        return Response.json({ task_id: 'test-task', status: state || (waiting ? 'Processing' : 'Success'), file_id: noUrl ? '' : 'test-file', base_resp: baseResp });
    };
    return { calls, fetchImpl, sleep: async () => {}, pollIntervalMs: 100, timeoutMs: 10000 };
}
async function cli(dir, flags, deps) {
    return execute(parseArgv(['media:video', '--workspace', dir, ...flags]), {}, deps);
}

test('新增视频适配器注册，comfy-mcp 保持默认且仍由 Agent 执行', async (t) => {
    assert.equal(DEFAULT_PROVIDERS.video, 'comfy-mcp');
    assert.equal(PROVIDERS.video['comfy-mcp'].execution, 'agent');
    assert.deepEqual(Object.keys(PROVIDERS.video).sort(), [...ids, 'comfy-mcp'].sort());
    const { dir } = await fixture(t, 'runway-video');
    await fs.writeFile(path.join(dir, 'video-remake.json'), '{}');
    const deps = { fetchImpl: () => assert.fail('默认 Agent 不得发起云 API 请求') };
    await assert.rejects(cli(dir, ['--request', 'request.json'], deps), { code: 'MEDIA_AGENT_REQUIRED' });
    await assert.rejects(cli(dir, ['--task-id', 'test-task'], deps), { code: 'MEDIA_AGENT_REQUIRED' });
    for (const provider of ids) assert.equal(resolveMediaConfig({}, { VIDEO_REMAKE_MEDIA_VIDEO: provider }, dir).video.provider, provider);
});
for (const id of ids) {
    for (const edit of [false, true]) {
        test(`${id} ${edit ? '首帧图生' : '文生'}视频 CLI 提交、轮询、下载并保留统一文件结果`, async (t) => {
            const { dir } = await fixture(t, id, edit);
            const deps = mock(id);
            const result = await cli(dir, ['--request', 'request.json', '--out', 'result.mp4'], deps);
            assert.equal(result.data.provider, `${id}.generate`);
            assert.equal(result.data.taskId, 'test-task');
            assert.deepEqual(await fs.readFile(result.data.path), mp4);
            assert.equal(JSON.stringify(result).includes('secret'), false);
            const posts = deps.calls.filter(({ init }) => init.method === 'POST');
            assert.equal(posts.length, 1);
            const body = JSON.parse(posts[0].init.body);
            if (id === 'runway-video') {
                assert.equal(body.duration, 6);
                assert.equal(body.model, 'gen4.5');
                assert.equal(body.ratio, edit ? '1280:720' : '720:1280');
                assert.equal(Boolean(body.promptImage), edit);
                assert.match(posts[0].url, edit ? /image_to_video$/ : /text_to_video$/);
            } else if (id === 'aliyun-video') {
                assert.equal(posts[0].init.headers['X-DashScope-Async'], 'enable');
                assert.equal(body.model, edit ? 'wan2.7-i2v-2026-04-25' : 'wan2.7-t2v');
                assert.equal(body.parameters.duration, 6);
                assert.equal(body.parameters.resolution, '720P');
                if (edit) assert.match(body.input.media[0].url, /^data:image\/png;base64,/);
                else assert.equal(body.parameters.ratio, '9:16');
            } else {
                assert.equal(body.model, 'MiniMax-Hailuo-2.3');
                assert.equal(body.duration, 6);
                assert.equal(body.resolution, '768P');
                assert.equal(Boolean(body.first_frame_image), edit);
                assert.ok(deps.calls.some(({ url }) => url.includes('/files/retrieve?file_id=test-file')));
            }
            const count = deps.calls.length;
            await assert.rejects(cli(dir, ['--request', 'request.json', '--out', 'result.mp4'], deps), { code: 'ALREADY_EXISTS' });
            assert.equal(deps.calls.length, count);
            assert.equal((await fs.readdir(dir)).some((file) => file.endsWith('.part')), false);
        });
    }
    test(`${id} doctor 与 prepare 离线；驱动音频/多参考/姿态需求不会降级`, async (t) => {
        const { dir, request } = await fixture(t, id);
        const deps = { fetchImpl: () => assert.fail('不应联网') };
        const doctor = await execute(parseArgv(['media:doctor', '--workspace', dir, '--task', 'video']), {}, deps);
        assert.equal(doctor.data.media.video.ready, true);
        assert.equal(JSON.stringify(doctor).includes('fixture-secret'), false);
        const prepare = await execute(parseArgv(['media:prepare', '--workspace', dir, '--task', 'video', '--request', 'request.json']), {}, deps);
        assert.equal(prepare.data.execution, 'program');
        for (const extra of [{ audio: 'reference.png' }, { referenceVideo: 'reference.png' }, { images: ['reference.png', 'reference.png'] }]) {
            await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify({ ...request, ...extra }));
            await assert.rejects(cli(dir, ['--request', 'request.json'], deps), { code: 'MEDIA_CAPABILITY_UNSUPPORTED' });
        }
        await fs.rm(path.join(dir, 'key'));
        await assert.rejects(execute(parseArgv(['media:doctor', '--workspace', dir, '--task', 'video']), {}, deps), { code: 'DOCTOR_FAILED' });
    });
    test(`${id} 超时保留任务ID；resume 仅查询下载，不重新提交`, async (t) => {
        const { dir } = await fixture(t, id);
        const deps = mock(id, { pending: true });
        await assert.rejects(cli(dir, ['--request', 'request.json'], { ...deps, timeoutMs: 10000, pollIntervalMs: 5000 }),
            (error) => error.code === 'MEDIA_FAILED' && error.data.taskId === 'test-task' && error.message.includes('--task-id'));
        assert.equal(deps.calls.filter(({ init }) => init.method === 'POST').length, 1);
        const resumed = mock(id);
        const result = await cli(dir, ['--task-id', 'test-task', '--out', 'resumed.mp4'], resumed);
        assert.equal(result.data.taskId, 'test-task');
        assert.deepEqual(await fs.readFile(result.data.path), mp4);
        assert.equal(resumed.calls.filter(({ init }) => init.method === 'POST').length, 0);
    });
    test(`${id} 任务失败、未知状态和不完整结果不留假视频，不自动重试`, async (t) => {
        const { dir } = await fixture(t, id);
        for (const opts of [{ state: 'FAILED' }, { state: 'UNKNOWN' }, { noUrl: true }, { invalidDownload: true }, { downloadError: true }, { oversize: true }]) {
            const deps = mock(id, opts);
            await assert.rejects(cli(dir, ['--request', 'request.json', '--out', 'failed.mp4'], deps), (error) => {
                assert.equal(error.code, 'MEDIA_FAILED');
                assert.equal(error.data.taskId, 'test-task');
                assert.equal(error.message.includes('secret'), false);
                return true;
            });
            await assert.rejects(fs.access(path.join(dir, 'failed.mp4')));
            assert.equal((await fs.readdir(dir)).some((file) => file.endsWith('.part')), false);
            assert.equal(deps.calls.filter(({ init }) => init.method === 'POST').length, 1);
        }
    });
}

test('视频需求校验在提交前拦截不支持的时长、画幅、输出后缀和配置组合', async (t) => {
    const offline = { fetchImpl: () => assert.fail('不应提交') };
    for (const [id, change, settings] of [
        ['runway-video', { duration: 11 }, {}], ['runway-video', { duration: 2.5 }, {}],
        ['runway-video', { aspectRatio: '1:1' }, {}], ['aliyun-video', { images: ['reference.png'], aspectRatio: '9:16' }, {}],
        ['minimax-video', { duration: 10 }, { resolution: '1080P' }], ['minimax-video', { aspectRatio: '16:9' }, {}],
        ['aliyun-video', { options: { arbitrary: true } }, {}],
    ]) {
        const { dir, request } = await fixture(t, id, false, settings);
        await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify({ ...request, ...change }));
        await assert.rejects(cli(dir, ['--request', 'request.json'], offline), { code: 'INVALID_INPUT' });
    }
    const { dir } = await fixture(t, 'runway-video');
    await assert.rejects(cli(dir, [], offline), { code: 'INVALID_INPUT' });
    await assert.rejects(cli(dir, ['--request', 'request.json', '--task-id', 'task'], offline), { code: 'INVALID_INPUT' });
    await assert.rejects(cli(dir, ['--task-id', '../task'], offline), { code: 'INVALID_INPUT' });
    await assert.rejects(cli(dir, ['--request', 'request.json', '--out', 'bad.png'], offline), { code: 'INVALID_INPUT' });
});

test('视频服务 HTTP 错误、非 JSON 和网络错误均不回显密钥，未成功提交不伪造任务 ID', async (t) => {
    const { dir } = await fixture(t, 'runway-video');
    for (const fetchImpl of [
        async () => new Response('fixture-secret', { status: 429 }),
        async () => new Response('fixture-secret'),
        async () => { throw new Error('fixture-secret'); },
        async () => Response.json({}),
    ]) {
        let calls = 0;
        await assert.rejects(cli(dir, ['--request', 'request.json'], { fetchImpl: (...args) => { calls++; return fetchImpl(...args); } }), (error) => {
            assert.equal(error.code, 'MEDIA_FAILED');
            assert.equal(error.message.includes('fixture-secret'), false);
            assert.equal(error.data, undefined);
            return true;
        });
        assert.equal(calls, 1);
    }
});

test('视频下载中断清理半成品，提交后目标被创建也不会覆盖', async (t) => {
    const { dir } = await fixture(t, 'runway-video');
    for (const race of [false, true]) {
        const deps = mock('runway-video');
        const target = path.join(dir, `${race}.mp4`);
        const upstream = deps.fetchImpl;
        deps.fetchImpl = async (url, init) => {
            if (!url.startsWith('https://download.example/')) return upstream(url, init);
            if (race) {
                await fs.writeFile(target, 'existing-video');
                return new Response(mp4);
            }
            let sent = false;
            return new Response(new ReadableStream({
                pull(controller) {
                    if (sent) controller.error(new Error('secret download interruption'));
                    else { sent = true; controller.enqueue(mp4); }
                },
            }));
        };
        await assert.rejects(cli(dir, ['--request', 'request.json', '--out', target], deps), { code: 'MEDIA_FAILED' });
        if (race) assert.equal(await fs.readFile(target, 'utf8'), 'existing-video');
        else await assert.rejects(fs.access(target));
        assert.equal((await fs.readdir(dir)).some((file) => file.endsWith('.part')), false);
    }
});

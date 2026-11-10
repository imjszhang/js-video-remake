import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { execute } from '../cli/remake.js';
import { parseArgv } from '../src/args.js';
import { resolveMediaConfig } from '../src/media/config.js';
import { downloadedVideo, run, tempWorkspace } from './helpers.js';

const noExternalCalls = {
    fetchImpl: async () => assert.fail('不得联网'),
};

test('codex-image 可通过配置和环境选择，作为默认并拒绝已移除的适配器', () => {
    assert.equal(resolveMediaConfig({}, {}).image.provider, 'codex-image');
    assert.throws(() => resolveMediaConfig({ image: { provider: 'js-designer' } }, {}), /Unknown media/);
    assert.deepEqual(resolveMediaConfig({ image: { provider: 'codex-image' } }, {}).image,
        { provider: 'codex-image', settings: {} });
    assert.equal(resolveMediaConfig({}, { VIDEO_REMAKE_MEDIA_IMAGE: 'codex-image' }).image.provider, 'codex-image');
    assert.throws(() => resolveMediaConfig({ image: { provider: 'codex-image', skillDir: '/unused' } }, {}),
        (error) => error.code === 'CONFIG_INVALID');
});

test('codex-image 需求准备不生成，doctor 如实报告无法确认，旧生成入口不回退', async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-image-test-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const env = { VIDEO_REMAKE_WORKSPACE: workspace, VIDEO_REMAKE_MEDIA_IMAGE: 'codex-image' };
    const call = (args) => execute(parseArgv(args), env, noExternalCalls);
    await fs.writeFile(path.join(workspace, 'reference.png'), 'fixture');
    for (const images of [[], ['reference.png']]) {
        await fs.writeFile(path.join(workspace, 'request.json'), JSON.stringify({
            intent: '办公室人物半身照', images, options: { transparentBackground: true },
        }));
        const before = await fs.readdir(workspace);
        const result = await call(['media:prepare', '--task', 'image', '--request', 'request.json']);
        assert.equal(result.data.execution, 'agent');
        assert.equal(result.data.provider, 'codex-image');
        assert.deepEqual(result.data.request.require, [images.length ? 'image-edit' : 'text-to-image']);
        assert.deepEqual(result.data.ledgerProviders, ['codex-image.generate', 'codex-image.edit']);
        await fs.access(result.data.guide);
        assert.deepEqual(await fs.readdir(workspace), before);
    }
    await assert.rejects(call(['media:doctor', '--task', 'image']), (error) => {
        assert.equal(error.code, 'DOCTOR_FAILED');
        assert.equal(error.data.media.image.ready, false);
        assert.equal(error.data.media.image.agentOnly, true);
        assert.match(error.data.media.image.hint, /CLI 无法验证/);
        return true;
    });
    await assert.rejects(call(['media:image', '--intent', '办公室']),
        (error) => error.code === 'MEDIA_AGENT_REQUIRED');
    for (const options of [{ quality: 'high' }, { transparentBackground: 'true' }]) {
        await fs.writeFile(path.join(workspace, 'request.json'), JSON.stringify({ intent: '办公室', options }));
        await assert.rejects(call(['media:prepare', '--task', 'image', '--request', 'request.json']),
            (error) => error.code === 'INVALID_INPUT');
    }
});

test('模拟 Codex 图片经统一入口登记，保留文件字节与来源', async (t) => {
    const workspace = await tempWorkspace(t, { videos: { abcdefghijk: downloadedVideo() } });
    await run(['bind', 'abcdefghijk'], workspace.env);
    await run(['start', 'youtube-abcdefghijk', '--as', 'demo'], workspace.env);
    // 固定的 1x1 PNG 测试夹具，不调用生成器。
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(workspace.directory, 'fixture.png'), bytes);
    for (const operation of ['generate', 'edit']) {
        const result = await execute(parseArgv(['media:land', 'demo', '--kind', 'image', '--from', 'fixture.png',
            '--intent', '模拟图片交付', '--provider', `codex-image.${operation}`, '--id', `img-demo-${operation}`]),
        { ...workspace.env, VIDEO_REMAKE_MEDIA_IMAGE: 'codex-image' }, noExternalCalls);
        assert.deepEqual(await fs.readFile(path.join(workspace.directory, result.data.path)), bytes);
        assert.equal(result.data.provider, `codex-image.${operation}`);
    }
    const ledger = JSON.parse(await fs.readFile(path.join(workspace.directory, 'productions/demo/assets/ledger.json'), 'utf8'));
    assert.deepEqual(ledger.items.map((item) => item.provider), ['codex-image.generate', 'codex-image.edit']);
});

test('已移除的图片 CLI 参数在执行前明确拒绝', async () => {
    for (const flag of ['--session', '--input-fidelity']) {
        await assert.rejects(execute(parseArgv(['media:image', '--intent', 'test', flag, 'legacy']), {}, {
            fetchImpl: () => assert.fail('不得调用图片服务'),
        }), error => error.code === 'INVALID_INPUT' && /已移除/.test(error.message));
    }
});

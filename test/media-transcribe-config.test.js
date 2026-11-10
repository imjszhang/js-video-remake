import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PROVIDERS, PROVIDERS, resolveMediaConfig } from '../src/media/config.js';

test('新增转写工具可显式选择，默认仍是 MLX', () => {
    assert.equal(DEFAULT_PROVIDERS.transcribe, 'mlx-whisper');
    assert.deepEqual(Object.keys(PROVIDERS.transcribe).sort(), ['aliyun-asr', 'azure-speech', 'faster-whisper', 'mlx-whisper']);
    for (const provider of Object.keys(PROVIDERS.transcribe)) {
        assert.equal(resolveMediaConfig({ transcribe: { provider } }, {}, '/tmp/work').transcribe.provider, provider);
        assert.equal(resolveMediaConfig({}, { VIDEO_REMAKE_MEDIA_TRANSCRIBE: provider }, '/tmp/work').transcribe.provider, provider);
    }
});

test('转写配置隔离各 provider 的字段，环境变量覆盖文件值', () => {
    assert.throws(() => resolveMediaConfig({ transcribe: { provider: 'azure-speech', transcriptionUrl: 'https://example.com/' } }, {}, '/tmp/work'), { code: 'CONFIG_INVALID' });
    assert.throws(() => resolveMediaConfig({ transcribe: { provider: 'faster-whisper', apiKeyFile: 'key' } }, {}, '/tmp/work'), { code: 'CONFIG_INVALID' });
    assert.throws(() => resolveMediaConfig({ transcribe: { provider: 'faster-whisper', localFilesOnly: false } }, {}, '/tmp/work'), { code: 'CONFIG_INVALID' });
    assert.throws(() => resolveMediaConfig({ transcribe: { provider: 'faster-whisper', python: '' } }, {}, '/tmp/work'), { code: 'CONFIG_INVALID' });
    const cases = [
        { provider: 'aliyun-asr', env: 'DASHSCOPE_API_KEY_FILE' },
        { provider: 'azure-speech', env: 'AZURE_SPEECH_API_KEY_FILE' },
        { provider: 'mlx-whisper', env: 'WHISPER_API_KEY_FILE' },
    ];
    for (const { provider, env } of cases) {
        const media = resolveMediaConfig({ transcribe: { provider, apiKeyFile: 'file-key' } }, { [env]: 'env-key' }, '/tmp/work');
        assert.equal(media.transcribe.settings.apiKeyFile, '/tmp/work/env-key');
    }
});

test('faster-whisper Python 裸命令保留 PATH 查找，文件路径按工作区解析', () => {
    for (const [python, expected] of [
        ['python3', 'python3'], ['.venv/bin/python', '/tmp/work/.venv/bin/python'],
        ['~/venv/bin/python', path.join(os.homedir(), 'venv/bin/python')], ['/opt/venv/bin/python', '/opt/venv/bin/python'],
    ]) {
        const media = resolveMediaConfig({ transcribe: { provider: 'faster-whisper', python } }, {}, '/tmp/work');
        assert.equal(media.transcribe.settings.python, expected);
    }
    const defaults = resolveMediaConfig({ transcribe: { provider: 'faster-whisper' } }, {}, '/tmp/work').transcribe.settings;
    assert.equal(defaults.python, 'python3');
    assert.equal(defaults.device, 'cpu');
    assert.equal(defaults.computeType, 'int8');
    assert.equal(defaults.localFilesOnly, 'true');
});

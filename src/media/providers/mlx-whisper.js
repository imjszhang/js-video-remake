import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../../errors.js';

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MODEL = 'whisper-large-v3';

async function readKey(file) {
    if (!file) return '';
    try {
        return (await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0].trim();
    } catch {
        throw appError('MEDIA_UNAVAILABLE', `无法读取转写密钥文件: ${file}`);
    }
}

export async function probeWhisper(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json().catch(() => ({}));
    if (body?.status !== 'ok') throw new Error(`健康检查返回 ${JSON.stringify(body).slice(0, 120)}`);
}

export async function transcribe(settings, { file, language, require: required = [] }, { fetchImpl = fetch, timeoutMs = 1800000 } = {}) {
    if (!settings.transcriptionUrl) throw appError('MEDIA_UNAVAILABLE', '未配置 WHISPER_TRANSCRIPTION_URL 或 media.transcribe.transcriptionUrl。');
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw appError('NOT_FOUND', `音频不存在: ${file}`);
    if (!stat.size) throw appError('INVALID_INPUT', '音频文件为空。');
    if (stat.size > MAX_UPLOAD_BYTES) throw appError('INVALID_INPUT', '音频超过 64 MiB；请压缩或分段后转写，转换成 WAV 不保证缩小文件。');

    const form = new FormData();
    form.set('file', new Blob([await fs.readFile(file)]), path.basename(file));
    form.set('model', settings.model || DEFAULT_MODEL);
    const lang = language || settings.language;
    if (lang) form.set('language', lang);
    form.set('response_format', 'verbose_json');
    if (required.includes('word-timestamps')) {
        form.append('timestamp_granularities[]', 'word');
        form.append('timestamp_granularities[]', 'segment');
    }

    const key = await readKey(settings.apiKeyFile);
    let response;
    try {
        response = await fetchImpl(settings.transcriptionUrl, {
            method: 'POST',
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            body: form,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw appError('MEDIA_FAILED', `转写服务不可达: ${error.message}`, { retryable: true });
    }
    const text = await response.text();
    if (!response.ok) throw appError('MEDIA_FAILED', `转写失败 HTTP ${response.status}: ${text.slice(0, 400)}`);
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw appError('MEDIA_FAILED', '转写服务没有返回 JSON。');
    }
    if (!Array.isArray(json?.segments) && !Array.isArray(json?.words)) throw appError('MEDIA_FAILED', '转写结果缺少 segments 或 words。');
    return json;
}

export default {
    id: 'mlx-whisper',
    task: 'transcribe',
    label: 'MLX Whisper 服务（whisper-large-v3）',
    guide: 'providers/mlx-whisper.md',
    ledgerProviders: ['local-llm.whisper-large-v3'],
    testedVersion: DEFAULT_MODEL,
    execution: 'program',
    capabilities: ['timed-transcription', 'word-timestamps'],
    publicSettings: ['healthUrl', 'transcriptionUrl', 'model', 'language'],
    fields: {
        healthUrl: { env: 'WHISPER_HEALTH_URL', type: 'url' },
        transcriptionUrl: { env: 'WHISPER_TRANSCRIPTION_URL', type: 'url' },
        apiKeyFile: { env: 'WHISPER_API_KEY_FILE', type: 'path' },
        deployDir: { env: 'WHISPER_DEPLOY_DIR', type: 'path' },
        model: { type: 'string', default: DEFAULT_MODEL },
        language: { type: 'string' },
    },
    async doctor(settings, { fetchImpl }) {
        if (!settings.transcriptionUrl) return { ready: false, version: '', hint: '未配置 WHISPER_TRANSCRIPTION_URL 或 media.transcribe.transcriptionUrl。' };
        if (!settings.healthUrl) return { ready: true, version: settings.model || DEFAULT_MODEL, hint: '未配置健康检查 URL，跳过探活。' };
        try {
            await probeWhisper(settings.healthUrl, { fetchImpl });
            return { ready: true, version: settings.model || DEFAULT_MODEL, hint: '' };
        } catch (error) {
            return { ready: false, version: '', hint: `转写服务未就绪: ${error.message}` };
        }
    },
    async transcribe(settings, request, deps) {
        return transcribe(settings, request, deps);
    },
};

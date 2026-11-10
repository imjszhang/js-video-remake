import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { appError } from '../../errors.js';

export const API_VERSION = '2025-10-15';
// 固定版本 REST 参考的保守上限；不要把云端升级后的限额直接当成本适配器支持范围。
export const MAX_UPLOAD_BYTES = 250_000_000;

const failed = (message) => appError('MEDIA_FAILED', message);

function endpointUrl(settings) {
    let endpoint;
    try { endpoint = new URL(settings.endpoint); } catch {
        throw appError('MEDIA_UNAVAILABLE', '未配置有效的 AZURE_SPEECH_ENDPOINT 或 media.transcribe.endpoint。');
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
        throw appError('CONFIG_INVALID', 'Azure Speech endpoint 必须是 HTTPS 资源根地址，不含路径、查询参数或凭据。');
    }
    return new URL(`/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`, endpoint).href;
}

async function readKey(file) {
    if (!file) throw appError('MEDIA_UNAVAILABLE', '未配置 AZURE_SPEECH_API_KEY_FILE 或 media.transcribe.apiKeyFile。');
    let key;
    try { key = (await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0].trim(); } catch {
        throw appError('MEDIA_UNAVAILABLE', '无法读取 Azure Speech 密钥文件。');
    }
    if (!key || /[^\x21-\x7e]/.test(key)) throw appError('MEDIA_UNAVAILABLE', 'Azure Speech 密钥文件第一行必须是非空有效密钥。');
    return key;
}

export function azureLocale(language) {
    if (language === undefined) return undefined;
    if (typeof language !== 'string' || !language.trim()) throw appError('INVALID_INPUT', 'Azure Speech language 必须是语言代码。');
    const trimmed = language.trim();
    const aliases = { zh: 'zh-CN', en: 'en-US' };
    const locale = aliases[trimmed.toLowerCase()] || trimmed;
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i.test(locale)) {
        throw appError('INVALID_INPUT', 'Azure Speech 请使用完整语言区域代码（如 zh-CN、en-US）；简写只兼容 zh、en。');
    }
    return locale;
}

function milliseconds(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw failed('Azure Speech 返回了无效的毫秒时间。');
    return value / 1000;
}

function timing(item) {
    if (!item || typeof item !== 'object') throw failed('Azure Speech 返回了无效的转写条目。');
    const start = milliseconds(item.offsetMilliseconds);
    const end = milliseconds(item.offsetMilliseconds + item.durationMilliseconds);
    milliseconds(item.durationMilliseconds);
    return { start, end };
}

export function normalizeAzureTranscript(json) {
    if (!json || !Array.isArray(json.phrases)) throw failed('Azure Speech 转写结果缺少 phrases。');
    const segments = json.phrases.map((phrase) => {
        const time = timing(phrase);
        if (typeof phrase.text !== 'string') throw failed('Azure Speech 转写分段缺少文本。');
        const segment = { ...time, text: phrase.text };
        if (phrase.locale !== undefined) {
            if (typeof phrase.locale !== 'string') throw failed('Azure Speech 返回了无效的 locale。');
            segment.language = phrase.locale;
        }
        if (phrase.words !== undefined) {
            if (!Array.isArray(phrase.words)) throw failed('Azure Speech 分段 words 必须是数组。');
            segment.words = phrase.words.map((word) => {
                const wordTime = timing(word);
                if (typeof word.text !== 'string') throw failed('Azure Speech 词级条目缺少文本。');
                return { ...wordTime, word: word.text };
            });
        }
        return segment;
    }).sort((a, b) => a.start - b.start);
    let text = segments.map((segment) => segment.text).join(' ');
    if (json.combinedPhrases !== undefined) {
        if (!Array.isArray(json.combinedPhrases) || json.combinedPhrases.some((phrase) => typeof phrase?.text !== 'string')) {
            throw failed('Azure Speech 返回了无效的 combinedPhrases。');
        }
        if (json.combinedPhrases.length) text = json.combinedPhrases.map((phrase) => phrase.text).join('\n');
    }
    if (text.trim() && !segments.length) throw failed('Azure Speech 返回了文本，但缺少带时间的转写分段。');
    const result = { text, segments };
    if (json.durationMilliseconds !== undefined) result.duration = milliseconds(json.durationMilliseconds);
    const languages = [...new Set(segments.map((segment) => segment.language).filter(Boolean))];
    if (languages.length === 1) result.language = languages[0];
    return result;
}

export async function transcribe(settings, { file, language }, { fetchImpl = fetch, timeoutMs = 1800000 } = {}) {
    const url = endpointUrl(settings);
    const key = await readKey(settings.apiKeyFile);
    const locale = azureLocale(language ?? settings.language);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw appError('NOT_FOUND', 'Azure Speech 输入音频不存在。');
    if (stat.size === 0) throw appError('INVALID_INPUT', 'Azure Speech 输入音频为空。');
    if (stat.size >= MAX_UPLOAD_BYTES) throw appError('INVALID_INPUT', 'Azure Speech 适配器要求音频小于 250 MB，请先分段或压缩。');
    const definition = { profanityFilterMode: 'None' };
    if (locale) definition.locales = [locale];
    const form = new FormData();
    form.set('audio', await openAsBlob(file), path.basename(file));
    form.set('definition', JSON.stringify(definition));
    let response;
    let body;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Ocp-Apim-Subscription-Key': key },
            body: form,
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
        body = await response.text();
    } catch {
        // 不回显远端错误内容/请求头，避免密钥或音频内容进入日志。
        throw appError('MEDIA_FAILED', 'Azure Speech 请求或读取响应失败（连接中断或超时）；未自动重试，请确认服务端处理情况。', { retryable: true });
    }
    if (!response.ok) {
        throw appError('MEDIA_FAILED', `Azure Speech 转写失败 HTTP ${response.status}；请检查资源区域、密钥、额度及音频格式/时长。`, {
            retryable: response.status === 429 || response.status >= 500,
        });
    }
    let json;
    try { json = JSON.parse(body); } catch { throw failed('Azure Speech 没有返回有效 JSON。'); }
    return normalizeAzureTranscript(json);
}

export default {
    id: 'azure-speech',
    task: 'transcribe',
    label: 'Azure Speech（Fast Transcription）',
    guide: 'providers/azure-speech.md',
    ledgerProviders: ['azure-speech'],
    testedVersion: `${API_VERSION}（仅模拟接口验证，未实测云服务）`,
    execution: 'program',
    capabilities: ['timed-transcription', 'word-timestamps'],
    publicSettings: ['endpoint', 'language'],
    fields: {
        endpoint: { env: 'AZURE_SPEECH_ENDPOINT', type: 'url' },
        apiKeyFile: { env: 'AZURE_SPEECH_API_KEY_FILE', type: 'path' },
        language: { env: 'AZURE_SPEECH_LANGUAGE', type: 'string' },
    },
    async doctor(settings) {
        try {
            endpointUrl(settings);
            azureLocale(settings.language);
            await readKey(settings.apiKeyFile);
            return { ready: true, version: API_VERSION, hint: '本地配置检查通过；未验证密钥有效性、服务区域或额度，也未调用云端转写。Fast Transcription 需要 S0 资源，不适用 F0 免费实时转写额度。' };
        } catch (error) {
            return { ready: false, version: '', hint: error.message };
        }
    },
    validateRequest(request) {
        if (Object.keys(request.options ?? {}).length) throw appError('INVALID_INPUT', 'azure-speech 不支持专属 options。');
        azureLocale(request.language);
    },
    transcribe,
};

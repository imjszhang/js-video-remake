import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError } from '../../errors.js';

export const DEFAULT_MODEL = 'qwen3-tts';
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 2000;

const invalid = (message) => appError('INVALID_INPUT', message);
const failed = (message) => appError('MEDIA_FAILED', message);
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const SPEECH_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [3000, 8000, 15000, 30000];

function pause(ms, signal) {
    if (signal?.aborted) throw appError('VIDEO_CANCELLED', '口播生成已取消。');
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(appError('VIDEO_CANCELLED', '口播生成已取消。'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function baseUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw appError('CONFIG_INVALID', '语音合成服务地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw appError('CONFIG_INVALID', '语音合成服务地址必须是不带凭据、查询参数或片段的 HTTP(S) URL。');
    }
    return url.href.replace(/\/$/, '');
}

async function readKey(file) {
    if (!file) throw appError('MEDIA_UNAVAILABLE', '未配置 QWEN_TTS_API_KEY_FILE 或 media.speech.apiKeyFile。');
    let key;
    try { key = (await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0].trim(); } catch {
        throw appError('MEDIA_UNAVAILABLE', `无法读取语音合成密钥文件: ${file}`);
    }
    if (!key) throw appError('MEDIA_UNAVAILABLE', '语音合成密钥文件第一行为空。');
    return key;
}

export function pcmWavInfo(bytes) {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
        throw invalid('参考音频必须是 WAV。');
    }
    let offset = 12;
    let format;
    let channels;
    let rate;
    let bits;
    let dataSize;
    while (offset + 8 <= bytes.length) {
        const id = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > bytes.length) break;
        if (id === 'fmt ' && size >= 16) {
            format = bytes.readUInt16LE(start);
            channels = bytes.readUInt16LE(start + 2);
            rate = bytes.readUInt32LE(start + 4);
            bits = bytes.readUInt16LE(start + 14);
        } else if (id === 'data') {
            dataSize = size;
            break;
        }
        offset = start + size + (size % 2);
    }
    if (format !== 1 || bits !== 16 || !rate || !channels || !dataSize) throw invalid('参考音频必须是 16-bit PCM WAV。');
    const duration = dataSize / (rate * channels * (bits / 8));
    if (duration < 1 || duration > 30) throw invalid('参考音频时长必须在 1 到 30 秒之间。');
    return { duration, channels, rate };
}

function boundedText(value, name) {
    if (typeof value !== 'string' || !value.trim() || [...value].length > MAX_TEXT) throw invalid(`${name} 必须是 1 到 ${MAX_TEXT} 个字符。`);
    return value;
}

export function validateSpeechRequest(request) {
    boundedText(request.text, 'text');
    boundedText(request.referenceText, 'referenceText');
    if (!request.reference) throw invalid('qwen-tts 需要参考音频 reference。');
    if (request.voice) throw invalid('qwen-tts 用参考音频确定音色，不接受 voice。');
    if (request.language !== undefined && (typeof request.language !== 'string' || !request.language.trim() || request.language.length > 32)) {
        throw invalid('language 必须是不超过 32 个字符的字符串。');
    }
    if (Object.keys(request.options ?? {}).length) throw invalid('qwen-tts 不支持专属 options。');
}

async function saveWav(bytes, outPath) {
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
        throw failed('语音合成服务没有返回 WAV。');
    }
    const target = outPath || path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-qwen-tts-')), 'speech.wav');
    if (path.extname(target).toLowerCase() !== '.wav') throw invalid('语音输出文件必须使用 .wav 后缀。');
    if (await fs.lstat(target).catch(() => null)) throw appError('ALREADY_EXISTS', '语音输出文件已存在，请更换 --out。');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    return target;
}

export async function synthesize(settings, request, { fetchImpl = fetch, timeoutMs = 600000, signal } = {}) {
    validateSpeechRequest(request);
    const stat = await fs.stat(request.reference).catch(() => null);
    if (!stat?.isFile() || !stat.size || stat.size > MAX_REFERENCE_BYTES) throw invalid('参考音频不存在、为空或超过 12 MiB。');
    const wav = await fs.readFile(request.reference);
    pcmWavInfo(wav);
    const key = await readKey(settings.apiKeyFile);
    const url = new URL('/v1/audio/speech', `${baseUrl(settings.baseUrl)}/`);
    const body = {
        model: settings.model || DEFAULT_MODEL,
        input: request.text,
        ref_text: request.referenceText,
        ref_audio_base64: wav.toString('base64'),
        response_format: 'wav',
        ...(request.language || settings.language ? { language: request.language || settings.language } : {}),
    };
    const payload = JSON.stringify(body);
    let bytes;
    for (let attempt = 1; attempt <= SPEECH_ATTEMPTS; attempt++) {
        let response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: payload,
                signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
                redirect: 'error',
            });
        } catch (error) {
            if (typeof error.code === 'string' && error.code.includes('_')) throw error;
            throw failed(`语音合成服务不可达: ${error.message}`);
        }
        bytes = Buffer.from(await response.arrayBuffer());
        if (response.ok) break;
        let message = bytes.toString('utf8').slice(0, 400);
        try { message = JSON.parse(bytes.toString('utf8'))?.error?.message || message; } catch { /* keep text */ }
        if (!RETRYABLE_STATUS.has(response.status) || attempt === SPEECH_ATTEMPTS) {
            throw failed(`语音合成失败 HTTP ${response.status}: ${message}`);
        }
        await pause(RETRY_DELAYS_MS[attempt - 1], signal);
    }
    if (bytes.length > MAX_AUDIO_BYTES) throw failed('语音合成结果超过 32 MiB。');
    return { path: await saveWav(bytes, request.outPath), provider: 'qwen-tts.speak' };
}

async function probe(url, key, fetchImpl) {
    const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json().catch(() => ({}));
    if (body?.status !== 'ok') throw new Error(`健康检查返回 ${JSON.stringify(body).slice(0, 120)}`);
}

export default {
    id: 'qwen-tts',
    task: 'speech',
    label: 'Qwen3 TTS（参考音频克隆，WAV）',
    guide: 'providers/qwen-tts.md',
    ledgerProviders: ['qwen-tts.speak'],
    testedVersion: DEFAULT_MODEL,
    execution: 'program',
    capabilities: ['text-to-speech'],
    publicSettings: ['baseUrl', 'healthUrl', 'model', 'language'],
    fields: {
        baseUrl: { env: 'QWEN_TTS_BASE_URL', type: 'url' },
        healthUrl: { env: 'QWEN_TTS_HEALTH_URL', type: 'url' },
        apiKeyFile: { env: 'QWEN_TTS_API_KEY_FILE', type: 'path' },
        model: { type: 'string', default: DEFAULT_MODEL },
        language: { type: 'string' },
    },
    validateRequest: validateSpeechRequest,
    async doctor(settings, { fetchImpl = fetch } = {}) {
        try {
            if (!settings.baseUrl) return { ready: false, version: '', hint: '未配置 QWEN_TTS_BASE_URL 或 media.speech.baseUrl。' };
            baseUrl(settings.baseUrl);
            const key = await readKey(settings.apiKeyFile);
            if (!settings.healthUrl) return { ready: true, version: settings.model || DEFAULT_MODEL, hint: '未配置健康检查 URL，仅检查了本地配置。' };
            await probe(settings.healthUrl, key, fetchImpl);
            return { ready: true, version: settings.model || DEFAULT_MODEL, hint: '' };
        } catch (error) {
            return { ready: false, version: '', hint: error.message };
        }
    },
    async synthesize(settings, request, deps) {
        return synthesize(settings, request, deps);
    },
};

import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appError } from '../../errors.js';

export const DEFAULT_MODEL = 'paraformer-v2';
export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
export const MAX_UPLOAD_BYTES = 1_000_000_000;
const LANGUAGES = new Set(['zh', 'en', 'ja', 'yue', 'ko', 'de', 'fr', 'ru']);
const failed = (message) => appError('MEDIA_FAILED', message);

async function readKey(file) {
    if (!file) throw appError('MEDIA_UNAVAILABLE', '未配置 DASHSCOPE_API_KEY_FILE 或 media.transcribe.apiKeyFile。');
    let key;
    try { key = (await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0].trim(); }
    catch { throw appError('MEDIA_UNAVAILABLE', '无法读取阿里百炼 API 密钥文件。'); }
    if (!key) throw appError('MEDIA_UNAVAILABLE', '阿里百炼 API 密钥文件第一行为空。');
    return key;
}

function httpsUrl(value, label, cloudResource = false) {
    let url;
    try { url = new URL(value); } catch { throw failed(`${label}不是有效地址。`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
        || (cloudResource && !url.hostname.endsWith('.aliyuncs.com'))) {
        throw failed(`${label}必须是无凭证的 HTTPS 地址${cloudResource ? '，且属于阿里云 OSS' : ''}。`);
    }
    return url.href;
}

function configuration(settings, language) {
    const model = settings.model || DEFAULT_MODEL;
    if (model !== DEFAULT_MODEL) throw appError('CONFIG_INVALID', 'aliyun-asr 当前只支持 paraformer-v2 文件转写模型。');
    const lang = language || settings.language;
    if (lang && (model !== DEFAULT_MODEL || !LANGUAGES.has(lang))) {
        throw appError('INVALID_INPUT', '语言提示仅支持 paraformer-v2，语言可选 zh、en、ja、yue、ko、de、fr、ru。');
    }
    const base = httpsUrl(settings.baseUrl || DEFAULT_BASE_URL, '百炼 API 地址').replace(/\/$/, '');
    if (new URL(base).search) throw appError('CONFIG_INVALID', '百炼 API 地址不能包含查询参数。');
    const uploadUrl = httpsUrl(settings.uploadUrl || `${base}/uploads`, '百炼上传凭证地址');
    return { model, language: lang, base, uploadUrl };
}

function seconds(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw failed('百炼转写结果包含无效的毫秒时间。');
    return value / 1000;
}

function timed(item) {
    if (!item || typeof item.text !== 'string') throw failed('百炼转写结果缺少文本。');
    const start = seconds(item.begin_time);
    const end = seconds(item.end_time);
    if (end < start) throw failed('百炼转写结果的结束时间早于开始时间。');
    return { start, end, text: item.text };
}

export function normalizeAliyunTranscript(json, language) {
    if (!Array.isArray(json?.transcripts)) throw failed('百炼结果缺少 transcripts。');
    const segments = [];
    for (const transcript of json.transcripts) {
        if (transcript?.channel_id !== 0 || !Array.isArray(transcript.sentences)) {
            throw failed('百炼结果缺少第 0 音轨的句子时间。');
        }
        for (const sentence of transcript.sentences) {
            const segment = timed(sentence);
            if (sentence.words !== undefined) {
                if (!Array.isArray(sentence.words)) throw failed('百炼结果 words 必须是数组。');
                segment.words = sentence.words.map((item) => {
                    const word = timed(item);
                    if (item.punctuation !== undefined && typeof item.punctuation !== 'string') throw failed('百炼词级标点格式无效。');
                    return { start: word.start, end: word.end, word: word.text + (item.punctuation || '') };
                });
            }
            segments.push(segment);
        }
    }
    segments.sort((a, b) => a.start - b.start);
    const text = json.transcripts.map((transcript) => typeof transcript.text === 'string'
        ? transcript.text : transcript.sentences.map((sentence) => sentence.text).join(' ')).join('\n');
    return { text, ...(language ? { language } : {}), segments };
}

export async function transcribeAliyun(settings, { file, language }, {
    fetchImpl = fetch, timeoutMs = 1800000, pollIntervalMs = 3000,
    sleep = (ms, signal) => delay(ms, undefined, { signal }),
} = {}) {
    const config = configuration(settings, language);
    const key = await readKey(settings.apiKeyFile);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw appError('NOT_FOUND', '待转写音频文件不存在。');
    if (!stat.size || stat.size > MAX_UPLOAD_BYTES) throw appError('INVALID_INPUT', '百炼临时上传要求非空文件，且不超过 1 GB。');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
        throw appError('INVALID_INPUT', '转写超时和轮询间隔必须是正整数毫秒。');
    }
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    let taskId;
    const request = async (url, options, label, json = true) => {
        signal.throwIfAborted();
        let response;
        try { response = await fetchImpl(url, { ...options, redirect: 'error', signal }); }
        catch { throw failed(`${label}网络请求失败；请检查网络，已提交的任务不会自动重试。`); }
        if (!response.ok) throw failed(`${label}失败（HTTP ${response.status}）。`);
        if (!json) return;
        try { return await response.json(); }
        catch { throw failed(`${label}没有返回有效 JSON。`); }
    };
    try {
        const policyUrl = new URL(config.uploadUrl);
        policyUrl.searchParams.set('action', 'getPolicy');
        policyUrl.searchParams.set('model', config.model);
        const policy = (await request(policyUrl.href, { headers }, '百炼上传凭证'))?.data;
        const fields = {
            OSSAccessKeyId: 'oss_access_key_id', Signature: 'signature', policy: 'policy',
            'x-oss-object-acl': 'x_oss_object_acl', 'x-oss-forbid-overwrite': 'x_oss_forbid_overwrite',
        };
        for (const name of [...Object.values(fields), 'upload_host', 'upload_dir']) {
            if (typeof policy?.[name] !== 'string' || !policy[name]) throw failed('百炼上传凭证缺少必要字段。');
        }
        const uploadHost = httpsUrl(policy.upload_host, 'OSS 上传地址', true);
        const extension = /^\.[a-z0-9]{1,8}$/i.test(path.extname(file)) ? path.extname(file) : '.audio';
        const filename = `${randomUUID()}${extension}`;
        const objectKey = `${policy.upload_dir.replace(/\/$/, '')}/${filename}`;
        const form = new FormData();
        for (const [name, keyName] of Object.entries(fields)) form.set(name, policy[keyName]);
        form.set('key', objectKey);
        form.set('success_action_status', '200');
        form.set('file', await openAsBlob(file), filename);
        await request(uploadHost, { method: 'POST', body: form }, '百炼音频上传', false);
        const parameters = { channel_id: [0], timestamp_alignment_enabled: true };
        if (config.language) parameters.language_hints = [config.language];
        const submission = await request(`${config.base}/services/audio/asr/transcription`, {
            method: 'POST',
            headers: { ...headers, 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
            body: JSON.stringify({ model: config.model, input: { file_urls: [`oss://${objectKey}`] }, parameters }),
        }, '百炼转写提交');
        const submittedId = submission?.output?.task_id;
        if (typeof submittedId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submittedId)) throw failed('百炼转写提交未返回有效任务 ID。');
        taskId = submittedId;
        for (let attempt = 0; attempt < Math.ceil(timeoutMs / pollIntervalMs); attempt++) {
            const result = await request(`${config.base}/tasks/${taskId}`, { method: 'GET', headers }, '百炼任务查询');
            const output = result?.output;
            if (output?.task_status === 'SUCCEEDED') {
                if (!Array.isArray(output.results) || output.results.length !== 1 || output.results[0]?.subtask_status !== 'SUCCEEDED') {
                    throw failed('百炼音频子任务失败或结果不完整。');
                }
                const url = httpsUrl(output.results[0].transcription_url, '百炼结果地址', true);
                // 签名 URL 自带下载权限，不能向 OSS 发送百炼 Bearer 密钥。
                return normalizeAliyunTranscript(await request(url, {}, '百炼结果下载'), config.language);
            }
            if (!['PENDING', 'RUNNING'].includes(output?.task_status)) throw failed('百炼转写任务失败或返回未知状态。');
            await sleep(Math.min(pollIntervalMs, timeoutMs), signal);
        }
        throw failed('百炼转写等待超时。');
    } catch (error) {
        const message = signal.aborted ? '百炼转写等待超时。' : error.code === 'MEDIA_FAILED' ? error.message : '百炼转写处理失败；请检查文件和网络。';
        throw appError('MEDIA_FAILED', `${message}${taskId ? ` 已提交任务 ${taskId}，请先查询状态，避免重复提交。` : ''}`, {
            data: taskId ? { taskId } : undefined,
        });
    }
}

export default {
    id: 'aliyun-asr',
    task: 'transcribe',
    label: '阿里百炼 Paraformer 文件转写',
    guide: 'providers/aliyun-asr.md',
    ledgerProviders: ['aliyun-asr'],
    testedVersion: 'Paraformer HTTP API；模拟验证，未实测',
    execution: 'program',
    capabilities: ['timed-transcription', 'word-timestamps'],
    publicSettings: ['baseUrl', 'uploadUrl', 'model', 'language'],
    fields: {
        apiKeyFile: { env: 'DASHSCOPE_API_KEY_FILE', type: 'path' },
        baseUrl: { env: 'DASHSCOPE_BASE_URL', type: 'url', default: DEFAULT_BASE_URL },
        uploadUrl: { env: 'DASHSCOPE_UPLOAD_URL', type: 'url' },
        model: { type: 'string', default: DEFAULT_MODEL },
        language: { type: 'string' },
    },
    async doctor(settings) {
        try {
            const { model } = configuration(settings);
            await readKey(settings.apiKeyFile);
            return { ready: true, version: model, hint: '仅通过本地配置检查；未验证账号权限、余额、服务可达性或真实转写。临时上传仅用于开发测试。' };
        } catch (error) {
            return { ready: false, version: '', hint: error.message };
        }
    },
    transcribe: transcribeAliyun,
};

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appError } from '../../errors.js';
import { inputImages } from './image-common.js';

export const invalid = (message) => appError('INVALID_INPUT', message);
export const failed = (message) => appError('MEDIA_FAILED', message);
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export function serviceUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw appError('CONFIG_INVALID', '视频服务地址无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw appError('CONFIG_INVALID', '视频服务需要不含凭据、查询参数和片段的 HTTPS 根地址。');
    return url.href.replace(/\/$/, '');
}
async function keyFile(file) {
    let key;
    try { key = (await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0].trim(); } catch { throw appError('MEDIA_UNAVAILABLE', '请配置可读取的视频服务 apiKeyFile。'); }
    if (!key || /[^\x21-\x7e]/.test(key)) throw appError('MEDIA_UNAVAILABLE', '视频密钥文件第一行无效。');
    return key;
}
export function taskId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid('视频任务 ID 无效。');
    return value;
}
export function basicRequest(request, { maxPrompt, minDuration, maxDuration, durations } = {}) {
    if (typeof request.intent !== 'string' || !request.intent.trim() || request.intent.length > maxPrompt) throw invalid(`提示词必须非空且不超过 ${maxPrompt} 字符。`);
    if (request.audio || request.referenceVideo || (request.images?.length ?? 0) > 1) throw appError('MEDIA_CAPABILITY_UNSUPPORTED', '此视频适配器只支持文生视频和单张首帧图生视频。');
    if (Object.keys(request.options ?? {}).length) throw invalid('此视频适配器暂不接受专属 options。');
    if (request.duration !== undefined && (!Number.isInteger(request.duration) || (durations ? !durations.includes(request.duration) : request.duration < minDuration || request.duration > maxDuration))) throw invalid('视频时长不在所选工具支持的范围内。');
}
export async function firstFrame(request, limit = 20_000_000) {
    const [image] = await inputImages(request.images, limit);
    return image ? `data:${image.mime};base64,${image.bytes.toString('base64')}` : undefined;
}
export async function checkOutput(file) {
    if (!file) return;
    if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.mp4') throw invalid('视频输出必须为绝对路径的 .mp4 文件。');
    if (await fs.lstat(file).catch(() => null)) throw appError('ALREADY_EXISTS', '视频输出已存在，请更换 --out；不会覆盖已有文件。');
}

function connection(deps) {
    const timeoutMs = deps.timeoutMs ?? 1800000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw invalid('视频超时必须是正整数毫秒。');
    const signal = AbortSignal.timeout(timeoutMs);
    const response = async (url, init = {}) => {
        signal.throwIfAborted();
        const result = await (deps.fetchImpl ?? fetch)(url, { ...init, signal, redirect: 'error' });
        if (!result.ok) throw failed(`视频服务返回 HTTP ${result.status}；未自动重试。`);
        return result;
    };
    const json = async (url, init) => {
        const res = await response(url, init);
        const limit = 4 * 1024 * 1024;
        if (Number(res.headers.get('content-length')) > limit) throw failed('视频服务 JSON 响应过大。');
        let size = 0;
        const chunks = [];
        const reader = res.body?.getReader();
        if (!reader) throw failed('视频服务响应为空。');
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) { await reader.cancel(); throw failed('视频服务 JSON 响应过大。'); }
            chunks.push(Buffer.from(value));
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failed('视频服务未返回有效 JSON。'); }
    };
    return { response, json, signal, timeoutMs };
}

async function download(urlValue, output, client) {
    let url;
    try { url = new URL(urlValue); } catch { throw failed('视频任务没有返回下载地址。'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw failed('视频下载地址必须是无凭据的 HTTPS 地址。');
    // 签名下载 URL 不携带 API 认证头，也不写入最终结果或日志。
    const response = await client.response(url.href);
    if (Number(response.headers.get('content-length')) > MAX_VIDEO_BYTES) throw failed('视频文件超过 512 MiB。');
    const target = output || path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-video-')), 'video.mp4');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const staging = path.join(path.dirname(target), `.remake-${randomUUID()}.part`);
    let handle;
    const reader = response.body?.getReader();
    if (!reader) throw failed('视频下载响应为空。');
    try {
        handle = await fs.open(staging, 'wx');
        let total = 0;
        let prefix = Buffer.alloc(0);
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_VIDEO_BYTES) throw failed('视频文件超过 512 MiB。');
            if (prefix.length < 32) prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 32 - prefix.length)]);
            await handle.writeFile(value);
        }
        if (total < 24 || prefix.toString('ascii', 4, 8) !== 'ftyp' || prefix.readUInt32BE(0) < 16 || prefix.readUInt32BE(0) > total
            || !['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(prefix.toString('ascii', 8, 12))) throw failed('下载结果不是支持的 MP4 容器，未保存为视频。');
        await handle.close();
        handle = undefined;
        // 同目录硬链接发布，目标已存在时失败，不覆盖；半成品不会成为正式输出。
        await fs.link(staging, target);
        return target;
    } finally {
        await reader.cancel().catch(() => {});
        if (handle) await handle.close().catch(() => {});
        await fs.rm(staging, { force: true });
    }
}

export function videoProvider(spec) {
    const settingsFor = (settings) => {
        const resolved = { ...spec.defaults, ...settings };
        resolved.baseUrl = serviceUrl(resolved.baseUrl);
        spec.validateSettings?.(resolved);
        return resolved;
    };
    async function run(settings, request, deps = {}, resumeId) {
        const resolved = settingsFor(settings);
        if (!resumeId) spec.validateRequest(request);
        else taskId(resumeId);
        await checkOutput(request.outPath);
        const key = await keyFile(resolved.apiKeyFile);
        const client = connection(deps);
        const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...spec.headers };
        const interval = deps.pollIntervalMs ?? 15000;
        if (!Number.isInteger(interval) || interval < 1) throw invalid('视频轮询间隔必须是正整数毫秒。');
        let id = resumeId;
        try {
            if (!id) {
                const submission = await spec.build(resolved, request);
                const response = await client.json(`${resolved.baseUrl}${submission.path}`, { method: 'POST', headers, body: JSON.stringify(submission.body) });
                const value = spec.submitted(response);
                try { id = taskId(value); } catch { throw failed('视频服务未返回有效任务 ID；请先核对服务端是否已提交，勿自动重试。'); }
            }
            for (let attempt = 0; attempt < Math.ceil(client.timeoutMs / interval); attempt++) {
                const result = await spec.poll(resolved, id, (suffix) => client.json(`${resolved.baseUrl}${suffix}`, { method: 'GET', headers }));
                if (result.done) {
                    const file = await download(result.url, request.outPath, client);
                    return { path: file, provider: `${spec.id}.generate`, taskId: id };
                }
                await (deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })))(interval, client.signal);
            }
            throw failed('视频任务等待超时，服务端可能仍在运行。');
        } catch (error) {
            const message = client.signal.aborted ? '视频任务等待超时。' : ['MEDIA_FAILED', 'INVALID_INPUT', 'MEDIA_CAPABILITY_UNSUPPORTED', 'ALREADY_EXISTS'].includes(error.code)
                ? error.message : '视频请求、响应或文件交付失败；未自动重试。';
            throw appError(error.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'MEDIA_FAILED', `${message}${id ? ` 任务 ID：${id}；可用 media:video --task-id 继续查询，不要重复提交。` : ''}`, { data: id ? { taskId: id, provider: spec.id } : undefined });
        }
    }
    return {
        id: spec.id, task: 'video', label: spec.label, guide: `providers/${spec.id}.md`,
        execution: 'program', capabilities: ['text-to-video', 'image-to-video'], ledgerProviders: [`${spec.id}.generate`],
        testedVersion: '官方 REST 协议；仅模拟测试，未真实生成视频', publicSettings: Object.keys(spec.defaults),
        fields: spec.fields, validateRequest: spec.validateRequest,
        prepare(settings, request) { settingsFor(settings); spec.validateRequest(request); spec.validateCombined?.(settingsFor(settings), request); },
        async doctor(settings) {
            try {
                const resolved = settingsFor(settings);
                await keyFile(resolved.apiKeyFile);
                return { ready: true, version: resolved.model || `${resolved.textModel} / ${resolved.imageModel}`, hint: '仅检查本地配置；未确认云端账号、区域、模型权限或额度，未提交视频任务。' };
            } catch (error) { return { ready: false, version: '', hint: error.message }; }
        },
        generateVideo: (settings, request, deps) => { spec.validateCombined?.(settingsFor(settings), request); return run(settings, request, deps); },
        resumeVideo: (settings, id, request, deps) => run(settings, request, deps, id),
    };
}

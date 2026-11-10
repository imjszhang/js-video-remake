import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../errors.js';
import { resolveAssets, sourceId, validateEntry } from './assets.js';

export function gatewayVideo(config, { fetchImpl = fetch } = {}) {
    const settings = config.source;
    const env = config.env || process.env;

    async function request(resource, { method = 'GET', body, timeoutMs = settings.requestTimeoutMs } = {}) {
        let token = env[settings.tokenEnv] || '';
        if (!token && settings.tokenFile) {
            token = (await fs.readFile(settings.tokenFile, 'utf8').catch(() => {
                throw appError('SOURCE_AUTH', '无法读取数据源 tokenFile。');
            })).trim();
            if (settings.tokenJsonKey) {
                try { token = JSON.parse(token)[settings.tokenJsonKey]; }
                catch { throw appError('SOURCE_AUTH', 'tokenFile 不是有效 JSON。'); }
                if (typeof token !== 'string') throw appError('SOURCE_AUTH', 'tokenFile 缺少指定的 tokenJsonKey。');
            }
        }
        if (method !== 'GET' && !token) throw appError('SOURCE_AUTH', `入队需要 Bearer token：请设置 ${settings.tokenEnv} 或 source.tokenFile。`);
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body) headers['Content-Type'] = 'application/json';
        try {
            const response = await fetchImpl(new URL(resource, settings.baseUrl), {
                method, headers, body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
            });
            if (!response.ok) {
                const code = response.status === 404 ? 'NOT_FOUND'
                    : [401, 403].includes(response.status) ? 'SOURCE_AUTH' : 'SOURCE_HTTP';
                throw appError(code, `数据源 HTTP ${response.status}（${method} ${resource}）`,
                    { retryable: response.status === 429 || response.status >= 500 });
            }
            const data = await response.json().catch(error => {
                if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
                throw appError('SOURCE_PROTOCOL', '数据源未返回有效 JSON。');
            });
            if (!data || data.status !== 'ok') throw appError('SOURCE_PROTOCOL', '数据源响应 status 不是 ok。');
            return data;
        } catch (error) {
            if (error.retryable !== undefined) throw error;
            if (error.name === 'TimeoutError' || error.name === 'AbortError') {
                throw appError('SOURCE_TIMEOUT', '网关请求超时。', { retryable: true });
            }
            // Do not echo server bodies, request headers or URL credentials into logs.
            throw appError('SOURCE_UNAVAILABLE', '无法连接素材网关，请检查服务地址和网络。', { retryable: true });
        }
    }

    return {
        kind: 'gateway-video', location: settings.baseUrl,
        health: () => request('health.json'),
        async get(id, options) {
            const data = await request(`videos/${encodeURIComponent(sourceId(id))}.json`, options);
            return validateEntry(data.video, id);
        },
        async enqueue({ url, quality, force }) {
            const data = await request('videos.json', { method: 'POST', body: { url, quality, force } });
            return { video: validateEntry(data.video), skipped: Boolean(data.skipped), existed: Boolean(data.existed) };
        },
        async list(query = {}) {
            const params = new URLSearchParams(query);
            const data = await request(`videos.json?${params}`);
            if (!Array.isArray(data.data)) throw appError('SOURCE_PROTOCOL', '数据源未返回列表。');
            return { ...data, data: data.data.map(video => validateEntry(video)) };
        },
        resolveAssets(video) {
            const dir = settings.directoryTemplate.replaceAll('{id}', sourceId(video.videoId));
            const mapped = (name) => {
                if (typeof name !== 'string' || path.isAbsolute(name)) throw appError('SOURCE_ASSET_INVALID', '素材文件名必须是相对路径。');
                return path.join(dir, name);
            };
            // The gateway exposes public metadata, not its database or private local paths.
            return resolveAssets(config, video, {
                video: mapped(settings.videoFile),
                thumbnail: settings.thumbFile ? mapped(settings.thumbFile) : null,
                subs: Object.fromEntries(Object.entries(video.subs ?? {}).map(([lang, name]) => [lang, mapped(name)])),
            });
        },
    };
}

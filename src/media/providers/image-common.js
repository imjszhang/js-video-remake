import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError } from '../../errors.js';

export const invalid = (message) => appError('INVALID_INPUT', message);
export const failed = (message) => appError('MEDIA_FAILED', message);
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function baseUrl(value, allowHttp = false) {
    let url;
    try { url = new URL(value); } catch { throw appError('CONFIG_INVALID', '图片服务地址无效。'); }
    if (!(allowHttp ? ['http:', 'https:'] : ['https:']).includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw appError('CONFIG_INVALID', '图片服务地址协议无效，或包含凭据、查询参数、片段。');
    }
    return url.href.replace(/\/$/, '');
}

export async function readKey(file, optional = false) {
    if (!file && optional) return '';
    let key;
    try { key = (await fs.readFile(file, 'utf8')).split(/\r?\n/, 1)[0].trim(); } catch {
        throw appError('MEDIA_UNAVAILABLE', '请配置可读取的图片服务 apiKeyFile。');
    }
    if (!key || /[^\x21-\x7e]/.test(key)) throw appError('MEDIA_UNAVAILABLE', '图片密钥文件第一行无效。');
    return key;
}

export function validateOptions(request, allowed = []) {
    const unknown = Object.keys(request.options ?? {}).find((key) => !allowed.includes(key));
    if (unknown) throw invalid(`当前图片适配器不支持选项 ${unknown}。`);
}

export function imageType(bytes) {
    if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', ext: '.png' };
    if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', ext: '.jpg' };
    if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
    throw failed('图片不是支持的 PNG、JPEG 或 WebP 文件。');
}

export async function inputImages(files = [], limit = 20_000_000) {
    const result = [];
    for (const file of files) {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile() || !stat.size || stat.size > limit) throw invalid(`参考图片不存在、为空或超过 ${limit} 字节。`);
        const bytes = await fs.readFile(file);
        result.push({ bytes, ...imageType(bytes), name: path.basename(file) });
    }
    return result;
}

export function decodeImage(value) {
    if (typeof value !== 'string' || !value.length || value.length > MAX_IMAGE_BYTES * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
        throw failed('服务没有返回有效的图片 Base64。');
    }
    return Buffer.from(value, 'base64');
}

export async function outputTarget(outPath) {
    if (!outPath) return undefined;
    if (!path.isAbsolute(outPath)) throw invalid('输出文件必须为绝对路径。');
    if (await fs.lstat(outPath).catch(() => null)) throw appError('ALREADY_EXISTS', '图片输出文件已存在，请更换 --out。');
    return outPath;
}

export async function saveImage(bytes, request, id) {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw failed('输出图片为空或超过 32 MiB。');
    const { ext } = imageType(bytes);
    const target = request.outPath || path.join(await fs.mkdtemp(path.join(os.tmpdir(), `remake-${id}-`)), `image${ext}`);
    const actualExt = path.extname(target).toLowerCase();
    if (actualExt !== ext && !(ext === '.jpg' && actualExt === '.jpeg')) throw invalid(`输出图片格式为 ${ext}，请使用匹配的输出后缀。`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    return { path: target, provider: `${id}.${request.images?.length ? 'edit' : 'generate'}` };
}

export function transport(deps = {}) {
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 600000);
    const request = async (url, init = {}, binary = false) => {
        try {
            signal.throwIfAborted();
            const response = await (deps.fetchImpl ?? fetch)(url, { ...init, redirect: 'error', signal });
            if (!response.ok) throw failed(`图片服务返回 HTTP ${response.status}；未自动重试。`);
            const limit = binary ? MAX_IMAGE_BYTES : 48 * 1024 * 1024;
            if (Number(response.headers.get('content-length')) > limit) throw failed('图片服务响应过大。');
            const reader = response.body?.getReader();
            if (!reader) throw failed('图片服务返回空响应。');
            const chunks = [];
            let size = 0;
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > limit) { await reader.cancel(); throw failed('图片服务响应过大。'); }
                chunks.push(Buffer.from(value));
            }
            const bytes = Buffer.concat(chunks);
            if (binary) return bytes;
            try { return JSON.parse(bytes.toString('utf8')); } catch { throw failed('图片服务未返回有效 JSON。'); }
        } catch (error) {
            if (error.code === 'MEDIA_FAILED') throw error;
            throw failed('图片服务连接或响应失败（可能超时）；未自动重试，提交后请先确认服务处理情况。');
        }
    };
    return { request, signal };
}

export async function cloudDoctor(settings, defaults) {
    try {
        baseUrl(settings.baseUrl || defaults.baseUrl);
        await readKey(settings.apiKeyFile);
        return { ready: true, version: settings.model || defaults.model, hint: '仅检查本地配置；未验证云端模型权限、密钥有效性和额度，未实际生图。' };
    } catch (error) { return { ready: false, version: '', hint: error.message }; }
}

export function metadata(id, label) {
    return { id, task: 'image', label, guide: `providers/${id}.md`, execution: 'program',
        capabilities: ['text-to-image', 'image-edit'], ledgerProviders: [`${id}.generate`, `${id}.edit`],
        testedVersion: '官方 HTTP 协议；仅模拟测试，未实际生图', publicSettings: ['baseUrl', 'model'] };
}

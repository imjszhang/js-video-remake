import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appError } from '../errors.js';
import { isWithin } from '../schema.js';

export function sourceId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw appError('INVALID_INPUT', '素材 ID 只能包含字母、数字、下划线和连字符。');
    }
    return id;
}

export function validateEntry(video, expectedId) {
    if (!video || typeof video !== 'object' || Array.isArray(video)) {
        throw appError('SOURCE_PROTOCOL', '数据源未返回有效的 video 对象。');
    }
    sourceId(video.videoId);
    if (expectedId && video.videoId !== expectedId) throw appError('SOURCE_PROTOCOL', '数据源返回了不同的素材 ID。');
    if (!['queued', 'fetching', 'downloaded', 'failed'].includes(video.status)) {
        throw appError('SOURCE_PROTOCOL', `未知素材状态: ${String(video.status)}`);
    }
    if (typeof video.platform !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(video.platform)) {
        throw appError('SOURCE_PROTOCOL', '数据源未返回有效的 platform。');
    }
    if (video.subs != null && (typeof video.subs !== 'object' || Array.isArray(video.subs))) throw appError('SOURCE_PROTOCOL', 'subs 必须是语言到路径的映射。');
    return video;
}

// A provider supplies paths relative to the explicitly configured shared asset root.
// Resolve symlinks before opening files; HTTP metadata is never filesystem authority.
export async function resolveAssets(config, video, files) {
    const root = await fs.realpath(config.assetRoot).catch(() => {
        throw appError('SOURCE_ASSET_MISSING', '共享素材目录不存在，请配置 assetRoot。');
    });
    async function checked(relative, optional = false) {
        if (relative == null && optional) return null;
        if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) {
            throw appError('SOURCE_ASSET_INVALID', '素材清单必须使用相对 assetRoot 的路径。');
        }
        const file = path.resolve(root, relative);
        if (!isWithin(root, file)) throw appError('ASSET_OUTSIDE_ROOT', '素材路径越出 assetRoot。');
        try {
            const real = await fs.realpath(file);
            if (!isWithin(root, real)) throw appError('ASSET_OUTSIDE_ROOT', '素材链接越出 assetRoot。');
            const stat = await fs.stat(real);
            if (!stat.isFile()) throw appError('SOURCE_ASSET_INVALID', '素材路径不是文件。');
            return { file: path.resolve(config.assetRoot, path.relative(root, real)), real, stat };
        } catch (error) {
            if (error.code === 'ENOENT' && optional) return null;
            if (error.code === 'ENOENT') throw appError('SOURCE_ASSET_MISSING', `共享素材未找到: ${relative}；请检查目录映射或等待服务端下载完成。`);
            throw error;
        }
    }
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw appError('SOURCE_PROTOCOL', '素材清单缺少 files 对象。');
    if (files.subs != null && (typeof files.subs !== 'object' || Array.isArray(files.subs))) throw appError('SOURCE_PROTOCOL', 'subs 必须是语言到路径的映射。');
    const media = await checked(files.video);
    const thumb = await checked(files.thumbnail, true);
    const subs = {};
    for (const [language, file] of Object.entries(files.subs ?? {})) {
        const subtitle = await checked(file, true);
        if (subtitle) subs[language] = subtitle.file;
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(media.real)) hash.update(chunk);
    return {
        video: { ...video, videoPath: media.file, thumbPath: thumb?.file ?? null,
            subs, bytes: media.stat.size, sha256: hash.digest('hex') },
        destDir: config.assetRoot,
    };
}

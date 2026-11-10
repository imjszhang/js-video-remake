import fs from 'node:fs/promises';
import { appError } from '../errors.js';
import { resolveAssets, sourceId, validateEntry } from './assets.js';

export function manifestSource(config) {
    async function entries() {
        let data;
        try { data = JSON.parse(await fs.readFile(config.source.manifest, 'utf8')); }
        catch { throw appError('SOURCE_UNAVAILABLE', '无法读取素材清单 JSON。'); }
        if (!data || data.schema !== 'video-remake.source-list@1' || !Array.isArray(data.items)) {
            throw appError('SOURCE_PROTOCOL', '素材清单需要 schema: video-remake.source-list@1 和 items 数组。');
        }
        const seen = new Set();
        for (const entry of data.items) {
            validateEntry(entry?.video);
            if (seen.has(entry.video.videoId)) throw appError('SOURCE_PROTOCOL', '素材清单中有重复 ID。');
            seen.add(entry.video.videoId);
        }
        return data.items;
    }
    return {
        kind: 'manifest', location: config.source.manifest,
        async health() { return { status: 'ok', total: (await entries()).length, writable: false }; },
        async list() { return { status: 'ok', data: (await entries()).map(entry => entry.video) }; },
        async get(id) {
            sourceId(id);
            const item = (await entries()).find(entry => entry.video.videoId === id);
            if (!item) throw appError('NOT_FOUND', `素材清单中没有 ${id}`);
            return item.video;
        },
        async enqueue() { throw appError('SOURCE_UNSUPPORTED', '本地清单不支持 URL 入队，请使用 bind <id>。'); },
        async resolveAssets(video) {
            const item = (await entries()).find(entry => entry.video.videoId === video.videoId);
            if (!item?.files) throw appError('SOURCE_PROTOCOL', '素材清单条目缺少 files。');
            return resolveAssets(config, video, item.files);
        },
    };
}

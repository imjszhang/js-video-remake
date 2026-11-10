import path from 'node:path';
import { appError } from '../errors.js';
import { readReferenceCatalog, readReferenceSource } from '../references.js';
import { resolveAssets, sourceId } from './assets.js';

export function localSource(config) {
    async function entry(id) {
        sourceId(id);
        const catalog = await readReferenceCatalog(config);
        const reference = catalog.references.find(item => item.id === id)
            || catalog.references.find(item => item.archiveVideoId === id);
        if (!reference) throw appError('NOT_FOUND', `本地参考视频清单中没有 ${id}，请先使用 reference:import 导入。`);
        return { reference, source: await readReferenceSource(config, reference) };
    }
    function videoFrom(reference, source) {
        return { videoId: reference.archiveVideoId, platform: reference.platform, status: 'downloaded',
            title: source.title, canonicalUrl: source.canonicalUrl, channel: source.channel,
            kind: source.kind, durationSec: source.durationSec, quality: source.quality };
    }
    return {
        kind: 'local', location: config.catalogPath,
        async health() { return { status: 'ok', total: (await readReferenceCatalog(config)).references.length, writable: true }; },
        async get(id) { const { reference, source } = await entry(id); return videoFrom(reference, source); },
        async list() {
            const catalog = await readReferenceCatalog(config);
            const data = [];
            for (const reference of catalog.references) data.push(videoFrom(reference, await readReferenceSource(config, reference)));
            return { status: 'ok', data };
        },
        async enqueue() {
            throw appError('SOURCE_UNSUPPORTED', '本地参考视频清单不下载链接。请使用 reference:import 导入文件或清单；旧网关可通过 --source-provider gateway-video 选择。');
        },
        async resolveAssets(video) {
            const { source } = await entry(`${video.platform}-${video.videoId}`);
            const files = {
                video: source.relVideo || path.relative(source.assetRoot, source.videoPath),
                thumbnail: source.relThumb,
                subs: source.subs,
            };
            const resolved = await resolveAssets({ ...config, assetRoot: source.assetRoot }, video, files);
            return { ...resolved, assetRoot: source.assetRoot, sourceProvider: source.provider };
        },
    };
}

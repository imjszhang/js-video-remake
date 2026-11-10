import fs from 'node:fs/promises';
import path from 'node:path';
import { createSourceProvider } from './sources/index.js';
import { findReference, loadOrCreateCatalog, upsertReference, writeCatalog } from './catalog.js';
import { appError } from './errors.js';
import { buildSource, qualityWarning, referenceId } from './schema.js';

export async function writeSource(referenceDir, source) {
    await fs.mkdir(referenceDir, { recursive: true });
    const file = path.join(referenceDir, 'SOURCE.json');
    await fs.writeFile(file, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
    return file;
}

export async function readSource(workspace, reference) {
    const file = path.join(workspace, reference.dir, 'SOURCE.json');
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        throw appError('NOT_FOUND', `SOURCE.json 不存在: ${file}`);
    }
}

export async function bindVideo(config, videoId, { requestedQuality, entry: suppliedEntry, provider = createSourceProvider(config) } = {}) {
    const metadata = suppliedEntry || await provider.get(videoId);
    if (metadata.status !== 'downloaded') throw appError('NOT_DOWNLOADED', `素材尚未下载完成（${metadata.status}）: ${videoId}`);
    const { video, destDir, assetRoot = config.assetRoot, sourceProvider } = await provider.resolveAssets(metadata);
    const id = referenceId(video.platform, video.videoId);
    const dir = path.join('references', id);
    const source = buildSource({ video, destDir, assetRoot });
    source.provider = sourceProvider ?? { kind: provider.kind, location: provider.location };
    await writeSource(path.join(config.workspace, dir), source);
    const catalog = await loadOrCreateCatalog(config.catalogPath);
    const existing = findReference(catalog, id);
    const entry = upsertReference(catalog, {
        id,
        dir,
        archiveVideoId: video.videoId,
        platform: video.platform || 'youtube',
        status: existing?.status === 'understanding' ? 'understanding' : 'bound',
    });
    await writeCatalog(config.catalogPath, catalog);
    const warning = qualityWarning(video, requestedQuality || config.quality);
    return {
        command: 'bind',
        reference: entry,
        source,
        warning,
    };
}

import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appError } from './errors.js';
import { buildSource, emptyCatalog, isWithin, normalizeCatalog, referenceId, SOURCE_SCHEMA } from './schema.js';
import { upsertReference, writeCatalog } from './catalog.js';
import { sourceId } from './sources/assets.js';
import { manifestSource } from './sources/manifest.js';

// Reading the reference library never initializes a workspace or contacts a source.
export async function readReferenceCatalog(config) {
    let text;
    try { text = await fs.readFile(config.catalogPath, 'utf8'); }
    catch (error) {
        if (error.code === 'ENOENT') return emptyCatalog();
        throw appError('CATALOG_INVALID', '无法读取本地参考视频台账。');
    }
    try { return normalizeCatalog(JSON.parse(text)); }
    catch (error) {
        if (error.code === 'CATALOG_INVALID') throw error;
        throw appError('CATALOG_INVALID', '本地参考视频台账不是有效的 JSON。');
    }
}

export async function readReferenceSource(config, reference) {
    const root = path.resolve(config.workspace, 'references');
    if (typeof reference.dir !== 'string') throw appError('SOURCE_PROTOCOL', '参考记录缺少目录。');
    const file = path.resolve(config.workspace, reference.dir, 'SOURCE.json');
    if (!isWithin(root, file)) throw appError('ASSET_OUTSIDE_ROOT', '参考记录目录越出 references。');
    try {
        const real = await fs.realpath(file);
        const workspace = await fs.realpath(config.workspace);
        if (!isWithin(workspace, real)) throw appError('ASSET_OUTSIDE_ROOT', '参考记录链接越出工作区。');
        const source = JSON.parse(await fs.readFile(real, 'utf8'));
        if (source?.schema !== SOURCE_SCHEMA || typeof source.videoPath !== 'string' || !path.isAbsolute(source.videoPath)
            || typeof source.assetRoot !== 'string' || !path.isAbsolute(source.assetRoot)) {
            throw appError('SOURCE_PROTOCOL', '参考记录 SOURCE.json 的原片指针无效。');
        }
        return source;
    } catch (error) {
        if (['ASSET_OUTSIDE_ROOT', 'SOURCE_PROTOCOL'].includes(error.code)) throw error;
        throw appError('SOURCE_UNAVAILABLE', `无法读取参考记录 ${reference.id} 的 SOURCE.json。`);
    }
}

async function readableVideo(file) {
    try {
        await fs.access(file, constants.R_OK);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size === 0) throw new Error();
        return stat;
    } catch { throw appError('SOURCE_ASSET_MISSING', '原片不存在、为空或不可读取。'); }
}

export async function listReferences(config) {
    const catalog = await readReferenceCatalog(config);
    const references = await Promise.all(catalog.references.map(async (reference) => {
        const item = { ...reference, title: reference.id, available: false,
            productions: catalog.productions.filter(production => production.referenceIds?.includes(reference.id)).map(production => production.slug) };
        try {
            const source = await readReferenceSource(config, reference);
            item.title = source.title || reference.id;
            item.videoPath = source.videoPath;
            item.provider = source.provider?.kind || 'local';
            item.canonicalUrl = source.canonicalUrl || '';
            item.durationSec = source.durationSec ?? null;
            await readableVideo(source.videoPath);
            item.available = true;
        } catch (error) { item.availabilityError = error.message; }
        return item;
    }));
    return { command: 'reference:list', references };
}

async function prepareFile(config, { file, id, title, expectedPath }) {
    if (typeof file !== 'string' || !file.trim()) throw appError('INVALID_INPUT', '请提供本地视频文件。');
    if (id !== undefined) sourceId(id);
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw appError('INVALID_INPUT', '标题不能为空。');
    const requested = path.resolve(config.workspace, file);
    await readableVideo(requested);
    const real = await fs.realpath(requested);
    if (expectedPath && real !== expectedPath) throw appError('SOURCE_ASSET_INVALID', '扫描后的文件路径已变化，请重新扫描。');
    const hash = createHash('sha256');
    let handle;
    let stat;
    try {
        handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        stat = await handle.stat();
        if (!stat.isFile() || !stat.size) throw appError('SOURCE_ASSET_INVALID', '导入文件已变化或不再是有效普通文件。');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await fs.stat(real);
        if (await fs.realpath(real) !== real || after.dev !== stat.dev || after.ino !== stat.ino
            || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
            throw appError('SOURCE_ASSET_INVALID', '导入期间原片发生变化，请重试。');
        }
    } catch (error) {
        if (error.code === 'SOURCE_ASSET_INVALID') throw error;
        throw appError('SOURCE_ASSET_MISSING', '导入期间原片已不可读取，请重试。');
    } finally { await handle?.close(); }
    const sha256 = hash.digest('hex');
    const root = path.dirname(real);
    const video = { videoId: id || sha256, platform: 'local', status: 'downloaded',
        title: title?.trim() || path.basename(real, path.extname(real)), videoPath: real, bytes: stat.size, sha256 };
    const source = buildSource({ video, destDir: root, assetRoot: root });
    source.provider = { kind: 'local', location: real };
    return [{ video, source, expectedPath }];
}

async function prepareManifest(config, file) {
    const manifestPath = path.resolve(config.workspace, file);
    const provider = manifestSource({ ...config, source: { ...config.source, manifest: manifestPath } });
    const prepared = [];
    for (const metadata of (await provider.list()).data) {
        if (metadata.status !== 'downloaded') throw appError('NOT_DOWNLOADED', `素材尚未下载完成（${metadata.status}）: ${metadata.videoId}`);
        const { video, destDir } = await provider.resolveAssets(metadata);
        if (!video.bytes) throw appError('SOURCE_ASSET_MISSING', `原片为空: ${metadata.videoId}`);
        const source = buildSource({ video, destDir, assetRoot: config.assetRoot });
        source.provider = { kind: 'manifest', location: manifestPath };
        prepared.push({ video, source });
    }
    return prepared;
}

async function checkedDestination(config, id) {
    const dir = path.join(config.workspace, 'references', id);
    // Do not follow a pre-existing directory/file symlink when writing a snapshot.
    for (const target of [path.join(config.workspace, 'references'), dir, path.join(dir, 'SOURCE.json')]) {
        try {
            const stat = await fs.lstat(target);
            if (stat.isSymbolicLink()) throw appError('ASSET_OUTSIDE_ROOT', '参考记录写入路径不能是软链接。');
            if (target.endsWith('SOURCE.json') ? !stat.isFile() : !stat.isDirectory()) {
                throw appError('SOURCE_ASSET_INVALID', '参考记录写入路径类型无效。');
            }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return dir;
}

function normalizeOrigin(origin) {
    if (origin === undefined) return null;
    if (!origin || typeof origin !== 'object' || typeof origin.provider !== 'string' || !/^[a-z][a-z0-9-]*$/.test(origin.provider)) {
        throw appError('INVALID_INPUT', '下载来源需要有效的适配器标识。');
    }
    let url;
    try {
        url = new URL(origin.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { throw appError('INVALID_INPUT', '下载来源需要不含凭据的 HTTP(S) 链接。'); }
    for (const name of ['title', 'channel']) {
        if (origin[name] !== undefined && typeof origin[name] !== 'string') throw appError('INVALID_INPUT', '下载来源的标题和频道必须是文本。');
    }
    if (origin.durationSec != null && (!Number.isFinite(origin.durationSec) || origin.durationSec < 0)) {
        throw appError('INVALID_INPUT', '下载来源的时长无效。');
    }
    return { ...origin, url: url.href };
}

export async function importReference(config, { file, id, title, manifest, origin } = {}) {
    if (Boolean(file) === Boolean(manifest)) throw appError('INVALID_INPUT', '请提供一个本地文件，或使用 --manifest 导入清单。');
    if (manifest && (id !== undefined || title !== undefined || origin !== undefined)) throw appError('INVALID_INPUT', '清单导入使用条目中的 ID、标题和来源，不能同时覆盖。');
    const provenance = normalizeOrigin(origin);
    const prepared = manifest ? await prepareManifest(config, manifest) : await prepareFile(config, { file, id, title: title !== undefined ? title : provenance?.title || undefined });
    if (provenance) {
        Object.assign(prepared[0].source, {
            provider: { kind: provenance.provider, location: provenance.url },
            canonicalUrl: provenance.url, channel: provenance.channel || '', durationSec: provenance.durationSec ?? null,
        });
    }
    return persistReferences(config, prepared);
}

// Folder imports preflight every file and every target before any snapshot is written.
export async function importReferenceFiles(config, files) {
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file.trim())) {
        throw appError('INVALID_INPUT', '批量导入需要本地文件路径数组。');
    }
    const prepared = new Map();
    const catalog = await readReferenceCatalog(config);
    const existingIds = new Set(catalog.references.map(item => item.id));
    for (const file of files) {
        let stat;
        try { stat = await fs.lstat(path.resolve(config.workspace, file)); }
        catch { throw appError('SOURCE_ASSET_MISSING', '批量导入的原片不存在或不可读取。'); }
        if (stat.isSymbolicLink()) throw appError('SOURCE_ASSET_INVALID', '文件夹批量导入不跟随软链接。');
        const [item] = await prepareFile(config, { file, expectedPath: path.resolve(config.workspace, file) });
        const id = referenceId(item.video.platform, item.video.videoId);
        // Keep an existing content-based binding instead of redirecting it to a duplicate copy.
        if (!existingIds.has(id) && !prepared.has(id)) prepared.set(id, item);
    }
    return persistReferences(config, [...prepared.values()]);
}

async function persistReferences(config, prepared) {
    const catalog = await readReferenceCatalog(config);
    // Validate the whole batch and all destinations before making any changes.
    for (const item of prepared) {
        item.id = referenceId(item.video.platform, item.video.videoId);
        item.dir = await checkedDestination(config, item.id);
        item.localFile = await fs.realpath(item.source.videoPath);
        if (item.expectedPath && item.localFile !== item.expectedPath) throw appError('SOURCE_ASSET_INVALID', '扫描后的文件路径已变化，请重新扫描。');
        item.localThumb = item.source.thumbPath ? await fs.realpath(item.source.thumbPath) : null;
        const existing = catalog.references.find(reference => reference.id === item.id);
        let previous = existing;
        if (!previous) {
            try {
                await fs.access(path.join(item.dir, 'SOURCE.json'));
                previous = { id: item.id, dir: path.relative(config.workspace, item.dir) };
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (previous) {
            const source = await readReferenceSource(config, previous);
            let previousHash = source.sha256;
            if (!previousHash) {
                try {
                    await readableVideo(source.videoPath);
                    const hash = createHash('sha256');
                    for await (const chunk of createReadStream(source.videoPath)) hash.update(chunk);
                    previousHash = hash.digest('hex');
                } catch { throw appError('REFERENCE_CONFLICT', `无法核对已有参考 ${item.id} 的原片，请使用新的 ID。`); }
            }
            if (previousHash !== item.source.sha256) {
                throw appError('REFERENCE_CONFLICT', `参考 ID ${item.id} 已指向不同原片，请使用新的 ID。`);
            }
            item.source.boundAt = source.boundAt || item.source.boundAt;
            item.existing = existing;
        }
    }
    const references = [];
    for (const item of prepared) {
        await fs.mkdir(item.dir, { recursive: true });
        await fs.writeFile(path.join(item.dir, 'SOURCE.json'), `${JSON.stringify(item.source, null, 2)}\n`, 'utf8');
        references.push(upsertReference(catalog, {
            id: item.id, dir: path.relative(config.workspace, item.dir), archiveVideoId: item.video.videoId,
            platform: item.video.platform, status: item.existing?.status || 'bound',
            localFile: item.localFile, localThumb: item.localThumb,
        }));
    }
    if (prepared.length) await writeCatalog(config.catalogPath, catalog);
    return { command: 'reference:import', references, count: references.length };
}

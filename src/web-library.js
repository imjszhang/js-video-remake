import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveConfig } from './config.js';

const videoTypes = new Map([['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'], ['.m4v', 'video/mp4']]);
const imageTypes = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);
const templateTypes = new Map([['.video', 'application/zip']]);
const PACKAGE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v\d+$/;
const plain = (text) => String(text).replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

/**
 * Version notes from a production's PROGRESS.md: entries that start with "YYYY-MM-DD[ HH:MM] <version>：summary",
 * followed by "- " bullets. The last entry for a version wins.
 */
export function progressNotes(text) {
    const notes = new Map();
    let current = null;
    for (const line of String(text).split(/\r?\n/)) {
        const head = /^(\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2})?\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)*-v\d+|v\d+)[：:]\s*(.+)$/i.exec(line);
        if (head) {
            current = { date: head[1], summary: plain(head[3]).slice(0, 240), details: [] };
            notes.set(head[2], current);
            continue;
        }
        if (/^\d{4}-\d{2}-\d{2}\b/.test(line)) { current = null; continue; }
        const bullet = /^-\s+(.+)$/.exec(line);
        if (current && bullet && current.details.length < 12) current.details.push(plain(bullet[1]).slice(0, 400));
    }
    return notes;
}
const inside = (base, target) => target === base || (!path.relative(base, target).startsWith(`..${path.sep}`) && path.relative(base, target) !== '..' && !path.isAbsolute(path.relative(base, target)));
const positive = (...values) => values.map(Number).find((value) => Number.isFinite(value) && value > 0) ?? null;
const safeUrl = (value) => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

function relativePath(base, input) {
    if (typeof input !== 'string' || !input || path.isAbsolute(input) || input.includes('\0')) throw new Error('Invalid relative path');
    const resolved = path.resolve(base, input);
    if (!inside(base, resolved)) throw new Error('Path leaves allowed directory');
    return resolved;
}

async function checkedPath(base, input) {
    const requested = relativePath(base, input);
    const resolved = await fs.realpath(requested);
    if (!inside(base, resolved)) throw new Error('Symlink leaves allowed directory');
    return resolved;
}

async function jsonIn(base, file, optional = true) {
    try { return JSON.parse(await fs.readFile(await checkedPath(base, file), 'utf8')); }
    catch (error) { if (optional && error.code === 'ENOENT') return {}; throw error; }
}

function audioState(...records) {
    for (const record of records) {
        if (!record) continue;
        if (record.audio === 'none' || record.hasAudio === false || record.audioStreams === 0) return 'none';
        if (record.hasAudio === true || Number(record.audioStreams) > 0) return 'present';
        const streams = record.exportProbe?.streams;
        if (Array.isArray(streams)) return streams.some((stream) => stream.codec_type === 'audio') ? 'present' : 'none';
    }
    return 'unknown';
}

/** Read catalog-published outputs and their bound originals. The private media map never leaves the server. */
export async function readWebLibrary(workspace, { env = process.env } = {}) {
    const root = await fs.realpath(workspace);
    let catalog;
    try { catalog = await jsonIn(root, 'catalog.json', false); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        catalog = { productions: [], references: [] };
    }
    if (!Array.isArray(catalog.productions)) throw new Error('Catalog has no productions list');
    const media = new Map();
    const warnings = [];
    const references = new Map();
    const localFiles = new Map();
    const projects = [];
    let archiveRoot = null;
    try {
        // SOURCE.json is metadata, never authority to open an arbitrary absolute path.
        const config = resolveConfig({ workspace: root, ...(env.REMAKE_ASSET_ROOT ? { assetRoot: env.REMAKE_ASSET_ROOT } : {}) }, env, root);
        archiveRoot = await fs.realpath(config.assetRoot);
    } catch { /* Missing archive/config must not prevent viewing remakes. */ }
    for (const reference of catalog.references ?? []) {
        if (!/^[a-z0-9_-]+$/i.test(reference.id ?? '')) continue;
        try {
            const base = path.join(root, 'references', reference.id);
            const source = await jsonIn(base, 'SOURCE.json');
            references.set(reference.id, source);
            // Explicit file imports authorize this one file, never a SOURCE-provided directory.
            if (typeof reference.localFile === 'string' && path.isAbsolute(reference.localFile)) {
                localFiles.set(reference.id, { video: reference.localFile, thumbnail: reference.localThumb });
            }
        } catch { /* A missing reference must not prevent viewing its remake. */ }
    }

    async function register(base, file, typeMap, exactPath) {
        const type = typeMap.get(path.extname(String(file)).toLowerCase());
        if (!type) throw new Error('Unsupported media type');
        const absolute = await checkedPath(base, file);
        if (exactPath && absolute !== exactPath) throw new Error('Imported file path has changed');
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) throw new Error('Media is not a file');
        const id = createHash('sha256').update(path.relative(root, absolute)).digest('hex').slice(0, 32);
        media.set(id, { path: absolute, base, type, name: path.basename(absolute), size: stat.size, mtimeMs: stat.mtimeMs });
        return { id, url: `media/${id}`, stat, absolute };
    }

    async function optionalImage(base, candidates) {
        for (const file of candidates.filter(Boolean)) {
            try { return (await register(base, file, imageTypes)).url; } catch { /* Optional artwork. */ }
        }
        return null;
    }

    async function localPoster(file) {
        if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
        try { return (await register(path.dirname(file), path.basename(file), imageTypes, file)).url; }
        catch { return null; }
    }

    async function original(referenceId, episodeMetadata, projectSlug) {
        const source = references.get(referenceId);
        const local = localFiles.get(referenceId);
        const localFile = local?.video;
        if (!source || (!localFile && !archiveRoot)) return null;
        try {
            const asset = localFile
                ? await register(path.dirname(localFile), path.basename(localFile), videoTypes, localFile)
                : await register(archiveRoot, source.relVideo, videoTypes);
            let probe = {};
            if (episodeMetadata && /^[a-z0-9][a-z0-9_-]*$/i.test(episodeMetadata.slug ?? '') && Number.isInteger(episodeMetadata.episode) && episodeMetadata.episode > 0) {
                try {
                    const prefix = String(episodeMetadata.episode).padStart(2, '0');
                    const candidate = await jsonIn(root, `productions/${projectSlug}/episodes/${prefix}-${episodeMetadata.slug}/analysis/probe.json`);
                    // A probe for a different file cannot describe this original.
                    if (candidate.format?.filename && await fs.realpath(candidate.format.filename) === asset.absolute) probe = candidate;
                } catch { /* Optional source analysis. */ }
            }
            const stream = Array.isArray(probe.streams) ? probe.streams.find((item) => item.codec_type === 'video') : null;
            return {
                id: referenceId,
                title: typeof source.title === 'string' && source.title.trim() ? source.title : referenceId,
                url: asset.url,
                poster: localFile ? await localPoster(local.thumbnail) : await optionalImage(archiveRoot, [source.relThumb]),
                duration: positive(probe.format?.duration, episodeMetadata?.duration, source.durationSec),
                width: positive(stream?.width, episodeMetadata?.width, source.width),
                height: positive(stream?.height, episodeMetadata?.height, source.height),
                bytes: asset.stat.size,
                audio: audioState({ exportProbe: probe }, source),
                sourceUrl: safeUrl(source.canonicalUrl),
            };
        } catch { return null; }
    }

    const referenceMedia = [];
    for (const id of references.keys()) {
        const media = await original(id);
        if (media) referenceMedia.push(media);
    }

    for (const entry of catalog.productions) {
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(entry.slug ?? '')) {
            warnings.push('已跳过项目标识无效的目录项。');
            continue;
        }
        const project = {
            slug: entry.slug,
            title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : entry.slug,
            status: typeof entry.status === 'string' ? entry.status : 'unknown',
            updatedAt: null,
            referenceCount: Array.isArray(entry.referenceIds) ? entry.referenceIds.length : 0,
            videos: [],
            draftVersions: [],
            defaultDraftVersion: null,
            templates: [],
        };
        const dates = [entry.updatedAt, entry.createdAt].map(Date.parse).filter(Number.isFinite);
        const referenceIds = Array.isArray(entry.referenceIds) ? entry.referenceIds : [];
        let episodes = [];
        try {
            const metadata = await jsonIn(root, `productions/${entry.slug}/EPISODES.json`);
            if (Array.isArray(metadata)) episodes = metadata;
        } catch { /* Optional source analysis. */ }
        // Keep the original drafts descriptor valid; additional versions publish only
        // the outputs explicitly listed in their own manifests (including pilots).
        const draftDescriptors = [
            ...(entry.drafts?.dir ? [entry.drafts] : []),
            ...(Array.isArray(entry.drafts?.versions) ? entry.drafts.versions : []),
        ];
        const descriptors = [...draftDescriptors.map((descriptor) => ['draft', descriptor]), ['delivery', entry.deliverable], ['comparison', entry.comparison]];
        // every comparison on disk, so each draft version can show the one made for it
        try {
            const dir = await checkedPath(root, `productions/${entry.slug}/drafts/comparisons`);
            for (const name of (await fs.readdir(dir)).filter((item) => /^v\d+$/.test(item)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
                descriptors.push(['comparison', { version: name, dir: `productions/${entry.slug}/drafts/comparisons/${name}`, file: 'comparison.mp4', manifest: 'MANIFEST.json', scanned: true }]);
            }
        } catch { /* No comparisons yet. */ }
        const seenOutputs = new Set();
        const draftLabels = new Map();
        const draftInfo = new Map();
        const draftFiles = new Map();   // absolute draft file → version
        const comparisonTops = [];
        const scannedIds = new Set();   // comparisons found on disk, not in the catalog
        for (const [kind, descriptor] of descriptors) {
            if (!descriptor) continue;
            try {
                const allowed = kind === 'delivery'
                    ? path.join(root, 'deliverables', entry.slug)
                    : path.join(root, 'productions', entry.slug, 'drafts');
                const requested = relativePath(root, descriptor.dir);
                if (!inside(allowed, requested)) throw new Error('Output outside project directory');
                const base = await fs.realpath(requested);
                if (!inside(allowed, base)) throw new Error('Output symlink outside project directory');
                const outputKey = `${kind}:${base}:${descriptor.manifest ?? 'MANIFEST.json'}`;
                if (seenOutputs.has(outputKey)) continue;
                seenOutputs.add(outputKey);
                const [manifest, review, production] = await Promise.all([
                    jsonIn(base, descriptor.manifest ?? 'MANIFEST.json'),
                    jsonIn(base, 'REVIEW.json'),
                    kind === 'delivery' ? jsonIn(base, 'PRODUCTION.json') : Promise.resolve({}),
                ]);
                for (const date of [manifest.createdAt, production.createdAt]) {
                    const time = Date.parse(date); if (Number.isFinite(time)) dates.push(time);
                }
                const renders = kind === 'draft' ? manifest.renders : [{ file: descriptor.file }];
                if (!Array.isArray(renders)) throw new Error('Draft manifest has no renders');
                const version = descriptor.version ?? manifest.version ?? (kind === 'draft' ? path.basename(base) : null);
                if (kind === 'draft' && typeof descriptor.label === 'string' && descriptor.label.trim()) draftLabels.set(version, descriptor.label.trim());
                if (kind === 'draft' && !draftInfo.has(version)) {
                    const pkg = manifest.package && typeof manifest.package === 'object' ? manifest.package : null;
                    draftInfo.set(version, {
                        importedAt: Number.isFinite(Date.parse(manifest.importedAt)) ? manifest.importedAt : null,
                        frozen: Boolean(pkg?.treeHash),
                        renderVerified: pkg ? pkg.renderVerified === true : null,
                        packageName: typeof pkg?.name === 'string' && PACKAGE_NAME.test(pkg.name) ? pkg.name : null,
                    });
                }
                const top = kind === 'comparison' && typeof manifest.inputs?.top?.path === 'string' ? manifest.inputs.top.path : null;
                for (const render of renders) {
                    try {
                        const asset = await register(base, render.file, videoTypes);
                        const episode = Number.isInteger(render.episode) && render.episode > 0 ? render.episode : null;
                        const prefix = episode ? String(episode).padStart(2, '0') : null;
                        const probe = review.exportProbe?.streams?.find((stream) => stream.codec_type === 'video');
                        const verification = manifest.verification ?? {};
                        const resolution = /^(\d+)x(\d+)$/.exec(review.resolution ?? '');
                        const poster = await optionalImage(base, [render.poster, manifest.cover, prefix && `${prefix}-poster.jpg`, 'poster.jpg', 'cover.png']);
                        const contactSheet = await optionalImage(base, [render.contactSheet, review.visual?.sheet, prefix && `review/${prefix}-contact-sheet.jpg`]);
                        const referenceId = render.referenceId !== undefined
                            ? (referenceIds.includes(render.referenceId) ? render.referenceId : null)
                            : referenceIds.length === 1 ? referenceIds[0] : episode ? referenceIds[episode - 1] : null;
                        const source = references.get(referenceId);
                        const reference = await original(referenceId, episodes.find((item) => item.referenceId === referenceId), entry.slug);
                        if (kind === 'draft') draftFiles.set(asset.absolute, version);
                        if (top) comparisonTops.push([asset.id, top]);
                        if (descriptor.scanned) scannedIds.add(asset.id);
                        project.videos.push({
                            id: asset.id,
                            title: render.title || manifest.title || (kind === 'comparison' ? `${project.title} · 对比` : project.title),
                            kind,
                            version,
                            ...(episode ? { episode } : {}),
                            url: asset.url, poster, contactSheet,
                            duration: positive(render.duration, manifest.duration, verification.duration, manifest.render?.duration, review.duration, production.spec?.duration, review.exportProbe?.format?.duration),
                            width: positive(render.width, manifest.width, verification.width, manifest.layout?.width, production.spec?.width, probe?.width, resolution?.[1]),
                            height: positive(render.height, manifest.height, verification.height, manifest.layout?.height, production.spec?.height, probe?.height, resolution?.[2]),
                            bytes: asset.stat.size,
                            audio: audioState(render, manifest, verification, descriptor, review),
                            language: render.language ?? manifest.language ?? descriptor.language ?? null,
                            referenceUrl: safeUrl(source?.canonicalUrl),
                            reference,
                        });
                        dates.push(asset.stat.mtimeMs);
                    } catch {
                        if (!descriptor.scanned) warnings.push(`${entry.slug}：有一条${kind === 'draft' ? '草稿' : kind === 'delivery' ? '交付' : '对比'}视频不可读取，已跳过。`);
                    }
                }
            } catch {
                if (!descriptor.scanned) warnings.push(`${entry.slug}：${kind === 'draft' ? '草稿' : kind === 'delivery' ? '交付' : '对比'}目录或元数据不可读取。`);
            }
        }
        // A comparison whose upper video is a published draft belongs to that draft's version.
        for (const [id, top] of comparisonTops) {
            const forVersion = draftFiles.get(path.resolve(root, top));
            const video = project.videos.find((item) => item.id === id);
            if (video && forVersion) video.forVersion = forVersion;
        }
        // an older comparison is published only when it belongs to a published draft version
        for (const video of project.videos.filter((item) => scannedIds.has(item.id) && !item.forVersion)) {
            project.videos.splice(project.videos.indexOf(video), 1);
            media.delete(video.id);
        }
        let notes = new Map();
        try { notes = progressNotes(await fs.readFile(await checkedPath(root, `productions/${entry.slug}/PROGRESS.md`), 'utf8')); } catch { /* Optional. */ }
        // Empty or unreadable versions must never become selectable in the UI.
        for (const video of project.videos.filter((item) => item.kind === 'draft')) {
            let group = project.draftVersions.find((item) => item.version === video.version);
            if (!group) {
                const info = draftInfo.get(video.version) ?? {};
                let forkedFrom = null;
                if (info.packageName) {
                    try {
                        const pkg = await jsonIn(root, `productions/${entry.slug}/videos/${info.packageName}/video.json`);
                        const from = pkg.source?.forkedFrom?.video;
                        if (typeof from === 'string' && PACKAGE_NAME.test(from)) forkedFrom = from;
                    } catch { /* Package removed. */ }
                }
                group = {
                    version: video.version, label: draftLabels.get(video.version) ?? null, videoCount: 0,
                    forkedFrom, importedAt: info.importedAt ?? null, frozen: info.frozen ?? false, renderVerified: info.renderVerified ?? null,
                    note: notes.get(info.packageName ?? video.version) ?? notes.get(video.version) ?? null,
                };
                project.draftVersions.push(group);
            }
            group.videoCount += 1;
        }
        // .video templates registered by video:pack under deliverables/<slug>/templates/
        for (const item of Array.isArray(entry.templates) ? entry.templates : []) {
            try {
                const allowed = path.join(root, 'deliverables', entry.slug, 'templates');
                if (!inside(allowed, relativePath(root, item.file))) throw new Error('Template outside project directory');
                const asset = await register(root, item.file, templateTypes);
                if (!inside(await fs.realpath(path.join(root, 'deliverables', entry.slug, 'templates')), asset.absolute)) throw new Error('Template symlink outside project directory');
                const inputs = Array.isArray(item.inputs) ? item.inputs.filter((name) => /^[a-z]+$/i.test(name)) : [];
                project.templates.push({
                    id: asset.id, url: asset.url, name: asset.stat.size ? path.basename(asset.absolute) : null,
                    title: typeof item.title === 'string' ? item.title : path.basename(asset.absolute),
                    summary: typeof item.summary === 'string' ? item.summary : null,
                    video: typeof item.video === 'string' && PACKAGE_NAME.test(item.video) ? item.video : null,
                    inputs, textCount: Number.isInteger(item.textCount) ? item.textCount : null,
                    duration: positive(item.duration), width: positive(item.width), height: positive(item.height),
                    bytes: asset.stat.size, packedAt: Number.isFinite(Date.parse(item.packedAt)) ? item.packedAt : null,
                });
                dates.push(asset.stat.mtimeMs);
            } catch {
                warnings.push(`${entry.slug}：有一个 .video 模板不可读取，已跳过。`);
            }
        }
        project.templates.sort((a, b) => (Date.parse(b.packedAt) || 0) - (Date.parse(a.packedAt) || 0));
        project.defaultDraftVersion = [entry.drafts?.activeVersion, entry.drafts?.version, project.draftVersions[0]?.version]
            .find((version) => project.draftVersions.some((item) => item.version === version)) ?? null;
        if (!dates.length) {
            try { dates.push((await fs.stat(await checkedPath(root, `productions/${entry.slug}`))).mtimeMs); } catch { /* New project without a directory. */ }
        }
        project.updatedAt = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
        projects.push(project);
    }
    projects.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    return { projects, warnings, media, referenceMedia };
}

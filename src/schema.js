import path from 'node:path';
import { appError } from './errors.js';

export const SOURCE_SCHEMA = 'video-remake.source@1';
export const CATALOG_VERSION = 1;

export function emptyCatalog() {
    return { version: CATALOG_VERSION, references: [], productions: [] };
}

export function normalizeCatalog(raw) {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') {
        throw appError('CATALOG_INVALID', 'catalog.json must be an object.');
    }
    if (raw.version !== CATALOG_VERSION) {
        throw appError('CATALOG_INVALID', `catalog.json version must be ${CATALOG_VERSION}.`);
    }
    if (!Array.isArray(raw.references) || !Array.isArray(raw.productions)) {
        throw appError('CATALOG_INVALID', 'catalog.json must have references and productions arrays.');
    }
    return {
        version: CATALOG_VERSION,
        references: raw.references.map((item) => ({ ...item })),
        productions: raw.productions.map((item) => ({ ...item })),
    };
}

export function referenceId(platform, videoId) {
    return `${platform || 'youtube'}-${videoId}`;
}

export function isWithin(root, target) {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function toPosixRelative(fromDir, toFile) {
    let rel = path.relative(path.resolve(fromDir), path.resolve(toFile));
    if (!rel) rel = path.basename(toFile);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel.split(path.sep).join('/');
}

export function joinArchivePath(destDir, relativeName) {
    if (!relativeName) return null;
    if (path.isAbsolute(relativeName)) return relativeName;
    return path.join(destDir, relativeName);
}

export function buildSource({ video, destDir, assetRoot, boundAt = new Date().toISOString() }) {
    const videoPath = joinArchivePath(destDir, video.videoPath);
    const thumbPath = joinArchivePath(destDir, video.thumbPath);
    if (!videoPath) throw appError('BIND_FAILED', 'Archive entry has no video path.');
    if (!isWithin(assetRoot, destDir)) {
        throw appError('ASSET_OUTSIDE_ROOT', `Archive destDir is outside asset-root: ${destDir}`);
    }
    const relFromRoot = (abs) => (abs ? path.relative(assetRoot, abs).split(path.sep).join('/') : null);
    const subs = {};
    const absSubs = {};
    for (const [lang, rel] of Object.entries(video.subs || {})) {
        const abs = joinArchivePath(destDir, rel);
        absSubs[lang] = abs;
        subs[lang] = relFromRoot(abs);
    }
    return {
        schema: SOURCE_SCHEMA,
        archiveVideoId: video.videoId,
        platform: video.platform || 'youtube',
        kind: video.kind || '',
        canonicalUrl: video.canonicalUrl || video.inputUrl || '',
        title: video.title || '',
        channel: video.channel || '',
        durationSec: video.durationSec ?? null,
        quality: video.quality || '',
        sha256: video.sha256 || '',
        bytes: video.bytes ?? null,
        assetRoot,
        relVideo: relFromRoot(videoPath),
        relThumb: relFromRoot(thumbPath),
        subs,
        videoPath,
        thumbPath,
        absSubs,
        boundAt,
    };
}

export function qualityWarning(video, requestedQuality) {
    if (video.quality === '720' && requestedQuality === '1080') {
        return '成片清晰度为 720，复刻默认 1080。未加 --force，已按现有成片绑定。';
    }
    return '';
}

export function assertSlug(slug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '')) {
        throw appError('INVALID_INPUT', 'slug must be lowercase letters, numbers, and hyphens.');
    }
    return slug;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appError } from './errors.js';
import { resolveMediaConfig } from './media/config.js';

const QUALITIES = new Set(['720', '1080', 'audio']);

function absolute(value, base) {
    if (typeof value !== 'string' || !value.trim()) {
        throw appError('CONFIG_INVALID', 'Paths must be nonempty strings.');
    }
    const trimmed = value.trim();
    if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
    return path.resolve(base, trimmed);
}

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
        const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!file || Array.isArray(file) || typeof file !== 'object') {
            throw appError('CONFIG_INVALID', 'Configuration must be an object.');
        }
        return file;
    } catch (error) {
        if (error.code === 'CONFIG_INVALID') throw error;
        throw appError('CONFIG_INVALID', `Cannot parse configuration: ${filePath}`);
    }
}

export function findWorkspace(startDir) {
    let dir = path.resolve(startDir);
    while (true) {
        const pkgPath = path.join(dir, 'package.json');
        const catalogPath = path.join(dir, 'catalog.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg?.name === 'video-remake' || fs.existsSync(catalogPath)) return dir;
            } catch {
                if (fs.existsSync(catalogPath)) return dir;
            }
        } else if (fs.existsSync(catalogPath)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return path.resolve(startDir);
        dir = parent;
    }
}

export function resolveConfig(overrides = {}, env = process.env, cwd = process.cwd()) {
    const workspace = absolute(
        overrides.workspace || env.VIDEO_REMAKE_WORKSPACE || findWorkspace(cwd),
        cwd,
    );
    const configPath = absolute(
        overrides.configPath || env.VIDEO_REMAKE_CONFIG || path.join(workspace, 'video-remake.json'),
        cwd,
    );
    const file = fs.existsSync(configPath) ? readJsonIfExists(configPath) : {};
    if ((overrides.configPath || env.VIDEO_REMAKE_CONFIG) && !fs.existsSync(configPath)) {
        throw appError('CONFIG_INVALID', `Configuration does not exist: ${configPath}`);
    }

    const assetRoot = absolute(
        overrides.assetRoot || env.VIDEO_REMAKE_ASSET_ROOT || file.assetRoot || 'assets/source', workspace,
    );
    const raw = file.source ?? {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw appError('CONFIG_INVALID', 'source must be an object.');
    const source = {
        provider: overrides.sourceProvider || env.VIDEO_REMAKE_SOURCE_PROVIDER || raw.provider || 'local',
        baseUrl: overrides.sourceUrl || env.VIDEO_REMAKE_SOURCE_URL || raw.baseUrl || 'http://127.0.0.1:8888/video/api/v1/',
        tokenEnv: raw.tokenEnv || 'VIDEO_REMAKE_SOURCE_TOKEN',
        tokenJsonKey: raw.tokenJsonKey,
        tokenFile: raw.tokenFile ? absolute(raw.tokenFile, workspace) : undefined,
        manifest: absolute(overrides.sourceManifest || env.VIDEO_REMAKE_SOURCE_MANIFEST || raw.manifest || 'sources.json', workspace),
        directoryTemplate: raw.directoryTemplate ?? 'videos/{id}',
        videoFile: raw.videoFile ?? 'video.mp4',
        thumbFile: raw.thumbFile ?? 'thumb.jpg',
    };
    if (!['local', 'gateway-video', 'manifest'].includes(source.provider)) throw appError('CONFIG_INVALID', 'Unknown source provider.');
    try {
        const url = new URL(source.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        source.baseUrl = url.href.replace(/\/?$/, '/');
    } catch { throw appError('CONFIG_INVALID', 'source.baseUrl must be an HTTP(S) URL without credentials, query or fragment.'); }
    if (typeof source.directoryTemplate !== 'string') throw appError('CONFIG_INVALID', 'directoryTemplate must be a string.');
    for (const [key, fallback] of Object.entries({ requestTimeoutMs: 15000, pollIntervalMs: 2000, waitTimeoutMs: 600000 })) {
        source[key] = Number(overrides[key] ?? raw[key] ?? fallback);
        if (!Number.isSafeInteger(source[key]) || source[key] < 1 || source[key] > 2147483647) throw appError('CONFIG_INVALID', `${key} must be a positive integer <= 2147483647.`);
    }
    const quality = String(overrides.quality ?? env.VIDEO_REMAKE_QUALITY ?? file.quality ?? '1080');
    if (!QUALITIES.has(quality)) {
        throw appError('CONFIG_INVALID', 'quality must be 720, 1080, or audio.');
    }

    const rawDownload = file.download ?? {};
    if (!rawDownload || typeof rawDownload !== 'object' || Array.isArray(rawDownload)) {
        throw appError('CONFIG_INVALID', 'download 必须是对象。');
    }
    const executable = overrides.downloadExecutable ?? env.VIDEO_REMAKE_DOWNLOAD_EXECUTABLE ?? rawDownload.executable ?? 'yt-dlp';
    if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) {
        throw appError('CONFIG_INVALID', 'download.executable 必须是可执行文件名称或路径。');
    }
    const download = {
        provider: overrides.downloadProvider ?? env.VIDEO_REMAKE_DOWNLOAD_PROVIDER ?? rawDownload.provider ?? 'yt-dlp',
        executable: executable.includes('/') || executable.includes('\\') ? absolute(executable, workspace) : executable.trim(),
        directory: absolute(overrides.downloadDir ?? env.VIDEO_REMAKE_DOWNLOAD_DIR ?? rawDownload.directory ?? 'assets/source/downloads', workspace),
        timeoutMs: Number(overrides.downloadTimeoutMs ?? env.VIDEO_REMAKE_DOWNLOAD_TIMEOUT_MS ?? rawDownload.timeoutMs ?? 1800000),
    };
    if (download.provider !== 'yt-dlp') throw appError('CONFIG_INVALID', '不支持的下载适配器。');
    if (!Number.isSafeInteger(download.timeoutMs) || download.timeoutMs < 1 || download.timeoutMs > 2147483647) {
        throw appError('CONFIG_INVALID', 'download.timeoutMs 必须是 1 到 2147483647 的整数。');
    }

    const media = resolveMediaConfig(file.media ?? {}, env, workspace);

    return {
        workspace,
        configPath,
        catalogPath: path.join(workspace, 'catalog.json'),
        source,
        env,
        assetRoot,
        quality,
        media,
        download,
    };
}

export const WORKSPACE_DIRS = ['references', 'productions', 'deliverables', 'assets', 'packages'];

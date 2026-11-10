import { appError } from '../errors.js';
import { importReference } from '../references.js';
import { ytDlp } from './yt-dlp.js';

// Downloading is independent of the reference source: results always enter the
// local catalog, while legacy gateway ingestion keeps its existing adapter.
export function createDownloadProvider(config) {
    if (config.download.provider === 'yt-dlp') return ytDlp;
    throw appError('CONFIG_INVALID', `不支持的下载工具: ${config.download.provider}`);
}

export async function downloadDoctor(config, deps = {}) {
    const provider = createDownloadProvider(config);
    return { command: 'download:doctor', provider: provider.kind,
        ...await provider.doctor(config.download, { ...deps, env: deps.env ?? config.env }) };
}

export async function downloadReference(config, { url, quality } = {}, deps = {}) {
    const provider = createDownloadProvider(config);
    const downloaded = await provider.download(config.download, { url, quality: quality ?? config.quality }, { ...deps, env: deps.env ?? config.env });
    try {
        const register = () => {
            if (deps.signal?.aborted) throw appError('DOWNLOAD_CANCELLED', '下载任务已停止，原片保留但未登记。');
            return importReference(config, { file: downloaded.file, title: downloaded.origin.title, origin: downloaded.origin });
        };
        const result = await (deps.withCatalogWrite ? deps.withCatalogWrite(register) : register());
        return { ...result, command: 'reference:download', provider: provider.kind, file: downloaded.file };
    } catch {
        // A disk error may have written part of the reference transaction. Retain
        // the successful original so recovery never leaves a registered pointer broken.
        throw appError('DOWNLOAD_IMPORT_FAILED', `视频已下载，但登记失败；文件已保留，可用 reference:import 重新导入：${downloaded.file}`, {
            data: { command: 'reference:download', provider: provider.kind, file: downloaded.file, retained: true },
        });
    }
}

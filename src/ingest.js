import { setTimeout as sleep } from 'node:timers/promises';
import { createSourceProvider } from './sources/index.js';
import { bindVideo } from './bind.js';
import { appError } from './errors.js';

export async function ingestUrl(config, { url, force = false, quality }) {
    const provider = createSourceProvider(config);
    const selected = quality || config.quality;
    const added = await provider.enqueue({ url, quality: selected, force });
    const videoId = added.video.videoId;
    let latest = added.video;
    let pollCount = 0;
    const deadline = Date.now() + config.source.waitTimeoutMs;
    while (latest.status !== 'downloaded') {
        if (latest.status === 'failed') throw appError('SOURCE_FAILED', `服务端下载失败: ${videoId}`);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw appError('INGEST_TIMEOUT', `等待素材 ${videoId} 超时；请检查服务端下载 worker，完成后使用 bind ${videoId}。`, { retryable: true });
        await sleep(Math.min(config.source.pollIntervalMs, remaining));
        if (Date.now() >= deadline) continue;
        const remainingMs = Math.max(1, deadline - Date.now());
        try {
            latest = await provider.get(videoId, { timeoutMs: Math.min(config.source.requestTimeoutMs, remainingMs) });
        } catch (error) {
            // A request clipped to the total wait budget belongs to ingestion timeout.
            if (error.code === 'SOURCE_TIMEOUT' && remainingMs <= config.source.requestTimeoutMs) continue;
            throw error;
        }
        pollCount += 1;
    }
    const bound = await bindVideo(config, videoId, { requestedQuality: selected, entry: latest, provider });
    return { ...bound, command: 'ingest', ingestion: { provider: provider.kind, added, pollCount } };
}

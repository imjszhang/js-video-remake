import { localTools } from './doctor.js';

export async function projectPaths(config, options = {}) {
    const tools = await localTools(options);
    return {
        command: 'paths',
        workspace: config.workspace,
        assetRoot: config.assetRoot,
        source: { provider: config.source.provider, location: config.source.provider === 'local' ? config.catalogPath : config.source.provider === 'manifest' ? config.source.manifest : config.source.baseUrl },
        download: config.download,
        tools: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, hyperframes: tools.hyperframes },
        media: Object.fromEntries(Object.entries(config.media).map(([task, entry]) => [task, entry.provider])),
        ...(config.proxy ? { proxy: config.proxy } : {}),
    };
}

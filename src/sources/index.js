import { appError } from '../errors.js';
import { gatewayVideo } from './gateway-video.js';
import { localSource } from './local.js';
import { manifestSource } from './manifest.js';

// Provider contract: health(), list(), get(id), enqueue(request), resolveAssets(video).
// Business commands consume this contract; backend routes and layouts stay in adapters.
export function createSourceProvider(config, options = {}) {
    switch (config.source.provider) {
        case 'local': return localSource(config);
        case 'gateway-video': return gatewayVideo(config, options);
        case 'manifest': return manifestSource(config);
        default: throw appError('CONFIG_INVALID', `不支持的数据源: ${config.source.provider}`);
    }
}

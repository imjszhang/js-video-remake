import { videoProvider, basicRequest, firstFrame, invalid, failed, taskId } from './video-common.js';
const defaults = { baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-Hailuo-2.3', resolution: '768P' };
function check(json) {
    if (!json || json.base_resp?.status_code !== 0) throw failed('MiniMax 视频接口返回业务错误或缺少状态码。');
    return json;
}
export default videoProvider({
    id: 'minimax-video', label: 'MiniMax 海螺视频 API', defaults,
    fields: { baseUrl: { type: 'url', env: 'MINIMAX_VIDEO_BASE_URL', default: defaults.baseUrl },
        apiKeyFile: { type: 'path', env: 'MINIMAX_API_KEY_FILE' }, model: { type: 'string', default: defaults.model },
        resolution: { type: 'string', default: defaults.resolution } },
    validateSettings(settings) {
        if (settings.model !== defaults.model || !['768P', '1080P'].includes(settings.resolution)) throw invalid('MiniMax 适配器支持 Hailuo-2.3，分辨率为 768P 或 1080P。');
    },
    validateCombined(settings, request) {
        if (settings.resolution === '1080P' && (request.duration ?? 6) !== 6) throw invalid('MiniMax 1080P 只支持 6 秒视频。');
    },
    validateRequest(request) {
        basicRequest(request, { maxPrompt: 2000, durations: [6, 10] });
        if (request.aspectRatio) throw invalid('此 MiniMax 接口不支持显式 aspectRatio；图生视频请通过首帧控制画幅。');
    },
    async build(settings, request) {
        const image = await firstFrame(request, 19_999_999);
        return { path: '/video_generation', body: { model: settings.model, prompt: request.intent,
            duration: request.duration ?? 6, resolution: settings.resolution, prompt_optimizer: false,
            ...(image ? { first_frame_image: image } : {}) } };
    },
    submitted: (json) => check(json).task_id,
    async poll(settings, id, get) {
        const json = check(await get(`/query/video_generation?task_id=${id}`));
        if (json.status === 'Success') {
            let fileId;
            try { fileId = taskId(json.file_id); } catch { throw failed('MiniMax 任务成功但缺少有效 file_id。'); }
            const file = check(await get(`/files/retrieve?file_id=${fileId}`));
            return { done: true, url: file.file?.download_url };
        }
        if (['Preparing', 'Queueing', 'Processing'].includes(json.status)) return { done: false };
        throw failed('MiniMax 视频任务失败或状态未知。');
    },
});

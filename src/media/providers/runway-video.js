import { videoProvider, basicRequest, firstFrame, invalid, failed } from './video-common.js';
const defaults = { baseUrl: 'https://api.dev.runwayml.com/v1', model: 'gen4.5' };
export default videoProvider({
    id: 'runway-video', label: 'Runway Gen-4.5', defaults,
    fields: { baseUrl: { type: 'url', env: 'RUNWAY_VIDEO_BASE_URL', default: defaults.baseUrl },
        apiKeyFile: { type: 'path', env: 'RUNWAY_API_KEY_FILE' }, model: { type: 'string', default: defaults.model } },
    headers: { 'X-Runway-Version': '2024-11-06' },
    validateSettings(settings) { if (settings.model !== 'gen4.5') throw invalid('Runway 适配器目前只支持 gen4.5。'); },
    validateRequest(request) {
        basicRequest(request, { maxPrompt: 1000, minDuration: 2, maxDuration: 10 });
        if (request.aspectRatio && !['16:9', '9:16'].includes(request.aspectRatio)) throw invalid('Runway 适配器支持 16:9 或 9:16。');
    },
    async build(settings, request) {
        const image = await firstFrame(request, 3_500_000);
        return { path: image ? '/image_to_video' : '/text_to_video', body: {
            model: settings.model, promptText: request.intent, duration: request.duration ?? 5,
            ratio: request.aspectRatio === '9:16' ? '720:1280' : '1280:720', ...(image ? { promptImage: image } : {}),
        } };
    },
    submitted: (json) => json?.id,
    async poll(settings, id, get) {
        const json = await get(`/tasks/${id}`);
        if (json?.status === 'SUCCEEDED') return { done: true, url: json.output?.[0] };
        if (['PENDING', 'THROTTLED', 'RUNNING'].includes(json?.status)) return { done: false };
        throw failed('Runway 任务失败、被取消或返回未知状态。');
    },
});

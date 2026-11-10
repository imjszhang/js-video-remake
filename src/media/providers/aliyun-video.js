import { videoProvider, basicRequest, firstFrame, invalid, failed } from './video-common.js';
const defaults = { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', textModel: 'wan2.7-t2v', imageModel: 'wan2.7-i2v-2026-04-25', resolution: '720P' };
export default videoProvider({
    id: 'aliyun-video', label: '阿里百炼万相视频', defaults,
    fields: { baseUrl: { type: 'url', env: 'DASHSCOPE_VIDEO_BASE_URL', default: defaults.baseUrl },
        apiKeyFile: { type: 'path', env: 'DASHSCOPE_API_KEY_FILE' }, textModel: { type: 'string', default: defaults.textModel },
        imageModel: { type: 'string', default: defaults.imageModel }, resolution: { type: 'string', default: defaults.resolution } },
    headers: { 'X-DashScope-Async': 'enable' },
    validateSettings(settings) {
        if (!['wan2.7-t2v', 'wan2.7-t2v-2026-06-12'].includes(settings.textModel)
            || settings.imageModel !== defaults.imageModel || !['720P', '1080P'].includes(settings.resolution)) throw invalid('万相视频模型或分辨率不在本适配器支持范围。');
    },
    validateRequest(request) {
        basicRequest(request, { maxPrompt: 5000, minDuration: 2, maxDuration: 15 });
        if (request.images?.length && request.aspectRatio) throw invalid('万相图生视频由首帧决定画幅，请调整首帧并省略 aspectRatio。');
        if (request.aspectRatio && !['16:9', '9:16', '1:1', '4:3', '3:4'].includes(request.aspectRatio)) throw invalid('万相文生视频不支持该画幅。');
    },
    async build(settings, request) {
        const image = await firstFrame(request);
        return { path: '/services/aigc/video-generation/video-synthesis', body: {
            model: image ? settings.imageModel : settings.textModel,
            input: { prompt: request.intent, ...(image ? { media: [{ type: 'first_frame', url: image }] } : {}) },
            parameters: { resolution: settings.resolution, duration: request.duration ?? 5, prompt_extend: false,
                ...(image ? {} : { ratio: request.aspectRatio || '16:9' }) },
        } };
    },
    submitted: (json) => json?.output?.task_id,
    async poll(settings, id, get) {
        const json = await get(`/tasks/${id}`);
        if (json?.output?.task_status === 'SUCCEEDED') return { done: true, url: json.output.video_url };
        if (['PENDING', 'RUNNING'].includes(json?.output?.task_status)) return { done: false };
        throw failed('万相视频任务失败、取消或状态未知。');
    },
});

import { baseUrl, readKey, validateOptions, inputImages, decodeImage, outputTarget, saveImage, transport, cloudDoctor, metadata, invalid, failed } from './image-common.js';
const defaults = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image' };
const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
function validateRequest(request) {
    validateOptions(request);
    if (request.size && !ratios.includes(request.size)) throw invalid(`Gemini size 使用画幅比例：${ratios.join('、')}。`);
    if (request.images?.length > 14) throw invalid('Gemini 适配器最多接收 14 张参考图。');
}
export default {
    ...metadata('gemini-image', 'Gemini 图像生成'),
    fields: { baseUrl: { type: 'url', env: 'GEMINI_IMAGE_BASE_URL', default: defaults.baseUrl },
        apiKeyFile: { type: 'path', env: 'GEMINI_IMAGE_API_KEY_FILE' }, model: { type: 'string', env: 'GEMINI_IMAGE_MODEL', default: defaults.model } },
    validateRequest,
    doctor: (settings) => cloudDoctor(settings, defaults),
    async generateImage(settings, request, deps = {}) {
        validateRequest(request);
        await outputTarget(request.outPath);
        const key = await readKey(settings.apiKeyFile);
        const images = await inputImages(request.images);
        if (images.reduce((n, image) => n + image.bytes.length, 0) > 14_000_000) throw invalid('Gemini 内联参考图总量超过本适配器 14 MB 限制。');
        const parts = [...images.map((image) => ({ inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') } })), { text: request.intent }];
        const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
        if (request.size) generationConfig.imageConfig = { aspectRatio: request.size };
        const { request: call } = transport(deps);
        const json = await call(`${baseUrl(settings.baseUrl || defaults.baseUrl)}/models/${encodeURIComponent(settings.model || defaults.model)}:generateContent`, {
            method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
        });
        const candidate = json?.candidates?.[0];
        if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw failed('Gemini 未正常完成图片生成；请检查内容限制或输出限制。');
        const part = candidate?.content?.parts?.find((item) => item.inlineData && !item.thought);
        if (!part?.inlineData?.mimeType?.startsWith('image/')) throw failed('Gemini 未返回图片（可能被拦截或只返回文字）。');
        return saveImage(decodeImage(part.inlineData.data), request, 'gemini-image');
    },
};

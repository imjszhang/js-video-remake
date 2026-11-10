import { baseUrl, readKey, validateOptions, inputImages, decodeImage, outputTarget, saveImage, transport, cloudDoctor, metadata, invalid } from './image-common.js';
const defaults = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst' };
function validateRequest(request) {
    validateOptions(request, ['quality']);
    if (request.options?.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(request.options.quality)) throw invalid('OpenAI quality 只支持 auto、low、medium、high。');
    if (request.images?.length > 16) throw invalid('OpenAI 适配器最多接收 16 张参考图。');
    if (request.size && !/^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/.test(request.size)) throw invalid('OpenAI size 使用 auto 或 宽x高。');
}
export default {
    ...metadata('openai-image', 'OpenAI Images API'),
    fields: { baseUrl: { type: 'url', env: 'OPENAI_IMAGE_BASE_URL', default: defaults.baseUrl },
        apiKeyFile: { type: 'path', env: 'OPENAI_IMAGE_API_KEY_FILE' }, model: { type: 'string', env: 'OPENAI_IMAGE_MODEL', default: defaults.model } },
    validateRequest,
    doctor: (settings) => cloudDoctor(settings, defaults),
    async generateImage(settings, request, deps = {}) {
        validateRequest(request);
        await outputTarget(request.outPath);
        const key = await readKey(settings.apiKeyFile);
        const images = await inputImages(request.images);
        const parameters = { model: settings.model || defaults.model, prompt: request.intent, n: 1, output_format: 'png',
            size: request.size || 'auto', quality: request.options?.quality || 'auto' };
        const headers = { Authorization: `Bearer ${key}` };
        let body;
        if (images.length) {
            body = new FormData();
            for (const [name, value] of Object.entries(parameters)) body.set(name, String(value));
            for (const image of images) body.append('image[]', new Blob([image.bytes], { type: image.mime }), image.name);
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(parameters);
        }
        const { request: call } = transport(deps);
        const json = await call(`${baseUrl(settings.baseUrl || defaults.baseUrl)}/images/${images.length ? 'edits' : 'generations'}`, { method: 'POST', headers, body });
        return saveImage(decodeImage(json?.data?.[0]?.b64_json), request, 'openai-image');
    },
};

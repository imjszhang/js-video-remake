import { baseUrl, readKey, validateOptions, inputImages, outputTarget, saveImage, transport, cloudDoctor, metadata, invalid, failed } from './image-common.js';
const defaults = { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-image' };
function validateRequest(request) {
    validateOptions(request);
    if (request.images?.length > 9) throw invalid('万相最多接收 9 张参考图。');
    if (request.intent.length > 5000) throw invalid('万相提示词不能超过 5000 个字符。');
    if (request.size && !['1K', '2K'].includes(request.size)) throw invalid('万相适配器 size 只支持 1K、2K。');
}
export default {
    ...metadata('aliyun-image', '阿里百炼万相'),
    fields: { baseUrl: { type: 'url', env: 'DASHSCOPE_IMAGE_BASE_URL', default: defaults.baseUrl },
        apiKeyFile: { type: 'path', env: 'DASHSCOPE_API_KEY_FILE' }, model: { type: 'string', env: 'DASHSCOPE_IMAGE_MODEL', default: defaults.model } },
    validateRequest,
    async doctor(settings) {
        if (settings.model && !['wan2.7-image', 'wan2.7-image-pro'].includes(settings.model)) return { ready: false, version: '', hint: '本适配器只支持万相 2.7 图片模型。' };
        return cloudDoctor(settings, defaults);
    },
    async generateImage(settings, request, deps = {}) {
        validateRequest(request);
        if (settings.model && !['wan2.7-image', 'wan2.7-image-pro'].includes(settings.model)) throw invalid('本适配器只支持万相 2.7 图片模型。');
        await outputTarget(request.outPath);
        const key = await readKey(settings.apiKeyFile);
        const images = await inputImages(request.images);
        const content = [...images.map((image) => ({ image: `data:${image.mime};base64,${image.bytes.toString('base64')}` })), { text: request.intent }];
        const { request: call } = transport(deps);
        const json = await call(`${baseUrl(settings.baseUrl || defaults.baseUrl)}/services/aigc/multimodal-generation/generation`, {
            method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: settings.model || defaults.model, input: { messages: [{ role: 'user', content }] }, parameters: { n: 1, size: request.size || '2K', watermark: false } }),
        });
        const value = json?.output?.choices?.[0]?.message?.content?.find((item) => item.image)?.image;
        let url;
        try { url = new URL(value); } catch { throw failed('百炼没有返回图片下载地址。'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw failed('百炼图片下载地址无效。');
        // 签名下载链接不携带百炼密钥，不写入结果或日志。
        const bytes = await call(url.href, {}, true);
        return saveImage(bytes, request, 'aliyun-image');
    },
};

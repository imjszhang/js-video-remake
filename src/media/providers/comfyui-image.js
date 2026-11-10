import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appError } from '../../errors.js';
import { baseUrl, readKey, validateOptions, inputImages, outputTarget, saveImage, transport, metadata, invalid, failed } from './image-common.js';

const DEFAULT_URL = 'http://127.0.0.1:8188';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function validateRequest(request) {
    validateOptions(request);
    if (request.size && !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(request.size)) throw invalid('ComfyUI size 使用正整数宽x高，如 1024x1024。');
}
function binding(graph, slot, value) {
    if (!object(slot) || typeof slot.node !== 'string' || typeof slot.input !== 'string'
        || !Object.hasOwn(graph, slot.node) || !object(graph[slot.node]?.inputs)
        || !Object.hasOwn(graph[slot.node].inputs, slot.input)) throw invalid('ComfyUI 绑定必须指向工作流已有的 node/input。');
    if (value !== undefined) graph[slot.node].inputs[slot.input] = value;
}
async function load(settings) {
    let config;
    try { config = JSON.parse(await fs.readFile(settings.workflowFile, 'utf8')); } catch { throw appError('MEDIA_UNAVAILABLE', '请配置可读取的 ComfyUI workflowFile JSON。'); }
    if (!object(config) || !['generate', 'edit'].some((mode) => config[mode])) throw invalid('ComfyUI 工作流配置需要 generate 或 edit。');
    for (const mode of ['generate', 'edit']) {
        const profile = config[mode];
        if (!profile) continue;
        if (!object(profile.workflow) || !Object.keys(profile.workflow).length
            || Object.values(profile.workflow).some((node) => !object(node) || typeof node.class_type !== 'string' || !object(node.inputs))) {
            throw invalid('ComfyUI 需要 API 格式工作流，不接受界面导出的 nodes/links 格式。');
        }
        binding(profile.workflow, profile.prompt);
        if (!Array.isArray(profile.images ?? [])) throw invalid('ComfyUI images 绑定必须是数组。');
        for (const slot of profile.images ?? []) binding(profile.workflow, slot);
        if (mode === 'edit' && !profile.images?.length) throw invalid('编辑工作流必须配置参考图输入绑定。');
        if (mode === 'generate' && profile.images?.length) throw invalid('文生图工作流不能配置参考图绑定。');
        if (profile.width || profile.height) {
            binding(profile.workflow, profile.width);
            binding(profile.workflow, profile.height);
        }
        if (typeof profile.outputNode !== 'string' || !Object.hasOwn(profile.workflow, profile.outputNode)) throw invalid('ComfyUI 必须指定已有的 outputNode。');
    }
    return config;
}
async function prepare(settings, request) {
    validateRequest(request);
    const config = await load(settings);
    const profile = config[request.images?.length ? 'edit' : 'generate'];
    if (!profile) throw appError('MEDIA_CAPABILITY_UNSUPPORTED', 'ComfyUI 未配置本次需求对应的文生图或编辑工作流。');
    if ((profile.images?.length ?? 0) !== (request.images?.length ?? 0)) throw invalid('参考图数量必须与 ComfyUI 工作流的 images 绑定数量一致。');
    if (request.size && (!profile.width || !profile.height)) throw invalid('指定尺寸时，ComfyUI 工作流必须配置 width 和 height 绑定。');
    binding(profile.workflow, profile.prompt, request.intent);
    if (request.size) {
        const [width, height] = request.size.split('x').map(Number);
        binding(profile.workflow, profile.width, width);
        binding(profile.workflow, profile.height, height);
    }
    return profile;
}
export default {
    ...metadata('comfyui-image', 'ComfyUI 图片工作流'),
    publicSettings: ['baseUrl'],
    fields: { baseUrl: { type: 'url', env: 'COMFYUI_IMAGE_URL', default: DEFAULT_URL },
        workflowFile: { type: 'path', env: 'COMFYUI_IMAGE_WORKFLOW' }, apiKeyFile: { type: 'path', env: 'COMFYUI_IMAGE_API_KEY_FILE' } },
    validateRequest, prepare,
    async doctor(settings) {
        try {
            baseUrl(settings.baseUrl || DEFAULT_URL, true);
            await load(settings);
            await readKey(settings.apiKeyFile, true);
            return { ready: true, version: '', hint: '仅检查工作流配置；未连接 ComfyUI，未确认节点、模型或服务可用性，未生图。' };
        } catch (error) { return { ready: false, version: '', hint: error.message }; }
    },
    async generateImage(settings, request, deps = {}) {
        const profile = await prepare(settings, request);
        await outputTarget(request.outPath);
        const images = await inputImages(request.images);
        const key = await readKey(settings.apiKeyFile, true);
        const headers = key ? { Authorization: `Bearer ${key}` } : {};
        const base = baseUrl(settings.baseUrl || DEFAULT_URL, true);
        const { request: call, signal } = transport(deps);
        const interval = deps.pollIntervalMs ?? 1000;
        if (!Number.isInteger(interval) || interval <= 0) throw invalid('轮询间隔必须为正整数毫秒。');
        let promptId;
        try {
            for (const [index, image] of images.entries()) {
                const form = new FormData();
                form.set('image', new Blob([image.bytes], { type: image.mime }), `${randomUUID()}${image.ext}`);
                form.set('type', 'input');
                form.set('overwrite', 'false');
                const uploaded = await call(`${base}/upload/image`, { method: 'POST', headers, body: form });
                if (typeof uploaded.name !== 'string' || !uploaded.name || (uploaded.subfolder !== undefined && typeof uploaded.subfolder !== 'string')) throw failed('ComfyUI 上传未返回图片名称。');
                binding(profile.workflow, profile.images[index], uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name);
            }
            const submitted = await call(`${base}/prompt`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: profile.workflow, client_id: randomUUID() }) });
            if (typeof submitted.prompt_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submitted.prompt_id)) throw failed('ComfyUI 未返回有效任务 ID。');
            promptId = submitted.prompt_id;
            if (submitted.error || Object.keys(submitted.node_errors ?? {}).length) throw failed('ComfyUI 工作流节点验证失败。');
            for (let attempt = 0; attempt < Math.ceil((deps.timeoutMs ?? 600000) / interval); attempt++) {
                const history = await call(`${base}/history/${encodeURIComponent(promptId)}`, { headers });
                const entry = history[promptId];
                if (entry?.status?.status_str === 'error' || entry?.status?.messages?.some((message) => ['execution_error', 'execution_interrupted'].includes(message[0]))) throw failed('ComfyUI 工作流执行失败或被中断。');
                if (entry?.status?.completed) {
                    const image = entry.outputs?.[profile.outputNode]?.images?.[0];
                    if (typeof image?.filename !== 'string' || !image.filename || !['output', 'temp'].includes(image.type)) throw failed('ComfyUI 已完成，但指定节点没有图片输出。');
                    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type });
                    const bytes = await call(`${base}/view?${query}`, { headers }, true);
                    return await saveImage(bytes, request, 'comfyui-image');
                }
                await (deps.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(interval, signal);
            }
            throw failed('ComfyUI 等待超时，任务可能仍在运行。');
        } catch (error) {
            throw appError('MEDIA_FAILED', `${signal.aborted ? 'ComfyUI 等待超时。' : error.code ? error.message : 'ComfyUI 调用失败。'}${promptId ? ` 任务 ${promptId}，请先查询状态，不要重复提交。` : ''}`, { data: promptId ? { promptId } : undefined });
        }
    },
};

import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../errors.js';

// 能力名称描述制作需求，不描述供应商、模型或调用协议。
export const MEDIA_CAPABILITIES = {
    image: ['text-to-image', 'image-edit'],
    video: ['text-to-video', 'image-to-video', 'audio-driven-video', 'pose-reference-video', 'multi-reference-video'],
    transcribe: ['timed-transcription', 'word-timestamps'],
    speech: ['text-to-speech'],
};

const REQUEST_FIELDS = {
    image: ['intent', 'images', 'size', 'outPath'],
    video: ['intent', 'images', 'audio', 'referenceVideo', 'duration', 'aspectRatio', 'outPath'],
    transcribe: ['file', 'language'],
    speech: ['text', 'reference', 'referenceText', 'language', 'voice', 'outPath'],
};
const invalid = (message) => appError('INVALID_INPUT', message);
const failed = (message) => appError('MEDIA_FAILED', message);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function string(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} 必须是非空字符串。`);
    return value;
}

export function normalizeMediaRequest(task, input, workspace) {
    if (!REQUEST_FIELDS[task]) throw invalid(`任务只接受 ${Object.keys(REQUEST_FIELDS).join(' | ')}。`);
    if (!object(input)) throw invalid('素材需求必须是 JSON 对象。');
    const fields = [...REQUEST_FIELDS[task], 'options', 'require'];
    const unknown = Object.keys(input).find((key) => !fields.includes(key));
    if (unknown) throw invalid(`${task} 素材需求不支持字段 ${unknown}。`);
    const request = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    request.options = input.options ?? {};
    if (!object(request.options)) throw invalid('options 必须是对象。');
    request.require = input.require ?? [];
    if (!Array.isArray(request.require)) throw invalid('require 必须是能力名称数组。');
    for (const capability of request.require) {
        if (!MEDIA_CAPABILITIES[task].includes(capability)) throw invalid(`${task} 未知能力: ${capability}。`);
    }

    const inferred = [];
    if (task === 'transcribe') {
        request.file = path.resolve(workspace, string(input.file, 'file'));
        if (input.language !== undefined) string(input.language, 'language');
        inferred.push('timed-transcription');
    } else if (task === 'speech') {
        request.text = string(input.text, 'text');
        if (input.reference !== undefined) request.reference = path.resolve(workspace, string(input.reference, 'reference'));
        if (input.referenceText !== undefined) string(input.referenceText, 'referenceText');
        if (input.language !== undefined) string(input.language, 'language');
        if (input.voice !== undefined) string(input.voice, 'voice');
        if (input.outPath !== undefined) request.outPath = path.resolve(workspace, string(input.outPath, 'outPath'));
        inferred.push('text-to-speech');
    } else {
        string(input.intent, 'intent');
        if (input.images !== undefined && !Array.isArray(input.images)) throw invalid('images 必须是文件路径数组。');
        request.images = (input.images ?? []).map((file) => path.resolve(workspace, string(file, 'images')));
        if (task === 'image') {
            inferred.push(request.images.length ? 'image-edit' : 'text-to-image');
            if (input.size !== undefined) string(input.size, 'size');
            if (input.outPath !== undefined) request.outPath = path.resolve(workspace, string(input.outPath, 'outPath'));
        } else {
            if (input.outPath !== undefined) request.outPath = path.resolve(workspace, string(input.outPath, 'outPath'));
            for (const key of ['audio', 'referenceVideo']) {
                if (input[key] !== undefined) request[key] = path.resolve(workspace, string(input[key], key));
            }
            if (request.audio) inferred.push('audio-driven-video');
            if (request.referenceVideo) inferred.push('pose-reference-video');
            if (request.images.length > 1) inferred.push('multi-reference-video');
            if (!inferred.length) inferred.push(request.images.length ? 'image-to-video' : 'text-to-video');
            if (input.duration !== undefined && (!Number.isFinite(input.duration) || input.duration <= 0)) {
                throw invalid('duration 必须是大于 0 的秒数。');
            }
            if (input.aspectRatio !== undefined && !/^[1-9]\d*:[1-9]\d*$/.test(string(input.aspectRatio, 'aspectRatio'))) {
                throw invalid('aspectRatio 必须是正整数比例，例如 9:16。');
            }
        }
    }
    request.require = [...new Set([...inferred, ...request.require])];
    return request;
}

export function assertCapabilities(provider, request) {
    const missing = request.require.filter((capability) => !provider.capabilities.includes(capability));
    if (missing.length) {
        throw appError('MEDIA_CAPABILITY_UNSUPPORTED', `${provider.id} 不支持所需能力: ${missing.join('、')}。`, {
            data: { provider: provider.id, required: request.require, missing, supported: provider.capabilities },
        });
    }
    if (provider.validateRequest) provider.validateRequest(request);
    else if (Object.keys(request.options).length) throw invalid(`${provider.id} 不支持专属 options。`);
}

export async function validateRequestFiles(request) {
    const files = [...(request.images ?? []), request.file, request.audio, request.referenceVideo, request.reference].filter(Boolean);
    for (const file of files) {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile()) throw appError('NOT_FOUND', `素材输入文件不存在: ${file}`);
    }
}

export async function validateMediaFileResult(result, provider) {
    if (!object(result) || typeof result.path !== 'string' || !path.isAbsolute(result.path)) {
        throw failed(`${provider.id} 必须返回素材文件的绝对路径 path。`);
    }
    if (!provider.ledgerProviders.includes(result.provider)) throw failed(`${provider.id} 返回了未声明的素材来源。`);
    if (result.sourcePath !== undefined && (typeof result.sourcePath !== 'string' || !path.isAbsolute(result.sourcePath))) {
        throw failed(`${provider.id} 返回的 sourcePath 必须是绝对路径。`);
    }
    const stat = await fs.stat(result.path).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw failed(`${provider.id} 没有留下有效的素材文件。`);
    return result;
}

export function validateTranscriptResult(json, request) {
    if (!object(json) || (!Array.isArray(json.segments) && !Array.isArray(json.words))) {
        throw failed('转写结果缺少 segments 或 words。');
    }
    const time = (item) => {
        const numeric = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value));
        if (!numeric(item.start) || !numeric(item.end) || Number(item.start) < 0 || Number(item.end) < Number(item.start)) {
            throw failed('转写时间必须是非负秒数，且 end 不小于 start。');
        }
    };
    const timed = (item, word = false) => {
        if (!object(item) || typeof (word ? item.word ?? item.text : item.text) !== 'string') {
            throw failed('转写条目必须包含文本。');
        }
        time(item);
    };
    for (const key of ['segments', 'words']) {
        if (json[key] !== undefined && !Array.isArray(json[key])) throw failed(`转写 ${key} 必须是数组。`);
    }
    for (const word of json.words ?? []) timed(word, true);
    for (const segment of json.segments ?? []) {
        if (!object(segment)) throw failed('转写 segments 条目必须是对象。');
        if (segment.words !== undefined && !Array.isArray(segment.words)) throw failed('转写分段 words 必须是数组。');
        if (segment.words?.length) {
            for (const word of segment.words) timed(word, true);
            if (segment.start !== undefined || segment.end !== undefined) time(segment);
        } else timed(segment);
    }
    if (request.require.includes('word-timestamps')) {
        // 与 captions 的读取顺序一致：有分段时，所有非空分段都必须有词级时间。
        const segments = json.segments?.length ? json.segments : null;
        const words = segments ? segments.flatMap((segment) => segment.words ?? []) : json.words ?? [];
        const hasText = (word) => (word.word ?? word.text).trim().length > 0;
        if (!words.some(hasText) || (segments && segments.some((segment) => !segment.words?.some(hasText) && segment.text?.trim()))) {
            throw failed('本次需求要求 word-timestamps，但转写结果没有完整的词级时间。');
        }
    }
    return json;
}

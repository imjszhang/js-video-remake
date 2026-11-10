import os from 'node:os';
import path from 'node:path';
import { appError } from '../errors.js';
import codexImage from './providers/codex-image.js';
import openaiImage from './providers/openai-image.js';
import geminiImage from './providers/gemini-image.js';
import aliyunImage from './providers/aliyun-image.js';
import comfyuiImage from './providers/comfyui-image.js';
import comfyMcp from './providers/comfy-mcp.js';
import runwayVideo from './providers/runway-video.js';
import aliyunVideo from './providers/aliyun-video.js';
import minimaxVideo from './providers/minimax-video.js';
import mlxWhisper from './providers/mlx-whisper.js';
import aliyunAsr from './providers/aliyun-asr.js';
import fasterWhisper from './providers/faster-whisper.js';
import azureSpeech from './providers/azure-speech.js';

// Registered providers per task. Add a module under providers/ and list it here.
export const PROVIDERS = {
    image: { [codexImage.id]: codexImage,
        [openaiImage.id]: openaiImage, [geminiImage.id]: geminiImage,
        [aliyunImage.id]: aliyunImage, [comfyuiImage.id]: comfyuiImage },
    video: { [comfyMcp.id]: comfyMcp, [runwayVideo.id]: runwayVideo,
        [aliyunVideo.id]: aliyunVideo, [minimaxVideo.id]: minimaxVideo },
    transcribe: {
        [mlxWhisper.id]: mlxWhisper, [aliyunAsr.id]: aliyunAsr,
        [fasterWhisper.id]: fasterWhisper, [azureSpeech.id]: azureSpeech,
    },
};

// This project's selection when video-remake.json does not name one.
export const DEFAULT_PROVIDERS = { image: 'codex-image', video: 'comfy-mcp', transcribe: 'mlx-whisper' };
export const MEDIA_TASKS = Object.keys(DEFAULT_PROVIDERS);
export const PROVIDER_ENV = { image: 'VIDEO_REMAKE_MEDIA_IMAGE', video: 'VIDEO_REMAKE_MEDIA_VIDEO', transcribe: 'VIDEO_REMAKE_MEDIA_TRANSCRIBE' };

const invalid = (message) => appError('CONFIG_INVALID', message);

function fieldValue(type, value, name, workspace) {
    if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} must be a nonempty string.`);
    const trimmed = value.trim();
    if (type === 'path' || (type === 'executable' && /[/\\]/.test(trimmed))) {
        return trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : path.resolve(workspace, trimmed);
    }
    if (type === 'url') {
        let url;
        try { url = new URL(trimmed); } catch { throw invalid(`${name} must be an HTTP(S) URL.`); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid(`${name} must be an HTTP(S) URL without credentials.`);
        return url.href;
    }
    return trimmed;
}

export function getProvider(task, id, providers = PROVIDERS) {
    const provider = providers[task]?.[id];
    if (!provider) throw invalid(`Unknown media.${task}.provider: ${id}（可选: ${Object.keys(providers[task] || {}).join(', ')}）`);
    return provider;
}

export function resolveMediaConfig(raw = {}, env = process.env, workspace = process.cwd(), providers = PROVIDERS) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('media must be an object.');
    const unknownTask = Object.keys(raw).find((task) => !MEDIA_TASKS.includes(task));
    if (unknownTask) throw invalid(`Unknown media task: ${unknownTask}（可选: ${MEDIA_TASKS.join(', ')}）`);
    const media = {};
    for (const task of MEDIA_TASKS) {
        const section = raw[task] ?? {};
        if (!section || typeof section !== 'object' || Array.isArray(section)) throw invalid(`media.${task} must be an object.`);
        const id = env[PROVIDER_ENV[task]] || section.provider || DEFAULT_PROVIDERS[task];
        const provider = getProvider(task, id, providers);
        const unknown = Object.keys(section).find((key) => key !== 'provider' && !provider.fields[key]);
        if (unknown) throw invalid(`media.${task}.${unknown} is not a ${id} setting.`);
        const settings = {};
        for (const [key, field] of Object.entries(provider.fields)) {
            const value = (field.env && env[field.env]) || (section[key] ?? field.default);
            if (value !== undefined) settings[key] = fieldValue(field.type, value, `media.${task}.${key}`, workspace);
        }
        media[task] = { provider: id, settings };
    }
    return media;
}

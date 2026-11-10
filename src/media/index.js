import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../errors.js';
import { openProduction } from '../start.js';
import { getProvider, MEDIA_TASKS } from './config.js';
import { ID_RE, KIND_PREFIX, land } from './land.js';
import { normalizeMediaRequest, assertCapabilities, validateRequestFiles, validateMediaFileResult, validateTranscriptResult } from './contracts.js';

export const SKILL_DIR = '.agents/skills/remake-media';
function selected(config, task, deps = {}) {
    const entry = config.media[task];
    return { entry, provider: getProvider(task, entry.provider, deps.providers) };
}

function workspacePath(config, file) {
    return path.resolve(config.workspace, file);
}

async function prepareRequest(config, task, input, deps) {
    const request = normalizeMediaRequest(task, input, config.workspace);
    const { entry, provider } = selected(config, task, deps);
    assertCapabilities(provider, request);
    await validateRequestFiles(request);
    if (provider.prepare) await provider.prepare(entry.settings, request);
    return { entry, provider, request };
}

// 纯本地检查；不探活、不生成、不创建制作或台账。
export async function mediaPrepare(config, { task, request: file } = {}, deps = {}) {
    if (!MEDIA_TASKS.includes(task)) throw appError('INVALID_INPUT', `--task 只接受 ${MEDIA_TASKS.join(' | ')}。`);
    if (typeof file !== 'string' || !file.trim()) throw appError('INVALID_INPUT', 'media:prepare 需要 --request <素材需求.json>。');
    let input;
    try {
        input = JSON.parse(await fs.readFile(workspacePath(config, file), 'utf8'));
    } catch (error) {
        throw appError(error.code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_INPUT', `无法读取素材需求 JSON: ${file}`);
    }
    const { provider, request } = await prepareRequest(config, task, input, deps);
    return {
        command: 'media:prepare', task, provider: provider.id,
        execution: provider.execution, agentOnly: provider.execution === 'agent',
        guide: `${SKILL_DIR}/${provider.guide}`,
        capabilities: provider.capabilities, ledgerProviders: provider.ledgerProviders,
        request,
    };
}

export async function mediaDoctor(config, { task } = {}, deps = {}) {
    if (task !== undefined && !MEDIA_TASKS.includes(task)) throw appError('INVALID_INPUT', `--task 只接受 ${MEDIA_TASKS.join(' | ')}。`);
    const tasks = task ? [task] : MEDIA_TASKS;
    const warnings = [];
    const media = {};
    for (const name of tasks) {
        const { entry, provider } = selected(config, name, deps);
        const check = await provider.doctor(entry.settings, { ...deps, env: config.env ?? process.env, fetchImpl: deps.fetchImpl ?? fetch });
        media[name] = {
            provider: provider.id,
            label: provider.label,
            guide: `${SKILL_DIR}/${provider.guide}`,
            agentOnly: provider.execution === 'agent',
            execution: provider.execution,
            capabilities: provider.capabilities,
            ledgerProviders: provider.ledgerProviders,
            testedVersion: provider.testedVersion,
            version: check.version,
            ready: check.ready,
            hint: check.hint,
            settings: Object.fromEntries(Object.entries(entry.settings).filter(([key]) => (provider.publicSettings ?? []).includes(key))),
        };
        if (!check.ready) warnings.push(`${name} (${provider.id}): ${check.hint}`);
    }
    const data = { command: 'media:doctor', media, warnings };
    if (task && !media[task].ready) throw appError('DOCTOR_FAILED', `${task} 不可用: ${media[task].hint}`, { data });
    return data;
}

export async function mediaImage(config, flags, deps = {}) {
    if (!flags.intent) throw appError('INVALID_INPUT', 'media:image 需要 --intent。');
    if (flags.session !== undefined || flags.inputFidelity !== undefined) {
        throw appError('INVALID_INPUT', '图片生成已移除 --session 和 --input-fidelity 参数。');
    }
    // 质量选项由所选适配器校验。
    const options = Object.fromEntries(Object.entries({
        quality: flags.imageQuality,
    }).filter(([, value]) => value !== undefined));
    const { entry, provider, request } = await prepareRequest(config, 'image', {
        intent: flags.intent,
        images: flags.image,
        size: flags.size,
        outPath: flags.out,
        require: flags.require,
        options,
    }, deps);
    if (provider.execution !== 'program') throw appError('MEDIA_AGENT_REQUIRED', `请由 Agent 按 ${SKILL_DIR}/${provider.guide} 生成图片。`);
    const result = await validateMediaFileResult(await provider.generateImage(entry.settings, request,
        { ...deps, env: config.env ?? process.env }), provider);
    return { command: 'media:image', provider: result.provider, path: result.path, sourcePath: result.sourcePath };
}

export async function mediaVideo(config, flags = {}, deps = {}) {
    if (Boolean(flags.request) === Boolean(flags.taskId)) throw appError('INVALID_INPUT', 'media:video 需要 --request <需求.json> 或 --task-id <已有任务ID>，二者不能同时使用。');
    let entry;
    let provider;
    let request;
    if (flags.taskId) {
        ({ entry, provider } = selected(config, 'video', deps));
        request = { outPath: flags.out ? workspacePath(config, flags.out) : undefined };
        if (flags.require) throw appError('INVALID_INPUT', '继续查询任务时不能添加新的能力要求。');
    } else {
        let input;
        try { input = JSON.parse(await fs.readFile(workspacePath(config, flags.request), 'utf8')); }
        catch (error) { throw appError(error.code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_INPUT', '无法读取视频需求 JSON。'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw appError('INVALID_INPUT', '视频需求必须是 JSON 对象。');
        if (input.require !== undefined && !Array.isArray(input.require)) throw appError('INVALID_INPUT', 'require 必须是能力名称数组。');
        ({ entry, provider, request } = await prepareRequest(config, 'video', {
            ...input, ...(flags.out ? { outPath: flags.out } : {}),
            require: [...(input.require ?? []), ...(flags.require ?? [])],
        }, deps));
    }
    if (provider.execution !== 'program') throw appError('MEDIA_AGENT_REQUIRED', `请由 Agent 按 ${SKILL_DIR}/${provider.guide} 生成或查询视频。`);
    const context = { ...deps, env: config.env ?? process.env };
    let raw;
    if (flags.taskId) {
        if (!provider.resumeVideo) throw appError('MEDIA_CAPABILITY_UNSUPPORTED', '所选视频适配器不支持按任务 ID 继续查询。');
        raw = await provider.resumeVideo(entry.settings, flags.taskId, request, context);
    } else raw = await provider.generateVideo(entry.settings, request, context);
    const result = await validateMediaFileResult(raw, provider);
    return { command: 'media:video', provider: result.provider, path: result.path, taskId: result.taskId };
}

export async function mediaTranscribe(config, { slug, from, id, language, force, require: required } = {}, deps = {}) {
    if (!from) throw appError('INVALID_INPUT', 'media:transcribe 需要 --from <audio>。');
    const { dir } = await openProduction(config, slug);
    const audio = workspacePath(config, from);
    const transcriptId = id || path.basename(audio, path.extname(audio));
    if (!ID_RE.test(transcriptId)) throw appError('INVALID_INPUT', `转写 id 不合法: ${transcriptId}（用 --id 指定）`);
    const { entry, provider, request } = await prepareRequest(config, 'transcribe', { file: audio, language, require: required }, deps);
    if (provider.execution !== 'program') throw appError('MEDIA_AGENT_REQUIRED', `请由 Agent 按 ${SKILL_DIR}/${provider.guide} 转写。`);
    const target = path.join(dir, 'assets', `${transcriptId}.transcript.json`);
    if (!force) {
        try {
            await fs.access(target);
            throw appError('ALREADY_EXISTS', `转写已存在: ${path.relative(config.workspace, target)}（--force 覆盖）`);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    const json = validateTranscriptResult(await provider.transcribe(entry.settings, request,
        { ...deps, env: config.env ?? process.env }), request);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(json, null, 2)}\n`);
    return {
        command: 'media:transcribe',
        slug,
        provider: provider.ledgerProviders[0],
        path: path.relative(config.workspace, target).split(path.sep).join('/'),
        next: `remake captions ${slug} --from assets/${transcriptId}.transcript.json`,
    };
}

export async function mediaLand(config, { slug, kind, from, intent, provider, id } = {}) {
    if (!KIND_PREFIX[kind]) throw appError('INVALID_INPUT', 'media:land 需要 --kind image|video|audio。');
    await openProduction(config, slug);
    const landed = land({
        workspace: config.workspace,
        slug,
        kind,
        from: from ? workspacePath(config, from) : from,
        intent,
        provider,
        id,
    });
    return {
        command: 'media:land', slug, id: landed.id, path: landed.path, provider: landed.provider, html: landed.html,
        next: `remake video:add ${slug} --id ${landed.id}`,
    };
}

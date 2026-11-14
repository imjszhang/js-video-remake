import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { appError } from './errors.js';
import { resolveConfig } from './config.js';
import { resolveVideo, getTemplateEditor, getTemplateCaptions, saveTemplateCaptions, getTemplateVoice, getTemplateVoiceAsset, saveTemplateInputs, storeTemplateAsset, runTemplateAction, saveVideoStyle, getTemplatePromptScript } from './videos.js';

import { probeTemplateProvider } from './template-provider-probe.js';
import { saveTemplateProvider } from './template-providers.js';
import { templateAgentOptions } from './template-agent.js';
import { executeAgent } from './agent.js';
import { appendJobLog, eventLog } from './template-job-log.js';

const ACTIONS = new Set(['prepare', 'check', 'preview', 'compose', 'fork', 'remix', 'export', 'generate', 'voice']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const INPUT_LIMIT = 2 * 1024 * 1024;
const MEDIA_LIMIT = 1024 * 1024 * 1024;

function json(response, status, body, head = false) {
    const data = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    response.end(head ? undefined : data);
}

async function readJson(request) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw appError('INVALID_INPUT', '请求需要 JSON 内容。');
    const chunks = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > INPUT_LIMIT) { request.resume(); throw appError('TOO_LARGE', '填写内容不能超过 2 MiB。'); }
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw appError('INVALID_INPUT', '填写内容不是有效的 JSON。'); }
}

/** Package scripts run only after a same-origin explicit action; arbitrary HTML is never served. */
export function createTemplateController({ root, deps = {}, sendAsset }) {
    const config = resolveConfig({ workspace: root });
    const active = new Map();
    const mutations = new Set();
    const jobs = new Map();
    let closing = false;
    let savingProvider = false;
    const keyFor = ({ slug, name }) => `${slug}/${name}`;
    async function jobFile({ slug, name }, create = false) {
        let directory = await fs.realpath(root);
        for (const segment of ['productions', slug, 'drafts', '.template-jobs']) {
            directory = path.join(directory, segment);
            let stat;
            try { stat = await fs.lstat(directory); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                if (!create) return null;
                try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
                stat = await fs.lstat(directory);
            }
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw appError('VIDEO_INVALID', '任务状态目录必须位于当前制作内，不能使用符号链接。');
        }
        const file = path.join(directory, `${name}.json`);
        try {
            const stat = await fs.lstat(file);
            if (stat.isSymbolicLink() || !stat.isFile()) throw appError('VIDEO_INVALID', '任务状态必须是当前制作内的普通文件。');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return file;
    }

    async function persist(job, options) {
        const file = await jobFile(options, true);
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
    }

    async function currentJob(options) {
        const running = active.get(keyFor(options));
        if (running) return running.job;
        try {
            const file = await jobFile(options);
            if (!file) return null;
            const job = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!TERMINAL.has(job.status)) {
                job.status = 'failed'; job.stage = 'interrupted'; job.message = '服务已重启，上次任务中断，请重新运行。'; job.error = job.message;
                job.finishedAt = new Date().toISOString();
                appendJobLog(job, { kind: 'error', text: job.message });
                await persist(job, options);
            }
            if (job.action === 'generate' && !job.logs && job.agentRunId && TERMINAL.has(job.status)) {
                try {
                    const retained = await executeAgent(config, 'logs', { runId: job.agentRunId, stream: 'events', lines: 1000 });
                    for (const line of retained.text.split('\n')) {
                        let event;
                        try { event = JSON.parse(line); } catch { continue; }
                        const entry = eventLog(event);
                        if (entry) appendJobLog(job, { ...entry, time: event.time });
                    }
                    if (job.logs?.length) {
                        appendJobLog(job, { kind: job.status === 'failed' ? 'error' : 'status', text: job.message, time: job.finishedAt });
                        job.logsRecovered = true;
                        await persist(job, options);
                    }
                } catch { /* Older jobs may not have retained runtime records. */ }
            }
            jobs.set(job.id, { job, key: keyFor(options) });
            return job;
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }

    async function editorJob(options) {
        const own = await currentJob(options);
        if (own) return own;
        const file = await jobFile(options);
        if (!file) return null;
        // A generated version can show its originating job after a page reload.
        for (const name of await fs.readdir(path.dirname(file))) {
            if (!/^[a-z0-9-]+-v[0-9]+\.json$/.test(name)) continue;
            const source = { slug: options.slug, name: name.slice(0, -5) };
            const saved = JSON.parse(await fs.readFile(await jobFile(source), 'utf8'));
            if (saved.status === 'succeeded' && saved.result?.video === options.name) return saved;
        }
        return null;
    }

    function assertIdle(options) {
        if ([...active.values()].some(entry => entry.job.action === 'generate')) throw appError('TEMPLATE_BUSY', 'Agent 正在生成新模板，请等待完成或取消后再修改。');
        if (active.has(keyFor(options)) || mutations.has(keyFor(options))) throw appError('TEMPLATE_BUSY', '这个模板正在处理，请等待完成或取消任务后再修改。');
    }

    async function withPackageLock(options, operation) {
        if (closing) throw appError('TEMPLATE_BUSY', '服务正在关闭，请稍后重试。');
        assertIdle(options);
        const key = keyFor(options);
        mutations.add(key);
        try { return await operation(); }
        finally { mutations.delete(key); }
    }

    async function startJob(options, body) {
        if (closing) throw appError('TEMPLATE_BUSY', '服务正在关闭，请稍后重试。');
        if (!ACTIONS.has(body?.action)) throw appError('INVALID_INPUT', '不支持的模板操作。');
        assertIdle(options);
        if (active.size || mutations.size) throw appError('TEMPLATE_BUSY', '另一个模板正在处理，请完成后再开始新的任务。');
        mutations.add(keyFor(options));
        try {
            const editor = await getTemplateEditor(config, options);
            if (editor.frozen && !['fork', 'check', 'remix', 'export', 'generate'].includes(body.action)) throw appError('VIDEO_FROZEN', '这个版本已生成成片，请复制为新版本后继续编辑。');
            const job = { id: randomUUID(), action: body.action, status: 'running', stage: 'starting', message: '任务已开始', startedAt: new Date().toISOString(), result: null, error: null };
            if (body.action === 'generate') {
                if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000 || body.prompt.includes('\0')) throw appError('INVALID_INPUT', '请填写 1–12000 字的模板修改要求。');
                if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 160) throw appError('INVALID_INPUT', '请填写 1–160 字的新模板名称。');
                if (body.subtitleScript !== undefined && (typeof body.subtitleScript !== 'string' || body.subtitleScript.length > 30000 || body.subtitleScript.includes('\0'))) throw appError('INVALID_INPUT', '新字幕原稿需要是最多 30000 字的文本。');
                if (body.mode !== undefined && !['derive', 'revise'].includes(body.mode)) throw appError('INVALID_INPUT', '生成方式只能是 derive 或 revise。');
                Object.assign(job, { prompt: body.prompt, subtitleScript: body.subtitleScript, title: body.title, target: body.target, providerTarget: body.providerTarget, model: body.model, mode: body.mode || 'derive' });
            }
            appendJobLog(job, { kind: 'status', text: '任务已在服务端启动，刷新或关闭网页不会取消。服务关闭或重启会中断任务。' });
            const abort = new AbortController();
            const entry = { job, abort, key: keyFor(options), promise: null };
            active.set(entry.key, entry);
            jobs.set(job.id, entry);
            try { await persist(job, options); }
            catch (error) { active.delete(entry.key); jobs.delete(job.id); throw error; }
            entry.promise = (async () => {
                let completion;
                try {
                    const result = await runTemplateAction(config, { ...options, action: body.action, at: body.at, title: body.title, style: body.style, prompt: body.prompt, subtitleScript: body.subtitleScript, target: body.target, providerTarget: body.providerTarget, model: body.model, mode: body.mode, voice: body.voice, language: body.language, revision: body.revision, reference: body.reference, referenceText: body.referenceText }, {
                        ...deps, signal: abort.signal,
                        onAgentEvent: async event => {
                            const line = eventLog(event);
                            if (line) { appendJobLog(job, line); await persist(job, options); }
                        },
                        onProgress: async ({ stage, message, agentRunId }) => {
                            job.stage = stage; job.message = message;
                            appendJobLog(job, { kind: 'progress', text: message });
                            if (agentRunId) job.agentRunId = agentRunId;
                            await persist(job, options);
                        },
                    });
                    // A completed registration/fork has committed its result. Cancellation
                    // cannot retroactively turn that successful commit into a cancelled job.
                    completion = { result, status: 'succeeded', message: '已完成' };
                } catch (error) {
                    const status = abort.signal.aborted ? 'cancelled' : 'failed';
                    completion = { status, error: error.message, message: status === 'cancelled' ? '任务已取消' : error.message,
                        report: error.data?.report || error.report || null,
                        ...(error.data?.agentRunId ? { agentRunId: error.data.agentRunId } : {}) };
                } finally {
                    const finished = { ...job, ...completion, logs: [...(job.logs || [])], finishedAt: new Date().toISOString() };
                    appendJobLog(finished, { kind: finished.status === 'failed' ? 'error' : 'status', text: finished.message });
                    try { await persist(finished, options); }
                    catch { finished.error ||= '任务已结束，但状态未能保存。'; }
                    // A visible terminal state must mean the package can accept new work.
                    // Keep the running object unchanged during asynchronous persistence.
                    Object.assign(job, finished);
                    active.delete(entry.key);
                }
            })();
            return { ...job };
        } finally { mutations.delete(keyFor(options)); }
    }

    return {
        withPackageLock,
        async handle(request, response, url) {
            const match = /^\/api\/projects\/([a-z0-9-]+)\/templates\/([a-z0-9-]+-v[0-9]+)\/(editor|captions(?:\/original)?|prompt|voice(?:\/audio)?|providers(?:\/test|\/models)?|inputs|style|assets|jobs(?:\/[a-f0-9-]+(?:\/cancel)?)?|preview\/[^/]+)$/.exec(url.pathname);
            if (!match) return false;
            const options = { slug: match[1], name: match[2] };
            const route = match[3], method = request.method;
            const head = method === 'HEAD';
            try {
                if (!['GET', 'HEAD'].includes(method) && (request.headers['x-remake-action'] !== 'template' || request.headers['sec-fetch-site'] === 'cross-site')) {
                    request.resume(); json(response, 403, { error: '请从模板项目页进行操作。' }); return true;
                }
                if (route === 'editor' && ['GET', 'HEAD'].includes(method)) {
                    const editor = await getTemplateEditor(config, options);
                    json(response, 200, { ...editor, job: await editorJob(options) }, head);
                } else if (route === 'voice' && ['GET', 'HEAD'].includes(method)) {
                    json(response, 200, await getTemplateVoice(config, options, deps), head);
                } else if (route === 'voice/audio' && ['GET', 'HEAD'].includes(method)) {
                    await sendAsset(request, response, await getTemplateVoiceAsset(config, options), url.searchParams.get('download') === '1');
                } else if (route === 'captions' && ['GET', 'HEAD'].includes(method)) {
                    json(response, 200, await getTemplateCaptions(config, options), head);
                } else if (route === 'prompt' && ['GET', 'HEAD'].includes(method)) {
                    const script = await getTemplatePromptScript(config, {
                        ...options,
                        format: url.searchParams.get('format') || 'txt',
                        language: url.searchParams.get('language') || 'zh',
                    });
                    const data = Buffer.from(script.content, 'utf8');
                    response.writeHead(200, {
                        'Content-Type': script.contentType,
                        'Content-Disposition': `attachment; filename="${script.filename}"`,
                        'Content-Length': data.length, 'Cache-Control': 'no-store',
                    });
                    response.end(head ? undefined : data);
                } else if (route === 'captions/original' && ['GET', 'HEAD'].includes(method)) {
                    const captions = await getTemplateCaptions(config, { ...options, originalOnly: true });
                    if (!captions.supported) throw appError('VIDEO_INVALID', captions.reason);
                    const data = `${JSON.stringify(captions.original.map(({ at, zh, en }) => ({ at, zh, en })), null, 2)}\n`;
                    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${options.name}-captions-original.json"`, 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
                    response.end(head ? undefined : data);
                } else if (route === 'captions' && method === 'PUT') {
                    const body = await readJson(request);
                    json(response, 200, await withPackageLock(options, () => saveTemplateCaptions(config, { ...options, rows: body?.rows, revision: body?.revision, inputs: body?.inputs })));
                } else if (['providers/test', 'providers/models'].includes(route) && method === 'POST') {
                    const body = await readJson(request);
                    await getTemplateEditor(config, options);
                    json(response, 200, await probeTemplateProvider(config, body, deps));
                } else if (route === 'providers' && method === 'PUT') {
                    const body = await readJson(request);
                    if (savingProvider) throw appError('TEMPLATE_BUSY', '另一个 Provider 正在保存，请稍后重试。');
                    savingProvider = true;
                    let result;
                    try { result = await withPackageLock(options, async () => {
                        await getTemplateEditor(config, options);
                        const choices = await templateAgentOptions(config, deps);
                        return saveTemplateProvider(config, body, (choices.providers || []).map(item => item.id));
                    }); } finally { savingProvider = false; }
                    json(response, 200, result);
                } else if (route === 'style' && method === 'PUT') {
                    const body = await readJson(request);
                    assertIdle(options); mutations.add(keyFor(options));
                    try { json(response, 200, await saveVideoStyle(config, { ...options, style: body?.style })); }
                    finally { mutations.delete(keyFor(options)); }
                } else if (route === 'inputs' && method === 'PUT') {
                    const body = await readJson(request);
                    assertIdle(options); mutations.add(keyFor(options));
                    try { json(response, 200, await saveTemplateInputs(config, { ...options, inputs: body?.inputs })); }
                    finally { mutations.delete(keyFor(options)); }
                } else if (route === 'assets' && method === 'POST') {
                    assertIdle(options); mutations.add(keyFor(options));
                    let temporary;
                    try {
                        const editor = await getTemplateEditor(config, options);
                        if (editor.frozen) throw appError('VIDEO_FROZEN', '这个版本已生成成片，请复制为新版本后上传素材。');
                        if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw appError('INVALID_INPUT', '请上传素材文件。');
                        const kind = url.searchParams.get('kind');
                        if (!['presenter', 'voice', 'music', 'captions', 'texts'].includes(kind) || !Object.hasOwn(editor.schema, kind)) throw appError('INVALID_INPUT', '模板不支持这类素材。');
                        const limit = ['captions', 'texts'].includes(kind) ? INPUT_LIMIT : MEDIA_LIMIT;
                        if (Number(request.headers['content-length']) > limit) throw appError('TOO_LARGE', '素材文件超过上传限制（影音 1 GiB，文字 2 MiB）。');
                        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-template-asset-'));
                        const file = path.join(temporary, 'upload');
                        const handle = await fs.open(file, 'wx');
                        let size = 0;
                        try {
                            for await (const chunk of request.iterator({ destroyOnReturn: false })) {
                                size += chunk.length;
                                if (size > limit) throw appError('TOO_LARGE', '素材文件超过上传限制（影音 1 GiB，文字 2 MiB）。');
                                await handle.writeFile(chunk);
                            }
                        } finally { await handle.close(); }
                        if (!size) throw appError('INVALID_INPUT', '素材文件为空。');
                        json(response, 201, await storeTemplateAsset(config, { ...options, file, kind, filename: url.searchParams.get('filename') }));
                    } finally {
                        request.resume();
                        mutations.delete(keyFor(options));
                        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
                    }
                } else if (route === 'jobs' && method === 'POST') {
                    json(response, 202, await startJob(options, await readJson(request)));
                } else if (route.startsWith('jobs/') && ['GET', 'HEAD', 'POST'].includes(method)) {
                    const [, id, action] = route.split('/');
                    await getTemplateEditor(config, options);
                    let entry = jobs.get(id);
                    if (!entry) { await currentJob(options); entry = jobs.get(id); }
                    if (!entry || entry.key !== keyFor(options)) throw appError('NOT_FOUND', '找不到这次任务。');
                    if (action === 'cancel' && method === 'POST') {
                        entry.abort?.abort();
                        json(response, 200, entry.job);
                    } else if (!action && ['GET', 'HEAD'].includes(method)) json(response, 200, entry.job, head);
                    else json(response, 405, { error: '不支持此操作。' });
                } else if (route.startsWith('preview/') && ['GET', 'HEAD'].includes(method)) {
                    const filename = decodeURIComponent(route.slice('preview/'.length));
                    if (!/^[a-zA-Z0-9_.-]+\.(png|jpg|jpeg|webp)$/.test(filename)) throw appError('NOT_FOUND', '预览图片不存在。');
                    const pkg = await resolveVideo(config, options.slug, options.name);
                    const base = await fs.realpath(pkg.dir);
                    const expectedPackage = path.join(await fs.realpath(root), 'productions', options.slug, 'videos', options.name);
                    if (base !== expectedPackage || pkg.manifest.template?.format !== 'video-template@1') throw appError('NOT_FOUND', '预览图片不存在。');
                    const expected = path.join(base, '.work', 'preview', filename);
                    if (await fs.realpath(expected) !== expected) throw appError('NOT_FOUND', '预览图片不存在。');
                    await sendAsset(request, response, { path: expected, name: filename, type: filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }, false);
                } else json(response, 405, { error: '不支持此操作。' });
            } catch (error) {
                request.resume();
                if (!response.destroyed && !response.headersSent) {
                    const status = ['NOT_FOUND', 'ENOENT'].includes(error.code) ? 404 : ['TEMPLATE_BUSY', 'VIDEO_FROZEN', 'TEMPLATE_CAPTIONS_CONFLICT'].includes(error.code) ? 409 : error.code === 'TOO_LARGE' ? 413 : 400;
                    json(response, status, { error: error.message, report: error.data?.report || error.report || null }, head);
                }
            }
            return true;
        },
        close() {
            closing = true;
            const entries = [...active.values()];
            for (const entry of entries) entry.abort.abort();
            return Promise.allSettled(entries.map(entry => entry.promise));
        },
    };
}

import { randomUUID } from 'node:crypto';
import { appError } from './errors.js';
import { resolveConfig } from './config.js';
import { listReferences, importReference } from './references.js';
import { readWebLibrary } from './web-library.js';
import { scanReferences } from './reference-scan.js';
import { startProduction } from './start.js';
import { downloadDoctor, downloadReference } from './downloads/index.js';

const BODY_LIMIT = 64 * 1024;
const ROOT = '/api/references';
const READ_ROUTES = new Set([ROOT, `${ROOT}/download/doctor`, `${ROOT}/jobs`]);
const WRITE_ROUTES = new Set(['import', 'scan', 'scan/import', 'start', 'download'].map(action => `${ROOT}/${action}`));

function json(response, status, body, head = false) {
    if (response.destroyed || response.writableEnded) return;
    const output = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(output), 'Cache-Control': 'no-store' });
    response.end(head ? undefined : output);
}

function assertAction(request) {
    if (request.headers['x-remake-action'] !== 'references' || request.headers['sec-fetch-site'] === 'cross-site') {
        throw appError('FORBIDDEN', '请从参考视频页面发起操作。');
    }
    const origin = request.headers.origin;
    if (origin) {
        try {
            const parsed = new URL(origin);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== request.headers.host) throw new Error();
        } catch { throw appError('FORBIDDEN', '请求来源与当前网页不一致。'); }
    }
}

async function readJson(request) {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw appError('UNSUPPORTED_MEDIA', '请求需要 JSON 内容。');
    }
    if (Number(request.headers['content-length']) > BODY_LIMIT) throw appError('TOO_LARGE', '填写内容不能超过 64 KiB。');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > BODY_LIMIT) throw appError('TOO_LARGE', '填写内容不能超过 64 KiB。');
        chunks.push(chunk);
    }
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        return body;
    } catch { throw appError('INVALID_INPUT', '填写内容不是有效的 JSON 对象。'); }
}

function text(value, name, optional = false) {
    if (optional && value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 8192) {
        throw appError('INVALID_INPUT', `请填写有效的${name}。`);
    }
    return value.trim();
}

function scanOptions(body, importing) {
    if (body.recursive !== undefined && typeof body.recursive !== 'boolean') throw appError('INVALID_INPUT', '包含子文件夹选项无效。');
    if (importing && (!Array.isArray(body.select) || !body.select.length || body.select.some(value => typeof value !== 'string'))) {
        throw appError('INVALID_INPUT', '请先选择至少一个扫描到的视频。');
    }
    return { directory: text(body.directory, '文件夹路径'), recursive: body.recursive ?? false,
        import: importing, select: importing ? body.select : [] };
}

function downloadOptions(body) {
    let url;
    try {
        url = new URL(text(body.url, '视频链接'));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { throw appError('INVALID_INPUT', '视频链接必须是无用户名和密码的 HTTP(S) URL。'); }
    const quality = body.quality ?? '1080';
    if (!['720', '1080'].includes(quality)) throw appError('INVALID_INPUT', '下载清晰度只支持 720 或 1080。');
    return { url: url.href, quality };
}

function errorStatus(error) {
    if (error.code === 'FORBIDDEN') return 403;
    if (error.code === 'TOO_LARGE') return 413;
    if (error.code === 'UNSUPPORTED_MEDIA') return 415;
    if (error.code === 'NOT_FOUND') return 404;
    if (error.code === 'SERVICE_CLOSING') return 503;
    if (['DOWNLOAD_BUSY', 'ALREADY_EXISTS', 'REFERENCE_CONFLICT'].includes(error.code)) return 409;
    return 400;
}

/** Local paths are supplied explicitly; catalog writes share the web server queue. */
export function createReferenceController({ root, deps = {} }) {
    const env = deps.env ?? process.env;
    const config = resolveConfig({ workspace: root }, env, root);
    const jobs = new Map();
    let active;
    let closing = false;
    let queue = Promise.resolve();
    const localQueue = operation => {
        const pending = queue.then(operation);
        queue = pending.catch(() => {});
        return pending;
    };
    const assertOpen = () => {
        if (closing) throw appError('SERVICE_CLOSING', '服务正在关闭，请稍后重试。');
    };
    const withWrite = operation => (deps.withCatalogWrite || localQueue)(() => {
        assertOpen();
        return operation();
    });

    function trimJobs() {
        const completed = [...jobs.values()].filter(entry => entry.job.status !== 'running');
        for (const entry of completed.slice(0, Math.max(0, completed.length - 20))) jobs.delete(entry.job.id);
    }

    function startDownload(options) {
        assertOpen();
        if (active) throw appError('DOWNLOAD_BUSY', '已有视频正在下载，请等待完成后再开始。');
        const job = { id: randomUUID(), status: 'running', ...options, createdAt: new Date().toISOString() };
        const entry = { job, abort: new AbortController(), promise: null };
        jobs.set(job.id, entry);
        active = entry;
        entry.promise = (async () => {
            try {
                job.result = await downloadReference(config, options, { ...deps, env, signal: entry.abort.signal, withCatalogWrite: withWrite });
                job.status = 'succeeded';
            } catch (error) {
                job.status = 'failed';
                job.error = { message: error.message || '下载失败，请重试。', code: error.code || 'DOWNLOAD_FAILED',
                    ...(error.data ? { data: error.data } : {}) };
            } finally {
                job.finishedAt = new Date().toISOString();
                if (active === entry) active = null;
                trimJobs();
            }
        })();
        return job;
    }

    async function handle(request, response, url) {
        const pathname = url.pathname;
        if (pathname !== ROOT && !pathname.startsWith(`${ROOT}/`)) return false;
        const head = request.method === 'HEAD';
        const jobMatch = /^\/api\/references\/jobs\/([a-f0-9-]+)$/.exec(pathname);
        const isRead = READ_ROUTES.has(pathname) || Boolean(jobMatch);
        const isWrite = WRITE_ROUTES.has(pathname);
        try {
            if (!isRead && !isWrite) {
                request.resume();
                json(response, 404, { error: '参考视频接口不存在。', code: 'NOT_FOUND' }, head);
                return true;
            }
            if (isRead ? !['GET', 'HEAD'].includes(request.method) : request.method !== 'POST') {
                request.resume();
                response.setHeader('Allow', isRead ? 'GET, HEAD' : 'POST');
                json(response, 405, { error: '此接口不支持该请求方式。', code: 'METHOD_NOT_ALLOWED' }, head);
                return true;
            }
            if (pathname === ROOT) {
                const result = await listReferences(config);
                const library = await readWebLibrary(root, { env });
                const media = new Map((library.referenceMedia || []).map(item => [item.id, item]));
                for (const item of result.references) {
                    item.videoUrl = media.get(item.id)?.url || null;
                    item.posterUrl = media.get(item.id)?.poster || null;
                }
                json(response, 200, result, head);
            }
            else if (pathname === `${ROOT}/download/doctor`) json(response, 200, await downloadDoctor(config, { ...deps, env }), head);
            else if (pathname === `${ROOT}/jobs`) json(response, 200, { jobs: [...jobs.values()].map(entry => entry.job).reverse() }, head);
            else if (jobMatch) {
                const entry = jobs.get(jobMatch[1]);
                if (!entry) throw appError('NOT_FOUND', '下载任务不存在，服务重启后需重新读取参考清单。');
                json(response, 200, { job: entry.job }, head);
            } else {
                assertOpen();
                assertAction(request);
                const body = await readJson(request);
                assertOpen();
                if (pathname === `${ROOT}/import`) {
                    const options = { file: text(body.file, '视频文件路径', true), manifest: text(body.manifest, '清单路径', true),
                        id: text(body.id, '参考标识', true), title: text(body.title, '标题', true) };
                    if (body.assetRoot !== undefined && !options.manifest) throw appError('INVALID_INPUT', '素材根目录仅用于清单导入。');
                    const selectedConfig = body.assetRoot === undefined ? config
                        : resolveConfig({ workspace: root, assetRoot: text(body.assetRoot, '素材根目录') }, env, root);
                    json(response, 201, await withWrite(() => importReference(selectedConfig, options)));
                } else if (pathname === `${ROOT}/scan`) {
                    json(response, 200, await scanReferences(config, scanOptions(body, false)));
                } else if (pathname === `${ROOT}/scan/import`) {
                    const options = scanOptions(body, true);
                    json(response, 201, await withWrite(() => scanReferences(config, options)));
                } else if (pathname === `${ROOT}/start`) {
                    const referenceId = text(body.referenceId, '参考标识');
                    const slug = text(body.slug, '制作标识');
                    const result = await withWrite(async () => {
                        const reference = (await listReferences(config)).references.find(item => item.id === referenceId);
                        if (!reference) throw appError('NOT_FOUND', '参考视频不存在，请刷新清单。');
                        if (!reference.available) throw appError('SOURCE_ASSET_MISSING', '原片当前不可用，请恢复文件后再创建制作。');
                        return startProduction(config, { refId: referenceId, slug });
                    });
                    json(response, 201, result);
                } else if (pathname === `${ROOT}/download`) {
                    json(response, 202, { job: startDownload(downloadOptions(body)) });
                }
            }
        } catch (error) {
            request.resume();
            json(response, errorStatus(error), { error: error.message || '操作失败，请重试。', code: error.code || 'FAILED',
                ...(error.data ? { data: error.data } : {}) }, head);
        }
        return true;
    }

    let shutdown;
    return { handle, close() {
        if (!shutdown) {
            closing = true;
            active?.abort.abort();
            shutdown = Promise.allSettled([active?.promise, queue]);
        }
        return shutdown;
    } };
}

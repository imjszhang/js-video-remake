import { readCatalog, writeCatalog } from './catalog.js';
import { listVideos, packVideo, unpackVideo } from './videos.js';
import { resolveConfig } from './config.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { readWebLibrary } from './web-library.js';
import { createReproController } from './repro/web.js';
import { createReferenceController } from './reference-web.js';
import { createTemplateController } from './template-web.js';

const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
    ['/ui.js', ['ui.js', 'text/javascript; charset=utf-8']],
    ['/state.js', ['state.js', 'text/javascript; charset=utf-8']],
    ['/library.js', ['library.js', 'text/javascript; charset=utf-8']],
    ['/playback.js', ['playback.js', 'text/javascript; charset=utf-8']],
    ['/projects.js', ['projects.js', 'text/javascript; charset=utf-8']],
    ['/templates.js', ['templates.js', 'text/javascript; charset=utf-8']],
    ['/library-model.js', ['library-model.js', 'text/javascript; charset=utf-8']],
    ['/comparison.js', ['comparison.js', 'text/javascript; charset=utf-8']],
    ['/versions.js', ['versions.js', 'text/javascript; charset=utf-8']],
    ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']],
    ['/caption-editor.js', ['caption-editor.js', 'text/javascript; charset=utf-8']],
    ['/voice-editor.js', ['voice-editor.js', 'text/javascript; charset=utf-8']],
    ['/template-editor.js', ['template-editor.js', 'text/javascript; charset=utf-8']],
    ['/references', ['references.html', 'text/html; charset=utf-8']],
    ['/references.html', ['references.html', 'text/html; charset=utf-8']],
    ['/references.js', ['references.js', 'text/javascript; charset=utf-8']],
    ['/references.css', ['references.css', 'text/css; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/navigation.css', ['navigation.css', 'text/css; charset=utf-8']],
    ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
    ['/repro', ['repro.html', 'text/html; charset=utf-8']],
    ['/repro.html', ['repro.html', 'text/html; charset=utf-8']],
    ['/repro.js', ['repro.js', 'text/javascript; charset=utf-8']],
    ['/repro.css', ['repro.css', 'text/css; charset=utf-8']],
]);

/** 前端静态资源的唯一清单；页面里的 <script>/<link> 必须在这里登记。 */
export const WEB_ASSETS = staticFiles;

export function parseByteRange(header, size) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2]) || size === 0) return false;
    let start;
    let end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
        end = Math.min(end, size - 1);
    }
    return { start, end };
}

function json(response, status, body, head = false) {
    const output = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(output), 'Cache-Control': 'no-store' });
    response.end(head ? undefined : output);
}

async function sendMedia(request, response, asset, download) {
    // Recheck the resolved file on every request, including after a catalog refresh.
    if (await fs.realpath(asset.path) !== asset.path) return json(response, 404, { error: '媒体不存在。' }, request.method === 'HEAD');
    const file = await fs.open(asset.path, 'r');
    let streamed = false;
    try {
        const stat = await file.stat();
        if (!stat.isFile()) return json(response, 404, { error: '媒体不存在。' }, request.method === 'HEAD');
        const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
        const range = request.headers['if-range'] && request.headers['if-range'] !== etag
            ? null : parseByteRange(request.headers.range, stat.size);
        const headers = {
            'Content-Type': asset.type,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-cache',
            'ETag': etag,
            'Last-Modified': stat.mtime.toUTCString(),
        };
        if (download) {
            const fallback = asset.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            headers['Content-Disposition'] = `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/'/g, '%27')}`;
        }
        if (range === false) {
            response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
            response.end();
            return;
        }
        if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
        headers['Content-Length'] = range ? range.end - range.start + 1 : stat.size;
        response.writeHead(range ? 206 : 200, headers);
        if (request.method === 'HEAD' || stat.size === 0) { response.end(); return; }
        const stream = file.createReadStream(range || {});
        streamed = true;
        try { await pipeline(stream, response); }
        catch (error) {
            if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ABORT_ERR'].includes(error.code)) throw error;
        }
    } finally { if (!streamed) await file.close(); }
}

/** The gateway strips /remake/; every frontend URL is relative to that mount. */
export function createWebServer({ root = process.cwd(), reproDeps, reproConfig, templateDeps, referenceDeps } = {}) {
    const workspace = path.resolve(root);
    const reproduction = createReproController({ root: workspace, config: reproConfig, deps: reproDeps, sendAsset: sendMedia });
    let catalogQueue = Promise.resolve();
    const withCatalogWrite = operation => {
        const pending = catalogQueue.then(operation);
        catalogQueue = pending.catch(() => {});
        return pending;
    };
    const templates = createTemplateController({ root: workspace, deps: { ...templateDeps, withCatalogWrite }, sendAsset: sendMedia });
    const references = createReferenceController({ root: workspace, deps: { ...referenceDeps, withCatalogWrite } });
    const server = http.createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'same-origin');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; base-uri 'self'; frame-ancestors 'self'");
        try {
            const url = new URL(request.url, 'http://localhost');
            const head = request.method === 'HEAD';
            if (await references.handle(request, response, url)) return;
            if (await reproduction.handle(request, response, url)) return;
            if (await templates.handle(request, response, url)) return;
            if (url.pathname === '/api/templates/import' && request.method === 'POST') {
                if (request.headers['x-remake-action'] !== 'import' || request.headers['sec-fetch-site'] === 'cross-site') {
                    request.resume();
                    return json(response, 403, { error: '请从项目页面导入模板。' });
                }
                if (request.headers['content-type']?.split(';')[0].trim() !== 'application/octet-stream') {
                    request.resume();
                    return json(response, 415, { error: '请选择 .video 模板文件。' });
                }
                const limit = 100 * 1024 * 1024;
                if (Number(request.headers['content-length']) > limit) {
                    request.resume();
                    return json(response, 413, { error: '模板文件不能超过 100 MiB。' });
                }
                let temporary;
                try {
                    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-upload-'));
                    const file = path.join(temporary, 'template.video');
                    const handle = await fs.open(file, 'wx');
                    let size = 0;
                    try {
                        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
                            size += chunk.length;
                            if (size > limit) {
                                request.resume();
                                return json(response, 413, { error: '模板文件不能超过 100 MiB。' });
                            }
                            await handle.writeFile(chunk);
                        }
                    } finally { await handle.close(); }
                    if (!size) return json(response, 400, { error: '模板文件为空，请重新选择。' });
                    const pending = withCatalogWrite(() => unpackVideo(resolveConfig({ workspace }), {
                        file, slug: url.searchParams.get('slug') || undefined,
                    }));
                    const result = await pending;
                    return json(response, 201, result);
                } catch (error) {
                    if (!response.destroyed) return json(response, error.code === 'ALREADY_EXISTS' ? 409 : 400, { error: error.message });
                } finally {
                    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
                }
                return;
            }
            const archive = /^\/api\/projects\/([a-z0-9-]+)\/(archive|restore)$/.exec(url.pathname);
            if (archive && request.method === 'POST') {
                if (request.headers['x-remake-action'] !== 'archive' || request.headers['sec-fetch-site'] === 'cross-site') {
                    return json(response, 403, { error: '请从项目页面操作归档。' });
                }
                try {
                    await withCatalogWrite(async () => {
                        const config = resolveConfig({ workspace });
                        const catalog = await readCatalog(config.catalogPath);
                        const project = catalog.productions.find(item => item.slug === archive[1]);
                        if (!project) return json(response, 404, { error: '项目不存在。' });
                        project.archived = archive[2] === 'archive';
                        await writeCatalog(config.catalogPath, catalog);
                        json(response, 200, { archived: project.archived });
                    });
                } catch (error) {
                    // 列表按宽松规则读取台账，写入则要求当前格式；格式不符时不改动台账。
                    if (error.code !== 'CATALOG_INVALID') throw error;
                    json(response, 409, { error: '台账不是当前格式，无法保存归档状态。请运行 remake doctor 查看原因。' });
                }
                return;
            }
            const pack = /^\/api\/projects\/([a-z0-9-]+)\/templates\/([a-z0-9-]+-v[0-9]+)$/.exec(url.pathname);
            if (pack && request.method === 'POST') {
                if (request.headers['x-remake-action'] !== 'pack' || request.headers['sec-fetch-site'] === 'cross-site') {
                    return json(response, 403, { error: '请从项目页面发起打包。' });
                }
                try {
                    const options = { slug: pack[1], name: pack[2] };
                    const result = await templates.withPackageLock(options, () => withCatalogWrite(() => packVideo(resolveConfig({ workspace }), options)));
                    return json(response, 200, result);
                } catch (error) {
                    return json(response, error.code === 'TEMPLATE_BUSY' ? 409 : 400, { error: error.message });
                }
            }
            if (!['GET', 'HEAD'].includes(request.method)) {
                response.setHeader('Allow', 'GET, HEAD');
                return json(response, 405, { error: '只支持读取。' });
            }
            if (url.pathname === '/api/health') return json(response, 200, { ok: true, service: 'video-remake' }, head);
            if (url.pathname === '/api/projects') {
                const { projects, warnings } = await readWebLibrary(workspace);
                for (const project of projects) {
                    const packages = await listVideos(path.join(workspace, 'productions', project.slug));
                    project.templatePackages = packages.filter(pkg => pkg.manifest.template?.format === 'video-template@1')
                        .map(pkg => ({ name: pkg.name, title: pkg.manifest.title || pkg.name, lineage: pkg.lineage }));
                }
                return json(response, 200, { projects, warnings }, head);
            }
            const staticFile = staticFiles.get(url.pathname);
            if (staticFile) {
                const output = await fs.readFile(path.join(workspace, 'web', staticFile[0]));
                response.writeHead(200, { 'Content-Type': staticFile[1], 'Content-Length': output.length, 'Cache-Control': 'no-cache' });
                return response.end(head ? undefined : output);
            }
            const match = /^\/media\/([a-f0-9]{32})$/.exec(url.pathname);
            if (match) {
                const { media } = await readWebLibrary(workspace);
                const asset = media.get(match[1]);
                if (asset) return await sendMedia(request, response, asset, url.searchParams.has('download'));
            }
            json(response, 404, { error: '页面或媒体不存在。' }, head);
        } catch (error) {
            if (response.destroyed) return;
            if (response.headersSent) { response.destroy(); return; }
            json(response, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? '文件不存在。' : '暂时无法读取视频目录。' }, request.method === 'HEAD');
        }
    });
    let shutdown;
    server.shutdownTasks = () => shutdown ||= Promise.allSettled([references.close(), reproduction.close(), templates.close()]);
    server.on('close', () => { void server.shutdownTasks(); });
    return server;
}

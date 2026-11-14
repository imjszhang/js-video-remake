#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveConfig } from '../src/config.js';
import { appError } from '../src/errors.js';
import { parseHubUrl, readHubToken } from '../src/media/mcp-hub.js';

export const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const ASSET_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const HELP = `MCP Hub 文件传输（只上传和下载，不提交生成任务）

node scripts/mcp-hub-files.js [--workspace DIR] [--url URL] [--token-file FILE] upload FILE
node scripts/mcp-hub-files.js [--workspace DIR] [--url URL] [--token-file FILE] download ASSET_ID --out FILE [--sha256 HASH]

默认读取 media.video 的 hubUrl、hubTokenFile；URL 为 /mcp/<服务ID> 地址。
令牌只从权限为 0600 的文件读取，不接受原始令牌参数或标准输入。
传输上限为 512 MiB；下载目录须已存在，已有文件不会覆盖。
下载校验 Content-Length；没有长度时必须提供 --sha256。
`;

function fail(code, message) {
    return appError(code, message);
}

function parseCli(argv) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
            workspace: { type: 'string' }, url: { type: 'string' }, 'token-file': { type: 'string' },
            out: { type: 'string' }, sha256: { type: 'string' }, help: { type: 'boolean', short: 'h' },
        } });
    } catch {
        throw fail('HUB_ARGUMENT_INVALID', '参数无效；使用 --help 查看用法。令牌只能通过 --token-file 指定文件。');
    }
    const { values, positionals } = parsed;
    if (values.help) return { help: true };
    const [action, input] = positionals;
    if (positionals.length !== 2 || !['upload', 'download'].includes(action) || !input
        || Object.values(values).some((value) => typeof value === 'string' && (!value.trim() || value.includes('\0')))
        || (action === 'upload' && (values.out !== undefined || values.sha256 !== undefined))
        || (action === 'download' && (!values.out || !ASSET_ID.test(input)))
        || (values.sha256 !== undefined && !SHA256.test(values.sha256))) {
        throw fail('HUB_ARGUMENT_INVALID', '参数无效；下载需要素材 ID 和 --out，校验值须为 SHA-256。使用 --help 查看用法。');
    }
    return { action, input, ...values };
}

function localPath(value, base) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(base, value);
}

async function privateToken(file) {
    // The shared reader checks token format; keep the file-permission contract at
    // this entry point too, including when used independently of media:doctor.
    let stat;
    try { stat = await fs.lstat(file); }
    catch { throw fail('HUB_TOKEN_INVALID', '无法读取 Hub 设备令牌文件。'); }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw fail('HUB_TOKEN_INVALID', 'Hub 设备令牌必须保存在权限为 0600 的普通文件中，不能使用符号链接。');
    }
    try { return await readHubToken(file); }
    catch { throw fail('HUB_TOKEN_INVALID', 'Hub 设备令牌文件无效；需要一条有效设备令牌。'); }
}

async function cancelBody(response) {
    await response?.body?.cancel().catch(() => {});
}

async function request(fetchImpl, url, init, status) {
    let response;
    try { response = await fetchImpl(url.href, { ...init, redirect: 'error' }); }
    catch { throw fail('HUB_CONNECTION_FAILED', 'Hub 连接或文件传输失败；请检查网络。上传失败后请先核对素材，勿自动重复上传。'); }
    if (response.status !== status) {
        await cancelBody(response);
        throw fail('HUB_HTTP_ERROR', `Hub 返回 HTTP ${Number(response.status) || 0}；请检查设备权限及素材状态。`);
    }
    return response;
}

async function smallJson(response) {
    if (!response.body) throw fail('HUB_RESPONSE_INVALID', 'Hub 未返回素材信息。');
    const chunks = [];
    let bytes = 0;
    try {
        for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > MAX_REPLY_BYTES) throw new Error();
            chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw fail('HUB_RESPONSE_INVALID', 'Hub 素材响应无效或不完整。');
    }
}

async function upload(input, connection, deps) {
    let handle;
    try { handle = await fs.open(input, 'r'); }
    catch { throw fail('HUB_FILE_INVALID', '无法打开待上传文件。'); }
    let source;
    let body;
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw fail('HUB_FILE_INVALID', '只能上传普通文件。');
        if (stat.size > MAX_ASSET_BYTES) throw fail('HUB_FILE_TOO_LARGE', '文件超过 512 MiB 上传上限。');
        const hash = createHash('sha256');
        let bytes = 0;
        source = handle.createReadStream({ autoClose: false });
        body = Readable.from((async function* () {
            for await (const chunk of source) {
                bytes += chunk.length;
                if (bytes > MAX_ASSET_BYTES || bytes > stat.size) throw fail('HUB_FILE_CHANGED', '上传中文件发生变化；传输已停止。');
                hash.update(chunk);
                yield chunk;
            }
            if (bytes !== stat.size) throw fail('HUB_FILE_CHANGED', '上传中文件长度发生变化；传输已停止。');
        })());
        const url = new URL('/assets', connection.origin);
        url.searchParams.set('service', connection.service);
        url.searchParams.set('filename', path.basename(input));
        const response = await request(deps.fetchImpl, url, {
            method: 'PUT', headers: {
                Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/octet-stream',
                'Content-Length': String(stat.size), Accept: 'application/json',
            }, body, duplex: 'half', signal: deps.signal,
        }, 201);
        const asset = await smallJson(response);
        const sha256 = hash.digest('hex');
        if (!asset || !ASSET_ID.test(asset.id) || asset.service !== connection.service
            || asset.bytes !== stat.size || bytes !== stat.size || asset.sha256 !== sha256) {
            throw fail('HUB_RESPONSE_INVALID', 'Hub 素材信息与上传文件不一致；请先核对素材，勿自动重复上传。');
        }
        return { id: asset.id, service: asset.service, name: path.basename(input), bytes, sha256, download_path: `/assets/${asset.id}` };
    } finally {
        body?.destroy();
        source?.destroy();
        await handle.close().catch(() => {});
    }
}

async function rejectExisting(file) {
    try { await fs.lstat(file); }
    catch (error) {
        if (error.code === 'ENOENT') return;
        throw fail('HUB_FILE_INVALID', '无法检查下载目标。');
    }
    throw fail('ALREADY_EXISTS', '下载目标已经存在；请选择新文件名。');
}

function contentLength(response, expectedHash) {
    const value = response.headers.get('content-length');
    if (value === null) {
        if (expectedHash) return undefined;
        throw fail('HUB_RESPONSE_INVALID', '下载响应没有文件长度；请提供 --sha256 后重试。');
    }
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw fail('HUB_RESPONSE_INVALID', '下载响应的文件长度无效。');
    }
    if (Number(value) > MAX_ASSET_BYTES) throw fail('HUB_FILE_TOO_LARGE', '文件超过 512 MiB 下载上限。');
    return Number(value);
}

async function download(id, out, expectedHash, connection, deps) {
    await rejectExisting(out);
    const response = await request(deps.fetchImpl, new URL(`/assets/${id}`, connection.origin), {
        method: 'GET', headers: { Authorization: `Bearer ${connection.token}`, 'Accept-Encoding': 'identity' }, signal: deps.signal,
    }, 200);
    let temporary;
    let ownsTemporary = false;
    let handle;
    try {
        const length = contentLength(response, expectedHash);
        const encoding = response.headers.get('content-encoding');
        if ((encoding && encoding.toLowerCase() !== 'identity') || !response.body) {
            throw fail('HUB_RESPONSE_INVALID', '下载响应的文件流格式无效。');
        }
        temporary = path.join(path.dirname(out), `.${path.basename(out)}.${randomUUID()}.part`);
        handle = await fs.open(temporary, 'wx', 0o600);
        ownsTemporary = true;
        let bytes = 0;
        const hash = createHash('sha256');
        const verify = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_ASSET_BYTES || (length !== undefined && bytes > length)) {
                callback(fail('HUB_DOWNLOAD_INVALID', '下载文件超过声明长度或 512 MiB 上限。'));
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), verify, handle.createWriteStream(), { signal: deps.signal });
        handle = undefined;
        const sha256 = hash.digest('hex');
        if ((length !== undefined && bytes !== length) || (expectedHash && sha256 !== expectedHash.toLowerCase())) {
            throw fail('HUB_DOWNLOAD_INVALID', '下载文件长度或 SHA-256 校验失败，未保存结果。');
        }
        // A same-directory hard link publishes atomically and fails if another
        // writer created the destination after our initial existence check.
        try { await fs.link(temporary, out); }
        catch (error) {
            if (error.code === 'EEXIST') throw fail('ALREADY_EXISTS', '下载目标已经存在；请选择新文件名。');
            throw error;
        }
        return { id, path: out, bytes, sha256 };
    } finally {
        await handle?.close().catch(() => {});
        if (ownsTemporary) await fs.unlink(temporary).catch(() => {});
        await cancelBody(response);
    }
}

export async function executeHubFiles(argv, { fetchImpl = fetch, env = process.env, cwd = process.cwd(), signal } = {}) {
    const args = parseCli(argv);
    if (args.help) return { help: HELP };
    let config;
    try { config = resolveConfig(args.workspace ? { workspace: args.workspace } : {}, env, cwd); }
    catch { throw fail('HUB_CONFIG_INVALID', '无法解析项目配置；请先修正 video-remake.json 或环境变量。'); }
    const settings = config.media.video.settings;
    let connection;
    try { connection = parseHubUrl(args.url ?? settings.hubUrl); }
    catch { throw fail('HUB_CONFIG_INVALID', '请配置 hubUrl 或 --url，地址必须为 HTTP(S) /mcp/<服务ID> 且不含凭据、查询参数或片段。'); }
    const tokenFile = args['token-file'] !== undefined ? localPath(args['token-file'], cwd) : settings.hubTokenFile;
    if (!tokenFile) throw fail('HUB_TOKEN_INVALID', '请配置 hubTokenFile 或 --token-file。');
    connection.token = await privateToken(tokenFile);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const deps = { fetchImpl, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
    try {
        if (args.action === 'upload') return await upload(localPath(args.input, cwd), connection, deps);
        return await download(args.input, localPath(args.out, cwd), args.sha256, connection, deps);
    } catch (error) {
        if (error.code?.startsWith('HUB_') || error.code === 'ALREADY_EXISTS') throw error;
        throw fail('HUB_TRANSFER_FAILED', '文件传输失败或超时；请检查网络和本地文件权限。未完成的下载不会保存。');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    executeHubFiles(process.argv.slice(2)).then((result) => {
        process.stdout.write(result.help ?? `${JSON.stringify(result, null, 2)}\n`);
    }).catch((error) => {
        process.stderr.write(`${error.code || 'HUB_TRANSFER_FAILED'}: ${error.message}\n`);
        process.exitCode = 1;
    });
}

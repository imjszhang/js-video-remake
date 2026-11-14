import fs from 'node:fs/promises';
import { constants } from 'node:fs';

const PROTOCOL = '2025-03-26';
const MAX_REPLY_BYTES = 1024 * 1024;
const REQUIRED_TOOLS = ['server_info', 'validate_workflow', 'upload_file', 'run_workflow', 'job', 'fetch_outputs'];

export function parseHubUrl(value) {
    let url;
    try {
        url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
            || !/^\/mcp\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/?$/.test(url.pathname)) throw new Error();
    } catch {
        throw new Error('hubUrl 必须是无凭据、查询参数及片段的 HTTP(S) /mcp/<服务ID> 地址。');
    }
    url.pathname = url.pathname.replace(/\/$/, '');
    const service = url.pathname.slice('/mcp/'.length);
    if (service === 'default') throw new Error('视频接入需要 ComfyUI 专用入口，不能使用 /mcp/default。');
    return { url: url.href, origin: url.origin, service };
}

export async function readHubToken(file) {
    if (!file) throw new Error('请配置 hubTokenFile 或 COMFY_MCP_HUB_TOKEN_FILE。');
    let token;
    let handle;
    try {
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error();
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 512 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error();
        token = (await handle.readFile('utf8')).trim();
    } catch {
        throw new Error('无法读取 Hub 设备令牌文件；请使用普通文件并设置仅本人可读写（chmod 600）。');
    } finally {
        await handle?.close();
    }
    if (!/^mcp_hub_[A-Za-z0-9_-]{32,128}$/.test(token)) {
        throw new Error('Hub 令牌文件必须只有一条有效设备令牌，不能使用网关管理员密钥。');
    }
    return token;
}

function replyFrom(value, id) {
    const values = Array.isArray(value) ? value : [value];
    return values.find((item) => item?.jsonrpc === '2.0' && item.id === id && ('result' in item || 'error' in item));
}

// A small read-only MCP health probe, not a generation client. It supports the
// two response formats of Streamable HTTP and never retries a tool call.
async function readReply(response, id) {
    const type = (response.headers.get('content-type') || '').split(';')[0];
    if (!['application/json', 'text/event-stream'].includes(type) || !response.body) {
        await response.body?.cancel();
        throw new Error('Hub 返回了不支持的 MCP 响应。');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    const parse = (value) => {
        try { return replyFrom(JSON.parse(value), id); }
        catch { throw new Error('Hub 返回了无效 MCP JSON。'); }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            size += value?.byteLength || 0;
            if (size > MAX_REPLY_BYTES) throw new Error('Hub MCP 响应过大。');
            text += decoder.decode(value, { stream: !done });
            if (type === 'text/event-stream') {
                let match;
                while ((match = /\r?\n\r?\n/.exec(text))) {
                    const frame = text.slice(0, match.index);
                    text = text.slice(match.index + match[0].length);
                    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
                    if (data) {
                        const result = parse(data);
                        if (result) return result;
                    }
                }
            }
            if (done) break;
        }
        const result = type === 'application/json' ? parse(text) : undefined;
        if (!result) throw new Error('Hub 没有返回匹配的 MCP 响应。');
        return result;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export async function probeHub(settings, { fetchImpl = fetch, timeoutMs = 15000, requiredTools = REQUIRED_TOOLS, signal, token: suppliedToken } = {}) {
    const { url } = parseHubUrl(settings.hubUrl);
    signal?.throwIfAborted();
    const token = suppliedToken === undefined ? await readHubToken(settings.hubTokenFile) : suppliedToken;
    if (typeof token !== 'string' || !/^mcp_hub_[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Hub 设备令牌格式无效。');
    if (!Array.isArray(requiredTools) || requiredTools.some((name) => typeof name !== 'string' || !name)) {
        throw new Error('Hub 工具检查列表无效。');
    }
    let session;
    let protocol;
    let sequence = 0;
    async function rpc(method, params, notification = false) {
        const id = notification ? undefined : ++sequence;
        const headers = {
            Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(session ? { 'Mcp-Session-Id': session } : {}),
            ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}),
        };
        let response;
        try {
            signal?.throwIfAborted();
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            response = await fetchImpl(url, {
                method: 'POST', headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
                body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
            });
        } catch {
            throw new Error('Hub 连接失败或超时；请检查地址及网络。');
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Hub 返回 HTTP ${response.status}；请检查设备令牌和服务权限。`);
        }
        if (notification) {
            await response.body?.cancel();
            return;
        }
        let reply;
        try { reply = await readReply(response, id); }
        catch { throw new Error('Hub MCP 响应无效、不完整或读取超时。'); }
        if (reply.error || !reply.result) throw new Error('Hub 拒绝了 MCP 检查请求。');
        if (method === 'initialize') session = response.headers.get('mcp-session-id');
        return reply.result;
    }
    try {
        const initialized = await rpc('initialize', {
            protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'video-remake-doctor', version: '1.0.0' },
        });
        if (initialized.protocolVersion !== PROTOCOL) throw new Error('Hub 未协商到受支持的 MCP 检查协议。');
        protocol = initialized.protocolVersion;
        await rpc('notifications/initialized', undefined, true);
        const names = new Set();
        let cursor;
        for (let page = 0; page < 20; page++) {
            const catalog = await rpc('tools/list', cursor ? { cursor } : {});
            for (const tool of catalog.tools || []) names.add(tool.name);
            cursor = catalog.nextCursor;
            if (!cursor) break;
        }
        if (cursor) throw new Error('Hub 工具目录分页过多。');
        if (requiredTools.some((name) => !names.has(name))) {
            throw new Error('设备缺少所选工作流需要的工具；请检查 ComfyUI 服务和设备权限。');
        }
        const info = await rpc('tools/call', { name: 'server_info', arguments: {} });
        if (info.isError) throw new Error('Hub 的 ComfyUI 状态检查失败。');
        let result = info.structuredContent;
        if (!result) {
            try { result = JSON.parse(info.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')); }
            catch { throw new Error('Hub 未返回有效的 ComfyUI 状态。'); }
        }
        if (result.bridge !== 'running' || result.remote?.online !== true) {
            throw new Error('Hub 已连接，但 ComfyUI 桥接或远端服务尚未就绪。');
        }
        const version = typeof result.remote.version === 'string' && /^[\w.+-]{1,50}$/.test(result.remote.version)
            && !/mcp_hub_[A-Za-z0-9_-]{32,128}/.test(result.remote.version) && !result.remote.version.includes(token)
            ? result.remote.version : '';
        return { version, tools: names.size };
    } finally {
        if (session) {
            try {
                const response = await fetchImpl(url, {
                    method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)),
                    headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocol || PROTOCOL },
                });
                await response.body?.cancel();
            } catch { /* A health probe never makes session cleanup a readiness signal. */ }
        }
    }
}

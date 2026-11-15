import http from 'node:http';
import { socksFetch } from './media/socks.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** Local reverse proxy so a direct MCP client can reach a hub that is only available through the project SOCKS proxy. */
export async function startHubRelay({ proxy, upstream, forward = socksFetch, signal } = {}) {
    if (!proxy || typeof upstream !== 'string') return null;
    const target = new URL(upstream);
    if (!['http:', 'https:'].includes(target.protocol) || LOOPBACK.has(target.hostname)) return null;
    const server = http.createServer(async (request, response) => {
        try {
            if (signal?.aborted) {
                response.writeHead(503);
                response.end();
                return;
            }
            const incoming = new URL(request.url || '/', target);
            if (request.method !== 'POST' || incoming.pathname !== target.pathname) {
                response.writeHead(incoming.pathname === target.pathname ? 405 : 404);
                response.end();
                return;
            }
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) {
                if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) continue;
                if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
                else if (value !== undefined) headers.set(key, value);
            }
            const upstreamResponse = await forward(proxy, incoming.href, {
                method: request.method, headers, body: body.length ? body : undefined, signal, redirect: 'error',
            });
            const payload = Buffer.from(await upstreamResponse.arrayBuffer());
            const out = {};
            upstreamResponse.headers.forEach((value, key) => {
                if (!['content-length', 'transfer-encoding', 'connection'].includes(key)) out[key] = value;
            });
            response.writeHead(upstreamResponse.status, out);
            response.end(payload);
        } catch {
            if (!response.headersSent) response.writeHead(502);
            response.end();
        }
    });
    server.requestTimeout = 0;
    const abort = () => server.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
    } catch (error) {
        signal?.removeEventListener('abort', abort);
        throw error;
    }
    const local = new URL(upstream);
    local.hostname = '127.0.0.1';
    local.port = String(server.address().port);
    return {
        url: local.href,
        close: () => new Promise(resolve => {
            signal?.removeEventListener('abort', abort);
            server.close(resolve);
        }),
    };
}

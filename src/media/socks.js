import { once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { appError } from '../errors.js';

function invalid(message) {
    return appError('CONFIG_INVALID', message);
}

export function parseSocksUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw invalid('proxy 必须是 socks5 URL。'); }
    if (url.protocol !== 'socks5:' || !url.hostname || !url.port || url.username || url.password
        || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
        throw invalid('proxy 必须是不带凭据的 socks5://主机:端口。');
    }
    return { hostname: url.hostname, port: Number(url.port) };
}

function readerFor(socket) {
    let buffer = Buffer.alloc(0);
    let ended = false;
    let failed = null;
    const waiters = [];
    const notify = () => {
        while (waiters.length) {
            const waiter = waiters[0];
            if (failed) {
                waiters.shift();
                waiter.reject(failed);
                continue;
            }
            if (waiter.size && buffer.length >= waiter.size) {
                const out = buffer.subarray(0, waiter.size);
                buffer = buffer.subarray(waiter.size);
                waiters.shift();
                waiter.resolve(out);
                continue;
            }
            if (ended && !waiter.size) {
                const out = buffer;
                buffer = Buffer.alloc(0);
                waiters.shift();
                waiter.resolve(out);
                continue;
            }
            if (ended && waiter.size) {
                waiters.shift();
                waiter.reject(new Error('代理连接提前关闭'));
                continue;
            }
            break;
        }
    };
    const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); notify(); };
    const onEnd = () => { ended = true; notify(); };
    const onError = (error) => { failed = failed || error; notify(); };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
    return {
        read: (size) => new Promise((resolve, reject) => { waiters.push({ size, resolve, reject }); notify(); }),
        rest: () => new Promise((resolve, reject) => { waiters.push({ resolve, reject }); notify(); }),
        fail: (error) => { failed = failed || error; socket.destroy(); notify(); },
        release() {
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('error', onError);
            const leftover = buffer;
            buffer = Buffer.alloc(0);
            return leftover;
        },
    };
}

function httpReader(reader) {
    let pending = Buffer.alloc(0);
    const pull = async (size) => {
        while (pending.length < size) pending = Buffer.concat([pending, await reader.read(size - pending.length)]);
        const out = pending.subarray(0, size);
        pending = pending.subarray(size);
        return out;
    };
    const line = async () => {
        while (!pending.includes('\r\n')) {
            if (pending.length > 256 * 1024) throw new Error('HTTP 头部过大');
            pending = Buffer.concat([pending, await reader.read(1)]);
        }
        const at = pending.indexOf('\r\n');
        const value = pending.subarray(0, at);
        pending = pending.subarray(at + 2);
        return value;
    };
    return { pull, line };
}

async function readHttp(reader) {
    const source = httpReader(reader);
    const statusLine = (await source.line()).toString('latin1');
    const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine)?.[1]);
    if (!status) throw new Error('代理返回的不是 HTTP 响应');
    const headers = new Headers();
    for (let header = await source.line(); header.length; header = await source.line()) {
        const text = header.toString('latin1');
        const index = text.indexOf(':');
        if (index > 0) headers.append(text.slice(0, index).trim(), text.slice(index + 1).trim());
    }
    let body;
    if ((headers.get('transfer-encoding') || '').toLowerCase().includes('chunked')) {
        const parts = [];
        for (;;) {
            const size = Number.parseInt((await source.line()).toString('latin1').split(';', 1)[0].trim(), 16);
            if (!Number.isFinite(size)) throw new Error('分块长度无效');
            if (size === 0) {
                for (let trailer = await source.line(); trailer.length; trailer = await source.line());
                break;
            }
            parts.push(await source.pull(size));
            const end = await source.pull(2);
            if (end.toString('latin1') !== '\r\n') throw new Error('分块结束符无效');
        }
        body = Buffer.concat(parts);
        headers.delete('transfer-encoding');
    } else if (headers.has('content-length')) {
        body = await source.pull(Number(headers.get('content-length')));
    } else {
        body = await reader.rest();
    }
    headers.delete('content-length');
    return new Response(body, { status, headers });
}

function writeAll(socket, chunk) {
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        socket.once('error', onError);
        const done = () => { socket.off('error', onError); resolve(); };
        if (socket.write(chunk)) done();
        else socket.once('drain', done);
    });
}

async function openTunnel(proxy, host, port, signal) {
    const socket = net.connect(proxy.port, proxy.hostname);
    const reader = readerFor(socket);
    const onAbort = () => reader.fail(signal.reason instanceof Error ? signal.reason : new Error('代理连接已取消'));
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            socket.once('connect', () => { socket.off('error', onError); resolve(); });
            socket.once('error', onError);
        });
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
        const method = await reader.read(2);
        if (method[0] !== 0x05 || method[1] !== 0x00) throw new Error('SOCKS5 代理不接受无认证连接');
        const name = Buffer.from(host);
        if (name.length > 255) throw new Error('目标主机名过长');
        const request = Buffer.alloc(7 + name.length);
        request[0] = 0x05;
        request[1] = 0x01;
        request[2] = 0x00;
        request[3] = 0x03;
        request[4] = name.length;
        name.copy(request, 5);
        request.writeUInt16BE(port, 5 + name.length);
        socket.write(request);
        const reply = await reader.read(4);
        if (reply[0] !== 0x05 || reply[1] !== 0x00) throw new Error(`SOCKS5 连接失败，代码 ${reply[1]}`);
        if (reply[3] === 0x01) await reader.read(6);
        else if (reply[3] === 0x04) await reader.read(18);
        else if (reply[3] === 0x03) await reader.read((await reader.read(1))[0] + 2);
        else throw new Error('SOCKS5 返回了未知地址类型');
        return { socket, reader, onAbort };
    } catch (error) {
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        throw error;
    }
}

export async function socksFetch(proxy, url, init = {}, tlsOptions = {}) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw invalid('经 socks5 代理访问时，地址需要使用 HTTP 或 HTTPS。');
    const { signal, ...options } = init;
    const request = new Request(url, options);
    const body = Buffer.from(await request.arrayBuffer());
    const headers = new Headers(request.headers);
    headers.set('host', target.host);
    headers.set('connection', 'close');
    headers.delete('accept-encoding');
    headers.delete('transfer-encoding');
    if (body.length) headers.set('content-length', String(body.length));
    else headers.delete('content-length');
    let head = `${request.method} ${target.pathname}${target.search} HTTP/1.1\r\n`;
    headers.forEach((value, key) => { head += `${key}: ${value}\r\n`; });
    head += '\r\n';

    const tunnel = await openTunnel(parseSocksUrl(proxy), target.hostname, Number(target.port || (target.protocol === 'https:' ? 443 : 80)), signal);
    let stream = tunnel.socket;
    let reader = tunnel.reader;
    try {
        if (target.protocol === 'https:') {
            const leftover = reader.release();
            if (leftover.length) tunnel.socket.unshift(leftover);
            stream = tls.connect({ socket: tunnel.socket, servername: target.hostname, ALPNProtocols: ['http/1.1'], ...tlsOptions });
            if (signal?.aborted) stream.destroy();
            else signal?.addEventListener('abort', () => stream.destroy(), { once: true });
            await once(stream, 'secureConnect');
            reader = readerFor(stream);
        }
        await writeAll(stream, head);
        if (body.length) await writeAll(stream, body);
        return await readHttp(reader);
    } finally {
        signal?.removeEventListener('abort', tunnel.onAbort);
        stream.destroy();
    }
}

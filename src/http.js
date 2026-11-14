import { socksFetch } from './media/socks.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

// Program HTTP. A configured SOCKS5 proxy carries non-loopback requests.
// Injected fetch implementations stay unchanged so tests do not open a proxy.
export function httpFetch(proxy, fetchImpl = fetch) {
    if (!proxy || fetchImpl !== fetch) return fetchImpl;
    return (url, init) => {
        let target;
        try { target = new URL(url); } catch { return fetchImpl(url, init); }
        if (LOOPBACK.has(target.hostname)) return fetchImpl(url, init);
        return socksFetch(proxy, typeof url === 'string' ? url : target.href, init);
    };
}

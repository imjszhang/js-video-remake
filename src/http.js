import { httpProxyFetch, socksFetch } from './media/socks.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

// Program HTTP. SOCKS5 and HTTP proxies carry non-loopback requests.
// Injected fetch implementations stay unchanged so tests do not open a proxy.
export function httpFetch(proxy, fetchImpl = fetch) {
    if (!proxy || fetchImpl !== fetch) return fetchImpl;
    const forward = proxy.startsWith('socks5:') ? socksFetch : httpProxyFetch;
    return (url, init) => {
        let target;
        try { target = new URL(url, 'http://local.invalid'); } catch { return fetchImpl(url, init); }
        if (LOOPBACK.has(target.hostname)) return fetchImpl(url, init);
        return forward(proxy, typeof url === 'string' ? url : target.href, init);
    };
}

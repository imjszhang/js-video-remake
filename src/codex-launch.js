import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Codex disables project MCP while the workspace trust level is untrusted. The runtime sets that explicitly. Subscription image generation also needs the HTTP proxy inside the shell environment; the runtime removes every proxy variable for ChatGPT login. */
export function allowCodexProjectMcp(args, proxy) {
    const rewritten = args.map(arg => {
        if (arg.includes('.trust_level')) return arg.replaceAll('"untrusted"', '"trusted"');
        if (proxy && arg.startsWith('shell_environment_policy.exclude=')) {
            return arg.replaceAll(',"*PROXY*"', '').replaceAll(',"*proxy*"', '');
        }
        return arg;
    });
    if (!proxy) return rewritten;
    const value = JSON.stringify({
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
        http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
        NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    });
    return [...rewritten, '-c', `shell_environment_policy.set=${value}`];
}

/** HTTP proxy declared for Codex shells. Ignored by `--ignore-user-config`, but model traffic on this machine needs it. */
export function codexHttpProxy(home = path.join(os.homedir(), '.codex')) {
    let text;
    try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); }
    catch { return null; }
    const found = {};
    for (const line of text.split('\n')) {
        const match = /^(HTTPS_PROXY|HTTP_PROXY|https_proxy|http_proxy)\s*=\s*"([^"]*)"\s*$/.exec(line.trim());
        if (!match) continue;
        let url;
        try { url = new URL(match[2]); }
        catch { continue; }
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) continue;
        found[match[1]] = url.href;
    }
    return found.HTTPS_PROXY || found.https_proxy || found.HTTP_PROXY || found.http_proxy || null;
}

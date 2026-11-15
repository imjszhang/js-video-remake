#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { allowCodexProjectMcp } from './codex-launch.js';

const bin = process.env.VIDEO_REMAKE_CODEX_BIN;
if (!bin) {
    process.stderr.write('缺少 VIDEO_REMAKE_CODEX_BIN\n');
    process.exit(127);
}
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const child = spawn(bin, allowCodexProjectMcp(process.argv.slice(2), proxy), { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
child.once('error', error => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
});

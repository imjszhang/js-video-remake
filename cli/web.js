#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../src/web-server.js';

const root = process.env.REMAKE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const host = process.env.REMAKE_HOST || '127.0.0.1';
const port = Number(process.env.REMAKE_PORT || 8786);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('REMAKE_PORT 必须是 1–65535 的端口号。\n');
    process.exit(1);
}
const server = createWebServer({ root });
server.on('error', (error) => { process.stderr.write(`Video Remake 启动失败：${error.message}\n`); process.exitCode = 1; });
server.listen(port, host, () => process.stdout.write(`Video Remake: http://${host}:${port}/\n`));
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        const stopped = server.shutdownTasks();
        server.close(async () => { await stopped; process.exit(0); });
        setTimeout(() => process.exit(0), 5000).unref();
    });
}

#!/usr/bin/env node
// Serves the film package and opens it for preview. The page's own preview.js adds the
// scrubber; this only hosts the files and prints the address.
//   node tools/preview.mjs [--port 3002] [--no-open]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined || value.startsWith('--') ? true : value;
}

// Same rule as the renderer: the package root is the working directory unless --root says otherwise.
const ROOT = path.resolve(option('root', process.cwd()));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml' };

const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400); response.end(); return; }
    const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
    if ((file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(response);
});

const requested = Number(option('port', 0));
server.listen(requested, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${server.address().port}/`;
    console.log(JSON.stringify({ ok: true, url: address }));
    if (process.argv.includes('--no-open')) return;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
});

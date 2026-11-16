#!/usr/bin/env node
// film renderer. Drives a page exposing window.__film through the Chrome DevTools
// protocol and encodes the frames with FFmpeg. No dependencies beyond Node.js, a
// local Chrome and FFmpeg. The page must draw frame(t) from t alone.
//
//   node tools/render.mjs --entry index.html --out renders/film.mp4
//   node tools/render.mjs --frames 0,30,60 --png-dir renders/stills
//   node tools/render.mjs --check
//
// Chrome comes from FILM_CHROME or the usual per-platform location. Dimensions come
// from film.json unless --width/--height override them.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The package root is the working directory, so the same tools work whether they sit at
// tools/ or film/tools/. --root overrides it for a caller that drives several packages.
const ROOT = path.resolve(option('root', process.cwd()));

function option(name, fallback = undefined) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined || value.startsWith('--') ? true : value;
}
const flag = name => process.argv.includes(`--${name}`);
function fail(message) { console.error(message); process.exit(1); }

function findChrome() {
    if (process.env.FILM_CHROME && fs.existsSync(process.env.FILM_CHROME)) return process.env.FILM_CHROME;
    const candidates = process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : process.platform === 'win32'
            ? ['C:/Program Files/Google/Chrome/Application/chrome.exe']
            : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function staticServer(root) {
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml' };
    const server = http.createServer((request, response) => {
        let pathname;
        try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
        catch { response.writeHead(400); response.end(); return; }
        const file = path.join(root, pathname);
        if ((file !== root && !file.startsWith(`${root}${path.sep}`)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            response.writeHead(404); response.end(); return;
        }
        response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        fs.createReadStream(file).pipe(response);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function connectDevtools(port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('DevTools 连接失败')), { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const waiter = pending.get(message.id);
            clearTimeout(waiter.timer);
            pending.delete(message.id);
            message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
        } else for (const listener of listeners) listener(message);
    });
    return {
        socket,
        send: (method, params = {}, sessionId, ms = 120000) => new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${method}`)); }, ms);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
        }),
        listen: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    };
}

async function main() {
    const entry = option('entry', 'index.html');
    const output = option('out', null);
    const pngDir = option('png-dir', null);
    const frameList = option('frames', null);
    const checking = flag('check');
    const dpr = Number(option('dpr', 1));
    const readyTimeoutMs = Number(option('ready-timeout', 90000));
    const ffmpeg = option('ffmpeg', 'ffmpeg');
    const chromePath = findChrome();
    if (!chromePath) fail('找不到 Chrome。设置 FILM_CHROME 指向可执行文件。');
    if (!fs.existsSync(path.join(ROOT, entry))) fail(`入口不存在: ${entry}`);

    let declared = {};
    const filmFile = path.join(ROOT, 'film.json');
    if (fs.existsSync(filmFile)) declared = JSON.parse(fs.readFileSync(filmFile, 'utf8'));
    const width = Number(option('width', declared.width || 1920));
    const height = Number(option('height', declared.height || 1080));

    const server = await staticServer(ROOT);
    const port = server.address().port;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'film-chrome-'));
    const chrome = spawn(chromePath, [
        '--headless=new', `--remote-debugging-port=0`, `--user-data-dir=${profile}`,
        // Metal is macOS only; elsewhere Chrome picks its default GPU backend.
        ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
        '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio',
        '--hide-scrollbars', '--no-first-run', '--disable-background-timer-throttling',
        '--autoplay-policy=no-user-gesture-required',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let chromeLog = '';
    const debugPort = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Chrome 启动超时: ${chromeLog.slice(-400)}`)), 20000);
        chrome.stderr.on('data', chunk => {
            chromeLog += chunk;
            const match = chromeLog.match(/DevTools listening on ws:\/\/[^\s/]+:(\d+)\//);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        chrome.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome 退出（${code}）: ${chromeLog.slice(-400)}`)); });
    });
    const devtools = await connectDevtools(debugPort);
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    const shutdown = async () => {
        try { devtools.socket.close(); } catch { /* closed */ }
        try { chrome.kill('SIGKILL'); } catch { /* gone */ }
        // Chrome keeps writing its profile until it is gone; deleting earlier races it.
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
        server.close();
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
        catch (error) { console.error(`未能清理临时浏览器目录 ${profile}: ${error.message}`); }
    };

    try {
        const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
        // Every request is paused before it leaves the browser. Only the package server
        // is let through; anything else is failed and recorded, so no frame can depend on
        // the network and nothing in the page can send data out.
        const external = [];
        const local = `http://127.0.0.1:${port}/`;
        devtools.listen(message => {
            if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
            const { requestId, request } = message.params;
            if (request.url.startsWith(local) || request.url.startsWith('data:') || request.url.startsWith('blob:')) {
                devtools.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
            } else {
                external.push(request.url);
                devtools.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
            }
        });
        await devtools.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
        await devtools.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId);
        await devtools.send('Page.enable', {}, sessionId);
        await devtools.send('Runtime.enable', {}, sessionId);
        await devtools.send('Page.navigate', { url: `http://127.0.0.1:${port}/${entry}?capture` }, sessionId);
        try {
            const deadline = Date.now() + readyTimeoutMs;
            for (;;) {
                const result = await devtools.send('Runtime.evaluate', {
                    expression: 'window.__film && window.__film.ready ? Promise.resolve(window.__film.ready).then(() => true) : false',
                    awaitPromise: true, returnByValue: true,
                }, sessionId);
                if (result.exceptionDetails) throw new Error(`页面异常: ${JSON.stringify(result.exceptionDetails).slice(0, 600)}`);
                if (result.result?.value === true) break;
                if (Date.now() > deadline) throw new Error('页面在限定时间内没有就绪（window.__film.ready）。');
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (external.length) throw new Error(`页面请求了外部网络，已拦截: ${external.slice(0, 3).join(', ')}`);
            const info = JSON.parse((await devtools.send('Runtime.evaluate', {
                expression: 'JSON.stringify({ duration: window.__film.duration, fps: window.__film.fps, width: window.__film.width, height: window.__film.height, hasAudio: typeof window.__film.exportWav === "function" })',
                returnByValue: true,
            }, sessionId)).result.value);
            if (info.width !== width || info.height !== height) throw new Error(`页面尺寸 ${info.width}x${info.height} 与 film.json 的 ${width}x${height} 不一致。`);
            const total = Math.round(info.duration * info.fps);
            const frames = frameList
                ? frameList.split(',').map(value => Number(value.trim())).filter(Number.isInteger)
                : checking ? [0, Math.floor(total / 2), Math.max(0, total - 1)]
                    : Array.from({ length: total }, (_, index) => index);

            const draw = async time => {
                const result = await devtools.send('Runtime.evaluate', {
                    expression: `Promise.resolve(window.__film.frame(${time})).then(() => true)`, awaitPromise: true, returnByValue: true,
                }, sessionId);
                if (result.exceptionDetails) throw new Error(`frame(${time}) 失败: ${JSON.stringify(result.exceptionDetails).slice(0, 600)}`);
            };
            const grab = async () => Buffer.from((await devtools.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId)).data, 'base64');

            if (checking) {
                const report = [];
                for (const frame of frames) {
                    await draw(frame / info.fps);
                    const alone = createHash('sha256').update(await grab()).digest('hex');
                    await draw(Math.max(0, frame - 1) / info.fps);
                    await draw(frame / info.fps);
                    report.push({ frame, match: alone === createHash('sha256').update(await grab()).digest('hex') });
                }
                if (external.length) throw new Error(`页面请求了外部网络，已拦截: ${external.slice(0, 3).join(', ')}`);
                console.log(JSON.stringify({ ok: report.every(item => item.match), frames: report }));
                if (report.some(item => !item.match)) process.exitCode = 1;
                return;
            }
            if (pngDir) {
                const directory = path.resolve(ROOT, pngDir);
                fs.mkdirSync(directory, { recursive: true });
                for (const frame of frames) {
                    await draw(frame / info.fps);
                    fs.writeFileSync(path.join(directory, `f${String(frame).padStart(5, '0')}.png`), await grab());
                }
                if (external.length) throw new Error(`页面请求了外部网络，已拦截: ${external.slice(0, 3).join(', ')}`);
                console.log(JSON.stringify({ ok: true, frames: frames.length, dir: pngDir }));
                return;
            }
            if (!output) fail('需要 --out、--png-dir 或 --check。');
            const file = path.resolve(ROOT, output);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            let audio = null;
            if (info.hasAudio && !flag('no-audio')) {
                const result = await devtools.send('Runtime.evaluate', {
                    expression: 'window.__film.exportWav()', awaitPromise: true, returnByValue: true,
                }, sessionId, 600000);
                if (result.exceptionDetails) throw new Error(`exportWav 失败: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
                if (result.result?.value) {
                    audio = `${file}.wav`;
                    fs.writeFileSync(audio, Buffer.from(result.result.value, 'base64'));
                }
            }
            const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-i', 'pipe:0'];
            if (audio) args.push('-i', audio);
            args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
                '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart');
            if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
            args.push(file);
            const encoder = spawn(ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] });
            const encoded = new Promise((resolve, reject) => {
                encoder.on('error', reject);
                encoder.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
            });
            const started = Date.now();
            for (const frame of frames) {
                await draw(frame / info.fps);
                if (!encoder.stdin.write(await grab())) await new Promise(resolve => encoder.stdin.once('drain', resolve));
                if (frame % info.fps === 0) console.error(`frame ${frame}/${total}`);
            }
            encoder.stdin.end();
            await encoded;
            if (audio) fs.rmSync(audio, { force: true });
            if (external.length) throw new Error(`页面请求了外部网络，已拦截: ${external.slice(0, 3).join(', ')}`);
            console.log(JSON.stringify({ ok: true, output, frames: frames.length, seconds: +((Date.now() - started) / 1000).toFixed(1) }));
        } finally { await devtools.send('Target.closeTarget', { targetId }).catch(() => {}); }
    } finally { await shutdown(); }
}

main().catch(error => fail(error.stack || error.message));

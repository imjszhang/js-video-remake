import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appError } from './errors.js';
import { packageCli, packageEnvironment, resolveVideo } from './videos.js';
import { isFilm } from './film/engine.js';
import { runFixedCommand } from './repro/render.js';

export const STUDIO_PORT = 3002;
const invalid = (message) => appError('STUDIO_FAILED', message);

// Preview uses the package's own engine: HyperFrames Studio, or the film preview server.
async function runPreview(config, pkg, args, deps) {
    const cli = deps.hyperframesCli ?? await packageCli(config, pkg);
    const run = deps.runCommand || runFixedCommand;
    const result = await run(process.execPath, [cli, ...args], {
        cwd: pkg.dir,
        env: packageEnvironment(pkg.dir, config.env || process.env),
        timeoutMs: deps.timeoutMs ?? 30_000,
    });
    if (result?.exitCode !== 0) throw invalid(result?.stderr || result?.stdout || 'HyperFrames 命令失败。');
    return result;
}

// The film preview server serves until stopped, so it runs detached and reports its own URL.
function startFilmPreview(config, pkg, deps) {
    const launch = deps.spawn || spawn;
    const child = launch(process.execPath, [path.join(pkg.dir, 'tools/preview.mjs'), '--port', String(STUDIO_PORT)], {
        cwd: pkg.dir, env: packageEnvironment(pkg.dir, config.env || process.env), detached: true, stdio: 'ignore',
    });
    child.unref();
    return child.pid;
}

export async function studioProduction(config, { slug, video, stop = false, status = false } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, video);
    if (isFilm(pkg.manifest)) {
        if (stop || status) return { command: 'studio', slug, video: pkg.name, engine: 'film@1', action: stop ? 'stop' : 'status', output: 'film 预览随进程结束，没有后台服务。' };
        const pid = startFilmPreview(config, pkg, deps);
        return { command: 'studio', slug, video: pkg.name, engine: 'film@1', action: 'preview', port: STUDIO_PORT, pid, output: `http://127.0.0.1:${STUDIO_PORT}/` };
    }
    const action = stop ? '--stop' : status ? '--status' : '--background';
    const result = await runPreview(config, pkg, ['preview', pkg.dir, action], deps);
    return { command: 'studio', slug, video: pkg.name, action: action.slice(2), port: STUDIO_PORT, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

export async function timelineProduction(config, { slug, video, json = false } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, video);
    if (isFilm(pkg.manifest)) {
        const film = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(pkg.dir, 'film.json'), 'utf8'));
        const beats = (film.beats || []).map((beat) => `${beat.at}s  ${beat.name || ''}`).join('\n');
        const output = json ? JSON.stringify({ duration: film.duration, fps: film.fps, beats: film.beats || [] }) : beats;
        return { command: 'timeline', slug, video: pkg.name, engine: 'film@1', output };
    }
    const args = ['timeline', pkg.dir];
    if (json) args.push('--json');
    const result = await runPreview(config, pkg, args, deps);
    return { command: 'timeline', slug, video: pkg.name, output: (result.stdout || '').trim() };
}

export function studioPortOpen(port = STUDIO_PORT, { connect = net.connect } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (open) => {
            if (settled) return;
            settled = true;
            resolve(open);
        };
        let socket;
        try {
            socket = connect({ port, host: '127.0.0.1' });
        } catch {
            finish(false);
            return;
        }
        const timer = setTimeout(() => { socket.destroy(); finish(false); }, 200);
        timer.unref?.();
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); finish(true); });
        socket.once('error', () => { clearTimeout(timer); finish(false); });
    });
}

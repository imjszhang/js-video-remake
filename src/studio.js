import net from 'node:net';
import { appError } from './errors.js';
import { packageCli, packageEnvironment, resolveVideo } from './videos.js';
import { runFixedCommand } from './repro/render.js';

export const STUDIO_PORT = 3002;
const invalid = (message) => appError('STUDIO_FAILED', message);

// Preview and timeline use the package's own pinned HyperFrames.
async function runHyperframes(config, pkg, args, deps) {
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

export async function studioProduction(config, { slug, video, stop = false, status = false } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, video);
    const action = stop ? '--stop' : status ? '--status' : '--background';
    const result = await runHyperframes(config, pkg, ['preview', pkg.dir, action], deps);
    return { command: 'studio', slug, video: pkg.name, action: action.slice(2), port: STUDIO_PORT, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

export async function timelineProduction(config, { slug, video, json = false } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, video);
    const args = ['timeline', pkg.dir];
    if (json) args.push('--json');
    const result = await runHyperframes(config, pkg, args, deps);
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

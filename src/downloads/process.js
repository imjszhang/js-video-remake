import { spawn } from 'node:child_process';
import { appError } from '../errors.js';

// Keep downloader output private and bounded; never invoke a shell with a URL.
export function runDownloadProcess(executable, args, {
    cwd, env = process.env, timeoutMs = 1800000, maxOutputBytes = 8 * 1024 * 1024,
    spawnImpl = spawn, platform = process.platform, killImpl = process.kill, signal,
} = {}) {
    return new Promise((resolve, reject) => {
        let child;
        let timer;
        let stopTimer;
        let terminalError;
        let settled = false;
        let stdout = '';
        let total = 0;
        let onAbort;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(stopTimer);
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve(result);
        };
        const stop = () => {
            try {
                if (platform !== 'win32' && child?.pid) killImpl(-child.pid, 'SIGKILL');
                else if (platform === 'win32' && child?.pid) {
                    const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                    killer.on('error', () => child.kill('SIGKILL'));
                } else child?.kill('SIGKILL');
            } catch { try { child?.kill('SIGKILL'); } catch { /* Already stopped. */ } }
        };
        const terminate = error => {
            if (terminalError || settled) return;
            terminalError = error;
            stop();
            // Normally close follows SIGKILL immediately; wait for it before
            // callers remove partial files, while still bounding broken children.
            if (!settled) stopTimer = setTimeout(() => finish(appError('DOWNLOAD_STOP_UNCONFIRMED',
                '已请求停止下载，但尚未确认进程退出；临时文件将保留。',
                { data: { causeCode: terminalError.code } })), 1000);
        };
        if (signal?.aborted) {
            finish(appError('DOWNLOAD_CANCELLED', '下载已取消。'));
            return;
        }
        try {
            child = spawnImpl(executable, args, {
                cwd, env, shell: false, detached: platform !== 'win32', windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) { finish(error); return; }
        const collect = (chunk, output) => {
            if (settled) return;
            total += Buffer.byteLength(chunk);
            if (total > maxOutputBytes) {
                terminate(appError('DOWNLOAD_OUTPUT_LIMIT', '下载工具输出超过限制。'));
            } else if (output) stdout += chunk.toString();
        };
        child.stdout.setEncoding?.('utf8');
        child.stderr.setEncoding?.('utf8');
        child.stdout.on('data', chunk => collect(chunk, true));
        child.stderr.on('data', chunk => collect(chunk, false));
        child.on('error', error => finish(terminalError || error));
        child.on('close', (code, signal) => {
            if (terminalError) finish(terminalError);
            else if (code === 0) finish(null, { stdout });
            else finish(appError('DOWNLOAD_FAILED', `下载工具未成功退出${signal ? '（已终止）' : ''}。`));
        });
        onAbort = () => terminate(appError('DOWNLOAD_CANCELLED', '下载已取消，正在停止下载进程。'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        if (settled) return;
        timer = setTimeout(() => {
            terminate(appError('DOWNLOAD_TIMEOUT', '下载超时，下载进程及其子进程已停止。'));
        }, timeoutMs);
    });
}

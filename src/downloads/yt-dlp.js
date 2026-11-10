import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../errors.js';
import { isWithin } from '../schema.js';
import { runDownloadProcess } from './process.js';

const OUTPUT_LIMIT = 8 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);
const COMMON_ARGS = ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--js-runtimes', `node:${process.execPath}`, '--no-playlist', '--playlist-items', '1', '--no-warnings', '--no-progress'];

function httpUrl(input) {
    try {
        const url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        return url.href;
    } catch { throw appError('INVALID_INPUT', '下载链接必须是无用户名和密码的 HTTP(S) URL。'); }
}

function cleanText(value, length = 500) {
    if (typeof value !== 'string') return undefined;
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length) || undefined;
}

function failure(error) {
    if (['DOWNLOAD_CANCELLED', 'DOWNLOAD_STOP_UNCONFIRMED', 'DOWNLOAD_UNAVAILABLE', 'DOWNLOAD_TIMEOUT', 'DOWNLOAD_OUTPUT_LIMIT', 'DOWNLOAD_PROTOCOL', 'INVALID_INPUT'].includes(error.code)) return error;
    if (error.killed || error.code === 'ETIMEDOUT') return appError('DOWNLOAD_TIMEOUT', '下载超时，未登记参考视频。');
    return appError('DOWNLOAD_FAILED', '视频下载失败；请检查链接是否支持、网络和 yt-dlp / ffmpeg 安装。未登记参考视频。');
}

function parseRecord(result) {
    const stdout = typeof result === 'string' ? result : result?.stdout;
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > OUTPUT_LIMIT) throw appError('DOWNLOAD_PROTOCOL', '下载工具返回内容缺失或超过限制。');
    let record;
    try { record = JSON.parse(stdout.trim()); }
    catch { throw appError('DOWNLOAD_PROTOCOL', '下载工具没有返回单条有效的 JSON 结果。'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw appError('DOWNLOAD_PROTOCOL', '下载工具返回格式无效。');
    if (['playlist', 'multi_video'].includes(record._type) || Array.isArray(record.entries)) throw appError('INVALID_INPUT', '请提供单个视频链接，不支持整张播放列表。');
    if (record.is_live || ['is_live', 'is_upcoming'].includes(record.live_status)) throw appError('INVALID_INPUT', '暂不支持直播或尚未开始的视频。');
    return record;
}

export const ytDlp = {
    kind: 'yt-dlp',
    async doctor(settings, deps = {}) {
        const run = deps.runDownload || runDownloadProcess;
        const checks = await Promise.all([
            { tool: 'yt-dlp', executable: settings.executable, args: ['--ignore-config', '--no-plugin-dirs', '--version'] },
            { tool: 'ffmpeg', executable: 'ffmpeg', args: ['-version'] },
        ].map(async check => {
            try {
                const result = await run(check.executable, check.args, {
                    env: deps.env ?? process.env, timeoutMs: Math.min(settings.timeoutMs, 10000), maxOutputBytes: 64 * 1024,
                });
                const output = typeof result === 'string' ? result : result?.stdout;
                const version = cleanText(output?.split('\n')[0], 160);
                if (!version) throw new Error();
                return { tool: check.tool, ready: true, version };
            } catch {
                return { tool: check.tool, ready: false, hint: `无法运行 ${check.tool}；请安装或检查可执行文件路径。` };
            }
        }));
        return { ready: checks.every(check => check.ready), version: checks[0].version, checks,
            hint: checks.filter(check => !check.ready).map(check => check.hint).join(' ') };
    },
    async download(settings, { url, quality = '1080' }, deps = {}) {
        if (deps.signal?.aborted) throw appError('DOWNLOAD_CANCELLED', '下载已取消。');
        const inputUrl = httpUrl(url);
        const selected = String(quality);
        if (!['720', '1080'].includes(selected)) throw appError('INVALID_INPUT', '参考视频下载只支持 720 或 1080，不支持纯音频。');
        const run = deps.runDownload || runDownloadProcess;
        const deadline = Date.now() + settings.timeoutMs;
        let directory;
        try {
            await fs.mkdir(settings.directory, { recursive: true });
            const root = await fs.realpath(settings.directory);
            directory = await fs.mkdtemp(path.join(root, 'download-'));
            const invoke = async args => {
                if (deps.signal?.aborted) throw appError('DOWNLOAD_CANCELLED', '下载已取消。');
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw appError('DOWNLOAD_TIMEOUT', '下载超时，未登记参考视频。');
                let output;
                try {
                    output = await run(settings.executable, args, {
                        cwd: directory, env: deps.env ?? process.env,
                        timeoutMs: remaining, maxOutputBytes: OUTPUT_LIMIT, signal: deps.signal,
                    });
                } catch (error) {
                    if (error.code === 'ENOENT') throw appError('DOWNLOAD_UNAVAILABLE', '找不到 yt-dlp，请安装后再试，或配置 download.executable。');
                    throw error;
                }
                return parseRecord(output);
            };
            // --no-playlist alone does not reject playlist-only URLs. Inspect one entry
            // without downloading before permitting the download operation.
            const info = await invoke([...COMMON_ARGS, '--dump-single-json', '--flat-playlist', '--skip-download', '--', inputUrl]);
            const final = await invoke([...COMMON_ARGS, '--no-simulate', '--abort-on-error',
                '--no-overwrites', '--no-write-info-json', '--no-write-playlist-metafiles',
                '--format', `bv*[height<=${selected}]+ba/b[height<=${selected}]/bv[height<=${selected}]`,
                '--merge-output-format', 'mp4', '--remux-video', 'mp4',
                '--output', path.join(directory, 'video.%(ext)s'),
                '--print', 'after_move:%(.{filepath,title,webpage_url,channel,uploader,duration})j', '--', inputUrl]);
            if (typeof final.filepath !== 'string' || !final.filepath || final.filepath.includes('\0')) throw appError('DOWNLOAD_PROTOCOL', '下载结果缺少原片路径。');
            const requested = path.resolve(directory, final.filepath);
            if (!isWithin(directory, requested)) throw appError('DOWNLOAD_PROTOCOL', '下载结果路径越出本次下载目录。');
            const file = await fs.realpath(requested);
            if (!isWithin(directory, file) || !VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())) throw appError('DOWNLOAD_PROTOCOL', '下载结果不是本次目录中的视频文件。');
            const stat = await fs.stat(file);
            if (!stat.isFile() || !stat.size) throw appError('DOWNLOAD_PROTOCOL', '下载结果为空或不是文件。');
            let canonicalUrl = inputUrl;
            try { if (final.webpage_url || info.webpage_url) canonicalUrl = httpUrl(final.webpage_url || info.webpage_url); } catch { /* Keep the validated user URL. */ }
            const duration = final.duration ?? info.duration;
            return { file, origin: { provider: 'yt-dlp', url: canonicalUrl,
                title: cleanText(final.title || info.title), channel: cleanText(final.channel || final.uploader || info.channel || info.uploader),
                ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationSec: duration } : {}),
            } };
        } catch (error) {
            if (directory && error.code === 'DOWNLOAD_STOP_UNCONFIRMED') {
                throw appError(error.code, `尚未确认下载进程退出，请检查任务后再清理保留目录：${directory}`, {
                    data: { command: 'reference:download', provider: 'yt-dlp', directory, retained: true },
                });
            }
            if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
            throw failure(error);
        }
    },
};

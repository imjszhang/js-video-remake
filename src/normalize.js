import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appError } from './errors.js';
import { openProduction } from './start.js';
import { land } from './media/land.js';

const execFileAsync = promisify(execFile);
const invalid = (message) => appError('NORMALIZE_INVALID', message);

export function hasAlpha(pixFmt = '') {
    return /^(?:rgba|bgra|argb|abgr|ya\d|yuva|gbrap)/.test(pixFmt);
}

export function evenScale() {
    return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
}

export function stillVideoArgs({ input, output, fps, frames }) {
    return ['-y', '-loop', '1', '-i', input, '-frames:v', String(frames), '-r', String(fps),
        '-vf', evenScale(), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-movflags', '+faststart', output];
}

export function alphaKeepArgs({ input, output, fps, frames, still }) {
    return ['-y', ...(still ? ['-loop', '1'] : []), '-i', input, '-frames:v', String(frames), '-r', String(fps),
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', output];
}

export function alphaFlattenArgs({ input, output, fps, frames, still }) {
    const graph = `[0:v]${evenScale()},format=rgba[fg];[fg]split[a][b];`
        + `[a]drawbox=c=black:t=fill[bg];[bg][b]overlay=format=auto,format=yuv420p[out]`;
    return ['-y', ...(still ? ['-loop', '1'] : []), '-i', input, '-filter_complex', graph, '-map', '[out]',
        '-frames:v', String(frames), '-r', String(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-movflags', '+faststart', output];
}

async function probeFile(file, deps) {
    if (deps.probe) return deps.probe(file);
    let data;
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,nb_frames:format=duration',
            '-of', 'json', file,
        ], { maxBuffer: 4 * 1024 * 1024 });
        data = JSON.parse(stdout);
    } catch (error) {
        throw invalid(`无法检查素材 ${file}: ${error.message}`);
    }
    const stream = (data.streams || []).find((item) => item.codec_type === 'video') || {};
    return {
        pixFmt: stream.pix_fmt || '',
        codec: stream.codec_name || '',
        width: Number(stream.width) || 0,
        height: Number(stream.height) || 0,
        duration: Number(data.format?.duration) || 0,
    };
}

function frameCount(duration, fps) {
    const frames = Math.round(Number(duration) * fps);
    if (!Number.isFinite(frames) || frames < 1) throw invalid('duration 必须是正数。');
    return frames;
}

export function normalizePlan({ kind, probe, alpha, duration, fps }) {
    const rate = Number(fps ?? 30);
    if (!Number.isInteger(rate) || rate < 1 || rate > 240) throw invalid('fps 必须是 1–240 的整数。');
    if (kind === 'audio') {
        return { action: 'skip', reason: '音频不在这里转码。编进代码视频包后，用 hyperframes normalize-audio 对齐响度。' };
    }
    const still = kind === 'image';
    const alphaSource = hasAlpha(probe?.pixFmt);
    if (!still && !alphaSource) {
        return { action: 'skip', reason: '已是无透明通道的视频，不做转码。响度归一使用 hyperframes normalize-audio。' };
    }
    if (alphaSource && !alpha) throw invalid('这个素材带透明通道，请指定 --alpha keep 或 --alpha flatten。');
    if (alpha && !['keep', 'flatten'].includes(alpha)) throw invalid('alpha 必须是 keep 或 flatten。');
    const seconds = duration ?? (still ? 5 : probe.duration);
    const frames = frameCount(seconds, rate);
    const mode = alphaSource && alpha === 'keep' ? 'alpha-keep' : alphaSource ? 'alpha-flatten' : 'still-video';
    const extension = mode === 'alpha-keep' ? '.mov' : '.mp4';
    const argsFor = mode === 'alpha-keep' ? alphaKeepArgs : mode === 'alpha-flatten' ? alphaFlattenArgs : stillVideoArgs;
    return { action: 'transcode', mode, fps: rate, frames, extension, still, argsFor };
}

export async function normalizeAsset(config, { slug, id, duration, fps, alpha } = {}, deps = {}) {
    if (!id) throw invalid('normalize 需要 --id <assetId>。');
    const { dir } = await openProduction(config, slug);
    const ledgerPath = path.join(dir, 'assets', 'ledger.json');
    let ledger;
    try {
        ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    } catch {
        throw invalid('制作还没有素材台账。');
    }
    const item = ledger.items?.find((entry) => entry.id === id);
    if (!item) throw invalid(`台账里没有素材: ${id}`);
    const source = path.join(config.workspace, item.path);
    const probe = item.kind === 'audio' ? null : await probeFile(source, deps);
    const plan = normalizePlan({ kind: item.kind, probe, alpha, duration, fps });
    if (plan.action === 'skip') {
        return { command: 'normalize', slug, id, status: 'skipped', reason: plan.reason };
    }
    const temporary = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-normalize-')), `normalized${plan.extension}`);
    const args = plan.argsFor({ input: source, output: temporary, fps: plan.fps, frames: plan.frames, still: plan.still });
    try {
        try {
            if (deps.runFfmpeg) await deps.runFfmpeg(args);
            else await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 8 * 1024 * 1024 });
        } catch (error) {
            throw appError('NORMALIZE_FAILED', `ffmpeg 转码失败: ${String(error.stderr || error.message).trim().slice(-800)}`);
        }
        const landed = land({
            workspace: config.workspace,
            slug,
            kind: 'video',
            from: temporary,
            intent: `${plan.mode} from ${id}`,
            provider: 'local.normalize',
            sourceId: id,
        });
        return {
            command: 'normalize', slug, id, status: 'landed', mode: plan.mode, fps: plan.fps, frames: plan.frames,
            assetId: landed.id, path: landed.path, html: landed.html, ffmpeg: args, next: `remake video:add ${slug} --id ${landed.id}`,
        };
    } finally {
        await fs.rm(path.dirname(temporary), { recursive: true, force: true });
    }
}

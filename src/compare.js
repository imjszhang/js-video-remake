import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readCatalog, writeCatalog, findProduction } from './catalog.js';
import { appError } from './errors.js';
import { writeComparisonProject } from './compare-template.js';
import { HYPERFRAMES_VERSION } from './repro/project.js';
import { HYPERFRAMES_CLI, rendererEnvironment, runFixedCommand } from './repro/render.js';

const execFileAsync = promisify(execFile);
const invalid = (message) => appError('COMPARE_INVALID', message);
const number = (value, name, positive = false) => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
        throw invalid(`${name} 必须是有效秒数。`);
    }
    const result = Number(value);
    if (!Number.isFinite(result) || (positive ? result <= 0 : result < 0)) {
        throw invalid(`${name} 必须是${positive ? '正数' : '非负数'}。`);
    }
    return result;
};

function rate(value) {
    const [numerator, denominator = '1'] = String(value ?? '').split('/');
    const result = Number(numerator) / Number(denominator);
    return Number.isFinite(result) && result > 0 ? result : null;
}

export async function probeMedia(file) {
    let data;
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error', '-count_frames', '-show_entries',
            'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration:format=duration',
            '-of', 'json', file,
        ], { maxBuffer: 4 * 1024 * 1024 });
        data = JSON.parse(stdout);
    } catch (error) {
        throw invalid(`无法检查视频 ${file}: ${error.message}`);
    }
    const videos = (data.streams ?? []).filter((stream) => stream.codec_type === 'video');
    const audios = (data.streams ?? []).filter((stream) => stream.codec_type === 'audio');
    const video = videos[0];
    const frameRate = [video?.avg_frame_rate, video?.r_frame_rate].find((value) => rate(value));
    const fps = rate(frameRate);
    const frames = Number(video?.nb_read_frames ?? video?.nb_frames);
    const duration = Number(video?.duration ?? data.format?.duration);
    if (!video || !fps || !Number.isFinite(duration) || duration <= 0 || !video.width || !video.height) {
        throw invalid(`视频缺少有效的尺寸、帧率或时长: ${file}`);
    }
    return {
        width: video.width, height: video.height, fps, frameRate, duration,
        frames: Number.isInteger(frames) && frames > 0 ? frames : null,
        hasAudio: audios.length > 0, audioStreams: audios.length, videoStreams: videos.length,
    };
}

async function sha256(file) {
    const hash = createHash('sha256');
    try {
        for await (const chunk of createReadStream(file)) hash.update(chunk);
    } catch (error) {
        throw invalid(`无法读取输入文件 ${file}: ${error.message}`);
    }
    return hash.digest('hex');
}

function resolveInput(workspace, file, name) {
    if (typeof file !== 'string' || !file.trim()) throw invalid(`${name} 必须指定视频文件。`);
    return path.resolve(workspace, file);
}

async function reserveVersion(comparisonsDir) {
    await fs.mkdir(comparisonsDir, { recursive: true });
    const entries = await fs.readdir(comparisonsDir);
    let version = 1 + Math.max(0, ...entries.map((entry) => Number(/^v(\d+)$/.exec(entry)?.[1] ?? 0)));
    while (true) {
        const dir = path.join(comparisonsDir, `v${version}`);
        try {
            await fs.mkdir(dir);
            return { version, dir };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            version += 1;
        }
    }
}

export function formatFrameRate(frameRate, fps) {
    if (typeof frameRate === 'string' && /^\d+\/\d+$/.test(frameRate)) {
        const [numerator, denominator] = frameRate.split('/').map(Number);
        if (denominator === 1 && numerator >= 1 && numerator <= 240) return String(numerator);
        if (denominator > 0 && numerator / denominator >= 1 && numerator / denominator <= 240) return `${numerator}/${denominator}`;
    }
    if (Number.isInteger(fps) && fps >= 1 && fps <= 240) return String(fps);
    throw invalid(`不支持的输出帧率: ${frameRate ?? fps}`);
}

export async function writeSilence(file, durationSec, deps = {}) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const exec = deps.execFile ?? execFileAsync;
    try {
        await exec('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-t', String(durationSec), '-c:a', 'aac', file,
        ]);
    } catch (error) {
        throw appError('COMPARE_RENDER_FAILED', `无法生成静音音轨: ${error.message}`);
    }
}

export async function renderComparison({
    dir, fps, outputFile, timeoutMs = 30 * 60 * 1000, env = process.env, signal,
}, deps = {}) {
    try {
        await fs.lstat(path.join(dir, '.env'));
        throw invalid('对比目录不得包含 .env。');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(dir, `.compare-render-${randomUUID()}.mp4`);
    const args = [HYPERFRAMES_CLI, 'render', dir, '--composition', 'composition/index.html', '--output', temporary, '--format', 'mp4', '--quality', 'looks', '--fps', String(fps)];
    try {
        const result = await (deps.runFixedCommand ?? runFixedCommand)(process.execPath, args, {
            cwd: dir,
            env: rendererEnvironment(dir, env),
            signal,
            timeoutMs,
        }, deps);
        if (result.termination === 'timeout') throw appError('COMPARE_RENDER_TIMEOUT', '对比渲染超过 30 分钟。');
        if (result.termination === 'cancelled') throw appError('COMPARE_RENDER_FAILED', '对比渲染已取消。');
        if (result.exitCode !== 0) {
            const detail = (result.stderr || result.stdout || '').trim();
            throw appError('COMPARE_RENDER_FAILED', detail || `HyperFrames 渲染失败（退出码 ${result.exitCode}）。`);
        }
        await fs.rename(temporary, outputFile);
        return { provider: 'local-hyperframes', version: HYPERFRAMES_VERSION };
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

function verifyOutput(media, fps, frames) {
    const problems = [];
    if (media.width !== 1080 || media.height !== 1920) problems.push('尺寸不是 1080×1920');
    if (Math.abs(media.fps - fps) > 0.0001) problems.push(`帧率 ${media.fps} 与 ${fps} 不同`);
    if (media.frames !== frames) problems.push(`帧数 ${media.frames} 与 ${frames} 不同`);
    if (Math.abs(media.duration - frames / fps) > 1 / fps + 0.001) problems.push('时长与计划不符');
    // render-hyperframes always muxes one audio track, including silent AAC for audio:none.
    if (media.videoStreams !== 1 || media.audioStreams !== 1) problems.push('必须有一个视频流和一个音频流');
    if (problems.length) throw appError('COMPARE_VERIFY_FAILED', `对比视频验收失败: ${problems.join('；')}。`);
}

async function publishComparison(config, slug, versionNumber, comparison) {
    // Only serialize comparison publication; rendering and probing stay concurrent.
    const lock = `${config.catalogPath}.compare-lock`;
    const deadline = Date.now() + 10000;
    while (true) {
        try {
            await fs.mkdir(lock);
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) {
                throw appError('COMPARE_CATALOG_BUSY', `等待对比目录登记锁超过 10 秒: ${lock}。当前版本已保留，catalog 未更新。`);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    try {
        const fresh = await readCatalog(config.catalogPath);
        const current = findProduction(fresh, slug);
        if (!current) throw invalid(`制作项目在渲染期间被移除: ${slug}`);
        const currentVersion = Number(String(current.comparison?.version ?? '0').replace(/^v/, ''));
        if (currentVersion < versionNumber) {
            current.comparison = comparison;
            const pendingCatalog = path.join(lock, 'catalog.json');
            await writeCatalog(pendingCatalog, fresh);
            await fs.rename(pendingCatalog, config.catalogPath);
        }
        return current;
    } finally {
        await fs.rm(lock, { recursive: true, force: true });
    }
}

export async function compareProduction(config, {
    slug, top, bottom, topLabel = '合成版', bottomLabel,
    audio = 'top', topStart = 0, bottomStart = 0, duration,
} = {}, deps = {}) {
    const probe = deps.probeMedia ?? probeMedia;
    const writeProject = deps.writeComparisonProject ?? writeComparisonProject;
    const silence = deps.writeSilence ?? writeSilence;
    const render = deps.renderComparison ?? renderComparison;
    const progress = deps.progress ?? ((message) => process.stderr.write(`[compare] ${message}\n`));
    if (!['top', 'bottom', 'none'].includes(audio)) throw invalid('audio 必须是 top、bottom 或 none。');
    const requestedTopStart = number(topStart, 'topStart');
    const requestedBottomStart = number(bottomStart, 'bottomStart');
    const requestedDuration = duration === undefined ? undefined : number(duration, 'duration', true);
    const catalog = await readCatalog(config.catalogPath);
    const production = findProduction(catalog, slug);
    if (!production) throw invalid(`未找到制作项目: ${slug}`);
    const topPath = resolveInput(config.workspace, top, 'top');
    let previousBottom;
    if (bottom === undefined) {
        if (!production.comparison) throw invalid('首次生成必须指定 bottom；后续可复用上次固定基准。');
        const previous = production.comparison;
        try {
            const manifest = JSON.parse(await fs.readFile(path.resolve(config.workspace, previous.dir, previous.manifest ?? 'MANIFEST.json'), 'utf8'));
            previousBottom = manifest.inputs?.bottom;
        } catch (error) {
            throw invalid(`无法读取上次对比基准: ${error.message}`);
        }
        if (!previousBottom?.path || !previousBottom.sha256) throw invalid('上次 MANIFEST 缺少基准路径或 SHA256。');
        bottom = previousBottom.path;
    }
    const bottomPath = resolveInput(config.workspace, bottom, 'bottom');
    const [topHash, bottomHash, topMedia, bottomMedia] = await Promise.all([
        sha256(topPath), sha256(bottomPath), probe(topPath), probe(bottomPath),
    ]);
    if (previousBottom && bottomHash !== previousBottom.sha256) {
        throw invalid('固定 bottom 基准的 SHA256 已变化；请显式指定 bottom 确认新基准。');
    }
    if (audio !== 'none' && !(audio === 'top' ? topMedia : bottomMedia).hasAudio) {
        throw invalid(`所选 ${audio} 视频没有音轨；请选择另一输入或 audio=none。`);
    }
    const fps = topMedia.fps;
    const frameRate = formatFrameRate(topMedia.frameRate, fps);
    if (!Number.isFinite(fps) || fps <= 0) throw invalid('top 视频帧率无效。');
    const topStartFrame = Math.round(requestedTopStart * fps);
    const bottomStartFrame = Math.round(requestedBottomStart * fps);
    const topAvailable = Math.floor(topMedia.duration * fps + 0.0001) - topStartFrame;
    const bottomAvailable = Math.floor(bottomMedia.duration * fps + 0.0001) - bottomStartFrame;
    if (requestedTopStart >= topMedia.duration || requestedBottomStart >= bottomMedia.duration
        || topAvailable < 1 || bottomAvailable < 1) throw invalid('起始秒数超出输入视频范围。');
    if (requestedDuration === undefined && topAvailable !== bottomAvailable) {
        throw invalid('上下输入剩余时长不同，请显式指定 duration，避免静默裁切。');
    }
    const frames = requestedDuration === undefined ? topAvailable : Math.round(requestedDuration * fps);
    if (frames < 1) throw invalid('duration 不足一帧。');
    if (frames > topAvailable || frames > bottomAvailable
        || (requestedDuration !== undefined && (requestedTopStart + requestedDuration > topMedia.duration + 0.0001
            || requestedBottomStart + requestedDuration > bottomMedia.duration + 0.0001))) {
        throw invalid('所选时间范围超出输入视频。');
    }
    const inputs = {
        top: { path: topPath, sha256: topHash, media: topMedia, label: String(topLabel), startSeconds: topStartFrame / fps, startFrame: topStartFrame },
        bottom: { path: bottomPath, sha256: bottomHash, media: bottomMedia, label: String(bottomLabel ?? previousBottom?.label ?? '原版预览'), startSeconds: bottomStartFrame / fps, startFrame: bottomStartFrame },
    };
    const reserved = await reserveVersion(path.resolve(config.workspace, production.dir, 'drafts', 'comparisons'));
    const { dir } = reserved;
    const versionNumber = reserved.version;
    const version = `v${versionNumber}`;
    const createdAt = new Date().toISOString();
    let stage = 'project';
    try {
        progress(`${version}: 写入构图，${frames} 帧 @ ${frameRate} fps`);
        const project = await writeProject({
            dir, top: topPath, bottom: bottomPath, topLabel: inputs.top.label, bottomLabel: inputs.bottom.label,
            audio, fps, frameRate, frames, topStartFrame, bottomStartFrame,
        });
        if (audio === 'none') {
            stage = 'silence';
            await silence(path.join(dir, 'composition', 'silence.m4a'), frames / fps);
        }
        stage = 'render';
        progress(`${version}: 开始渲染`);
        const file = path.join(dir, 'comparison.mp4');
        const rendered = await render({
            dir, fps: frameRate, outputFile: file, env: config.env, signal: deps.signal,
        }, deps) ?? {};
        stage = 'verify';
        progress(`${version}: 渲染完成，检查尺寸、帧数和音轨`);
        const verification = await probe(file);
        verifyOutput(verification, fps, frames);
        // Detect a source replaced during rendering before publishing its recorded hash.
        const [finalTopHash, finalBottomHash] = await Promise.all([sha256(topPath), sha256(bottomPath)]);
        if (finalTopHash !== topHash || finalBottomHash !== bottomHash) throw invalid('渲染期间输入视频发生变化，请使用稳定的输入文件重新生成。');
        const manifest = {
            schema: 'video-remake.comparison@1', slug, version, createdAt,
            layout: project.layout, inputs,
            render: {
                fps, frames, duration: frames / fps, audio,
                provider: rendered.provider || 'local-hyperframes', version: rendered.version || HYPERFRAMES_VERSION,
                composition: 'composition/index.html',
            },
            project: { composition: path.relative(dir, project.composition).split(path.sep).join('/') },
            file: 'comparison.mp4', verification,
        };
        stage = 'manifest';
        await fs.writeFile(path.join(dir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        stage = 'catalog';
        const current = await publishComparison(config, slug, versionNumber, {
            version, dir: path.relative(config.workspace, dir).split(path.sep).join('/'),
            file: 'comparison.mp4', manifest: 'MANIFEST.json',
        });
        progress(`${version}: 已保存 ${file}`);
        return { command: 'compare', slug, version, file, manifest, production: current };
    } catch (error) {
        await fs.writeFile(path.join(dir, 'FAILED.json'), `${JSON.stringify({
            schema: 'video-remake.comparison-failure@1', slug, version, createdAt,
            failedAt: new Date().toISOString(), stage, inputs,
            error: { code: error.code ?? 'COMPARE_FAILED', message: error.message },
        }, null, 2)}\n`).catch(() => {});
        throw error;
    }
}

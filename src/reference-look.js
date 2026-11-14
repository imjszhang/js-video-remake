import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appError } from './errors.js';
import { findReference } from './catalog.js';
import { readReferenceCatalog, readReferenceSource } from './references.js';
import { isWithin } from './schema.js';

const execFileAsync = promisify(execFile);
const SCENE_THRESHOLD = 0.3;
const DEDUP_GAP = 0.4;
const MAX_UNIFORM_FPS = 2;
const DEFAULT_WIDTH = 1024;
const DEFAULT_MAX_FRAMES = 100;

function invalid(message) {
    throw appError('INVALID_INPUT', message);
}

function roundTime(value) {
    return Math.round(value * 1000) / 1000;
}

function clockNumber(value) {
    return String(roundTime(value));
}

function parseClock(value, name) {
    if (typeof value !== 'string' || !value.trim()) invalid(`${name} 必须是秒数或时间码。`);
    const text = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return roundTime(Number(text));
    const match = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
    if (!match) invalid(`${name} 必须是秒数或 MM:SS、HH:MM:SS。`);
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes > 59 || seconds >= 60) invalid(`${name} 的分和秒必须小于 60。`);
    return roundTime(hours * 3600 + minutes * 60 + seconds);
}

function integerOption(value, name, { min, max, fallback }) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) invalid(`${name} 必须是整数。`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) invalid(`${name} 必须在 ${min} 到 ${max} 之间。`);
    return number;
}

function assertInside(time, duration, name) {
    if (time < 0 || time > duration) invalid(`${name} 超出原片时长。`);
    return time;
}

async function readableVideo(file) {
    try {
        await fs.access(file, constants.R_OK);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size === 0) throw new Error();
        return stat;
    } catch (error) {
        if (error.code === 'SOURCE_ASSET_MISSING') throw error;
        throw appError('SOURCE_ASSET_MISSING', '原片不存在、为空或不可读取。');
    }
}

async function probeDuration(file, deps) {
    try {
        const result = deps.probe ? await deps.probe(file) : await probeWithFfprobe(file);
        const duration = roundTime(Number(result?.duration ?? result));
        if (!Number.isFinite(duration) || duration <= 0) throw appError('LOOK_FAILED', '无法读取原片时长。');
        return duration;
    } catch (error) {
        if (error.code === 'LOOK_FAILED') throw error;
        throw appError('LOOK_FAILED', `无法读取原片时长: ${error.message}`);
    }
}

async function probeWithFfprobe(file) {
    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file,
    ], { maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout);
    return { duration: Number(data.format?.duration) };
}

async function runFfmpeg(args, deps) {
    if (deps.runFfmpeg) {
        const result = await deps.runFfmpeg(args);
        return { stdout: result?.stdout || '', stderr: result?.stderr || '' };
    }
    try {
        const { stdout, stderr } = await execFileAsync('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024 });
        return { stdout: String(stdout || ''), stderr: String(stderr || '') };
    } catch (error) {
        throw appError('LOOK_FAILED', `ffmpeg 失败: ${String(error.stderr || error.message).trim().slice(-800)}`);
    }
}

async function fileHash(file, deps) {
    const digest = deps.hashFile
        ? await deps.hashFile(file)
        : await hashFile(file);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
        throw appError('LOOK_FAILED', '原片哈希无效。');
    }
    return digest;
}

async function hashFile(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

function parseSceneTimes(stderr) {
    const times = [];
    for (const match of String(stderr || '').matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
        const time = roundTime(Number(match[1]));
        if (Number.isFinite(time) && time >= 0) times.push(time);
    }
    return times;
}

function dedupTimes(times) {
    const kept = [];
    for (const time of [...times].sort((left, right) => left - right)) {
        if (!kept.length || time - kept[kept.length - 1] >= DEDUP_GAP) kept.push(time);
    }
    return kept;
}

function awayFrom(time, anchors) {
    return anchors.every(anchor => Math.abs(anchor - time) >= DEDUP_GAP);
}

function sampleEvenly(times, count) {
    if (times.length <= count) return times;
    if (count <= 0) return [];
    const indexes = new Set();
    if (count === 1) indexes.add(Math.floor((times.length - 1) / 2));
    else {
        for (let index = 0; index < count; index += 1) {
            indexes.add(Math.round(index * (times.length - 1) / (count - 1)));
        }
    }
    return [...indexes].sort((left, right) => left - right).map(index => times[index]);
}

function uniformTimes(start, end, count) {
    if (count <= 0) return [];
    const span = end - start;
    if (count === 1) return [roundTime(start + span / 2)];
    const step = span / count;
    return Array.from({ length: count }, (_, index) => roundTime(start + (index + 0.5) * step));
}

function selectLookTimes({ start, end, cues, sceneTimes, maxFrames }) {
    const chosen = [...cues].sort((left, right) => left - right);
    const budget = maxFrames - chosen.length;
    const scenes = dedupTimes(sceneTimes.filter(time => time >= start && time <= end && awayFrom(time, chosen)));
    let selection = 'scene';
    let sampled = [];
    if (budget > 0 && scenes.length >= 4) {
        sampled = sampleEvenly(scenes, budget);
    } else if (budget > 0) {
        selection = 'uniform';
        const span = end - start;
        const rateCap = Math.max(1, Math.floor(span * MAX_UNIFORM_FPS));
        sampled = uniformTimes(start, end, Math.min(budget, rateCap)).filter(time => awayFrom(time, chosen));
    }
    const frames = [
        ...chosen.map(time => ({ time, cue: true })),
        ...sampled.map(time => ({ time, cue: false })),
    ].sort((left, right) => left.time - right.time || Number(right.cue) - Number(left.cue));
    return { selection, frames };
}

function parseVttTime(value) {
    const match = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value || '');
    if (!match) return null;
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes > 59 || seconds >= 60) return null;
    return roundTime(hours * 3600 + minutes * 60 + seconds);
}

function parseVtt(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    if (!/^WEBVTT\b/i.test(lines[0]?.trim() || '') && !text.includes('-->')) {
        throw new Error('不是 WebVTT');
    }
    const cues = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes('-->')) continue;
        const [rawStart, rawRest] = lines[index].split('-->');
        const start = parseVttTime(rawStart.trim().split(/\s+/)[0]);
        const end = parseVttTime(rawRest.trim().split(/\s+/)[0]);
        const textLines = [];
        index += 1;
        while (index < lines.length && lines[index].trim() !== '') {
            textLines.push(lines[index]);
            index += 1;
        }
        const caption = textLines.join('\n').trim();
        if (start == null || end == null || end < start || !caption) continue;
        cues.push({ start, end, text: caption });
    }
    return cues;
}

function captionTime(item) {
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        throw new Error('时间无效');
    }
    return { start: roundTime(start), end: roundTime(end) };
}

function parseTranscript(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('格式不对');
    const useSegments = Array.isArray(json.segments) && json.segments.length > 0;
    const rows = useSegments ? json.segments : Array.isArray(json.words) ? json.words : null;
    if (!rows) throw new Error('缺少 segments 或 words');
    return rows.map(item => {
        const text = useSegments ? item?.text : (item?.word ?? item?.text);
        if (!item || typeof text !== 'string') throw new Error('缺少文本');
        const time = captionTime(item);
        return { source: 'transcript', ...time, text: text.trim() };
    }).filter(item => item.text);
}

async function loadCaptions(refDir, source) {
    const cues = [];
    const warnings = [];
    const subs = source.absSubs && typeof source.absSubs === 'object' ? source.absSubs : {};
    for (const [lang, file] of Object.entries(subs)) {
        if (typeof file !== 'string' || !path.isAbsolute(file)) {
            warnings.push(`字幕 ${lang} 的路径无效。`);
            continue;
        }
        let text;
        try {
            text = await fs.readFile(file, 'utf8');
        } catch {
            warnings.push(`字幕 ${lang} 无法读取。`);
            continue;
        }
        try {
            for (const cue of parseVtt(text)) cues.push({ source: 'vtt', lang, ...cue });
        } catch {
            warnings.push(`字幕 ${lang} 不是有效的 WebVTT。`);
        }
    }
    const transcriptPath = path.join(refDir, 'transcript.json');
    let transcriptStat;
    try { transcriptStat = await fs.lstat(transcriptPath); }
    catch (error) { if (error.code !== 'ENOENT') warnings.push('transcript.json 无法读取。'); }
    if (transcriptStat?.isSymbolicLink()) warnings.push('transcript.json 不能是软链接。');
    else if (transcriptStat?.isFile()) {
        try {
            cues.push(...parseTranscript(JSON.parse(await fs.readFile(transcriptPath, 'utf8'))));
        } catch {
            warnings.push('transcript.json 不是有效的转写结果。');
        }
    } else if (transcriptStat) warnings.push('transcript.json 不是普通文件。');
    return { cues, warnings };
}

function captionsAt(cues, time) {
    return cues
        .filter(cue => cue.start <= time && time <= cue.end)
        .map(({ source, lang, start, end, text }) => ({ source, ...(lang ? { lang } : {}), start, end, text }))
        .sort((left, right) => left.start - right.start || left.source.localeCompare(right.source));
}

async function referenceDirectory(config, reference) {
    const root = path.resolve(config.workspace, 'references');
    if (typeof reference.dir !== 'string' || !reference.dir.trim()) {
        throw appError('SOURCE_PROTOCOL', '参考记录缺少目录。');
    }
    const dir = path.resolve(config.workspace, reference.dir);
    if (!isWithin(root, dir)) throw appError('ASSET_OUTSIDE_ROOT', '参考记录目录越出 references。');
    let stat;
    try { stat = await fs.lstat(dir); }
    catch { throw appError('SOURCE_UNAVAILABLE', `无法读取参考记录 ${reference.id} 的目录。`); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw appError('ASSET_OUTSIDE_ROOT', '参考记录目录不能是软链接。');
    const real = await fs.realpath(dir);
    const workspace = await fs.realpath(config.workspace);
    if (!isWithin(workspace, real) || !isWithin(path.resolve(workspace, 'references'), real)) {
        throw appError('ASSET_OUTSIDE_ROOT', '参考记录目录越出 references。');
    }
    return real;
}

async function publishLook(refDir, staging) {
    const finalDir = path.join(refDir, 'look');
    let stat;
    try { stat = await fs.lstat(finalDir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw appError('SOURCE_ASSET_INVALID', 'look 目录不能是软链接。');
    if (stat && !stat.isDirectory()) throw appError('SOURCE_ASSET_INVALID', 'look 路径已被非目录占用。');
    const backup = path.join(refDir, `.look-backup-${randomUUID()}`);
    let moved = false;
    try {
        if (stat) {
            await fs.rename(finalDir, backup);
            moved = true;
        }
        await fs.rename(staging, finalDir);
        if (moved) await fs.rm(backup, { recursive: true, force: true });
    } catch (error) {
        if (moved) {
            await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
            await fs.rename(backup, finalDir).catch(() => {});
        }
        throw error;
    }
}

export async function lookReference(config, { id, start, end, at = [], width, maxFrames } = {}, deps = {}) {
    if (typeof id !== 'string' || !id.trim()) invalid('reference:look 需要一个参考 ID。');
    if (!Array.isArray(at) || at.some(item => typeof item !== 'string')) invalid('--at 必须是时间。');
    const frameWidth = integerOption(width, '--width', { min: 256, max: 1920, fallback: DEFAULT_WIDTH });
    const frameCap = integerOption(maxFrames, '--max-frames', { min: 1, max: 250, fallback: DEFAULT_MAX_FRAMES });
    const catalog = await readReferenceCatalog(config);
    const reference = findReference(catalog, id);
    if (!reference) throw appError('NOT_FOUND', `没有这条参考: ${id}`);
    const source = await readReferenceSource(config, reference);
    const refDir = await referenceDirectory(config, reference);
    const stat = await readableVideo(source.videoPath);
    const duration = await probeDuration(source.videoPath, deps);
    const rangeStart = start === undefined ? 0 : assertInside(parseClock(start, '--start'), duration, '--start');
    const rangeEnd = end === undefined ? duration : assertInside(parseClock(end, '--end'), duration, '--end');
    if (rangeEnd <= rangeStart) invalid('--end 必须晚于 --start。');
    const cueTimes = [];
    for (const value of at) {
        const time = assertInside(parseClock(value, '--at'), duration, '--at');
        if (time < rangeStart || time > rangeEnd) invalid('--at 必须落在 --start 和 --end 之间。');
        if (!cueTimes.some(item => Math.abs(item - time) < 0.001)) cueTimes.push(time);
    }
    if (cueTimes.length > frameCap) invalid('指定的时间点超过 --max-frames。');

    const recorded = typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256) ? source.sha256 : '';
    const sha256 = recorded && Number(source.bytes) === stat.size
        ? recorded
        : await fileHash(source.videoPath, deps);
    const warnings = [];
    let sceneTimes = [];
    let sceneFailed = false;
    try {
        const filter = `select='gt(scene,${SCENE_THRESHOLD})*between(t,${clockNumber(rangeStart)},${clockNumber(rangeEnd)})',showinfo`;
        const detected = await runFfmpeg([
            '-hide_banner', '-nostdin', '-i', source.videoPath,
            '-vf', filter, '-an', '-f', 'null', '-',
        ], deps);
        sceneTimes = parseSceneTimes(detected.stderr);
    } catch {
        sceneFailed = true;
    }
    const selected = selectLookTimes({
        start: rangeStart, end: rangeEnd, cues: cueTimes, sceneTimes, maxFrames: frameCap,
    });
    if (sceneFailed) {
        warnings.push(selected.selection === 'uniform'
            ? '场景检测失败，已改为均匀抽帧。'
            : '场景检测失败，已保留指定时间点。');
    }
    if (!selected.frames.length) invalid('这个时间范围内抽不出帧。');
    const { cues, warnings: captionWarnings } = await loadCaptions(refDir, source);
    warnings.push(...captionWarnings);

    const staging = path.join(refDir, `.look-staging-${randomUUID()}`);
    let published = false;
    try {
        await fs.mkdir(path.join(staging, 'frames'), { recursive: true });
        const frames = [];
        for (const [index, frame] of selected.frames.entries()) {
            const file = `frames/${String(index + 1).padStart(3, '0')}.jpg`;
            const output = path.join(staging, file);
            await runFfmpeg([
                '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source.videoPath,
                '-ss', clockNumber(frame.time), '-frames:v', '1',
                '-vf', `scale=${frameWidth}:-2`, '-q:v', '3', output,
            ], deps);
            const written = await fs.stat(output).catch(() => null);
            if (!written?.isFile() || written.size === 0) throw appError('LOOK_FAILED', '抽帧没有产生有效图片。');
            frames.push({
                file: file.split(path.sep).join('/'),
                time: frame.time,
                cue: frame.cue,
                captions: captionsAt(cues, frame.time),
            });
        }
        const index = {
            schema: 'video-remake.reference-look@1',
            referenceId: reference.id,
            videoPath: source.videoPath,
            sha256,
            bytes: stat.size,
            range: { start: rangeStart, end: rangeEnd },
            width: frameWidth,
            selection: selected.selection,
            frames,
            warnings,
        };
        await fs.writeFile(path.join(staging, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
        await publishLook(refDir, staging);
        published = true;
    } finally {
        if (!published) await fs.rm(staging, { recursive: true, force: true });
    }

    const relativeDir = path.relative(config.workspace, path.join(refDir, 'look')).split(path.sep).join('/');
    const captions = selected.frames.some(frame => captionsAt(cues, frame.time).length) ? 'aligned' : 'none';
    return {
        command: 'reference:look',
        referenceId: reference.id,
        dir: relativeDir,
        index: `${relativeDir}/index.json`,
        frameCount: selected.frames.length,
        range: { start: rangeStart, end: rangeEnd },
        width: frameWidth,
        selection: selected.selection,
        sha256,
        bytes: stat.size,
        captions,
        warnings,
        next: '阅读 look/index.json 和全部帧，把镜头、版式、字幕和声音写进参考目录的 ANALYSIS.md 与 TIMELINE.md。',
    };
}

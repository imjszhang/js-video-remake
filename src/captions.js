import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError } from './errors.js';
import { frameSeconds } from './composition-html.js';
import { captionBlock } from './production-template.js';
import { resolveVideo } from './videos.js';
import { rendererEnvironment, runFixedCommand } from './repro/render.js';

const HYPERFRAMES_CLI = fileURLToPath(new URL('../node_modules/hyperframes/bin/hyperframes.mjs', import.meta.url));
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿]/;
const invalid = (message) => appError('CAPTION_INVALID', message);

function wordText(word) {
    return String(word?.word ?? word?.text ?? '').trim();
}

export function transcriptWords(raw) {
    if (!raw || typeof raw !== 'object') throw invalid('转写必须是 JSON 对象。');
    const words = [];
    const push = (text, start, end) => {
        if (!text) return;
        const from = Number(start);
        const to = Number(end);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || from < 0) throw invalid(`转写时间无效: ${text}`);
        words.push({ text, start: from, end: to });
    };
    if (Array.isArray(raw.segments) && raw.segments.length) {
        for (const segment of raw.segments) {
            if (Array.isArray(segment.words) && segment.words.length) {
                for (const word of segment.words) push(wordText(word), word.start, word.end);
            } else {
                push(String(segment.text || '').trim(), segment.start, segment.end);
            }
        }
    } else if (Array.isArray(raw.words)) {
        for (const word of raw.words) push(wordText(word), word.start, word.end);
    }
    if (!words.length) throw invalid('转写里没有可用的词或句子。');
    return words;
}

function joinCue(left, right) {
    const next = right.trim();
    if (!left) return next;
    if (CJK.test(left.at(-1) || '') || CJK.test(next[0] || '')) return `${left}${next}`;
    return `${left} ${next}`;
}

const SENTENCE_END = /[.!?。！？][)"'\]}」』）]*$/;
const MAX_GAP_SEC = 0.8;

export function groupCues(words, maxChars = 16) {
    const limit = Number(maxChars);
    if (!Number.isInteger(limit) || limit < 1 || limit > 80) throw invalid('max-chars 必须是 1–80 的整数。');
    const cues = [];
    let current = null;
    for (const word of words) {
        const text = current ? joinCue(current.text, word.text) : word.text.trim();
        const pause = current && word.start - current.end > MAX_GAP_SEC;
        if (!current || pause || text.length > limit) {
            current = { text: word.text.trim(), start: word.start, end: word.end };
            cues.push(current);
        } else {
            current.text = text;
            current.end = word.end;
        }
        if (SENTENCE_END.test(current.text)) current = null;
    }
    return cues;
}

export function snapCues(cues, fps) {
    const rate = Number(fps);
    if (!Number.isInteger(rate) || rate < 1 || rate > 240) throw invalid('字幕帧率必须是 1–240 的整数。');
    const snapped = [];
    for (const cue of cues) {
        const previousEnd = snapped.at(-1)?.endFrame ?? 0;
        const startFrame = Math.max(previousEnd, Math.round(cue.start * rate));
        const endFrame = Math.max(startFrame + 1, Math.round(cue.end * rate));
        snapped.push({
            text: cue.text,
            startFrame,
            endFrame,
            start: Number(frameSeconds(startFrame, rate)),
            end: Number(frameSeconds(endFrame, rate)),
        });
    }
    return snapped;
}

export function cuesFromWhisper(raw, { maxChars = 16, fps = 30 } = {}) {
    return snapCues(groupCues(transcriptWords(raw), maxChars), fps);
}

export function hyperframesTranscript(cues) {
    return { words: cues.map((cue) => ({ text: cue.text, start: cue.start, end: cue.end })) };
}

function readFps(html) {
    const match = /data-fps="(\d+)"/.exec(html);
    return match ? Number(match[1]) : 30;
}

export function captionId(file) {
    const id = path.basename(file).replace(/\.json$/i, '').replace(/\.transcript$/i, '')
        .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    return /^[a-z]/.test(id) ? id : `captions-${id || 'track'}`;
}

async function transcriptFile(config, dir, from) {
    const candidates = path.isAbsolute(from) ? [from] : [path.resolve(dir, from), path.resolve(config.workspace, from)];
    for (const file of candidates) {
        try {
            await fs.access(file);
            return file;
        } catch { /* try the next base */ }
    }
    throw invalid(`找不到转写文件: ${from}`);
}

export async function writeCaptions(config, { slug, video, from, maxChars, fps } = {}, deps = {}) {
    if (!from) throw invalid('captions 需要 --from <transcript.json>。');
    const pkg = await resolveVideo(config, slug, video);
    const dir = pkg.productionDir;
    const source = await transcriptFile(config, dir, from);
    let raw;
    try {
        raw = JSON.parse(await fs.readFile(source, 'utf8'));
    } catch (error) {
        throw invalid(`无法读取转写 ${source}: ${error.message}`);
    }
    let declared = pkg.manifest.frame?.fps;
    if (!declared) {
        try {
            declared = readFps(await fs.readFile(path.join(pkg.dir, pkg.manifest.entry || 'index.html'), 'utf8'));
        } catch {
            throw invalid(`videos/${pkg.name} 没有入口 HTML，也没有在 video.json 声明 frame.fps。`);
        }
    }
    const cues = cuesFromWhisper(raw, { maxChars: maxChars ?? 16, fps: fps ?? declared });
    const id = captionId(source);
    // The track lives inside the package so the package stays self-contained.
    const folder = path.join(pkg.dir, 'captions');
    await fs.mkdir(folder, { recursive: true });
    const jsonFile = path.join(folder, `${id}.json`);
    const srtFile = path.join(folder, `${id}.srt`);
    const htmlFile = path.join(folder, `${id}.html`);
    await fs.writeFile(jsonFile, `${JSON.stringify(hyperframesTranscript(cues), null, 2)}\n`, 'utf8');
    const run = deps.runCommand || runFixedCommand;
    const args = [HYPERFRAMES_CLI, 'transcribe', jsonFile, '--to', 'srt', '--preserve-cues', '--output', srtFile];
    const result = await run(process.execPath, args, {
        cwd: folder,
        env: rendererEnvironment(folder, config.env || process.env),
        timeoutMs: deps.timeoutMs ?? 60_000,
    });
    if (result?.exitCode !== 0) throw invalid(`字幕导出失败（退出码 ${result?.exitCode}）。${result?.stderr || ''}`);
    await fs.writeFile(htmlFile, `${captionBlock({ id, cues, fps: Number(fps ?? declared) })}\n`, 'utf8');
    return {
        command: 'captions',
        slug,
        video: pkg.name,
        id,
        cues: cues.length,
        files: {
            json: path.relative(config.workspace, jsonFile),
            srt: path.relative(config.workspace, srtFile),
            html: path.relative(config.workspace, htmlFile),
        },
    };
}

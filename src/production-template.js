import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from './errors.js';
import { embedVariableFonts, escapeHtml, frameSeconds, seconds } from './composition-html.js';

export const DEFAULT_FRAME = Object.freeze({ width: 1080, height: 1920, fps: 30, durationSec: 10 });

const invalid = (message) => appError('COMPOSITION_INVALID', message);

function positiveInt(value, name, max = 7680) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > max) throw invalid(`${name} 必须是 1–${max} 的整数。`);
    return number;
}

export function parseFrameOptions({ width, height, fps, duration } = {}) {
    const frame = {
        width: width === undefined ? DEFAULT_FRAME.width : positiveInt(width, 'width'),
        height: height === undefined ? DEFAULT_FRAME.height : positiveInt(height, 'height'),
        fps: fps === undefined ? DEFAULT_FRAME.fps : positiveInt(fps, 'fps', 240),
        durationSec: duration === undefined ? DEFAULT_FRAME.durationSec : Number(duration),
    };
    if (!Number.isFinite(frame.durationSec) || frame.durationSec <= 0 || frame.durationSec > 60 * 60) {
        throw invalid('duration 必须是 0–3600 秒之间的正数。');
    }
    frame.frames = Math.max(1, Math.round(frame.durationSec * frame.fps));
    frame.durationSec = frame.frames / frame.fps;
    return frame;
}

export function mediaSnippet({ kind, id, src, start = '0', duration = '1', mediaStart = '0', volume = '1' }) {
    const safeId = escapeHtml(id);
    const safeSrc = escapeHtml(src);
    const safeStart = escapeHtml(start);
    const safeDuration = escapeHtml(duration);
    if (kind === 'image') {
        return `<img id="${safeId}" class="clip" src="${safeSrc}" alt="" data-start="${safeStart}" data-duration="${safeDuration}">`;
    }
    if (kind === 'video') {
        return `<video id="${safeId}" class="clip" src="${safeSrc}" muted playsinline data-start="${safeStart}" data-duration="${safeDuration}" data-media-start="${escapeHtml(mediaStart)}"></video>`;
    }
    if (kind === 'audio') {
        return `<audio id="${safeId}" class="clip" src="${safeSrc}" data-start="${safeStart}" data-duration="${safeDuration}" data-media-start="${escapeHtml(mediaStart)}" data-volume="${escapeHtml(volume)}"></audio>`;
    }
    throw invalid(`不支持的素材类型: ${kind}`);
}

export function captionBlock({ id, cues, fps }) {
    const rows = cues.map((cue, index) => {
        const start = frameSeconds(cue.startFrame, fps);
        const duration = frameSeconds(cue.endFrame - cue.startFrame, fps);
        return `    <div id="${escapeHtml(id)}-${index}" class="clip caption" data-start="${start}" data-duration="${duration}"><span>${escapeHtml(cue.text)}</span></div>`;
    });
    return `<!-- 贴到代码视频包入口 HTML 的 #root 内。HyperFrames 按 data-start / data-duration 显隐每条字幕。 -->
<div id="captions-${escapeHtml(id)}" class="captions">
${rows.join('\n')}
</div>`;
}

export async function compositionHtml({ id, width, height, fps, frames, compositionDir }) {
    const fontCss = await embedVariableFonts(compositionDir);
    const duration = seconds(frames, fps);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(id)}</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    ${fontCss}
    html, body { margin: 0; background: #000; }
    #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
    .captions { position: absolute; left: 6%; right: 6%; bottom: 8%; height: 20%; }
    .caption { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; }
    .caption span { font-family: "Noto Sans SC Variable", "Inter Variable", sans-serif; font-weight: 600; font-size: 48px; line-height: 1.35; color: #fff; text-shadow: 0 2px 8px #000; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="${escapeHtml(id)}" data-width="${width}" data-height="${height}" data-fps="${fps}" data-duration="${duration}">
  </div>
  <script>
    const root = document.querySelector("[data-composition-id]");
    window.__timelines[root.dataset.compositionId] = gsap.timeline({ paused: true });
  </script>
</body>
</html>
`;
}

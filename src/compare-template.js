import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from './errors.js';
import { embedVariableFonts, escapeHtml, seconds } from './composition-html.js';

// Each comparison retains this generated source, so later template changes do
// not change the appearance of an existing version when it is rebuilt.
export const COMPARISON_LAYOUT = {
    name: 'portrait-stack',
    version: 1,
    width: 1080,
    height: 1920,
    fit: 'contain',
    background: '#0B1017',
    panels: {
        top: { x: 28, y: 352, width: 1024, height: 576 },
        bottom: { x: 28, y: 1072, width: 1024, height: 576 },
    },
};

export { seconds };

export async function comparisonFontCss(compositionDir) {
    return embedVariableFonts(compositionDir, {
        fail: (message) => appError('COMPARE_RENDER_FAILED', message),
    });
}

function panel(id, rect, src, duration, mediaStart) {
    return `    <div id="${id}-panel" style="position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;overflow:hidden;background:#000;">
      <video id="${id}-picture" src="${src}" muted playsinline data-start="0" data-duration="${duration}" data-media-start="${mediaStart}" style="display:block;width:100%;height:100%;object-fit:contain;background:#000;"></video>
    </div>`;
}

export async function writeComparisonProject({
    dir, top, bottom, topLabel = '合成版', bottomLabel = '原版预览',
    audio = 'top', fps, frameRate = fps, frames, topStartFrame = 0, bottomStartFrame = 0,
}) {
    const compositionDir = path.join(dir, 'composition');
    const composition = path.join(compositionDir, 'index.html');
    await fs.mkdir(compositionDir, { recursive: true });
    const fontCss = await comparisonFontCss(compositionDir);
    const duration = seconds(frames, fps);
    const topStart = seconds(topStartFrame, fps);
    const bottomStart = seconds(bottomStartFrame, fps);
    const mediaPath = (file) => escapeHtml(path.resolve(file));
    const soundSrc = audio === 'none'
        ? './silence.m4a'
        : mediaPath(audio === 'bottom' ? bottom : top);
    const soundStart = audio === 'bottom' ? bottomStart : audio === 'top' ? topStart : '0';
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Comparison</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    ${fontCss}
    body { margin: 0; background: ${COMPARISON_LAYOUT.background}; }
    #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${COMPARISON_LAYOUT.background}; }
    .label { position: absolute; left: 40px; width: 1000px; height: 64px; line-height: 64px; font-family: "Inter Variable", "Noto Sans SC Variable", sans-serif; font-weight: 600; font-size: 42px; white-space: nowrap; overflow: hidden; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="comparison" data-width="${COMPARISON_LAYOUT.width}" data-height="${COMPARISON_LAYOUT.height}" data-fps="${escapeHtml(frameRate)}" data-duration="${duration}">
    <div id="backdrop" style="position:absolute;inset:0;background:${COMPARISON_LAYOUT.background};"></div>
${panel('top', COMPARISON_LAYOUT.panels.top, mediaPath(top), duration, topStart)}
${panel('bottom', COMPARISON_LAYOUT.panels.bottom, mediaPath(bottom), duration, bottomStart)}
    <div id="top-label" class="label" style="top:272px;color:#A7F3D0;">${escapeHtml(topLabel)}</div>
    <div id="bottom-label" class="label" style="top:992px;color:#E3E7ED;">${escapeHtml(bottomLabel)}</div>
    <audio id="sound" src="${soundSrc}" data-start="0" data-duration="${duration}" data-media-start="${soundStart}" data-volume="1"></audio>
  </div>
  <script>
    window.__timelines["comparison"] = gsap.timeline({ paused: true });
  </script>
</body>
</html>
`;
    await fs.writeFile(composition, html, 'utf8');
    return {
        composition,
        layout: structuredClone(COMPARISON_LAYOUT),
        output: 'comparison.mp4',
    };
}

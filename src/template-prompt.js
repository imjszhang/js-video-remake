import { appError } from './errors.js';

const LANGUAGES = new Set(['zh', 'en']);
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const fail = message => appError('VIDEO_INVALID', message);

const clock = seconds => {
    const total = Math.round(seconds * 1000);
    const hours = Math.floor(total / 3600000), minutes = Math.floor(total / 60000) % 60;
    const rest = Math.floor(total / 1000) % 60, millis = total % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Replace identity placeholders the same way speech synthesis does. A value that
 * is still the declared default means the user never filled it in, so it is
 * refused instead of silently being spoken.
 */
function spokenText(value, identity, fields, index, allowPlaceholders) {
    return value.replace(PLACEHOLDER, (match, key) => {
        if (!Object.hasOwn(identity, key) || typeof identity[key] !== 'string' || !identity[key].trim()) throw fail(`第 ${index + 1} 句含未填写的身份变量 ${match}，请先填写个人信息。`);
        const fallback = fields?.[key]?.default;
        if (!allowPlaceholders && typeof fallback === 'string' && fallback.trim() && identity[key] === fallback) throw fail(`第 ${index + 1} 句的身份变量 ${match} 仍是模板默认值「${fallback}」，请先填写个人信息。`);
        return identity[key];
    }).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}

/**
 * Build the speaking draft from the effective captions. Host-owned: reads only
 * caption rows and identity fields, never the template source or package files.
 */
export function buildPromptScript({ rows, identity = {}, fields = {}, duration, language = 'zh', gapSeconds = 2, allowPlaceholders = false } = {}) {
    if (!LANGUAGES.has(language)) throw fail('提词稿语言只能是中文或英文。');
    if (!Array.isArray(rows) || !rows.length) throw fail('没有可导出的字幕。');
    if (!Number.isFinite(duration) || duration <= 0) throw fail('模板时长无效。');
    if (!Number.isFinite(gapSeconds) || gapSeconds < 0.5 || gapSeconds > 60) throw fail('停顿阈值必须在 0.5–60 秒之间。');
    let previousEnd = 0;
    const lines = [];
    let skipped = 0, pauses = 0;
    for (const [index, row] of rows.entries()) {
        if (!row || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < previousEnd || row.end <= row.start || row.end > duration) throw fail(`第 ${index + 1} 句时间窗无效或与上一句重叠。`);
        previousEnd = row.end;
        const raw = row[language];
        if (typeof raw !== 'string' || raw.length > 2000) throw fail(`第 ${index + 1} 句文字无效或过长。`);
        const text = spokenText(raw, identity, fields, index, allowPlaceholders);
        if (!text) { skipped += 1; continue; }
        const previous = lines.at(-1);
        if (previous && row.start - previous.end >= gapSeconds) {
            pauses += 1;
            lines.push({ kind: 'pause', seconds: +(row.start - previous.end).toFixed(2), start: previous.end, end: row.start });
        }
        lines.push({ kind: 'line', index, start: row.start, end: row.end, text, charsPerSecond: +(text.length / (row.end - row.start)).toFixed(2) });
    }
    if (!lines.some(line => line.kind === 'line')) throw fail(`没有可朗读的${language === 'zh' ? '中文' : '英文'}字幕，请先填写字幕。`);
    const spoken = lines.filter(line => line.kind === 'line');
    return { language, duration, gapSeconds, count: spoken.length, skipped, pauses, lines };
}

export function promptText(script) {
    return `${script.lines.map(line => line.kind === 'pause' ? `……（停顿 ${line.seconds.toFixed(1)} 秒）……` : line.text).join('\n')}\n`;
}

export function promptSrt(script) {
    let cue = 0;
    return `${script.lines.filter(line => line.kind === 'line').map(line => `${++cue}\n${clock(line.start)} --> ${clock(line.end)}\n${line.text}\n`).join('\n')}`;
}

export function promptJson(script, { slug, video } = {}) {
    return `${JSON.stringify({
        format: 'video-prompt@1', slug, video, language: script.language, duration: script.duration,
        gapSeconds: script.gapSeconds, count: script.count, skipped: script.skipped, pauses: script.pauses,
        lines: script.lines.filter(line => line.kind === 'line').map(({ index, start, end, text, charsPerSecond }) => ({ index, start, end, text, charsPerSecond })),
    }, null, 2)}\n`;
}

/** A calm full-page card per line for tablets, printers or a second screen. */
export function promptCards(script, { title = '口播提词稿' } = {}) {
    const cards = script.lines.map(line => line.kind === 'pause'
        ? `<section class="pause"><p>停顿 ${line.seconds.toFixed(1)} 秒</p></section>`
        : `<section><p>${escapeHtml(line.text)}</p><footer>${clock(line.start).slice(3, 8)} · ${line.charsPerSecond} 字/秒</footer></section>`);
    return `<!doctype html>
<html lang="${script.language === 'zh' ? 'zh-CN' : 'en'}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f4f4f2;color:#1b1b1b}
section{display:flex;flex-direction:column;justify-content:center;min-height:45vh;margin:12px;padding:28px 32px;border-radius:18px;background:#fff;box-shadow:0 1px 3px #0001}
section p{font-size:clamp(24px,4vw,44px);line-height:1.45;margin:0}
section footer{margin-top:14px;font-size:15px;color:#888;font-variant-numeric:tabular-nums}
section.pause{min-height:auto;background:transparent;box-shadow:none;align-items:center}section.pause p{color:#999;font-size:20px}
@media print{body{background:#fff}section{break-after:page;min-height:70vh;box-shadow:none;border:1px solid #ddd}section.pause{break-inside:avoid}}
</style>
${cards.join('\n')}
</html>
`;
}

export const PROMPT_FORMATS = { txt: { ext: '.txt', type: 'text/plain; charset=utf-8' }, srt: { ext: '.srt', type: 'application/x-subrip; charset=utf-8' }, json: { ext: '.json', type: 'application/json; charset=utf-8' }, cards: { ext: '.html', type: 'text/html; charset=utf-8' } };

export function renderPromptScript(script, format, meta = {}) {
    if (!Object.hasOwn(PROMPT_FORMATS, format)) throw fail('提词稿格式只能是 txt、srt、json 或 cards。');
    if (format === 'txt') return promptText(script);
    if (format === 'srt') return promptSrt(script);
    if (format === 'json') return promptJson(script, meta);
    return promptCards(script, meta);
}

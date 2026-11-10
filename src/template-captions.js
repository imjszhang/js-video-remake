import { createHash } from 'node:crypto';
import { appError } from './errors.js';

const MAX_ROWS = 5000;
const MAX_TEXT = 2000;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => appError('VIDEO_INVALID', message);
const displayTime = (start, end) => `${start.toFixed(2)}–${end.toFixed(2)}`;

/** Recognize the fixed-timeline caption format without importing any package code. */
export function templateCaptionRows(raw, schema, duration) {
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ROWS || (Number.isInteger(schema?.count) && raw.length !== schema.count)) return null;
    if (raw.some((row, index) => !Array.isArray(row) || row.length !== 4 || !Number.isFinite(row[0]) || !Number.isFinite(row[1]) || row[0] < 0 || row[1] <= row[0] || (Number.isFinite(duration) && row[1] > duration + 0.001) || (index > 0 && row[0] < raw[index - 1][0]) || typeof row[2] !== 'string' || !row[2].trim() || row[2].length > MAX_TEXT || typeof row[3] !== 'string' || row[3].length > MAX_TEXT)) return null;
    return raw.map(([start, end, zh, en], index) => ({ index, start, end, at: displayTime(start, end), zh, en }));
}

export function mergeTemplateCaptionRows(original, overrides) {
    if (!Array.isArray(overrides) || overrides.length !== original.length) throw invalid(`字幕需要 ${original.length} 条，请保留原稿的条数。`);
    return original.map((row, index) => {
        const override = overrides[index];
        const zh = Array.isArray(override) ? override[0] : override?.zh;
        const en = (Array.isArray(override) ? override[1] : override?.en) ?? '';
        if (typeof zh !== 'string' || !zh.trim() || zh.length > MAX_TEXT || typeof en !== 'string' || en.length > MAX_TEXT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(zh + en)) throw invalid(`第 ${index + 1} 条字幕需要非空中文，中英文各不超过 ${MAX_TEXT} 字。`);
        return { ...row, zh, en };
    });
}

export function validateEditedCaptionRows(original, rows) {
    if (!Array.isArray(rows) || rows.length !== original.length) throw invalid(`字幕需要 ${original.length} 条，请保留原稿的条数。`);
    for (const [index, value] of rows.entries()) {
        if (!plainObject(value) || Object.keys(value).some(key => !['index', 'start', 'end', 'at', 'zh', 'en'].includes(key))) throw invalid(`第 ${index + 1} 条字幕格式无效。`);
        for (const key of ['index', 'start', 'end', 'at']) {
            if (value[key] !== undefined && value[key] !== original[index][key]) throw invalid('字幕时间轴与顺序不能修改，请只修改中英文文字。');
        }
    }
    return mergeTemplateCaptionRows(original, rows);
}

export function captionRevision(original, rows, sourcePath) {
    return createHash('sha256').update(JSON.stringify({ original, rows, sourcePath })).digest('hex');
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError } from './errors.js';

const FORMAT = 'video-style@1';
const CSS_FILE = 'src/shared.css';
const CONFIG_FILE = 'template-style.json';
const BEGIN = '\n/* video-remake:style:start */\n';
const END = '/* video-remake:style:end */\n';
const LIMIT = 2 * 1024 * 1024;
const KEYS = ['preset', 'background', 'foreground', 'accent', 'secondary', 'font', 'radius', 'captionScale', 'showHud', 'showGrid'];
const COLOR_KEYS = ['background', 'foreground', 'accent', 'secondary'];
const PRESETS = {
    midnight: { background: '#080f20', foreground: '#eef5ff', accent: '#60a5fa', secondary: '#fbbf24' },
    violet: { background: '#160e23', foreground: '#f5efff', accent: '#b794f6', secondary: '#f9a8d4' },
    forest: { background: '#091b18', foreground: '#e9fff5', accent: '#57d9a3', secondary: '#e9c46a' },
};
const LABELS = { original: '原始风格', midnight: '深海蓝', violet: '紫罗兰', forest: '森林绿', custom: '自定义' };
const error = message => appError('VIDEO_STYLE_INVALID', message);

async function safeFile(dir, relative, optional = false) {
    let current = path.resolve(dir);
    if ((await fs.lstat(current)).isSymbolicLink()) throw error('模板目录不能是符号链接。');
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (cause) { if (optional && cause.code === 'ENOENT') return null; throw cause; }
        if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw error(`样式文件必须是包内普通文件：${relative}`);
        if (i === parts.length - 1 && stat.size > LIMIT) throw error(`样式文件过大：${relative}`);
    }
    return current;
}

function splitCss(css) {
    const start = css.indexOf(BEGIN);
    if (start < 0) {
        if (css.includes('video-remake:style:')) throw error('公共样式的托管标记不完整，请先修复。');
        return css;
    }
    if (css.indexOf(BEGIN, start + BEGIN.length) >= 0 || !css.endsWith(END) || css.indexOf(END, start) !== css.length - END.length) throw error('公共样式的托管片段损坏，请先修复。');
    return css.slice(0, start);
}

function color(css, variable, fallback) {
    const value = new RegExp(`--${variable}\\s*:\\s*(#[a-fA-F0-9]{6}|#[a-fA-F0-9]{3})(?=\\s*;)`).exec(css)?.[1];
    return value ? hex(value) : fallback;
}
function hex(value) {
    const lowered = value.toLowerCase();
    return lowered.length === 4 ? `#${[...lowered.slice(1)].map(character => character.repeat(2)).join('')}` : lowered;
}
function defaults(css) {
    const radius = Number(/\.k-card\s*\{[^}]*border-radius\s*:\s*([\d.]+)px/.exec(css)?.[1] ?? 8);
    return { preset: 'original', background: color(css, 'bg', '#0c0e10'), foreground: color(css, 'ink', '#f2f3f5'), accent: color(css, 'blue', '#5b9bf5'), secondary: color(css, 'gold', '#f5b73b'), font: 'sans', radius: Math.min(32, Math.max(0, radius)), captionScale: 1, showHud: true, showGrid: true };
}
function presets(base) {
    return [{ id: 'original', label: LABELS.original, values: { ...base } }, ...Object.entries(PRESETS).map(([id, colors]) => ({ id, label: LABELS[id], values: { ...base, ...colors, preset: id } })), { id: 'custom', label: LABELS.custom, values: { ...base, preset: 'custom' } }];
}
function normalize(input, base) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !KEYS.includes(key))) throw error('样式设置包含不支持的字段。');
    const preset = input.preset ?? 'custom';
    if (!Object.hasOwn(LABELS, preset)) throw error('请选择有效的样式预设。');
    for (const key of COLOR_KEYS) if (input[key] !== undefined && (typeof input[key] !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input[key]))) throw error(`${key} 必须是十六进制颜色，例如 #60a5fa。`);
    if (input.font !== undefined && !['sans', 'serif', 'mono'].includes(input.font)) throw error('字体只支持无衬线、宋体或等宽。');
    for (const [key, min, max] of [['radius', 0, 32], ['captionScale', 0.8, 1.25]]) {
        if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < min || input[key] > max)) throw error(`${key} 应在 ${min}–${max} 之间。`);
    }
    for (const key of ['showHud', 'showGrid']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw error(`${key} 必须为开关值。`);
    if (preset === 'original') return { ...base };
    const result = { ...base, ...PRESETS[preset], ...input, preset };
    for (const key of COLOR_KEYS) result[key] = hex(result[key]);
    return result;
}

async function inspect(dir, manifest) {
    const declaration = manifest?.template?.style;
    if (declaration && (declaration.format !== FORMAT || declaration.adapter !== 'shared-css-v1' || declaration.file !== CSS_FILE)) return { supported: false, reason: '此模板尚未提供兼容的公共样式接口。' };
    const file = await safeFile(dir, CSS_FILE, true);
    if (!file) return { supported: false, reason: '此模板没有可编辑的公共样式文件。' };
    const css = await fs.readFile(file, 'utf8');
    const baseCss = splitCss(css);
    if (!declaration) {
        const buildFile = await safeFile(dir, 'build.mjs', true);
        const build = buildFile ? await fs.readFile(buildFile, 'utf8') : '';
        if (![':root', '--bg:', '--ink:', '--blue:', '.cap-zh', '.slot', '#root'].every(token => baseCss.includes(token)) || !/\bread\(\s*['"]src\/shared\.css['"]\s*\)/.test(build)) return { supported: false, reason: '此模板未声明公共样式接口，不能自动调整样式。' };
    }
    return { supported: true, file, css, baseCss, base: defaults(baseCss) };
}

export async function readTemplateStyle(dir, manifest) {
    const state = await inspect(dir, manifest);
    if (!state.supported) return state;
    const file = await safeFile(dir, CONFIG_FILE, true);
    let values = state.base;
    if (file) {
        let data;
        try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw error('template-style.json 不是有效的 JSON。'); }
        if (data?.format !== FORMAT) throw error('template-style.json 的格式不受支持。');
        values = normalize(data.values, state.base);
    }
    return { supported: true, values, presets: presets(state.base), fields: [
        { key: 'background', label: '背景色', type: 'color' }, { key: 'foreground', label: '主要文字', type: 'color' },
        { key: 'accent', label: '强调色', type: 'color' }, { key: 'secondary', label: '辅助色', type: 'color' },
        { key: 'font', label: '字体', type: 'select', options: [{ value: 'sans', label: '无衬线' }, { value: 'serif', label: '系统宋体' }, { value: 'mono', label: '等宽' }] },
        { key: 'radius', label: '卡片与矩形人物窗圆角', type: 'number', min: 0, max: 32, step: 1 },
        { key: 'captionScale', label: '字幕大小', type: 'number', min: 0.8, max: 1.25, step: 0.05 },
        { key: 'showHud', label: '显示取景框装饰', type: 'boolean' }, { key: 'showGrid', label: '显示背景网格', type: 'boolean' },
    ] };
}

function blend(a, b, fraction) {
    return `#${[1, 3, 5].map(offset => Math.round(parseInt(a.slice(offset, offset + 2), 16) * (1 - fraction) + parseInt(b.slice(offset, offset + 2), 16) * fraction).toString(16).padStart(2, '0')).join('')}`;
}
function fontValue(css, variable, fallback) {
    return new RegExp(`--${variable}\\s*:\\s*([^;]+);`).exec(css)?.[1] || fallback;
}
function captionSize(css, selector, fallback) {
    const body = new RegExp(`\\.${selector}\\s*\\{([^}]+)}`).exec(css)?.[1] || '';
    const font = /font\s*:[^;]*?([\d.]+)px\s*\/\s*([\d.]+)px/.exec(body);
    return font ? [Number(font[1]), Number(font[2])] : fallback;
}
function rules(values, css) {
    const { background, foreground, accent, secondary, font, radius, captionScale, showHud, showGrid } = values;
    const serif = '"Songti SC", "Noto Serif SC", Georgia, serif';
    const mono = fontValue(css, 'mono', 'monospace');
    const sans = font === 'serif' ? serif : font === 'mono' ? mono : fontValue(css, 'sans', 'sans-serif');
    const latin = font === 'sans' ? fontValue(css, 'latin', sans) : sans;
    const cond = font === 'sans' ? fontValue(css, 'cond', sans) : sans;
    const zh = captionSize(css, 'cap-zh', [25, 34]).map(value => +(value * captionScale).toFixed(3));
    const en = captionSize(css, 'cap-en', [14.5, 18]).map(value => +(value * captionScale).toFixed(3));
    const grid = showGrid ? 'linear-gradient(rgba(255,255,255,0.016) 1px, transparent 1px) 0 0 / 40px 40px, linear-gradient(90deg, rgba(255,255,255,0.016) 1px, transparent 1px) 0 0 / 40px 40px, ' : '';
    return `${BEGIN}:root {
    --bg: ${background}; --ink: ${foreground}; --ink-2: ${blend(foreground, background, 0.2)};
    --blue: ${accent}; --blue-deep: ${blend(accent, background, 0.3)}; --gold: ${secondary};
    --card: ${blend(background, foreground, 0.045)}; --line: ${blend(background, foreground, 0.14)};
    --sans: ${sans}; --latin: ${latin}; --mono: ${mono}; --cond: ${cond};
}
#root .bg { background: ${grid}radial-gradient(ellipse at 50% 45%, ${blend(background, accent, 0.06)} 0%, ${background} 70%); }
#root .hud, #root .hud-chc { visibility: ${showHud ? 'visible' : 'hidden'}; }
#root .k-card { border-radius: ${radius}px; }
#root .slot:not(.slot-circle) .slot-media, #root .slot:not(.slot-circle) .slot-frame { border-radius: ${radius}px; }
#root .cap-zh { font-size: ${zh[0]}px; line-height: ${zh[1]}px; }
#root .cap-en { font-size: ${en[0]}px; line-height: ${en[1]}px; }
${END}`;
}

async function atomicWrite(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, value, { flag: 'wx', mode: 0o644 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
}

export async function saveTemplateStyle(dir, manifest, input) {
    const state = await inspect(dir, manifest);
    if (!state.supported) throw error(state.reason);
    const values = normalize(input, state.base);
    const configFile = path.join(dir, CONFIG_FILE);
    const existingConfig = await safeFile(dir, CONFIG_FILE, true);
    const previousConfig = existingConfig ? await fs.readFile(existingConfig) : null;
    try {
        await atomicWrite(state.file, values.preset === 'original' ? state.baseCss : state.baseCss + rules(values, state.baseCss));
        if (values.preset === 'original') await fs.rm(configFile, { force: true });
        else await atomicWrite(configFile, `${JSON.stringify({ format: FORMAT, values }, null, 4)}\n`);
    } catch (cause) {
        await atomicWrite(state.file, state.css);
        if (previousConfig) await atomicWrite(configFile, previousConfig);
        else await fs.rm(configFile, { force: true });
        throw cause;
    }
    return readTemplateStyle(dir, manifest);
}

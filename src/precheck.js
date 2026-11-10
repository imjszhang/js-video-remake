import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError } from './errors.js';
import { rendererEnvironment, runFixedCommand } from './repro/render.js';

const HYPERFRAMES_CLI = fileURLToPath(new URL('../node_modules/hyperframes/bin/hyperframes.mjs', import.meta.url));
const CHECK_SECTIONS = ['lint', 'runtime', 'layout', 'motion', 'contrast', 'craft'];
const MEDIA_TAGS = new Set(['img', 'video', 'audio', 'source']);
// A faithful remake may need the reference's own low contrast.
const ADVISORY_CODES = new Set(['contrast_aa_failure']);
const FRAME_TOLERANCE = 1e-3;
const invalid = (message, data) => appError('REPRO_PRECHECK_FAILED', message, { data });

export function readDeclaredFps(html) {
    const match = /data-fps=(?:"([^"]+)"|'([^']+)')/.exec(html);
    const raw = match?.[1] || match?.[2];
    if (!raw) return null;
    const [numerator, denominator = '1'] = raw.split('/');
    const value = Number(numerator) / Number(denominator);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function attributes(source) {
    const values = {};
    const pattern = /([:@\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    for (const match of source.matchAll(pattern)) values[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    return values;
}

function markupTags(html) {
    const markup = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    return markup.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g);
}

function onFrame(value, fps) {
    const frames = value * fps;
    return Number.isFinite(frames) && Math.abs(frames - Math.round(frames)) <= FRAME_TOLERANCE;
}

export function inspectTiming(html, fps) {
    if (!Number.isFinite(fps) || fps <= 0) throw invalid('检查帧边界需要有效帧率。');
    const errors = [];
    const timings = [];
    for (const match of markupTags(html)) {
        const attrs = attributes(match[2]);
        for (const name of ['data-start', 'data-duration', 'data-media-start']) {
            const raw = attrs[name]?.trim();
            if (raw === undefined || raw === '') continue;
            const id = attrs.id || match[1];
            // data-start may reference another clip, e.g. "intro + 2".
            if (name === 'data-start' && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
                const offset = /\s[+-]\s+(\S+)$/.exec(raw)?.[1];
                if (offset !== undefined && !onFrame(Number(offset), fps)) {
                    errors.push(`${id} 的 ${name}="${raw}" 偏移量不是 ${fps} fps 下的整数帧。`);
                }
                continue;
            }
            const value = Number(raw);
            if (!Number.isFinite(value) || value < 0 || !onFrame(value, fps)) {
                errors.push(`${id} 的 ${name}="${raw}" 不是 ${fps} fps 下的整数帧。`);
            } else {
                timings.push({ id, name, value });
            }
        }
    }
    return { fps, timings, errors };
}

function remoteSource(src) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
}

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * `nested` mirrors how the renderer serves an entry below the project root:
 * paths resolve from the root, and leading "../" is clamped to it.
 */
export async function inspectSources(html, baseDir, exists = (file) => fs.access(file), { projectRoot, nested = false } = {}) {
    const missing = [];
    const escaped = [];
    const found = [];
    for (const match of markupTags(html)) {
        if (!MEDIA_TAGS.has(match[1].toLowerCase())) continue;
        const raw = attributes(match[2]).src;
        if (!raw || remoteSource(raw)) continue;
        let src = raw.replace(/[?#].*$/, '');
        try { src = decodeURIComponent(src); } catch { /* keep the literal path */ }
        const file = path.isAbsolute(src) ? src
            : nested ? path.resolve(projectRoot, src.replace(/^(?:\.\.\/)+/, '')) : path.resolve(baseDir, src);
        if (projectRoot && !inside(projectRoot, file)) {
            escaped.push(raw);
            continue;
        }
        try {
            await exists(file);
            found.push(file);
        } catch {
            missing.push(raw);
        }
    }
    return { found, missing, escaped };
}

export function summarizeCheckReport(report) {
    if (!report || typeof report !== 'object') return { ok: false, errors: ['HyperFrames check 没有返回 JSON。'], warnings: [] };
    const warnings = [];
    const errors = [];
    if (typeof report.error === 'string') errors.push(report.error);
    for (const name of CHECK_SECTIONS) {
        const section = report[name];
        if (!section || typeof section !== 'object') continue;
        let sectionErrors = 0;
        for (const finding of section.findings || []) {
            const code = finding.code || '';
            const advisory = ADVISORY_CODES.has(code);
            const item = { section: name, severity: advisory ? 'warning' : finding.severity || 'error', code, message: finding.message || code || name };
            if (finding.severity === 'error') sectionErrors += 1;
            if (item.severity === 'error') errors.push(`${code || name}: ${item.message}`);
            else warnings.push(item);
        }
        if ((section.errorCount || 0) > sectionErrors) errors.push(`${name} 有 ${section.errorCount - sectionErrors} 个未列出的错误。`);
    }
    return { ok: errors.length === 0, errors, warnings };
}

function parseReport(stdout) {
    const text = String(stdout || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw invalid('HyperFrames check 没有输出 JSON。');
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        throw invalid('HyperFrames check 的 JSON 无法解析。');
    }
}

/**
 * Static frame/asset checks, then the locked `hyperframes check`.
 * `projectRoot` is the directory the renderer serves; it defaults to the
 * entry's folder. `hyperframes check` serves its DIR as the site root, so an
 * entry below the project root (src/index.html) would load the wrong files;
 * those entries rely on the static checks and `render --strict` lint.
 */
export async function precheckComposition({
    dir, entry = 'index.html', projectRoot, fps, range, timeoutMs = 120_000, signal, env, hyperframesCli = HYPERFRAMES_CLI,
    cancelCode = 'REPRO_PRECHECK_CANCELLED', timeoutCode = 'REPRO_PRECHECK_TIMEOUT',
} = {}, deps = {}) {
    if (typeof dir !== 'string' || !dir) throw invalid('检查需要工程目录。');
    const htmlFile = path.resolve(dir, entry);
    const checkDir = path.dirname(htmlFile);
    const root = path.resolve(projectRoot ?? checkDir);
    let html;
    try {
        html = await fs.readFile(htmlFile, 'utf8');
    } catch {
        throw invalid(`找不到成片入口: ${htmlFile}`);
    }
    const nested = root !== checkDir;
    const rate = fps ?? readDeclaredFps(html) ?? 30;
    const timing = inspectTiming(html, rate);
    const assets = await inspectSources(html, checkDir, deps.exists, { projectRoot: root, nested });
    const errors = [
        ...assets.missing.map((src) => `缺少本地素材: ${src}`),
        ...assets.escaped.map((src) => `素材在渲染目录之外: ${src}`),
    ];
    // Off-frame times still render (HyperFrames rounds them), and reference
    // lengths such as 64.448 s are legitimately off-frame, so only report them.
    const frameWarnings = timing.errors.map((message) => ({ section: 'precheck', severity: 'warning', code: 'off_frame_timing', message }));
    if (errors.length) throw invalid(errors.join('\n'), { errors, warnings: frameWarnings });
    const base = { ok: true, fps: rate, entry: htmlFile, range: range ?? null, timing, assets: assets.found };
    if (nested || path.basename(htmlFile) !== 'index.html') {
        return { ...base, hyperframesCheck: 'skipped', warnings: [...frameWarnings, { section: 'precheck', severity: 'warning', code: 'hyperframes_check_skipped',
            message: 'HyperFrames check 只能检查工程根目录的 index.html；这个入口只做了素材和帧检查，lint 由渲染的 --strict 负责。' }] };
    }
    const args = [hyperframesCli, 'check', checkDir, '--json'];
    if (range !== undefined && range !== null && range !== '') args.push('--range', String(range));
    const run = deps.runCommand || runFixedCommand;
    const result = await run(process.execPath, args, {
        cwd: checkDir,
        env: rendererEnvironment(checkDir, env || process.env),
        signal,
        timeoutMs,
        // The JSON report grows with findings; a truncated report cannot be parsed.
        maxOutputBytes: 16 * 1024 * 1024,
    }, deps);
    if (result?.termination === 'cancelled') throw appError(cancelCode, '检查已取消。');
    if (result?.termination === 'timeout') throw appError(timeoutCode, '检查超时。');
    const report = parseReport(result?.stdout);
    const summary = summarizeCheckReport(report);
    const warnings = [...frameWarnings, ...summary.warnings];
    if (!summary.ok) throw invalid(summary.errors.join('\n'), { errors: summary.errors, warnings });
    return { ...base, hyperframesCheck: 'passed', warnings };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError } from './errors.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FONT_STYLES = [
    ['inter', '@fontsource-variable/inter/wght.css'],
    ['noto-sans-sc', '@fontsource-variable/noto-sans-sc/wght.css'],
];

export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
}

export function seconds(frames, fps) {
    const value = frames / fps;
    if (!Number.isFinite(value) || value < 0) throw appError('COMPOSITION_INVALID', '时长无效。');
    if (Number.isInteger(value)) return String(value);
    return String(Math.round(value * 1_000_000) / 1_000_000);
}

/** Decimal that stays on an integer frame after parseFloat. */
export function frameSeconds(frame, fps) {
    if (!Number.isInteger(frame) || frame < 0 || !Number.isFinite(fps) || fps <= 0) {
        throw appError('COMPOSITION_INVALID', '帧时间无效。');
    }
    return String(frame / fps);
}

/** Copy variable fonts into the composition so the renderer can embed them. */
export async function embedVariableFonts(compositionDir, { fail } = {}) {
    const raise = fail || ((message) => appError('COMPOSITION_INVALID', message));
    const fontDir = path.join(compositionDir, 'fonts');
    await fs.mkdir(fontDir, { recursive: true });
    const blocks = [];
    for (const [prefix, relative] of FONT_STYLES) {
        const cssFile = path.join(PACKAGE_ROOT, 'node_modules', relative);
        let css;
        try {
            css = await fs.readFile(cssFile, 'utf8');
        } catch {
            throw raise(`缺少字体样式: ${cssFile}`);
        }
        const packageDir = path.dirname(cssFile);
        const copied = new Map();
        const rewritten = css.replace(/url\((['"]?)(\.\/[^)'"]+)\1\)/g, (_full, _quote, asset) => {
            const source = path.resolve(packageDir, asset);
            const name = `${prefix}-${path.basename(source)}`;
            copied.set(name, source);
            return `url("./fonts/${name}")`;
        }).replaceAll('font-display: swap', 'font-display: block');
        await Promise.all([...copied].map(async ([name, source]) => {
            const destination = path.join(fontDir, name);
            try {
                await fs.link(source, destination);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    try {
                        await fs.copyFile(source, destination);
                    } catch {
                        throw raise(`缺少字体文件: ${source}`);
                    }
                }
            }
        }));
        blocks.push(rewritten);
    }
    return blocks.join('\n');
}

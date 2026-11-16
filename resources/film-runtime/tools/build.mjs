#!/usr/bin/env node
// Builds a single HTML file that plays the film when opened straight from disk.
//
//   node tools/build.mjs [--root DIR] [--entry index.html] [--out renders/<name>.html]
//
// A page opened from file:// may not load module files or fetch JSON, so the build
// turns every module reachable from the entry into a data: URL behind an import map,
// and embeds film.json and inputs/values.json for loadFilm() and loadInputs().
// A <base> tag points relative URLs (images, import.meta.url) back at the package.
import fs from 'node:fs';
import path from 'node:path';

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined || value.startsWith('--') ? fallback : value;
}
function fail(message) { console.error(message); process.exit(1); }

const ROOT = path.resolve(option('root', process.cwd()));
const ENTRY = option('entry', 'index.html');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

function defaultOut() {
    if (exists('video.json')) {
        const output = readJson('video.json').output;
        if (typeof output === 'string' && output.endsWith('.mp4')) return output.replace(/\.mp4$/, '.html');
    }
    return exists('reproduction.json') ? 'outputs/film.html' : 'renders/film.html';
}
const OUT = option('out', defaultOut());

// Package-relative POSIX path for a specifier, or null when it is not a local file.
function resolveLocal(fromFile, specifier) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
        if (/^https?:/i.test(specifier)) fail(`${fromFile} 引用了外部模块 ${specifier}；film 页面只能使用包内文件。`);
        return null;
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) return null;
    const joined = specifier.startsWith('/')
        ? path.posix.normalize(specifier.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    const relative = joined.split(/[?#]/)[0];
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) fail(`${fromFile} 引用了包外文件 ${specifier}。`);
    if (!exists(relative) || fs.statSync(path.join(ROOT, relative)).isDirectory()) fail(`${fromFile} 引用的 ${specifier} 不存在。`);
    return relative;
}

const STATIC = /(?<![\w$.])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?(['"])([^'"\n]+)\1/g;
const DYNAMIC = /(?<![\w$.])import\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const modules = new Map(); // key -> { source, mime }
const warnings = [];

// Rewrite one module so every local import goes through the import map, and queue
// what it imports. `location` is the file relative imports resolve against.
function addModule(key, location, source) {
    if (modules.has(key)) return;
    modules.set(key, null);
    modules.set(key, { source: rewrite(location, source), mime: location.endsWith('.json') ? 'application/json' : 'text/javascript' });
}

function rewrite(location, source) {
    const edits = [];
    for (const pattern of [STATIC, DYNAMIC]) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
            const specifier = match[2];
            const target = resolveLocal(location, specifier);
            if (target === null) {
                if (!/^[a-z][a-z0-9+.-]*:/i.test(specifier)) warnings.push(`${location} 的 ${specifier} 不是相对路径，单文件里无法解析。`);
                continue;
            }
            const start = match.index + match[0].lastIndexOf(specifier);
            edits.push([start, specifier.length, `@film/${target}`]);
            queue.push(target);
        }
    }
    edits.sort((a, b) => b[0] - a[0]);
    let rewritten = source;
    for (const [start, length, value] of edits) rewritten = rewritten.slice(0, start) + value + rewritten.slice(start + length);
    // A data: URL module has no useful import.meta.url; point it back at the source file.
    return rewritten.replace(/\bimport\.meta\.url\b/g, `__filmModuleUrl(${JSON.stringify(location)})`);
}
const queue = [];
function drain() {
    while (queue.length) {
        const relative = queue.shift();
        if (!modules.has(`@film/${relative}`)) addModule(`@film/${relative}`, relative, fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    }
}

if (!exists(ENTRY)) fail(`入口不存在: ${ENTRY}`);
let html = fs.readFileSync(path.join(ROOT, ENTRY), 'utf8');

// Module scripts: inline ones are rewritten in place, src= ones become an import.
html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attributes, body) => {
    if (!/\btype\s*=\s*["']?module["']?/i.test(attributes)) {
        if (/\bsrc\s*=/i.test(attributes)) warnings.push(`${ENTRY} 里的普通脚本 ${attributes.trim()} 没有打进单文件。`);
        return whole;
    }
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes);
    if (src) {
        const target = resolveLocal(ENTRY, src[1]);
        if (target === null) return whole;
        queue.push(target);
        return `<script type="module">import ${JSON.stringify(`@film/${target}`)};</script>`;
    }
    return `<script type="module">${rewrite(ENTRY, body)}</script>`;
});
drain();

const embed = {};
for (const relative of ['film.json', 'inputs/values.json']) if (exists(relative)) embed[relative] = readJson(relative);
const imports = {};
for (const [key, module] of modules) imports[key] = `data:${module.mime};base64,${Buffer.from(module.source).toString('base64')}`;
const safe = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// <base> points relative URLs at the package root, so images and the runtime's
// file lookups resolve the same as when the package is served.
const outDir = path.posix.dirname(OUT.split(path.sep).join('/'));
const base = outDir === '.' ? './' : `${outDir.split('/').map(() => '..').join('/')}/`;
const head = [
    `<base href="${base}">`,
    `<script>globalThis.__FILM_EMBED__ = ${safe(embed)};`
        + 'globalThis.__FILM_STANDALONE__ = true;'
        + 'globalThis.__filmModuleUrl = (file) => new URL(file, document.baseURI).href;</script>',
    `<script type="importmap">${safe({ imports })}</script>`,
].join('\n');
html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (tag) => `${tag}\n${head}`) : `${head}\n${html}`;

const target = path.resolve(ROOT, OUT);
if (!target.startsWith(`${ROOT}${path.sep}`)) fail(`输出必须在包内: ${OUT}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(`${target}.tmp`, html);
fs.renameSync(`${target}.tmp`, target);
// Marker for index.html: a page opened from disk can load a classic script but
// cannot fetch, so this file's presence is how it knows the build exists.
fs.writeFileSync(target.replace(/\.html$/, '.ready.js'), '// film build marker\n');
for (const warning of warnings) console.error(`警告: ${warning}`);
console.log(JSON.stringify({ ok: true, out: path.relative(ROOT, target).split(path.sep).join('/'), modules: modules.size, bytes: html.length, warnings: warnings.length }));

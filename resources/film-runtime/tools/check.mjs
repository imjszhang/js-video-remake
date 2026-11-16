#!/usr/bin/env node
// Static checks for a film page. A frame must be a function of film time alone, so the
// source may not read a clock, a timer or unseeded randomness. Run from the package root:
//   node tools/check.mjs [--root DIR] [file ...]
// With no files it checks every .js/.mjs/.html under src/ plus index.html.
import fs from 'node:fs';
import path from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const ROOT = path.resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd());
const RULES = [
    { id: 'clock', pattern: /\b(?:Date\.now|performance\.now|new Date)\s*\(/, detail: '用了真实时钟；画面必须只依赖影片时间 t' },
    { id: 'timer', pattern: /\b(?:requestAnimationFrame|setInterval)\s*\(/, detail: '用了动画循环或定时器当时钟' },
    { id: 'random', pattern: /\bMath\.random\s*\(/, detail: '用了 Math.random；改用带种子的随机数，保证同一帧每次相同' },
];

function files() {
    const given = process.argv.slice(2).filter((argument, index, all) => !argument.startsWith('--') && all[index - 1] !== '--root');
    if (given.length) return given.map(file => path.resolve(ROOT, file));
    const found = [];
    const walk = directory => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(?:js|mjs|html)$/.test(entry.name)) found.push(full);
        }
    };
    walk(path.join(ROOT, 'src'));
    const entry = path.join(ROOT, 'index.html');
    if (fs.existsSync(entry)) found.push(entry);
    return found;
}

// Blank out comments and string contents so rules only see code, keeping line breaks
// for line numbers. Code inside a template literal's ${...} is kept: it runs, so a
// clock read there must still be found.
function strip(source) {
    let out = '';
    let index = 0;
    const blank = (text) => text.replace(/[^\n]/g, ' ');
    const stack = []; // one entry per open ${, holding its brace depth
    while (index < source.length) {
        const char = source[index];
        const next = source[index + 1];
        if (char === '/' && next === '/') {
            const end = source.indexOf('\n', index);
            const stop = end < 0 ? source.length : end;
            out += blank(source.slice(index, stop));
            index = stop;
        } else if (char === '/' && next === '*') {
            const end = source.indexOf('*/', index + 2);
            const stop = end < 0 ? source.length : end + 2;
            out += blank(source.slice(index, stop));
            index = stop;
        } else if (char === '"' || char === "'") {
            let cursor = index + 1;
            while (cursor < source.length && source[cursor] !== char && source[cursor] !== '\n') cursor += source[cursor] === '\\' ? 2 : 1;
            out += blank(source.slice(index, cursor + 1));
            index = cursor + 1;
        } else if (char === '`' || (char === '}' && stack.length && stack.at(-1) === 0)) {
            // Start of a template literal, or the end of a ${...} inside one.
            if (char === '}') stack.pop();
            let cursor = index + 1;
            while (cursor < source.length && source[cursor] !== '`' && !(source[cursor] === '$' && source[cursor + 1] === '{')) cursor += source[cursor] === '\\' ? 2 : 1;
            out += char + blank(source.slice(index + 1, cursor));
            if (source[cursor] === '$') { out += '${'; stack.push(0); index = cursor + 2; }
            else { out += '`'; index = cursor + 1; }
        } else {
            if (stack.length && char === '{') stack[stack.length - 1] += 1;
            if (stack.length && char === '}') stack[stack.length - 1] -= 1;
            out += char;
            index += 1;
        }
    }
    return out;
}

const findings = [];
for (const file of files()) {
    const text = fs.readFileSync(file, 'utf8');
    const source = strip(text);
    for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(source);
        if (!match) continue;
        const line = source.slice(0, match.index).split('\n').length;
        findings.push({ file, line, id: rule.id, detail: rule.detail });
    }
}

const filmFile = path.join(ROOT, 'film.json');
const film = fs.existsSync(filmFile) ? JSON.parse(fs.readFileSync(filmFile, 'utf8')) : null;
if (film) {
    if (!(film.duration > 0) || !(film.fps > 0) || !Number.isInteger(film.width) || !Number.isInteger(film.height)) {
        findings.push({ file: 'film.json', line: 1, id: 'film-json', detail: 'film.json 需要正数的 duration、fps 和整数的 width、height' });
    }
    const frames = film.duration * film.fps;
    if (Number.isFinite(frames) && Math.abs(frames - Math.round(frames)) > 1e-6) {
        findings.push({ file: 'film.json', line: 1, id: 'film-json', detail: 'duration 不是 fps 下的整数帧' });
    }
    for (const [index, beat] of (film.beats || []).entries()) {
        if (typeof beat.at !== 'number' || beat.at < 0 || beat.at > film.duration) {
            findings.push({ file: 'film.json', line: index + 1, id: 'beat', detail: `节拍 ${beat.name || index} 的时间不在片长内` });
        }
    }
}

if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line}  ${finding.id}  ${finding.detail}`);
    process.exit(1);
}
console.log(JSON.stringify({ ok: true, files: files().length }));

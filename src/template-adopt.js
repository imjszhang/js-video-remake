import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError } from './errors.js';
import { FILM_ENGINE } from './film/constants.js';
import { TEMPLATE_FORMAT, forkVideo, resolveVideo } from './videos.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const invalid = message => appError('INVALID_INPUT', message);

const INPUTS_TOOL = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'video.json'), 'utf8'));
const frame = manifest.frame || {};
const film = frame.frames / frame.fps;
const defaults = { voice: null, music: null };
const errors = [];
const warnings = [];
const info = [];

if (!Number.isFinite(film) || film <= 0) errors.push('video.json 缺少有效的成片时长。');

if (args.has('--init') && !fs.existsSync(path.join(root, 'inputs.json'))) {
    fs.mkdirSync(path.join(root, 'inputs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'inputs.json'), JSON.stringify(defaults, null, 2) + '\\n');
}

let raw = {};
if (fs.existsSync(path.join(root, 'inputs.json'))) {
    try { raw = JSON.parse(fs.readFileSync(path.join(root, 'inputs.json'), 'utf8')); }
    catch { errors.push('inputs.json 不是有效的 JSON。'); }
}
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('inputs.json 必须是对象。');
else {
    for (const key of Object.keys(raw)) {
        if (key.startsWith('_') || key === 'voice' || key === 'music') continue;
        warnings.push('忽略未声明的输入 ' + key + '。这个模板只替换口播和音乐。');
    }
}

let ffprobeMissing = false;
function durationOf(file) {
    if (ffprobeMissing) return null;
    const run = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    if (run.error && run.error.code === 'ENOENT') { ffprobeMissing = true; return null; }
    if (run.status !== 0) return false;
    const value = Number(String(run.stdout).trim());
    return Number.isFinite(value) && value >= 0 ? value : false;
}

function resolveInput(value, label) {
    if (value === null || value === undefined || value === '') return null;
    const parts = typeof value === 'string' ? value.split('/') : [];
    if (typeof value !== 'string' || path.isAbsolute(value) || parts.includes('..') || parts.includes('.') || parts.includes('') || !value.startsWith('inputs/')) {
        errors.push(label + ' 只能使用本模板 inputs/ 内的相对路径，或留空。');
        return null;
    }
    const file = path.resolve(root, value);
    const inputsRoot = path.resolve(root, 'inputs');
    if (file !== inputsRoot && !file.startsWith(inputsRoot + path.sep)) {
        errors.push(label + ' 只能使用本模板 inputs/ 内的相对路径，或留空。');
        return null;
    }
    let stat;
    try { stat = fs.lstatSync(file); }
    catch { errors.push(label + ' 文件不存在：' + value); return null; }
    if (stat.isSymbolicLink() || !stat.isFile()) { errors.push(label + ' 必须是普通文件。'); return null; }
    const allowed = ['.mp4', '.mov', '.webm', '.m4v', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
    if (!allowed.includes(path.extname(file).toLowerCase())) { errors.push(label + ' 的格式不受支持。'); return null; }
    const duration = errors.length ? null : durationOf(file);
    if (duration === false) errors.push('无法读取' + label + '的时长：' + value);
    else if (typeof duration === 'number' && duration + 0.05 < film) errors.push(label + '短于成片（' + duration.toFixed(2) + ' 秒 / 成片 ' + film.toFixed(2) + ' 秒）。');
    else if (label === '口播' && typeof duration === 'number' && duration > film + 1) warnings.push('口播比成片长，多出的部分不会播放。');
    return value;
}

const voice = errors.some(item => item.startsWith('inputs.json')) ? null : resolveInput(raw.voice, '口播');
const music = errors.some(item => item.startsWith('inputs.json')) ? null : resolveInput(raw.music, '音乐');
if (ffprobeMissing) warnings.push('本机没有 ffprobe，未核对素材时长。');
if (voice || music) info.push('已填写的口播或音乐会替换原来的整条声音。');
else info.push('未填写口播和音乐，合成时保持原来的声音。');
if (voice) info.push('口播：' + voice);
if (music) info.push('音乐：' + music);

const report = { ok: errors.length === 0, errors, warnings, info };
if (args.has('--json')) process.stdout.write(JSON.stringify(report));
else {
    for (const item of errors) console.log('错误 ' + item);
    for (const item of warnings) console.log('提醒 ' + item);
    for (const item of info) console.log(item);
    if (report.ok) console.log('素材检查通过。');
}
process.exit(report.ok ? 0 : 1);
`;

const BUILD_TOOL = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'video.json'), 'utf8'));
const entry = manifest.entry || 'index.html';
const parts = String(entry).split('/');
if (!entry || path.isAbsolute(entry) || parts.includes('..') || parts.includes('')) {
    console.error('video.json 的 entry 必须是包内相对路径。');
    process.exit(1);
}
const entryFile = path.resolve(root, entry);
if (entryFile !== root && !entryFile.startsWith(root + path.sep)) {
    console.error('入口必须在模板目录内。');
    process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.scripts && pkg.scripts['film:build']) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const run = spawnSync(npm, ['run', 'film:build'], { cwd: root, stdio: 'inherit' });
    if ((run.status ?? 1) !== 0) process.exit(run.status || 1);
    if (!fs.existsSync(entryFile)) {
        console.error('film:build 没有生成入口 ' + entry);
        process.exit(1);
    }
}
const pictureFile = pkg.scripts && pkg.scripts['film:build'] ? entryFile : path.join(root, 'src', 'film.html');
if (!fs.existsSync(pictureFile)) {
    console.error('找不到画面源文件。没有 film:build 时需要 src/film.html。');
    process.exit(1);
}
let inputs = {};
if (fs.existsSync(path.join(root, 'inputs.json'))) inputs = JSON.parse(fs.readFileSync(path.join(root, 'inputs.json'), 'utf8'));
function inputSrc(value) {
    if (value === null || value === undefined || value === '') return null;
    const pieces = String(value).split('/');
    if (typeof value !== 'string' || path.isAbsolute(value) || pieces.includes('..') || !value.startsWith('inputs/')) {
        console.error('素材路径必须位于 inputs/ 内。');
        process.exit(1);
    }
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
const voice = inputSrc(inputs.voice);
const music = inputSrc(inputs.music);
const seconds = String(Math.round((manifest.frame.frames / manifest.frame.fps) * 1000) / 1000);
let html = fs.readFileSync(pictureFile, 'utf8');
html = html.replace(/<!-- adopted-audio:start -->[\\s\\S]*?<!-- adopted-audio:end -->\\n?/g, '');
if (voice || music) {
    html = html.replace(/<video\\b[^>]*>/gi, tag => {
        const quiet = tag.replace(/\\sdata-has-audio=(["'])true\\1/gi, '');
        return /\\smuted(?=[\\s>/])/i.test(quiet) ? quiet : quiet.replace(/<video\\b/i, '<video muted');
    });
    html = html.replace(/<audio\\b[^>]*>/gi, tag => (
        /\\sdata-volume=/.test(tag) ? tag.replace(/data-volume=(["'])[^"']*\\1/, 'data-volume="0"') : tag.replace(/<audio\\b/i, '<audio data-volume="0"')
    ));
    const tracks = [];
    if (voice) tracks.push('<audio id="adopted-voice" src="' + voice + '" data-start="0" data-duration="' + seconds + '" data-track-index="20" data-volume="1"></audio>');
    if (music) tracks.push('<audio id="adopted-music" src="' + music + '" data-start="0" data-duration="' + seconds + '" data-track-index="21" data-volume="0.35"></audio>');
    const block = '<!-- adopted-audio:start -->\\n' + tracks.join('\\n') + '\\n<!-- adopted-audio:end -->\\n';
    html = html.includes('</body>') ? html.replace('</body>', block + '</body>') : html + '\\n' + block;
}
fs.writeFileSync(entryFile, html);
const script = [
    '# 录制说明',
    '',
    '成片 ' + seconds + ' 秒。画面和时间轴保持收成模板时的样子。',
    '',
    '- 口播：' + (voice || '未填写，使用原来的声音。'),
    '- 音乐：' + (music || '未填写。'),
    '',
    '填写口播或音乐的任何一项后，原来的整条声音会被替换。两项都不填时，声音与收成时相同。',
    '人物、字幕和画面文字不在这里更换。',
    '',
].join('\\n');
fs.writeFileSync(path.join(root, 'SCRIPT.md'), script);
`;

const PREVIEW_TOOL = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = spawnSync(npm, ['exec', '--no-install', 'hyperframes', 'snapshot', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
`;

const COMPOSE_TOOL = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(label, command, argv) {
    console.log('\\n== ' + label);
    const run = spawnSync(command, argv, { cwd: root, stdio: 'inherit' });
    if ((run.status ?? 1) !== 0) {
        console.error('\\n' + label + '失败（退出码 ' + (run.status ?? 1) + '）。');
        process.exit(run.status || 1);
    }
}

if (!fs.existsSync(path.join(root, 'node_modules', 'hyperframes'))) {
    console.error('还没安装依赖。先运行 npm ci。');
    process.exit(1);
}
step('检查输入', process.execPath, ['tools/inputs.mjs']);
step('构建', process.execPath, ['tools/build.mjs']);
if (args.has('--no-render')) {
    console.log('\\n已构建入口 HTML。预览: npm run dev；渲染: npm run render');
    process.exit(0);
}
step('渲染', npm, ['run', 'render']);
const output = JSON.parse(fs.readFileSync(path.join(root, 'video.json'), 'utf8')).output;
console.log('\\n成片: ' + output);
`;

// Film packages already own tools/render.mjs, tools/preview.mjs and tools/build.mjs.
// These extra tools only prepare a replacement soundtrack and mux it after the film renderer.
const FILM_BUILD_TOOL = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'video.json'), 'utf8'));
const seconds = Math.round((manifest.frame.frames / manifest.frame.fps) * 1000) / 1000;
let inputs = {};
if (fs.existsSync(path.join(root, 'inputs.json'))) inputs = JSON.parse(fs.readFileSync(path.join(root, 'inputs.json'), 'utf8'));
const voice = inputs.voice || null;
const music = inputs.music || null;
const directory = path.join(root, '.film-audio');
const soundtrack = path.join(directory, 'soundtrack.wav');
if (!voice && !music) {
    fs.rmSync(soundtrack, { force: true });
} else {
    fs.mkdirSync(directory, { recursive: true });
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    if (voice) args.push('-i', voice);
    if (music) args.push('-i', music);
    if (voice && music) {
        args.push('-filter_complex', '[0:a]aformat=channel_layouts=stereo,volume=1[v];[1:a]aformat=channel_layouts=stereo,volume=0.35[m];[v][m]amix=inputs=2:duration=longest:normalize=0', '-t', String(seconds));
    } else {
        args.push('-t', String(seconds), '-vn');
    }
    args.push('-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', soundtrack);
    const run = spawnSync('ffmpeg', args, { cwd: root, stdio: 'inherit' });
    if ((run.status ?? 1) !== 0) {
        console.error('无法把口播和音乐合成替换音轨。请确认已安装 ffmpeg，且素材里有音轨。');
        process.exit(run.status || 1);
    }
}
const script = [
    '# 录制说明',
    '',
    '成片 ' + seconds + ' 秒。画面和时间轴保持收成模板时的样子。',
    '',
    '- 口播：' + (voice || '未填写，使用原来的声音。'),
    '- 音乐：' + (music || '未填写。'),
    '',
    '填写口播或音乐的任何一项后，原来的整条声音会被替换。两项都不填时，声音与收成时相同。',
    '人物、字幕和画面文字不在这里更换。',
    '',
].join('\\n');
fs.writeFileSync(path.join(root, 'SCRIPT.md'), script);
`;

const FILM_RENDER_TOOL = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const output = outIndex >= 0 ? args[outIndex + 1] : '';
if (!output || output.startsWith('--')) {
    console.error('需要 --out 成片路径。');
    process.exit(1);
}
const forwarded = args.filter((item, index) => item !== '--out' && args[index - 1] !== '--out');
const soundtrack = path.join(root, '.film-audio', 'soundtrack.wav');
function run(argv) {
    const result = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' });
    if ((result.status ?? 1) !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync(soundtrack)) {
    run(['tools/render.mjs', '--out', output, ...forwarded]);
    process.exit(0);
}
const temporary = output.replace(/\\.mp4$/i, '') + '.silent.mp4';
try {
    run(['tools/render.mjs', '--out', temporary, '--no-audio', ...forwarded]);
    const mix = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', temporary, '-i', soundtrack, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', output], { cwd: root, stdio: 'inherit' });
    if ((mix.status ?? 1) !== 0) {
        console.error('替换音轨没有合成进成片。');
        process.exit(mix.status || 1);
    }
} finally {
    fs.rmSync(path.join(root, temporary), { force: true });
}
`;

const FILM_COMPOSE_TOOL = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'video.json'), 'utf8'));
function step(label, argv) {
    console.log('\\n== ' + label);
    const run = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' });
    if ((run.status ?? 1) !== 0) {
        console.error('\\n' + label + '失败（退出码 ' + (run.status ?? 1) + '）。');
        process.exit(run.status || 1);
    }
}
step('检查输入', ['tools/inputs.mjs']);
step('准备声音', ['tools/template-build.mjs']);
step('渲染', ['tools/template-render.mjs', '--out', manifest.output]);
console.log('\\n成片: ' + manifest.output);
`;

function assertTitle(title) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 160 || /[\u0000-\u001f]/.test(title)) throw invalid('请填写 1–160 字的模板名称。');
    return title.trim();
}

function plainTitle(value, fallback) {
    const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
    return (text || fallback).slice(0, 160);
}

function packageRelative(file, label) {
    const parts = typeof file === 'string' ? file.split(/[\\/]/) : [];
    if (!file || path.isAbsolute(file) || parts.includes('..') || parts.includes('')) throw appError('VIDEO_INVALID', `${label}必须是包内相对路径。`);
    return parts.join('/');
}

async function writeTool(dir, relative, source) {
    const file = path.join(dir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, source, { flag: 'wx', mode: 0o644 }); }
    catch (error) {
        if (error.code === 'EEXIST') throw appError('VIDEO_INVALID', `已有 ${relative}，不能覆盖后再收成模板。`);
        throw error;
    }
}

/**
 * Copy a finished code-video package into a new template. The picture and timeline stay as they
 * were; voice and music are the only inputs the generated build actually applies.
 */
export async function adoptVideo(config, { slug, name, title, as: asName, skipInstall = false } = {}, deps = {}) {
    const source = await resolveVideo(config, slug, name);
    if (source.manifest.template?.format === TEMPLATE_FORMAT) {
        throw appError('VIDEO_INVALID', `videos/${source.name} 已经是模板。填写素材、预览和导出用模板工作台，或运行 video:pack。`);
    }
    const frame = source.manifest.frame;
    if (!frame || typeof frame.fps !== 'number' || !Number.isFinite(frame.fps) || frame.fps <= 0 || !Number.isInteger(frame.frames) || frame.frames <= 0) {
        throw appError('VIDEO_INVALID', '这个复刻工程没有有效的画幅和帧数，不能收成模板。');
    }
    const entry = packageRelative(source.manifest.entry || 'index.html', '入口 ');
    if (entry === 'src/film.html') throw appError('VIDEO_INVALID', '入口不能是 src/film.html。收成模板时会把当前入口保存成这个文件。');
    const chosen = title === undefined || title === null ? plainTitle(source.manifest.title, `${source.production.slug} 模板`) : assertTitle(title);
    const originId = ID.test(source.manifest.id) ? source.manifest.id : (ID.test(source.production.slug) ? source.production.slug : 'remake');
    const originVersion = Number.isInteger(source.manifest.version) && source.manifest.version > 0 ? source.manifest.version : 1;
    const lineage = {
        id: `template-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        title: chosen,
        version: 1,
        kind: 'derived',
        origin: { id: originId, title: plainTitle(source.manifest.title, source.name), version: originVersion, video: source.name },
        parent: null,
    };
    let created = null;
    try {
        const fork = await forkVideo(config, { slug, from: source.name, name: asName, skipInstall, templateLineage: lineage }, deps);
        created = path.resolve(config.workspace, fork.dir);
        const preservedBuild = source.manifest.engine === FILM_ENGINE
            ? await installFilmAdapter(created, { title: chosen, lineage, frame })
            : await installAdapter(created, { title: chosen, lineage, entry, frame });
        return { ...fork, command: 'video:template', title: chosen, inputs: ['voice', 'music'], preservedBuild, ...(source.manifest.engine === FILM_ENGINE ? { engine: FILM_ENGINE } : {}) };
    } catch (error) {
        if (created) await fs.rm(created, { recursive: true, force: true });
        throw error;
    }
}

async function installAdapter(dir, { title, lineage, entry, frame }) {
    const entryFile = path.join(dir, entry);
    const entryStat = await fs.lstat(entryFile);
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) throw appError('VIDEO_INVALID', '入口必须是包内的普通文件，不能是符号链接。');
    const picture = await fs.readFile(entryFile);
    await writeTool(dir, 'src/film.html', picture);
    await writeTool(dir, 'tools/inputs.mjs', INPUTS_TOOL);
    await writeTool(dir, 'tools/build.mjs', BUILD_TOOL);
    await writeTool(dir, 'tools/preview.mjs', PREVIEW_TOOL);
    await writeTool(dir, 'tools/compose.mjs', COMPOSE_TOOL);
    await writeTool(dir, 'AUTHORING.md', authoring());
    const pkgFile = path.join(dir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    const scripts = { ...(pkg.scripts || {}) };
    let preservedBuild = false;
    if (scripts.build && scripts.build !== 'node tools/build.mjs') {
        if (scripts['film:build']) throw appError('VIDEO_INVALID', '这个工程已经有 film:build 脚本，不能再自动收成模板。');
        if (/\b(?:npm|pnpm|yarn)\s+run\s+build\b/.test(scripts.build) || scripts.build.includes('tools/build.mjs')) {
            throw appError('VIDEO_INVALID', '这个工程的 build 脚本会再次调用 build，不能自动接成模板构建。');
        }
        scripts['film:build'] = scripts.build;
        preservedBuild = true;
    }
    Object.assign(scripts, {
        inputs: 'node tools/inputs.mjs',
        build: 'node tools/build.mjs',
        preview: 'node tools/preview.mjs',
        compose: 'node tools/compose.mjs',
    });
    await fs.writeFile(pkgFile, `${JSON.stringify({ ...pkg, scripts }, null, 2)}\n`);
    const manifestFile = path.join(dir, 'video.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const seconds = frame.frames / frame.fps;
    const secondsText = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(2);
    manifest.title = title;
    manifest.commands = {
        ...(manifest.commands || {}),
        inputs: 'npm run inputs',
        build: 'npm run build',
        compose: 'npm run compose',
    };
    manifest.template = {
        format: TEMPLATE_FORMAT,
        summary: `由复刻工程收成。画面和时间轴保持原样（${frame.width || '?'}×${frame.height || '?'}，${secondsText} 秒）。可替换口播和音乐；填写其中任何一项会替换原来的整条声音。不填则声音与收成时相同。人物、字幕和画面文字仍写在画面里。`,
        inputs: {
            voice: { kind: 'audio', required: false, duration: 'film', note: '一条与成片等长的口播。只要填写了口播或音乐，原来的整条声音就会被替换；都不填则保持原声。' },
            music: { kind: 'audio', required: false, duration: 'film or longer', note: '不短于成片的音乐。只要填写了口播或音乐，原来的整条声音就会被替换；只填音乐时成片里只剩音乐。' },
        },
        fixed: [
            '画面、时间轴和画面上的文字保持收成时的样子',
            '不填口播和音乐时，声音也保持原样',
            '填写口播或音乐的任何一项后，原来的整条声音被替换',
        ],
        pack: { exclude: [entry, 'SCRIPT.md', '.work/'] },
        lineage,
    };
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    await appendNote(dir, 'README.md', readmeNote(preservedBuild));
    await appendNote(dir, 'AGENTS.md', agentsNote());
    return preservedBuild;
}

async function installFilmAdapter(dir, { title, lineage, frame }) {
    const manifestFile = path.join(dir, 'video.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const output = manifest.output;
    if (typeof output !== 'string' || !output.endsWith('.mp4')) throw appError('VIDEO_INVALID', 'film 包的成片输出必须是 .mp4，才能收成模板。');
    await writeTool(dir, 'tools/inputs.mjs', INPUTS_TOOL);
    await writeTool(dir, 'tools/template-build.mjs', FILM_BUILD_TOOL);
    await writeTool(dir, 'tools/template-render.mjs', FILM_RENDER_TOOL);
    await writeTool(dir, 'tools/compose.mjs', FILM_COMPOSE_TOOL);
    const pkgFile = path.join(dir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    const scripts = { ...(pkg.scripts || {}) };
    let preservedBuild = false;
    if (scripts.build && scripts.build !== 'node tools/template-build.mjs') {
        if (scripts.build === 'node tools/build.mjs') scripts.player = scripts.build;
        else if (scripts['film:build']) throw appError('VIDEO_INVALID', '这个工程已经有 film:build 脚本，不能再自动收成模板。');
        else {
            scripts['film:build'] = scripts.build;
            preservedBuild = true;
        }
    }
    Object.assign(scripts, {
        inputs: 'node tools/inputs.mjs',
        build: 'node tools/template-build.mjs',
        compose: 'node tools/compose.mjs',
        render: `node tools/template-render.mjs --out ${output}`,
    });
    await writeTool(dir, 'AUTHORING.md', filmAuthoring(Boolean(scripts.player)));
    await fs.writeFile(pkgFile, `${JSON.stringify({ ...pkg, scripts }, null, 2)}\n`);
    const seconds = frame.frames / frame.fps;
    const secondsText = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(2);
    manifest.title = title;
    manifest.commands = {
        ...(manifest.commands || {}),
        inputs: 'npm run inputs',
        build: 'npm run build',
        compose: 'npm run compose',
    };
    manifest.template = {
        format: TEMPLATE_FORMAT,
        summary: `由 film 复刻工程收成。画面和时间轴保持原样（${frame.width || '?'}×${frame.height || '?'}，${secondsText} 秒）。可替换口播和音乐；填写其中任何一项会替换原来的整条声音。不填则声音与收成时相同。人物、字幕和画面文字仍写在画面里。`,
        inputs: {
            voice: { kind: 'audio', required: false, duration: 'film', note: '一条与成片等长的口播。只要填写了口播或音乐，原来的整条声音就会被替换；都不填则保持原声。' },
            music: { kind: 'audio', required: false, duration: 'film or longer', note: '不短于成片的音乐。和口播一起填时作为背景，音量较低；只填音乐时成片里只剩音乐。' },
        },
        fixed: [
            '画面、时间轴和画面上的文字保持收成时的样子',
            '不填口播和音乐时，声音也保持原样',
            '填写口播或音乐的任何一项后，原来的整条声音被替换',
        ],
        pack: { exclude: ['SCRIPT.md', '.work/', '.film-audio/'] },
        lineage,
    };
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const ignoreFile = path.join(dir, '.gitignore');
    const ignore = await fs.readFile(ignoreFile, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
    if (!ignore.includes('.film-audio/')) await fs.writeFile(ignoreFile, `${ignore.replace(/\n?$/, '\n')}.film-audio/\n`);
    await appendNote(dir, 'README.md', filmReadmeNote(preservedBuild));
    await appendNote(dir, 'AGENTS.md', filmAgentsNote());
    return preservedBuild;
}

function authoring() {
    return `# 模板说明

这个模板由复刻工程收成。

- 画面源文件是 \`src/film.html\`。\`npm run build\` 把它写成入口 HTML，并在填写了口播或音乐时替换声音。
- 不要手改构建生成的入口 HTML，下次构建会覆盖。改画面时改 \`src/film.html\`；如果包里有 \`film:build\`，构建会先运行它。
- \`inputs.json\` 只有 \`voice\` 和 \`music\`。不要另加人物、字幕或画面文字输入，除非同时改构建脚本，让这些输入真正生效。
- 两项都不填时，成片画面和声音与收成时相同。
`;
}

function readmeNote(preservedBuild) {
    return `
## 可填写模板

画面和时间轴在收成时已经固定。\`npm run inputs -- --init\` 写出 \`inputs.json\`，里面可以填：

- \`voice\`：与成片等长的口播
- \`music\`：不短于成片的音乐

填写其中任何一项，都会替换原来的整条声音。都不填时，声音保持原样。

\`\`\`bash
npm run inputs
npm run compose
\`\`\`
${preservedBuild ? '\n原来的构建脚本保留为 \`npm run film:build\`。模板构建会先运行它，再处理声音。\n' : ''}`;
}

function filmAuthoring(player) {
    return `# 模板说明

这个模板由 film 复刻工程收成。

- 画面仍是原来的入口页面。\`runtime/\`、\`tools/render.mjs\`、\`tools/check.mjs\`、\`tools/preview.mjs\` 保持原样，渲染器不读 HyperFrames 音轨。
- \`npm run build\` 只根据 \`inputs.json\` 准备替换音轨，并写出 \`SCRIPT.md\`。不改画面。
- 填写了口播或音乐时，\`npm run render\` 先渲染无声画面，再用 ffmpeg 把整条音轨换上。都不填时，沿用页面自己的 \`exportWav()\`。
- \`inputs.json\` 只有 \`voice\` 和 \`music\`。不要另加人物、字幕或画面文字输入，除非同时改构建脚本，让这些输入真正生效。
${player ? '- 可双击播放的单文件页面仍用 `npm run player`（原来的 `tools/build.mjs`）。\n' : ''}`;
}

function filmReadmeNote(preservedBuild) {
    return `
## 可填写模板

画面和时间轴在收成时已经固定。渲染仍走 film 引擎。\`npm run inputs -- --init\` 写出 \`inputs.json\`，里面可以填：

- \`voice\`：与成片等长的口播
- \`music\`：不短于成片的音乐

填写其中任何一项，都会替换原来的整条声音。都不填时，声音保持原样。

\`\`\`bash
npm run inputs
npm run compose
\`\`\`
${preservedBuild ? '\n原来的构建脚本保留为 \`npm run film:build\`。模板准备声音时不会自动运行它。\n' : ''}`;
}

function filmAgentsNote() {
    return `
## 模板

本包已收成 film 模板。口播和音乐的约定见 AUTHORING.md。\`npm run build\` 只准备替换音轨，不要改 \`runtime/\` 和 \`tools/render.mjs\`。
`;
}

function agentsNote() {
    return `
## 模板

本包已收成模板。画面源文件、口播和音乐的约定见 AUTHORING.md。构建命令是 \`npm run build\`，不要手改生成出的入口 HTML。
`;
}

async function appendNote(dir, name, text) {
    const file = path.join(dir, name);
    let current = '';
    try { current = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current.includes('## 可填写模板') || current.includes('## 模板')) return;
    await fs.writeFile(file, `${current.replace(/\n?$/, '\n')}${text}`);
}

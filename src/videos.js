import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError } from './errors.js';
import { openProduction } from './start.js';
import { findReference, readCatalog, upsertProduction, writeCatalog } from './catalog.js';
import { readSource } from './bind.js';
import { compositionHtml, parseFrameOptions } from './production-template.js';
import { precheckComposition } from './precheck.js';
import { probeMedia } from './compare.js';
import { rendererEnvironment, runFixedCommand } from './repro/render.js';
import { readZip, writeZip } from './zip.js';
import { assertSlug, emptyCatalog } from './schema.js';
import { readTemplateStyle, saveTemplateStyle } from './template-style.js';
import { templateCaptionRows, mergeTemplateCaptionRows, validateEditedCaptionRows, captionRevision } from './template-captions.js';
import { buildPromptScript, renderPromptScript, PROMPT_FORMATS } from './template-prompt.js';
import { describeTemplateLineages, templateLineagePointer } from './template-lineage.js';

// A code video package is a standalone HyperFrames project under
// productions/<slug>/videos/<name>/. It pins its own dependencies and never
// refers to files outside its directory; video-remake only drives it.
export const VIDEO_SCHEMA = 'video-package@1';
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v(\d+)$/;
// Installs, renders and HyperFrames caches; none of them are package source.
const COPY_EXCLUDES = new Set(['node_modules', 'renders', '.hyperframes', '.preview', '.work', '.thumbnails', '.waveform-cache', '.DS_Store']);
const ROOT_PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url));
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const RENDER_TIMEOUT_MS = 3 * 60 * 60_000;

const invalid = (message) => appError('INVALID_INPUT', message);
const rel = (config, file) => path.relative(config.workspace, file).split(path.sep).join('/');

export function videoVersion(name) {
    const match = NAME_RE.exec(name || '');
    return match ? Number(match[1]) : null;
}

function assertName(name) {
    if (!videoVersion(name)) throw invalid(`代码视频包名需要是小写字母、数字和连字符，并以 -vN 结尾，例如 code-v1: ${name}`);
    return name;
}

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function listVideos(dir) {
    const root = path.join(dir, 'videos');
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(root, entry.name);
        try { await fs.lstat(path.join(pkgDir, '.agent-pending')); continue; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        let manifest;
        try { manifest = await readJson(path.join(pkgDir, 'video.json')); } catch { continue; }
        if (manifest?.schema !== VIDEO_SCHEMA) continue;
        found.push({ name: entry.name, dir: pkgDir, manifest });
    }
    const lineages = describeTemplateLineages(found);
    for (const pkg of found) if (lineages.has(pkg.name)) pkg.lineage = lineages.get(pkg.name);
    return found.sort((a, b) => (videoVersion(a.name) ?? 0) - (videoVersion(b.name) ?? 0) || a.name.localeCompare(b.name));
}

/** Pick a package by name; without a name, the production must have exactly one. */
export async function resolveVideo(config, slug, name) {
    const { production, dir } = await openProduction(config, slug);
    const videos = await listVideos(dir);
    if (name !== undefined) {
        const hit = videos.find((video) => video.name === name);
        if (!hit) throw appError('NOT_FOUND', `没有代码视频包 videos/${name}（现有: ${videos.map((v) => v.name).join(', ') || '无'}）。`);
        return { production, productionDir: dir, ...hit };
    }
    if (videos.length === 1) return { production, productionDir: dir, ...videos[0] };
    if (!videos.length) throw appError('NOT_FOUND', `${slug} 还没有代码视频包。先运行 remake video:new ${slug}。`);
    throw invalid(`${slug} 有多个代码视频包，用 --video 指定: ${videos.map((v) => v.name).join(', ')}`);
}

function insidePackage(pkg, relative, label) {
    const file = path.resolve(pkg.dir, relative);
    if (file !== pkg.dir && !file.startsWith(`${pkg.dir}${path.sep}`)) throw appError('VIDEO_INVALID', `${label} 必须在包内: ${relative}`);
    return file;
}

export function outputPath(pkg) {
    if (typeof pkg.manifest.output !== 'string' || !pkg.manifest.output) throw appError('VIDEO_INVALID', `videos/${pkg.name}/video.json 缺少 output。`);
    return insidePackage(pkg, pkg.manifest.output, 'output');
}

async function packageCli(config, pkg) {
    const cli = path.join(pkg.dir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
    try {
        await fs.access(cli);
    } catch {
        throw appError('VIDEO_NOT_INSTALLED', `代码视频包还没安装依赖。运行: cd ${rel(config, pkg.dir)} && npm ci`);
    }
    return cli;
}

/** Operational variables only; npm also needs HOME for its cache. */
export function packageEnvironment(dir, env = process.env) {
    const result = rendererEnvironment(dir, env);
    for (const key of ['HOME', 'USERPROFILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
        if (typeof env[key] === 'string') result[key] = env[key];
    }
    return result;
}

async function runInPackage(config, pkg, command, args, { timeoutMs, label }, deps) {
    const run = deps.runCommand || runFixedCommand;
    const result = await run(command, args, {
        cwd: pkg.dir,
        env: packageEnvironment(pkg.dir, config.env || process.env),
        timeoutMs,
        signal: deps.signal,
        maxOutputBytes: 256 * 1024,
    }, deps);
    if (result?.termination === 'cancelled' || deps.signal?.aborted) throw appError('VIDEO_CANCELLED', '操作已取消。');
    if (result?.termination === 'timeout') throw appError('VIDEO_FAILED', `${label}超时。`);
    if (result?.exitCode !== 0) {
        const detail = `${result?.stderr || ''}${result?.stdout || ''}`.trim().slice(-1200);
        throw appError('VIDEO_FAILED', `${label}失败（退出码 ${result?.exitCode}）。${detail}`);
    }
    return result;
}

async function install(config, pkg, deps) {
    let locked = true;
    try { await fs.access(path.join(pkg.dir, 'package-lock.json')); } catch { locked = false; }
    const args = locked ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    await runInPackage(config, pkg, 'npm', args, { timeoutMs: INSTALL_TIMEOUT_MS, label: `npm ${args[0]} ` }, deps);
    return args[0];
}

async function sha256File(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

/** Hash of the package source: every file except installs, renders and caches. */
export async function treeHash(dir) {
    const files = [];
    const walk = async (current) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            if (COPY_EXCLUDES.has(entry.name)) continue;
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile()) files.push(file);
        }
    };
    await walk(dir);
    files.sort();
    const hash = createHash('sha256');
    for (const file of files) hash.update(`${path.relative(dir, file).split(path.sep).join('/')}\0${await sha256File(file)}\n`);
    return hash.digest('hex');
}
function readme({ name, title, frame, output }) {
    return `# ${title}

独立的代码视频包：HyperFrames 工程，自带锁定的依赖，不引用本目录以外的文件。${frame.width}×${frame.height}，${frame.fps} fps，${frame.frames} 帧。

\`\`\`bash
npm ci              # 安装锁定的 hyperframes
npm run check       # HyperFrames 检查
npm run dev         # 预览
npm run render      # 输出 ${output}
\`\`\`

入口是 \`index.html\`。素材放在本包的 \`assets/\` 下，用相对路径 \`./assets/...\` 引用；字体在 \`fonts/\`。画幅、入口和输出见 \`video.json\`。GSAP 从 CDN 加载，离线渲染时把它下载到 \`assets/\` 并改成本地路径。

包名 \`${name}\` 以 \`-vN\` 结尾。成片交付审阅后不再修改本包，改动请复制出新版本。
`;
}

function agents() {
    return `# 代码视频包

本目录是独立的 HyperFrames 工程。只修改本目录内的文件，不引用本目录以外的路径（不写 \`../\`，不写绝对路径）。

- 依赖：先运行 \`npm ci\`。HyperFrames 用本包锁定的版本：\`npx --no-install hyperframes <命令>\`，不要用 \`npx hyperframes@...\`。
- 改完运行 \`npm run check\`，错误修完再渲染。
- 每个计时元素需要 \`data-start\`、\`data-duration\` 和 \`class="clip"\`；根时间线注册在 \`window.__timelines\`，只用确定性逻辑。
- 素材放进 \`assets/\`，用 \`./assets/...\` 引用。
`;
}

async function sourceInfo(config, production) {
    try {
        const catalog = await readCatalog(config.catalogPath);
        const reference = findReference(catalog, production.referenceIds?.[0]);
        const source = reference ? await readSource(config.workspace, reference) : null;
        return { title: source?.title ?? null, url: source?.canonicalUrl ?? null };
    } catch {
        return { title: null, url: null };
    }
}

async function nextName(videos, prefix) {
    const used = videos.map((video) => video.name).filter((name) => name.startsWith(`${prefix}-v`)).map(videoVersion).filter(Boolean);
    return `${prefix}-v${Math.max(0, ...used) + 1}`;
}

export async function newVideo(config, { slug, name, width, height, fps, duration, skipInstall = false } = {}, deps = {}) {
    const { production, dir } = await openProduction(config, slug);
    const videos = await listVideos(dir);
    const target = assertName(name ?? await nextName(videos, 'code'));
    const pkgDir = path.join(dir, 'videos', target);
    try {
        await fs.access(pkgDir);
        throw appError('ALREADY_EXISTS', `已有 videos/${target}；新版本用 video:fork。`);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const frame = parseFrameOptions({ width, height, fps, duration });
    const rootPkg = await readJson(ROOT_PACKAGE);
    const output = `renders/${target}.mp4`;
    const source = await sourceInfo(config, production);
    await fs.mkdir(path.join(pkgDir, 'assets'), { recursive: true });
    const html = await compositionHtml({ id: target, width: frame.width, height: frame.height, fps: frame.fps, frames: frame.frames, compositionDir: pkgDir });
    const files = {
        'package.json': {
            name: `${production.slug}-${target}`.replace(/-v\d+$/, ''), version: '1.0.0', private: true, type: 'module',
            engines: { node: '>=22.15.0' },
            scripts: { check: 'hyperframes check', dev: 'hyperframes preview', render: `hyperframes render -o ${output}` },
            dependencies: { hyperframes: rootPkg.dependencies.hyperframes },
        },
        'video.json': {
            schema: VIDEO_SCHEMA, id: `${production.slug}-${target}`, version: videoVersion(target), title: `${production.slug} ${target}`,
            frame: { width: frame.width, height: frame.height, fps: frame.fps, frames: frame.frames },
            entry: 'index.html', output,
            commands: { install: 'npm ci', check: 'npm run check', render: 'npm run render' },
            inputs: {}, source: { ...source, forkedFrom: null },
        },
    };
    for (const [file, value] of Object.entries(files)) await fs.writeFile(path.join(pkgDir, file), `${JSON.stringify(value, null, 2)}\n`);
    await fs.writeFile(path.join(pkgDir, 'index.html'), html);
    await fs.writeFile(path.join(pkgDir, 'README.md'), readme({ name: target, title: files['video.json'].title, frame, output }));
    await fs.writeFile(path.join(pkgDir, 'AGENTS.md'), agents());
    await fs.writeFile(path.join(pkgDir, 'CLAUDE.md'), '@AGENTS.md\n');
    await fs.writeFile(path.join(pkgDir, '.gitignore'), `${[...COPY_EXCLUDES].filter((n) => n !== '.DS_Store').map((n) => `${n}/`).join('\n')}\n`);
    const pkg = { name: target, dir: pkgDir, manifest: files['video.json'] };
    const installed = skipInstall ? null : await install(config, pkg, deps);
    return { command: 'video:new', slug: production.slug, video: target, dir: rel(config, pkgDir), installed };
}

async function copyTree(from, to) {
    for (const entry of await fs.readdir(from)) {
        if (COPY_EXCLUDES.has(entry)) continue;
        await fs.cp(path.join(from, entry), path.join(to, entry), {
            recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true,
            filter: (source) => !COPY_EXCLUDES.has(path.basename(source)),
        });
    }
}

async function rewriteFile(file, from, to) {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (text.includes(from)) await fs.writeFile(file, text.replaceAll(from, to));
}

export async function forkVideo(config, { slug, from, name, skipInstall = false, templateLineage } = {}, deps = {}) {
    const source = await resolveVideo(config, slug, from);
    const videos = await listVideos(source.productionDir);
    const prefix = source.name.replace(/-v\d+$/, '');
    const lineage = source.lineage ? (templateLineage || nextTemplateLineage(source, videos, { mode: source.lineage.kind === 'source' ? 'derive' : 'revise', title: source.lineage.title })) : null;
    const target = assertName(name ?? (lineage ? `${lineage.id}-v${lineage.version}` : await nextName(videos, prefix)));
    const pkgDir = path.join(source.productionDir, 'videos', target);
    const sourceHash = await treeHash(source.dir);
    try {
        await fs.mkdir(pkgDir);
    } catch (error) {
        if (error.code === 'EEXIST') throw appError('ALREADY_EXISTS', `已有 videos/${target}。`);
        throw error;
    }
    try {
        await copyTree(source.dir, pkgDir);
        const oldOutput = source.manifest.output;
        const output = typeof oldOutput === 'string' && oldOutput.includes(source.name) ? oldOutput.replaceAll(source.name, target) : `renders/${target}.mp4`;
        for (const file of ['package.json', 'README.md']) await rewriteFile(path.join(pkgDir, file), oldOutput, output);
        const manifest = {
            ...source.manifest,
            ...(lineage ? { id: lineage.id, version: lineage.version, template: { ...source.manifest.template, lineage } } : { version: videoVersion(target) }),
            output,
            source: { ...(source.manifest.source || {}), forkedFrom: { video: source.name, version: source.manifest.version ?? null, treeHash: sourceHash } },
        };
        await fs.writeFile(path.join(pkgDir, 'video.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        const pkg = { name: target, dir: pkgDir, manifest };
        const installed = skipInstall ? null : await install(config, pkg, deps);
        return { command: 'video:fork', slug: source.production.slug, from: source.name, video: target, dir: rel(config, pkgDir), output, installed, ...(lineage ? { lineage } : {}) };
    } catch (error) {
        await fs.rm(pkgDir, { recursive: true, force: true });
        throw error;
    }
}
export async function checkVideo(config, { slug, name } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, name);
    const cli = deps.hyperframesCli ?? await packageCli(config, pkg);
    const entry = pkg.manifest.entry || 'index.html';
    insidePackage(pkg, entry, 'entry');
    const result = await precheckComposition({
        dir: pkg.dir, entry, projectRoot: pkg.dir, fps: pkg.manifest.frame?.fps,
        hyperframesCli: cli, timeoutMs: deps.timeoutMs ?? 600_000, env: config.env,
        signal: deps.signal, cancelCode: 'VIDEO_CANCELLED',
    }, deps);
    return { command: 'check', slug: pkg.production.slug, video: pkg.name, ...result };
}

export async function renderVideo(config, { slug, name } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, name);
    if (!deps.hyperframesCli) await packageCli(config, pkg);
    const scripts = (await readJson(path.join(pkg.dir, 'package.json'))).scripts || {};
    if (!scripts.render) throw appError('VIDEO_INVALID', `videos/${pkg.name}/package.json 没有 render 脚本。`);
    const output = outputPath(pkg);
    const steps = [];
    if (scripts.build) {
        await runInPackage(config, pkg, 'npm', ['run', 'build'], { timeoutMs: INSTALL_TIMEOUT_MS, label: 'npm run build ' }, deps);
        steps.push('build');
    }
    const started = Date.now();
    await runInPackage(config, pkg, 'npm', ['run', 'render'], { timeoutMs: deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS, label: 'npm run render ' }, deps);
    steps.push('render');
    let stat;
    try { stat = await fs.stat(output); } catch { stat = null; }
    if (!stat?.isFile() || stat.size === 0) throw appError('VIDEO_FAILED', `渲染结束但没有找到输出 ${rel(config, output)}；检查 package.json 的 render 脚本与 video.json 的 output 是否一致。`);
    // Recorded outside the package so the package never learns about video-remake.
    const record = { video: pkg.name, output: pkg.manifest.output, treeHash: await treeHash(pkg.dir), sha256: await sha256File(output), renderedAt: (deps.now?.() ?? new Date()).toISOString() };
    await fs.mkdir(path.dirname(renderRecordFile(pkg)), { recursive: true });
    await fs.writeFile(renderRecordFile(pkg), `${JSON.stringify(record, null, 2)}\n`);
    return {
        command: 'video:render', slug: pkg.production.slug, video: pkg.name, steps,
        output: rel(config, output), bytes: stat.size, elapsedMs: Date.now() - started,
        next: `remake video:import ${pkg.production.slug} --video ${pkg.name}`,
    };
}

function renderRecordFile(pkg) {
    return path.join(pkg.productionDir, 'drafts', '.renders', `${pkg.name}.json`);
}

/** Copy the package's render into drafts/<name>/ and record which source produced it. */
export async function importVideo(config, { slug, name, force = false } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, name);
    const output = outputPath(pkg);
    try { await fs.access(output); } catch {
        throw appError('NOT_FOUND', `还没有渲染结果 ${rel(config, output)}；先运行 remake video:render ${pkg.production.slug} --video ${pkg.name}。`);
    }
    const sourceHash = await treeHash(pkg.dir);
    let record = null;
    try { record = await readJson(renderRecordFile(pkg)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const verified = Boolean(record) && record.treeHash === sourceHash && record.sha256 === await sha256File(output);
    if (!verified && !force) {
        throw appError('VIDEO_UNVERIFIED', record
            ? `渲染之后 videos/${pkg.name} 的源文件或成片有变化，成片不能证明来自当前源文件。重新运行 remake video:render ${pkg.production.slug} --video ${pkg.name}。`
            : `没有 video:render 的渲染记录，无法确认成片来自当前源文件。先运行 remake video:render ${pkg.production.slug} --video ${pkg.name}，确有需要时加 --force 导入。`);
    }
    const draftDir = path.join(pkg.productionDir, 'drafts', pkg.name);
    const manifestFile = path.join(draftDir, 'MANIFEST.json');
    let previous = null;
    try { previous = await readJson(manifestFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.package?.treeHash && previous.package.treeHash !== sourceHash) {
        throw appError('VIDEO_FROZEN', `videos/${pkg.name} 已导入过草稿，之后源文件被改动。已导入的版本不再修改：用 remake video:fork ${pkg.production.slug} --video ${pkg.name} 开新版本，或把本包恢复原样。`);
    }
    await fs.mkdir(draftDir, { recursive: true });
    const file = path.basename(output);
    await fs.copyFile(output, path.join(draftDir, file));
    const probe = await (deps.probe || probeMedia)(path.join(draftDir, file));
    const sha256 = await sha256File(path.join(draftDir, file));
    const { size: bytes } = await fs.stat(path.join(draftDir, file));
    const manifest = {
        version: pkg.name,
        title: pkg.manifest.title || pkg.name,
        importedAt: (deps.now?.() ?? new Date()).toISOString(),
        package: { dir: rel(config, pkg.dir), name: pkg.name, version: pkg.manifest.version ?? null, treeHash: sourceHash, output: pkg.manifest.output, renderVerified: verified },
        renders: [{
            title: pkg.manifest.title || pkg.name, file, duration: probe.duration, width: probe.width, height: probe.height,
            fps: probe.frameRate, frames: probe.frames, audioStreams: probe.audioStreams, bytes, sha256,
        }],
    };
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const catalog = await readCatalog(config.catalogPath);
    const entry = catalog.productions.find((item) => item.slug === pkg.production.slug);
    const descriptor = { version: pkg.name, label: manifest.title, dir: rel(config, draftDir), manifest: 'MANIFEST.json' };
    const drafts = entry.drafts && typeof entry.drafts === 'object' ? { ...entry.drafts } : {};
    if (!drafts.dir) Object.assign(drafts, descriptor);
    else if (drafts.version !== pkg.name) {
        drafts.versions = [...(Array.isArray(drafts.versions) ? drafts.versions : []).filter((item) => item.version !== pkg.name), descriptor];
    }
    drafts.activeVersion = pkg.name;
    upsertProduction(catalog, { slug: entry.slug, drafts });
    await writeCatalog(config.catalogPath, catalog);
    return {
        command: 'video:import', slug: pkg.production.slug, video: pkg.name, reimport: Boolean(previous), renderVerified: verified,
        draft: rel(config, path.join(draftDir, file)), treeHash: sourceHash, duration: probe.duration, frames: probe.frames,
    };
}

/** Copy a ledger asset from productions/<slug>/assets into the package. */
export async function addVideoAsset(config, { slug, name, id, force = false } = {}) {
    if (!id) throw invalid('video:add 需要 --id <素材id>。');
    const pkg = await resolveVideo(config, slug, name);
    let ledger;
    try { ledger = await readJson(path.join(pkg.productionDir, 'assets', 'ledger.json')); } catch {
        throw appError('NOT_FOUND', `${slug} 还没有素材台账。`);
    }
    const item = ledger.items?.find((entry) => entry.id === id);
    if (!item) throw appError('NOT_FOUND', `台账里没有素材: ${id}`);
    const source = path.resolve(config.workspace, item.path);
    const assetsRoot = path.join(pkg.productionDir, 'assets');
    if (!source.startsWith(`${assetsRoot}${path.sep}`)) throw appError('VIDEO_INVALID', `素材不在制作的 assets/ 内: ${item.path}`);
    const relative = path.join('assets', item.kind, path.basename(source));
    const target = path.join(pkg.dir, relative);
    let status = 'copied';
    try {
        await fs.access(target);
        if (await sha256File(target) === await sha256File(source)) status = 'unchanged';
        else if (!force) throw appError('ALREADY_EXISTS', `包里已有不同内容的 ${relative}；确认覆盖请加 --force。`);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (status !== 'unchanged') {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
    }
    const entryDir = path.dirname(insidePackage(pkg, pkg.manifest.entry || 'index.html', 'entry'));
    const src = `./${path.relative(entryDir, target).split(path.sep).join('/')}`;
    const { htmlSnippet } = await import('./media/land.js');
    return {
        command: 'video:add', slug: pkg.production.slug, video: pkg.name, id, status,
        path: rel(config, target), html: htmlSnippet({ kind: item.kind, id, src }),
    };
}

export async function listVideosCommand(config, { slug } = {}) {
    const { production, dir } = await openProduction(config, slug);
    const videos = [];
    for (const pkg of await listVideos(dir)) {
        const exists = async (file) => fs.access(file).then(() => true, () => false);
        let draft = null;
        try { draft = await readJson(path.join(dir, 'drafts', pkg.name, 'MANIFEST.json')); } catch { /* not imported */ }
        let output = null;
        try { output = outputPath(pkg); } catch { /* invalid manifest is reported below */ }
        videos.push({
            name: pkg.name, version: pkg.lineage?.version ?? pkg.manifest.version ?? null, dir: rel(config, pkg.dir),
            ...(pkg.lineage ? { lineage: pkg.lineage } : {}),
            forkedFrom: pkg.manifest.source?.forkedFrom?.video ?? null,
            installed: await exists(path.join(pkg.dir, 'node_modules', 'hyperframes')),
            rendered: output ? await exists(output) : false,
            imported: Boolean(draft), frozen: Boolean(draft?.package?.treeHash),
        });
    }
    return { command: 'video:list', slug: production.slug, videos };
}

// ---------- .video template packages ----------
export const TEMPLATE_FORMAT = 'video-template@1';
export const PACK_FORMAT = 'video-pack@1';
const SKILL_DIR = fileURLToPath(new URL('../.agents/skills/video-template', import.meta.url));
// A template's user inputs never travel with it, whatever video.json says.
const ALWAYS_EXCLUDED = ['inputs.json', 'inputs/'];
const TEXT_EXT = new Set(['.md', '.json', '.mjs', '.js', '.html', '.css', '.txt', '.svg', '.yml', '.yaml']);
const PRIVATE = [
    [/\/Users\/[A-Za-z0-9._-]+\//, '本机用户目录'],
    [/\/home\/[A-Za-z0-9._-]+\//, '本机用户目录'],
    [/[A-Za-z]:\\Users\\/, '本机用户目录'],
    [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, '内网地址'],
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/, '疑似密钥'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
];

function excluded(relative, isDir, patterns) {
    const target = isDir ? `${relative}/` : relative;
    return patterns.some((p) => (p.endsWith('/') ? target === p || target.startsWith(p) : target === p));
}

async function packFiles(dir, patterns) {
    const files = [];
    let skipped = 0;
    const walk = async (current) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            const relative = path.relative(dir, file).split(path.sep).join('/');
            if (COPY_EXCLUDES.has(entry.name) || excluded(relative, entry.isDirectory(), patterns)) { skipped++; continue; }
            if (entry.isSymbolicLink()) throw appError('VIDEO_INVALID', `包里有符号链接，不能打进 .video: ${relative}`);
            if (entry.isDirectory()) await walk(file);
            else if (entry.isFile()) files.push({ relative, file });
        }
    };
    await walk(dir);
    return { files: files.sort((a, b) => a.relative.localeCompare(b.relative)), skipped };
}

function privateFindings(name, text) {
    const found = [];
    for (const [re, label] of PRIVATE) {
        const m = re.exec(text);
        if (m) found.push(`${name}: ${label}「${m[0].slice(0, 40)}」`);
    }
    return found;
}

/**
 * Pack a template package into <out>.video: a zip with one top-level folder holding the package source (no installs,
 * renders, caches, user inputs or generated files), the video-template agent skill, and a pack record in video.json.
 */
export async function packVideo(config, { slug, name, out, force = false } = {}, deps = {}) {
    const pkg = await resolveVideo(config, slug, name);
    const template = pkg.manifest.template;
    if (template?.format !== TEMPLATE_FORMAT) {
        throw appError('VIDEO_INVALID', `videos/${pkg.name}/video.json 没有 template（format: ${TEMPLATE_FORMAT}），不是模板包，不能打成 .video。格式见 docs/video-template.md。`);
    }
    const patterns = [...new Set([...ALWAYS_EXCLUDED, '.agents/skills/video-template/', '.claude/skills/video-template/', ...(template.pack?.exclude || [])])];
    const { files, skipped } = await packFiles(pkg.dir, patterns);
    const base = (pkg.lineage?.id || pkg.manifest.id || `${pkg.production.slug}-${pkg.name}`).replace(/[^a-z0-9-]+/gi, '-');
    const top = `${base}-v${pkg.lineage?.version ?? pkg.manifest.version ?? videoVersion(pkg.name) ?? 1}`;
    const entries = [];
    const findings = [];
    const hash = createHash('sha256');
    for (const { relative, file } of files) {
        if (relative === 'video.json') continue;
        const data = await fs.readFile(file);
        if (TEXT_EXT.has(path.extname(relative).toLowerCase())) findings.push(...privateFindings(relative, data.toString('utf8')));
        const { mtime, mode } = await fs.stat(file);
        entries.push({ name: `${top}/${relative}`, data, mtime, mode });
        hash.update(`${relative}\0${createHash('sha256').update(data).digest('hex')}\n`);
    }
    // the agent skill travels with the template so any agent can use it
    let skill;
    try { skill = await fs.readdir(SKILL_DIR, { withFileTypes: true }); } catch { throw appError('NOT_FOUND', '找不到 .agents/skills/video-template，无法把使用说明打进包。'); }
    for (const entry of skill.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
        const data = await fs.readFile(path.join(SKILL_DIR, entry.name));
        for (const root of ['.agents/skills/video-template', '.claude/skills/video-template']) {
            entries.push({ name: `${top}/${root}/${entry.name}`, data, mtime: new Date() });
        }
    }
    entries.push({ name: `${top}/inputs/README.md`, data: Buffer.from('# inputs\n\n把人物视频、口播、音乐和改好的字幕放在这里，路径写进上一级的 inputs.json（`npm run inputs -- --init` 生成）。本目录不随模板分发。\n'), mtime: new Date() });
    const contentHash = hash.digest('hex');
    const { forkedFrom, ...source } = pkg.manifest.source || {};
    const manifest = {
        ...pkg.manifest,
        ...(pkg.lineage ? { id: pkg.lineage.id, version: pkg.lineage.version, template: { ...pkg.manifest.template, lineage: pkg.lineage } } : {}),
        source,
        packed: { format: PACK_FORMAT, contentHash, files: files.length, packedAt: (deps.now?.() ?? new Date()).toISOString() },
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    findings.push(...privateFindings('video.json', manifestText));
    if (findings.length) throw appError('VIDEO_PRIVATE', `包里有不该公开的内容，先清理再打包:\n- ${findings.join('\n- ')}`);
    entries.unshift({ name: `${top}/video.json`, data: Buffer.from(manifestText), mtime: new Date() });

    const target = out ? path.resolve(config.workspace, out) : path.join(config.workspace, 'deliverables', pkg.production.slug, 'templates', `${top}.video`);
    if (!target.endsWith('.video')) throw invalid(`输出文件要以 .video 结尾: ${out}`);
    try {
        await fs.access(target);
        if (!force) throw appError('ALREADY_EXISTS', `已有 ${rel(config, target)}；覆盖请加 --force。`);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const zip = writeZip(entries);
    const check = readZip(zip);
    if (check.length !== entries.length) throw appError('VIDEO_FAILED', '打包校验失败：读回的文件数不一致。');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, zip);
    // the screening room lists templates from the catalog (only files under deliverables/<slug>/templates/)
    const templatesDir = path.join(config.workspace, 'deliverables', pkg.production.slug, 'templates');
    let registered = false;
    if (target.startsWith(`${templatesDir}${path.sep}`)) {
        const catalog = await readCatalog(config.catalogPath);
        const entry = catalog.productions.find((item) => item.slug === pkg.production.slug);
        const frame = pkg.manifest.frame || {};
        const record = {
            file: rel(config, target), video: pkg.name, ...(pkg.lineage ? { lineage: pkg.lineage } : {}), title: pkg.manifest.title || top, summary: template.summary || null,
            inputs: Object.keys(template.inputs || {}),
            textCount: Number.isInteger(template.inputs?.texts?.count) ? template.inputs.texts.count : null,
            width: frame.width ?? null, height: frame.height ?? null, duration: frame.frames && frame.fps ? +(frame.frames / frame.fps).toFixed(3) : null,
            bytes: zip.length, contentHash, packedAt: manifest.packed.packedAt,
        };
        const templates = (Array.isArray(entry.templates) ? entry.templates : []).filter((item) => item.file !== record.file && item.video !== record.video);
        upsertProduction(catalog, { slug: entry.slug, templates: [...templates, record] });
        await writeCatalog(config.catalogPath, catalog);
        registered = true;
    }
    return {
        command: 'video:pack', slug: pkg.production.slug, video: pkg.name, output: rel(config, target), folder: top,
        bytes: zip.length, files: entries.length, excluded: skipped, contentHash, registered,
    };
}

export { packageCli };

// Importing a template only writes validated files; it never executes package scripts.
export const MAX_TEMPLATE_BYTES = 100 * 1024 * 1024;

function templatePath(value, label) {
    if (typeof value !== 'string' || !value || /[\\:\x00-\x1f]/.test(value)
        || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw appError('VIDEO_INVALID', `${label} 必须是包内相对路径。`);
    }
    return value;
}

async function inspectTemplate(buffer) {
    let entries;
    try { entries = readZip(buffer); }
    catch (error) { throw appError('VIDEO_INVALID', `无法读取 .video 模板：${error.message}`); }
    const files = entries.filter(entry => !entry.name.endsWith('/'));
    const roots = new Set(entries.map(entry => entry.name.split('/')[0]));
    if (roots.size !== 1 || !files.length) throw appError('VIDEO_INVALID', '.video 必须包含且只包含一个顶层文件夹。');
    const folder = assertName([...roots][0]);
    const contents = new Map();
    for (const entry of files) {
        const relative = templatePath(entry.name.slice(folder.length + 1), '模板文件');
        if (entry.name !== `${folder}/${relative}`) throw appError('VIDEO_INVALID', '模板文件必须位于顶层文件夹内。');
        if (relative.split('/').some(part => COPY_EXCLUDES.has(part) || part === '.git')) {
            throw appError('VIDEO_INVALID', `模板包含安装产物、渲染结果或缓存：${relative}`);
        }
        contents.set(relative, entry);
    }
    const json = (name) => {
        try {
            const value = JSON.parse(contents.get(name)?.data.toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            return value;
        } catch { throw appError('VIDEO_INVALID', `模板缺少有效的 ${name}。`); }
    };
    const manifest = json('video.json');
    if (manifest.schema !== VIDEO_SCHEMA || manifest.template?.format !== TEMPLATE_FORMAT) {
        throw appError('VIDEO_INVALID', `模板需要 ${VIDEO_SCHEMA} 和 ${TEMPLATE_FORMAT} 声明。`);
    }
    assertSlug(manifest.id);
    if (!Number.isSafeInteger(manifest.version) || manifest.version < 1 || folder !== `${manifest.id}-v${manifest.version}`) {
        throw appError('VIDEO_INVALID', '顶层文件夹必须与模板 id 和 version 对应（<id>-vN）。');
    }
    for (const key of ['width', 'height', 'frames']) {
        if (!Number.isSafeInteger(manifest.frame?.[key]) || manifest.frame[key] <= 0) throw appError('VIDEO_INVALID', `模板 frame.${key} 必须是正整数。`);
    }
    if (typeof manifest.frame?.fps !== 'number' || !Number.isFinite(manifest.frame.fps) || manifest.frame.fps <= 0) throw appError('VIDEO_INVALID', '模板 frame.fps 必须是正数。');
    templatePath(manifest.entry, 'entry');
    templatePath(manifest.output, 'output');
    const pkg = json('package.json');
    const lock = json('package-lock.json');
    const expected = (await readJson(ROOT_PACKAGE)).dependencies.hyperframes;
    if (pkg.dependencies?.hyperframes !== expected || lock.packages?.['node_modules/hyperframes']?.version !== expected
        || lock.packages?.['']?.dependencies?.hyperframes !== expected || ![2, 3].includes(lock.lockfileVersion)) {
        throw appError('VIDEO_INVALID', `模板及锁文件必须锁定本项目的 HyperFrames ${expected}。`);
    }
    for (const key of ['inputs', 'build', 'compose', 'render']) {
        if (typeof pkg.scripts?.[key] !== 'string' || !pkg.scripts[key].trim()) throw appError('VIDEO_INVALID', `模板 package.json 缺少 ${key} 脚本。`);
    }
    return { folder, manifest, files: [...contents.entries()] };
}

export async function unpackVideo(config, { file, slug } = {}, deps = {}) {
    if (typeof file !== 'string' || !file.toLowerCase().endsWith('.video')) throw invalid('需要一个 .video 模板文件。');
    const source = path.resolve(config.workspace, file);
    const handle = await fs.open(source, 'r');
    let buffer;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_TEMPLATE_BYTES) throw appError('VIDEO_INVALID', '.video 必须是文件，且不能超过 100 MiB。');
        buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset > stat.size) throw appError('VIDEO_INVALID', '模板文件在读取时发生变化，请重试。');
        buffer = buffer.subarray(0, offset);
    } finally { await handle.close(); }
    const { folder, manifest, files } = await inspectTemplate(buffer);
    const name = assertSlug(slug === undefined ? manifest.id : slug);
    const importedAt = (deps.now?.() ?? new Date()).toISOString();
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const productionDir = path.join(config.workspace, 'productions', name);
    const packageDir = path.join(productionDir, 'videos', folder);
    await fs.mkdir(path.dirname(config.catalogPath), { recursive: true });
    const lockPath = `${config.catalogPath}.template-import.lock`;
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (error) {
        if (error.code === 'EEXIST') throw appError('ALREADY_EXISTS', '另一个模板正在导入，请稍后重试。');
        throw error;
    }
    let created = false;
    let catalogTempDir;
    try {
        let catalog;
        try { await fs.access(config.catalogPath); catalog = await readCatalog(config.catalogPath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; catalog = emptyCatalog(); }
        if (catalog.productions.some(entry => entry.slug.toLowerCase() === name.toLowerCase())) {
            throw appError('ALREADY_EXISTS', `制作 ${name} 已存在，请指定新的制作标识。`);
        }
        const parent = path.dirname(productionDir);
        await fs.mkdir(parent, { recursive: true });
        if (await fs.realpath(parent) !== path.join(await fs.realpath(config.workspace), 'productions')) throw appError('VIDEO_INVALID', 'productions 目录不能是符号链接。');
        try { await fs.mkdir(productionDir); created = true; }
        catch (error) {
            if (error.code === 'EEXIST') throw appError('ALREADY_EXISTS', `制作目录 ${name} 已存在，不能覆盖。`);
            throw error;
        }
        for (const sub of ['assets', 'drafts', 'videos']) await fs.mkdir(path.join(productionDir, sub));
        await fs.mkdir(packageDir);
        for (const [relative, entry] of files) {
            const target = path.join(packageDir, relative);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, entry.data, { flag: 'wx', mode: (entry.mode & 0o111) ? 0o755 : 0o644 });
        }
        await fs.writeFile(path.join(productionDir, 'BRIEF.md'), `# ${name}\n\n来源：外部 .video 模板 ${folder}。\n\n目标：填写本次使用的人物、口播、个人信息和画面文字。\n\n模板目录：videos/${folder}/\n先在模板目录运行 npm ci、npm run inputs -- --init、npm run build，按 SCRIPT.md 准备素材。\n`);
        await fs.writeFile(path.join(productionDir, 'TREATMENT.md'), '# 制作方案\n\n沿用模板的画面与时间轴，填写本次内容调整。\n');
        await fs.writeFile(path.join(productionDir, 'PROGRESS.md'), `# 制作进度\n\n${importedAt} 导入模板 ${folder}；尚未安装依赖、准备素材或渲染。\n`);
        upsertProduction(catalog, {
            slug: name, dir: rel(config, productionDir), title: typeof manifest.title === 'string' ? manifest.title : name,
            referenceIds: [], status: 'commissioned', deliverable: null,
            templateImport: { video: folder, sha256, importedAt, files: files.length },
        });
        catalogTempDir = await fs.mkdtemp(path.join(path.dirname(config.catalogPath), '.template-catalog-'));
        const catalogTemp = path.join(catalogTempDir, 'catalog.json');
        await writeCatalog(catalogTemp, catalog);
        await fs.rename(catalogTemp, config.catalogPath);
        created = false;
    } finally {
        try {
            if (created) await fs.rm(productionDir, { recursive: true, force: true });
        } finally {
            try {
                if (catalogTempDir) await fs.rm(catalogTempDir, { recursive: true, force: true });
            } finally {
                try { await lock.close(); }
                finally { await fs.rm(lockPath, { force: true }); }
            }
        }
    }
    return { command: 'video:unpack', slug: name, video: folder, dir: rel(config, packageDir), title: manifest.title || name, files: files.length, sha256, importedAt, installed: false };
}

// ---------- Template editor operations ----------
const TEMPLATE_JSON_LIMIT = 4 * 1024 * 1024;
const TEMPLATE_INPUT_KEYS = ['presenter', 'voice', 'music', 'identity', 'captions', 'texts'];
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function editorPackage(config, options) {
    const pkg = await resolveVideo(config, options.slug, options.name);
    if (pkg.manifest.template?.format !== TEMPLATE_FORMAT) throw appError('VIDEO_INVALID', '这个代码视频包不是可填写素材的模板。');
    const root = await fs.realpath(config.workspace);
    const expected = path.join(root, 'productions', pkg.production.slug, 'videos', pkg.name);
    if (await fs.realpath(pkg.dir) !== expected) throw appError('VIDEO_INVALID', '模板目录必须位于本制作内，不能使用符号链接。');
    let current = root;
    for (const segment of ['productions', pkg.production.slug, 'videos', pkg.name]) {
        current = path.join(current, segment);
        if ((await fs.lstat(current)).isSymbolicLink()) throw appError('VIDEO_INVALID', '模板目录不能使用符号链接。');
    }
    pkg.dir = expected;
    return pkg;
}

/** Resolve editor-owned files, rejecting every symlink component, including the target. */
async function editorFile(pkg, relative, { createParents = false, optional = false } = {}) {
    templatePath(relative, '素材路径');
    const parts = relative.split('/');
    let current = pkg.dir;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const last = index === parts.length - 1;
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (!last && createParents) { await fs.mkdir(current); continue; }
            if (optional) return null;
            if (last && createParents) return current;
            throw appError('VIDEO_INVALID', `素材文件不存在：${relative}`);
        }
        if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) throw appError('VIDEO_INVALID', `素材路径不是包内普通文件：${relative}`);
    }
    return current;
}

async function editorJson(pkg, relative, fallback) {
    const file = await editorFile(pkg, relative, { optional: true });
    if (!file) return fallback;
    if ((await fs.stat(file)).size > TEMPLATE_JSON_LIMIT) throw appError('VIDEO_INVALID', `${relative} 不能超过 4 MiB。`);
    try { return await readJson(file); }
    catch { throw appError('VIDEO_INVALID', `${relative} 不是有效的 JSON。`); }
}

async function templateFrozen(pkg) {
    try { await fs.lstat(path.join(pkg.productionDir, 'drafts', pkg.name, 'MANIFEST.json')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function editableTemplate(pkg) {
    if (await templateFrozen(pkg)) throw appError('VIDEO_FROZEN', '此版本已合成并登记，素材已冻结。请先创建新版本再修改。');
}

function templateDefaults(pkg) {
    const schema = pkg.manifest.template.inputs || {};
    const defaults = {};
    for (const key of TEMPLATE_INPUT_KEYS) {
        if (!Object.hasOwn(schema, key)) continue;
        if (key === 'presenter') defaults.presenter = { src: null, mediaStart: 0, objectPosition: schema.presenter.objectPosition || '50% 30%' };
        else if (key === 'identity') defaults.identity = Object.fromEntries(Object.entries(schema.identity.fields || {}).map(([name, value]) => [name, value.default ?? '']));
        else defaults[key] = null;
    }
    return defaults;
}

async function editorInputs(pkg) {
    const defaults = templateDefaults(pkg);
    const raw = await editorJson(pkg, 'inputs.json', {});
    if (!plainObject(raw)) throw appError('VIDEO_INVALID', 'inputs.json 必须是对象。');
    const out = { ...defaults };
    for (const [key, value] of Object.entries(raw)) if (!key.startsWith('_')) out[key] = value;
    if (Object.hasOwn(defaults, 'identity')) out.identity = { ...defaults.identity, ...(plainObject(raw.identity) ? raw.identity : {}) };
    if (Object.hasOwn(defaults, 'presenter')) out.presenter = { ...defaults.presenter, ...(typeof raw.presenter === 'string' ? { src: raw.presenter } : raw.presenter || {}) };
    return out;
}

function validateJsonAsset(kind, data, schema) {
    if (kind === 'captions') {
        if (!Array.isArray(data) || (Number.isInteger(schema?.count) && data.length !== schema.count)) throw appError('VIDEO_INVALID', `字幕需要 ${schema?.count ?? '有效数量的'} 条。`);
        if (data.some(row => Array.isArray(row) ? typeof row[0] !== 'string' || (row[1] !== undefined && typeof row[1] !== 'string') : !plainObject(row) || typeof row.zh !== 'string' || (row.en !== undefined && typeof row.en !== 'string'))) throw appError('VIDEO_INVALID', '字幕每条需要中文 zh 和可选英文 en。');
    } else {
        const groups = Array.isArray(data) ? data.map(group => group?.texts) : [data];
        if (!groups.length || groups.some(group => !plainObject(group) || Object.values(group).some(value => typeof value !== 'string'))) throw appError('VIDEO_INVALID', '画面文字需要文字键值对象，或带 texts 字段的分组数组。');
    }
}

async function validateEditorInputs(pkg, raw) {
    if (!plainObject(raw)) throw invalid('素材配置必须是对象。');
    const schema = pkg.manifest.template.inputs || {};
    const defaults = templateDefaults(pkg);
    for (const key of Object.keys(raw)) {
        if (!TEMPLATE_INPUT_KEYS.includes(key) || !Object.hasOwn(schema, key)) throw invalid(`模板没有输入项 ${key}。`);
    }
    const inputs = { ...defaults, ...raw };
    const asset = async (kind, value) => {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value !== 'string' || !value.startsWith('inputs/')) throw invalid(`${kind} 只能使用上传到本模板 inputs/ 内的素材。`);
        const file = await editorFile(pkg, value);
        if (kind === 'captions' || kind === 'texts') validateJsonAsset(kind, await editorJson(pkg, value), schema[kind]);
        return path.relative(pkg.dir, file).split(path.sep).join('/');
    };
    if (Object.hasOwn(inputs, 'presenter')) {
        const value = inputs.presenter ?? defaults.presenter;
        if (!plainObject(value) || Object.keys(value).some(key => !['src', 'mediaStart', 'objectPosition', 'placeholder'].includes(key))) throw invalid('人物素材格式无效。');
        const mediaStart = value.mediaStart ?? 0;
        const objectPosition = value.objectPosition ?? defaults.presenter.objectPosition;
        if (typeof mediaStart !== 'number' || !Number.isFinite(mediaStart) || mediaStart < 0) throw invalid('人物视频起点必须是非负秒数。');
        if (typeof objectPosition !== 'string' || !/^\d{1,3}(?:\.\d+)?% \d{1,3}(?:\.\d+)?%$/.test(objectPosition) || objectPosition.split(' ').some(v => parseFloat(v) > 100)) throw invalid('人脸位置应为两个 0–100% 的百分比，例如 50% 30%。');
        if (value.placeholder !== undefined && !['frame', 'none'].includes(value.placeholder)) throw invalid('人物占位方式只能是 frame 或 none。');
        inputs.presenter = { src: await asset('presenter', value.src), mediaStart, objectPosition, ...(value.placeholder ? { placeholder: value.placeholder } : {}) };
    }
    if (Object.hasOwn(inputs, 'identity')) {
        if (!plainObject(inputs.identity)) throw invalid('个人信息必须是对象。');
        const fields = schema.identity.fields || {};
        for (const [key, value] of Object.entries(inputs.identity)) {
            if (!Object.hasOwn(fields, key) || typeof value !== 'string' || value.length > 2000) throw invalid(`个人信息 ${key} 无效或过长。`);
        }
        inputs.identity = { ...defaults.identity, ...inputs.identity };
    }
    for (const kind of ['voice', 'music', 'captions', 'texts']) if (Object.hasOwn(inputs, kind)) inputs[kind] = await asset(kind, inputs[kind]);
    return inputs;
}

async function previewFiles(pkg) {
    const directory = path.join(pkg.dir, '.work', 'preview');
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const names = entries.filter(entry => entry.isFile() && /^[a-zA-Z0-9_.-]+\.(png|jpg|jpeg|webp)$/.test(entry.name)).map(entry => entry.name).sort();
        const safe = [];
        for (const name of names) if (await editorFile(pkg, `.work/preview/${name}`, { optional: true })) safe.push(name);
        return safe;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function getTemplateEditor(config, options = {}) {
    const pkg = await editorPackage(config, options);
    const { templateAgentOptions } = await import('./template-agent.js');
    const generationFile = await editorFile(pkg, '.work/generation.json', { optional: true });
    let generation = null;
    if (generationFile) {
        try {
            const saved = await readJson(generationFile);
            generation = Object.fromEntries(['title', 'prompt', 'subtitleScript', 'target', 'agentRunId', 'summary', 'mode'].filter(key => typeof saved[key] === 'string').map(key => [key, saved[key]]));
        } catch { /* A missing history must not prevent editing the template. */ }
    }
    const scriptFile = await editorFile(pkg, 'SCRIPT.md', { optional: true });
    let installed = false;
    try { await packageCli(config, pkg); installed = true; } catch (error) { if (error.code !== 'VIDEO_NOT_INSTALLED') throw error; }
    return {
        slug: pkg.production.slug, video: pkg.name, title: pkg.manifest.title || pkg.name, lineage: pkg.lineage,
        frame: pkg.manifest.frame, summary: pkg.manifest.template.summary || '', schema: pkg.manifest.template.inputs || {},
        inputs: await editorInputs(pkg), frozen: await templateFrozen(pkg), installed,
        script: scriptFile ? (await fs.readFile(scriptFile, 'utf8')).slice(0, TEMPLATE_JSON_LIMIT) : null,
        previewFiles: await previewFiles(pkg),
        style: await readTemplateStyle(pkg.dir, pkg.manifest),
        agent: await templateAgentOptions(config), generation,
    };
}

async function captionEditor(pkg, { originalOnly = false } = {}) {
    const frozen = await templateFrozen(pkg);
    const schema = pkg.manifest.template.inputs?.captions;
    const unsupported = reason => ({ supported: false, reason, frozen, count: 0, rows: [], original: [], revision: null });
    if (!schema) return unsupported('这个模板没有声明字幕输入。');
    const originalFile = await editorFile(pkg, 'src/data/captions.json', { optional: true });
    if (!originalFile) return unsupported('未找到可识别的字幕原稿，仍可通过 JSON 文件上传字幕。');
    let raw;
    try { raw = await editorJson(pkg, 'src/data/captions.json'); }
    catch (error) {
        // Invalid JSON is an unsupported source format; unsafe paths remain errors.
        if (error.code === 'VIDEO_INVALID' && error.message.includes('不是有效的 JSON')) return unsupported('字幕原稿格式无法识别，仍可通过 JSON 文件上传字幕。');
        throw error;
    }
    const duration = pkg.manifest.frame.frames / pkg.manifest.frame.fps;
    const original = templateCaptionRows(raw, schema, duration);
    if (!original) return unsupported('字幕原稿不是支持的固定时间轴格式，仍可通过 JSON 文件上传字幕。');
    const inputs = originalOnly ? {} : await editorInputs(pkg);
    let rows = original;
    if (inputs.captions) {
        if (typeof inputs.captions !== 'string' || !inputs.captions.startsWith('inputs/')) throw invalid('当前字幕必须是本模板 inputs/ 内的文件。');
        await editorFile(pkg, inputs.captions);
        rows = mergeTemplateCaptionRows(original, await editorJson(pkg, inputs.captions));
    }
    return { supported: true, frozen, count: rows.length, rows, original, source: inputs.captions ? 'custom' : 'default', revision: captionRevision(original, rows, inputs.captions || null) };
}

/** Read-only: does not initialize inputs, execute scripts or change the template. */
export async function getTemplateCaptions(config, options = {}) {
    return captionEditor(await editorPackage(config, options), { originalOnly: options.originalOnly });
}

/**
 * Read-only teleprompter draft built from the current effective captions and
 * filled identity. Never writes into the package, so frozen versions can export too.
 */
export async function getTemplatePromptScript(config, options = {}) {
    const format = options.format || 'txt';
    const language = options.language || 'zh';
    if (!Object.hasOwn(PROMPT_FORMATS, format)) throw invalid('提词稿格式只能是 txt、srt、json 或 cards。');
    const pkg = await editorPackage(config, options);
    const captions = await captionEditor(pkg);
    if (!captions.supported) throw invalid(captions.reason);
    const inputs = await editorInputs(pkg);
    const duration = pkg.manifest.frame.frames / pkg.manifest.frame.fps;
    const script = buildPromptScript({
        rows: captions.rows, identity: inputs.identity || {},
        fields: pkg.manifest.template.inputs?.identity?.fields || {},
        duration, language, gapSeconds: options.gapSeconds, allowPlaceholders: options.allowPlaceholders === true,
    });
    const content = renderPromptScript(script, format, { slug: pkg.production.slug, video: pkg.name, title: `${pkg.manifest.title || pkg.name} 口播提词稿` });
    return {
        slug: pkg.production.slug, video: pkg.name, format, language,
        filename: `${pkg.name}-prompt-${language}${PROMPT_FORMATS[format].ext}`,
        contentType: PROMPT_FORMATS[format].type, content,
        count: script.count, skipped: script.skipped, pauses: script.pauses,
    };
}

function speechFingerprint(captions, inputs, duration) {
    const identity = Object.fromEntries(Object.entries(inputs.identity || {}).sort(([a], [b]) => a.localeCompare(b)));
    return createHash('sha256').update(JSON.stringify([captions.revision, identity, duration])).digest('hex');
}

async function templateVoiceState(pkg, captions, inputs) {
    if (!inputs.voice) return null;
    if (typeof inputs.voice !== 'string' || !inputs.voice.startsWith('inputs/')) throw invalid('口播声音必须是本模板 inputs/ 内的文件。');
    await editorFile(pkg, inputs.voice);
    const duration = pkg.manifest.frame.frames / pkg.manifest.frame.fps;
    const generated = /^inputs\/uploads\/voice-[a-f0-9-]+\.wav$/.test(inputs.voice);
    const metadata = generated ? await editorJson(pkg, `${inputs.voice}.json`, null) : null;
    return {
        path: inputs.voice, filename: path.basename(inputs.voice), generated: Boolean(metadata),
        ...(metadata ? { provider: metadata.provider, voice: metadata.voice, language: metadata.language,
            duration: metadata.duration, count: metadata.count, adjustedCount: metadata.adjustedCount,
            firstAt: metadata.firstAt, createdAt: metadata.createdAt,
            stale: !captions.supported || metadata.fingerprint !== speechFingerprint(captions, inputs, duration) } : {}),
    };
}

export async function getTemplateVoice(config, options = {}, deps = {}) {
    const pkg = await editorPackage(config, options);
    const captions = await captionEditor(pkg);
    const inputs = await editorInputs(pkg);
    const { speechOptions } = await import('./template-speech.js');
    const engine = await (deps.speechOptions || speechOptions)(config, deps);
    const supported = Boolean(pkg.manifest.template.inputs?.voice) && captions.supported;
    return { ...engine, supported, frozen: captions.frozen, revision: captions.revision,
        ...(!supported ? { reason: captions.reason || '这个模板没有口播声音输入。' } : {}),
        audio: await templateVoiceState(pkg, captions, inputs) };
}

/** Only serve the currently selected package-local media, never an arbitrary path. */
export async function getTemplateVoiceAsset(config, options = {}) {
    const pkg = await editorPackage(config, options);
    const inputs = await editorInputs(pkg);
    if (!inputs.voice || typeof inputs.voice !== 'string' || !inputs.voice.startsWith('inputs/')) throw appError('NOT_FOUND', '尚未设置口播声音。');
    const file = await editorFile(pkg, inputs.voice);
    const types = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4' };
    const type = types[path.extname(file).toLowerCase()];
    if (!type) throw appError('NOT_FOUND', '口播声音的文件类型不受支持。');
    return { path: file, name: path.basename(file), type };
}

export async function generateTemplateVoice(config, { slug, name, voice, language = 'zh', revision } = {}, deps = {}) {
    const pkg = await editorPackage(config, { slug, name });
    await editableTemplate(pkg);
    if (!pkg.manifest.template.inputs?.voice) throw invalid('这个模板没有口播声音输入。');
    const captions = await captionEditor(pkg);
    if (!captions.supported) throw invalid(captions.reason);
    if (revision !== undefined && revision !== captions.revision) throw appError('TEMPLATE_CAPTIONS_CONFLICT', '字幕已更新，请重新读取后再生成口播。');
    const inputs = await validateEditorInputs(pkg, await editorInputs(pkg));
    const duration = pkg.manifest.frame.frames / pkg.manifest.frame.fps;
    const relative = `inputs/uploads/voice-${randomUUID()}.wav`;
    const outputFile = await editorFile(pkg, relative, { createParents: true });
    const metadataFile = `${outputFile}.json`;
    const { synthesizeCaptionSpeech } = await import('./template-speech.js');
    let committed = false;
    try {
        cancelled(deps.signal);
        const result = await (deps.synthesizeCaptionSpeech || synthesizeCaptionSpeech)(config, {
            rows: captions.rows, identity: inputs.identity || {}, voice, language, duration, outputFile,
        }, deps);
        cancelled(deps.signal);
        const stat = await fs.lstat(outputFile);
        if (!stat.isFile() || !stat.size || stat.size > 1024 * 1024 * 1024) throw invalid('语音生成没有返回有效的音频文件。');
        await fs.chmod(outputFile, 0o600);
        // Recheck before committing, including edits made outside the web server.
        const latestPackage = await editorPackage(config, { slug, name });
        await editableTemplate(latestPackage);
        const latestInputs = await editorInputs(latestPackage), latestCaptions = await captionEditor(latestPackage);
        const latestDuration = latestPackage.manifest.frame.frames / latestPackage.manifest.frame.fps;
        const fingerprint = speechFingerprint(captions, inputs, duration);
        if (fingerprint !== speechFingerprint(latestCaptions, latestInputs, latestDuration) || latestInputs.voice !== inputs.voice) throw appError('TEMPLATE_CAPTIONS_CONFLICT', '生成期间字幕、时间轴、个人信息或口播已更新，请重新生成。');
        const metadata = Object.fromEntries(['provider', 'voice', 'language', 'duration', 'count', 'adjustedCount', 'firstAt'].filter(key => result[key] !== undefined).map(key => [key, result[key]]));
        await fs.writeFile(metadataFile, `${JSON.stringify({ ...metadata, fingerprint, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        cancelled(deps.signal);
        const saved = await saveTemplateInputs(config, { slug, name, inputs: { ...latestInputs, voice: relative } });
        committed = true;
        return { ...metadata, inputs: saved.inputs, audio: await templateVoiceState(pkg, captions, saved.inputs) };
    } finally {
        if (!committed) { await fs.rm(outputFile, { force: true }); await fs.rm(metadataFile, { force: true }); }
    }
}

/** CLI only. Reads the saved voice sample and speaks the template captions with qwen-tts. */
export async function generateClonedTemplateVoice(config, { slug, name, language = 'zh', voiceId } = {}, deps = {}) {
    if (config.media?.speech?.provider !== 'qwen-tts') {
        throw appError('MEDIA_UNAVAILABLE', '按已保存音色念稿需要把 media.speech.provider 设为 qwen-tts。网页里的「根据字幕生成口播」仍使用系统音色。');
    }
    const { loadVoiceProfile } = await import('./voice-profile.js');
    const profile = await loadVoiceProfile(config, voiceId);
    const { getProvider } = await import('./media/config.js');
    const { httpFetch } = await import('./http.js');
    const provider = getProvider('speech', 'qwen-tts', deps.providers);
    const pkg = await resolveVideo(config, slug, name);
    const speak = (request) => provider.synthesize(config.media.speech.settings, request, {
        ...deps, signal: deps.signal, fetchImpl: httpFetch(config.proxy, deps.fetchImpl),
    });
    const { synthesizeClonedCaptionSpeech } = await import('./template-speech.js');
    const result = await generateTemplateVoice(config, { slug, name: pkg.name, voice: profile.id, language }, {
        ...deps,
        synthesizeCaptionSpeech: (innerConfig, args, innerDeps) => synthesizeClonedCaptionSpeech(innerConfig, {
            ...args, reference: profile.file, referenceText: profile.text, voice: profile.id,
        }, { ...innerDeps, speak }),
    });
    return { command: 'template:voice', slug, video: pkg.name, voiceId: profile.id, referenceFile: profile.relative, ...result };
}

export async function saveTemplateCaptions(config, { slug, name, rows, revision, inputs } = {}) {
    const pkg = await editorPackage(config, { slug, name });
    await editableTemplate(pkg);
    const current = await captionEditor(pkg);
    if (!current.supported) throw invalid(current.reason);
    if (revision !== undefined && (typeof revision !== 'string' || revision !== current.revision)) throw appError('TEMPLATE_CAPTIONS_CONFLICT', '字幕已在其他页面更新，请重新读取后再保存。');
    const updated = validateEditedCaptionRows(current.original, rows);
    const currentInputs = inputs === undefined ? await editorInputs(pkg) : inputs;
    if (!plainObject(currentInputs)) throw invalid('素材配置必须是对象。');
    // Validate other unsaved material fields before creating the replacement caption file.
    const values = await validateEditorInputs(pkg, { ...currentInputs, captions: null });
    const stalePreviews = await Promise.all((await previewFiles(pkg)).map(filename => editorFile(pkg, `.work/preview/${filename}`)));
    const relative = `inputs/uploads/captions-${randomUUID()}.json`;
    const file = await editorFile(pkg, relative, { createParents: true });
    let committed = false;
    try {
        await fs.writeFile(file, `${JSON.stringify(updated.map(({ at, zh, en }) => ({ at, zh, en })), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        values.captions = relative;
        const saved = await saveTemplateInputs(config, { slug, name, inputs: values });
        committed = true;
        for (const preview of stalePreviews) await fs.rm(preview, { force: true });
        return { inputs: saved.inputs, captions: await captionEditor(pkg) };
    } finally { if (!committed) await fs.rm(file, { force: true }); }
}

export async function saveVideoStyle(config, { slug, name, style } = {}) {
    const pkg = await editorPackage(config, { slug, name });
    await editableTemplate(pkg);
    const saved = await saveTemplateStyle(pkg.dir, pkg.manifest, style);
    for (const filename of await previewFiles(pkg)) await fs.unlink(await editorFile(pkg, `.work/preview/${filename}`));
    return { style: saved };
}

function nextTemplateLineage(source, videos, { mode = 'derive', title }) {
    if (!['derive', 'revise'].includes(mode)) throw invalid('模板生成方式只能是 derive（新模板）或 revise（当前模板的新版本）。');
    const parent = templateLineagePointer(source);
    if (mode === 'revise') {
        if (source.lineage.kind !== 'derived') throw invalid('来源模板保留原作者版本；请先创建一个独立的新模板，再迭代它的版本。');
        const latest = Math.max(...videos.filter(pkg => pkg.lineage?.id === source.lineage.id).map(pkg => pkg.lineage.version));
        return { ...source.lineage, title, version: latest + 1, parent };
    }
    return { id: `template-${randomUUID().replaceAll('-', '').slice(0, 12)}`, title, version: 1, kind: 'derived', origin: parent, parent };
}

/** A new reusable design starts without the previous user's media or input values. */
export async function remixTemplate(config, { slug, name, title, style, mode = 'derive' } = {}, deps = {}) {
    const source = await editorPackage(config, { slug, name });
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 160 || /[\x00-\x1f]/.test(title)) throw invalid('请填写 1–160 字的新模板名称。');
    cancelled(deps.signal);
    const videos = await listVideos(source.productionDir);
    const lineage = nextTemplateLineage(source, videos, { mode, title: title.trim() });
    await deps.onProgress?.({ stage: 'remix', message: mode === 'revise' ? '正在创建当前模板的新版本' : '正在创建独立的新模板' });
    const fork = await forkVideo(config, { slug, from: source.name, skipInstall: true, templateLineage: lineage }, deps);
    try {
        const pkg = await editorPackage(config, { slug, name: fork.video });
        cancelled(deps.signal);
        if (style !== undefined) await saveTemplateStyle(pkg.dir, pkg.manifest, style);
        for (const relative of ['inputs.json', 'inputs']) {
            await fs.rm(path.join(pkg.dir, relative), { recursive: true, force: true });
        }
        // The shared-CSS adapter has these declared generated outputs. Rebuild from defaults.
        const adapted = await readTemplateStyle(pkg.dir, pkg.manifest);
        if (adapted.supported) {
            for (const relative of ['index.html', 'SCRIPT.md', 'slots.json', 'assets/audio', 'assets/presenter', 'assets/voice']) {
                const parent = path.dirname(relative);
                if (parent !== '.' && await fs.lstat(path.join(pkg.dir, parent)).then(stat => stat.isSymbolicLink(), error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw appError('VIDEO_INVALID', '模板生成目录不能是符号链接。');
                await fs.rm(path.join(pkg.dir, relative), { recursive: true, force: true });
            }
        }
        const manifest = { ...pkg.manifest, title: title.trim() };
        delete manifest.packed;
        if (adapted.supported) manifest.template = { ...manifest.template, style: { format: 'video-style@1', adapter: 'shared-css-v1', file: 'src/shared.css' } };
        const target = await editorFile(pkg, 'video.json');
        cancelled(deps.signal);
        await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
        return { ...fork, command: 'video:remix', title: manifest.title, inputsReset: true, mode };
    } catch (error) {
        await fs.rm(path.resolve(config.workspace, fork.dir), { recursive: true, force: true });
        throw error;
    }
}

export async function saveTemplateInputs(config, { slug, name, inputs } = {}) {
    const pkg = await editorPackage(config, { slug, name });
    await editableTemplate(pkg);
    const value = await validateEditorInputs(pkg, inputs);
    const file = await editorFile(pkg, 'inputs.json', { createParents: true });
    const temporary = path.join(pkg.dir, `.inputs-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return { inputs: value };
}

export async function storeTemplateAsset(config, { slug, name, file, kind, filename } = {}) {
    const pkg = await editorPackage(config, { slug, name });
    await editableTemplate(pkg);
    const schema = pkg.manifest.template.inputs || {};
    if (!['presenter', 'voice', 'music', 'captions', 'texts'].includes(kind) || !Object.hasOwn(schema, kind)) throw invalid('模板不支持这类素材。');
    const ext = path.extname(filename || '').toLowerCase();
    const extensions = kind === 'presenter' ? ['.mp4', '.mov', '.webm', '.m4v']
        : ['captions', 'texts'].includes(kind) ? ['.json'] : ['.mp4', '.mov', '.webm', '.m4v', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
    if (!extensions.includes(ext)) throw invalid(`不支持此素材格式，请选择 ${extensions.join('、')}。`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || !stat.size || stat.size > 1024 * 1024 * 1024) throw invalid('素材必须是非空普通文件，且不超过 1 GiB。');
    if (['captions', 'texts'].includes(kind)) {
        if (stat.size > TEMPLATE_JSON_LIMIT) throw invalid('字幕或文字文件不能超过 4 MiB。');
        let data;
        try { data = await readJson(file); } catch { throw invalid('字幕或文字文件不是有效的 JSON。'); }
        validateJsonAsset(kind, data, schema[kind]);
    }
    const relative = `inputs/uploads/${kind}-${randomUUID()}${ext}`;
    const target = await editorFile(pkg, relative, { createParents: true });
    await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
    return { path: relative, filename: path.basename(filename), bytes: stat.size };
}

function cancelled(signal) {
    if (signal?.aborted) throw appError('VIDEO_CANCELLED', '操作已取消。');
}

export async function runTemplateAction(config, { slug, name, action, at, title, style, prompt, subtitleScript, target, providerTarget, model, mode, voice, language, revision } = {}, deps = {}) {
    if (!['prepare', 'check', 'preview', 'compose', 'fork', 'remix', 'export', 'generate', 'voice'].includes(action)) throw invalid('不支持的模板操作。');
    const pkg = await editorPackage(config, { slug, name });
    cancelled(deps.signal);
    if (action === 'generate') {
        const { generateTemplate } = await import('./template-agent.js');
        return generateTemplate(config, { slug, name, title, prompt, subtitleScript, target, providerTarget, model, mode }, deps);
    }
    if (action === 'voice') return generateTemplateVoice(config, { slug, name, voice, language, revision }, deps);
    if (action === 'remix') return remixTemplate(config, { slug, name, title, style, mode }, deps);
    if (action === 'export') {
        await deps.onProgress?.({ stage: 'export', message: '正在打包可复用模板' });
        const pack = () => { cancelled(deps.signal); return packVideo(config, { slug, name: pkg.name, force: true }, deps); };
        return deps.withCatalogWrite ? deps.withCatalogWrite(pack) : pack();
    }
    if (action === 'fork') return forkVideo(config, { slug, from: pkg.name, skipInstall: true }, deps);
    if (action !== 'check') await editableTemplate(pkg);
    await validateEditorInputs(pkg, await editorInputs(pkg));
    const progress = async (stage, message) => { cancelled(deps.signal); await deps.onProgress?.({ stage, message }); };
    const command = async (args, label) => runInPackage(config, pkg, 'npm', args, { timeoutMs: INSTALL_TIMEOUT_MS, label }, deps);
    const ensurePrepared = async () => {
        try { await packageCli(config, pkg); }
        catch (error) {
            if (error.code !== 'VIDEO_NOT_INSTALLED') throw error;
            await progress('install', '正在准备模板运行环境');
            await command(['ci', '--no-audit', '--no-fund'], '安装模板锁定依赖');
        }
        if (!await editorFile(pkg, 'inputs.json', { optional: true })) {
            await progress('initialize', '正在初始化素材配置');
            await command(['run', '--silent', 'inputs', '--', '--init'], '初始化素材');
        }
    };
    const check = async () => {
        await progress('check', '正在检查素材与时间轴');
        const run = deps.runCommand || runFixedCommand;
        const result = await run('npm', ['run', '--silent', 'inputs', '--', '--json'], {
            cwd: pkg.dir, env: packageEnvironment(pkg.dir, config.env || process.env), signal: deps.signal,
            timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 1024 * 1024,
        }, deps);
        cancelled(deps.signal);
        if (result.termination === 'cancelled') throw appError('VIDEO_CANCELLED', '操作已取消。');
        if (result.termination === 'timeout') throw appError('VIDEO_FAILED', '素材检查超时。');
        let report;
        try { report = JSON.parse(result.stdout); } catch { throw appError('VIDEO_FAILED', `素材检查没有返回有效报告。${String(result.stderr || '').slice(-600)}`); }
        if (typeof report.ok !== 'boolean' || !['errors', 'warnings', 'info'].every(key => Array.isArray(report[key]) && report[key].every(item => typeof item === 'string')) || ![0, 1].includes(result.exitCode)) throw appError('VIDEO_FAILED', '素材检查报告格式无效。');
        if (report.errors.length || result.exitCode !== 0) report.ok = false;
        return report;
    };
    if (action === 'check') return { report: await check() };
    await ensurePrepared();
    if (action === 'prepare') {
        await progress('build', '正在生成录制稿');
        await command(['run', 'build'], '生成录制稿');
        return getTemplateEditor(config, { slug, name: pkg.name });
    }
    const report = await check();
    if (!report.ok) throw appError('VIDEO_INPUTS_INVALID', '素材检查未通过，请先修正错误。', { data: { report } });
    if (action === 'preview') {
        const duration = pkg.manifest.frame.frames / pkg.manifest.frame.fps;
        const moments = at === undefined ? [0.1, 0.5, 0.85].map(fraction => +(duration * fraction).toFixed(3)) : at;
        if (!Array.isArray(moments) || !moments.length || moments.length > 12 || moments.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= duration)) throw invalid('预览时间需要 1–12 个位于成片时长内的秒数。');
        await progress('build', '正在构建预览画面');
        await command(['run', 'build'], '构建预览');
        await editorFile(pkg, '.work/preview/.sentinel', { createParents: true });
        for (const filename of await previewFiles(pkg)) {
            await fs.unlink(await editorFile(pkg, `.work/preview/${filename}`));
        }
        await progress('preview', '正在生成预览截图');
        await runInPackage(config, pkg, process.execPath, [await packageCli(config, pkg), 'snapshot', '--at', moments.join(','), '--no-end', '--output', '.work/preview'], { timeoutMs: INSTALL_TIMEOUT_MS, label: '生成预览' }, deps);
        return { report, previewFiles: await previewFiles(pkg), at: moments };
    }
    await progress('render', '正在合成视频，完成后自动加入放映室');
    const render = await renderVideo(config, { slug, name: pkg.name }, deps);
    await progress('register', '正在登记成片');
    const register = () => {
        cancelled(deps.signal);
        return importVideo(config, { slug, name: pkg.name }, deps);
    };
    const imported = await (deps.withCatalogWrite ? deps.withCatalogWrite(register) : register());
    return { report, render, imported };
}

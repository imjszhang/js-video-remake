import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { appError } from './errors.js';
import { isWithin } from './schema.js';
import { importReferenceFiles, readReferenceCatalog, readReferenceSource } from './references.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi', '.mpeg', '.mpg', '.mts', '.m2ts', '.flv', '.ogv', '.3gp']);
const MAX_ENTRIES = 10000;
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function registeredPaths(config) {
    const paths = new Map();
    for (const reference of (await readReferenceCatalog(config)).references) {
        try {
            const source = await readReferenceSource(config, reference);
            const file = await fs.realpath(source.videoPath);
            const ids = paths.get(file) || [];
            ids.push(reference.id);
            paths.set(file, ids);
        } catch { /* A broken snapshot remains visible in reference:list, not a scan blocker. */ }
    }
    return paths;
}

export async function scanReferences(config, { directory, recursive = false, import: shouldImport = false, select = [] } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw appError('INVALID_INPUT', 'reference:scan 需要一个本地文件夹。');
    if (typeof recursive !== 'boolean' || typeof shouldImport !== 'boolean' || !Array.isArray(select)
        || select.some(file => typeof file !== 'string' || !file.trim())) throw appError('INVALID_INPUT', '扫描参数无效。');
    if (select.length && !shouldImport) throw appError('INVALID_INPUT', '--select 需要同时使用 --import。');
    let root;
    try {
        root = await fs.realpath(path.resolve(config.workspace, directory));
        if (!(await fs.stat(root)).isDirectory()) throw new Error();
        await fs.access(root, constants.R_OK);
    } catch { throw appError('SOURCE_ASSET_MISSING', '扫描目录不存在或不可读取。'); }
    const registered = await registeredPaths(config);
    const candidates = [];
    const skipped = [];
    const pending = [{ directory: root, depth: 0 }];
    let visited = 0;
    while (pending.length) {
        const current = pending.shift();
        if (current.depth > 64) throw appError('SCAN_LIMIT', '扫描目录超过 64 层，请缩小扫描范围。');
        // Never follow a directory changed into a link after discovery.
        let resolvedDirectory;
        try { resolvedDirectory = await fs.realpath(current.directory); }
        catch { throw appError('SOURCE_ASSET_MISSING', '扫描期间目录已不可读取，请重试。'); }
        if (resolvedDirectory !== current.directory) throw appError('SOURCE_ASSET_INVALID', '扫描期间目录路径发生变化，请重试。');
        let handle;
        try { handle = await fs.opendir(current.directory); }
        catch {
            if (current.directory === root) throw appError('SOURCE_ASSET_MISSING', '扫描目录不可读取。');
            skipped.push({ path: current.directory, reason: '目录不可读取' });
            continue;
        }
        for await (const entry of handle) {
            if (++visited > MAX_ENTRIES) throw appError('SCAN_LIMIT', '扫描超过 10000 个目录项，请缩小扫描范围。');
            const file = path.join(current.directory, entry.name);
            if (entry.name.startsWith('.')) { skipped.push({ path: file, reason: '隐藏文件或目录' }); continue; }
            if (entry.isSymbolicLink()) { skipped.push({ path: file, reason: '不跟随软链接' }); continue; }
            if (entry.isDirectory()) {
                if (recursive) pending.push({ directory: file, depth: current.depth + 1 });
                continue;
            }
            if (!entry.isFile()) { skipped.push({ path: file, reason: '不是普通文件' }); continue; }
            if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            try {
                const stat = await fs.lstat(file);
                const real = await fs.realpath(file);
                if (!stat.isFile() || !stat.size || real !== file || !isWithin(root, real)) throw new Error();
                await fs.access(real, constants.R_OK);
                candidates.push({ path: real, relativePath: path.relative(root, real).split(path.sep).join('/'),
                    title: path.basename(entry.name, path.extname(entry.name)), bytes: stat.size,
                    referenceIds: [...(registered.get(real) || [])].sort(lexical) });
            } catch { skipped.push({ path: file, reason: '视频为空、不可读或路径已变化' }); }
        }
    }
    candidates.sort((a, b) => lexical(a.relativePath, b.relativePath));
    skipped.sort((a, b) => lexical(a.path, b.path));
    let selected = candidates;
    if (select.length) {
        const names = new Set();
        for (const file of select) {
            if (path.isAbsolute(file) || file.includes('\0') || file.split(/[\\/]/).includes('..')) throw appError('INVALID_INPUT', '--select 需要扫描结果中的相对文件路径。');
            const normalized = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
            if (!candidates.some(item => item.relativePath === normalized)) throw appError('INVALID_INPUT', `选择的文件不在扫描结果中: ${file}`);
            names.add(normalized);
        }
        selected = candidates.filter(item => names.has(item.relativePath));
    }
    const toImport = selected.filter(item => !item.referenceIds.length);
    if (shouldImport) {
        for (const item of toImport) {
            let real;
            try { real = await fs.realpath(item.path); }
            catch { throw appError('SOURCE_ASSET_MISSING', '扫描后的文件已不可读取，请重新扫描。'); }
            if (real !== item.path) throw appError('SOURCE_ASSET_INVALID', '扫描后的文件路径已变化，请重新扫描。');
        }
    }
    const imported = shouldImport ? (await importReferenceFiles(config, toImport.map(item => item.path))).references : [];
    return { command: 'reference:scan', directory: root, candidates, skipped, imported, importRequested: shouldImport };
}

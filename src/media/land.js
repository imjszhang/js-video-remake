import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appError } from '../errors.js';

export const LEDGER_FORMAT = 'remake-asset-ledger@1';
export const KIND_PREFIX = { image: 'img', video: 'vid', audio: 'aud' };
export const KIND_EXTS = {
    image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']),
    video: new Set(['.mp4', '.mov', '.webm', '.mkv']),
    audio: new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac']),
};

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const invalid = (message) => appError('LAND_INVALID', message);

export function dateStamp(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

export function makeId(kind, slug, now = new Date(), rand = randomBytes(2).toString('hex')) {
    const prefix = KIND_PREFIX[kind];
    if (!prefix) throw invalid(`不支持的 kind: ${kind}`);
    return `${prefix}-${slug}-${dateStamp(now)}-${rand}`;
}

export function htmlSnippet({ kind, id, src }) {
    if (kind === 'image') return `<img id="${id}" class="clip" src="${src}" alt="" data-start="0" data-duration="1">`;
    if (kind === 'video') {
        return `<video id="${id}" class="clip" src="${src}" muted playsinline data-start="0" data-duration="1" data-media-start="0"></video>`;
    }
    return `<audio id="${id}" class="clip" src="${src}" data-start="0" data-duration="1" data-media-start="0" data-volume="1"></audio>`;
}

function readLedger(ledgerPath) {
    if (!existsSync(ledgerPath)) return { format: LEDGER_FORMAT, items: [] };
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (!raw || raw.format !== LEDGER_FORMAT || !Array.isArray(raw.items)) {
        throw invalid(`台账格式不对: ${ledgerPath}`);
    }
    return { format: LEDGER_FORMAT, items: raw.items.map((item) => ({ ...item })) };
}

function writeJsonAtomic(filePath, value) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
}

/**
 * Copy a generated file into productions/<slug>/assets/<kind>/ and append it to the ledger.
 * `workspace` is the resolved workspace root (config.workspace).
 */
export function land({ workspace, slug, kind, from, intent, provider, id, sourceId, now = new Date() }) {
    if (!SLUG_RE.test(slug || '')) throw invalid('slug 必须是小写字母、数字和连字符');
    if (!KIND_PREFIX[kind]) throw invalid(`不支持的 kind: ${kind}（image | video | audio）`);
    if (!from) throw invalid('缺 --from');
    if (!intent) throw invalid('缺 --intent');
    if (!provider) throw invalid('缺 --provider');
    if (!workspace) throw invalid('缺工作区');

    const root = path.resolve(workspace);
    const productionDir = path.join(root, 'productions', slug);
    if (!existsSync(productionDir)) throw appError('NOT_FOUND', `制作不存在: ${slug}（先 remake start）`);

    const source = path.resolve(from);
    if (!existsSync(source)) throw appError('NOT_FOUND', `源文件不存在: ${source}`);

    const ext = path.extname(source).toLowerCase();
    if (!KIND_EXTS[kind].has(ext)) throw invalid(`${kind} 不接受扩展名 ${ext || '(none)'}`);

    const kindDir = path.join(productionDir, 'assets', kind);
    mkdirSync(kindDir, { recursive: true });

    const ledgerPath = path.join(productionDir, 'assets', 'ledger.json');
    const ledger = readLedger(ledgerPath);
    const used = new Set(ledger.items.map((item) => item.id));

    let assetId = id || makeId(kind, slug, now);
    if (id) {
        if (!ID_RE.test(id)) throw invalid(`id 不合法: ${id}`);
        if (used.has(id)) throw invalid(`id 已存在: ${id}`);
    } else {
        while (used.has(assetId)) assetId = makeId(kind, slug, now);
    }

    const destName = `${assetId}${ext}`;
    const destAbs = path.join(kindDir, destName);
    copyFileSync(source, destAbs);

    const item = {
        id: assetId,
        kind,
        path: path.relative(root, destAbs).split(path.sep).join('/'),
        provider,
        intent,
        sourcePath: source,
        createdAt: now.toISOString(),
        status: 'landed',
        ...(sourceId ? { sourceId } : {}),
    };
    ledger.items.push(item);
    writeJsonAtomic(ledgerPath, ledger);

    return {
        ...item,
        absPath: destAbs,
        html: htmlSnippet({ kind, id: assetId, src: `./assets/${kind}/${destName}` }),
    };
}

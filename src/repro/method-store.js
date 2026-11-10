import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { validateRequirements } from './capabilities.js';
import { validateSpec, safeProjectPath } from './schema.js';
import { scaffoldProject, safeProjectFile, snapshotProject, syncSkills } from './project.js';
import { loadTemplate } from './template-store.js';

export const METHOD_SCHEMA = 'video-remake.method-recipe@1';
export const ASSET_SCHEMA = 'video-remake.asset-pack@1';
export const GENERATION_MODE = 'method-generation';
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const REQUIRED_DOCS = ['AGENTS.md', ...['reproduce', 'validate', 'repair'].map(n => `.agents/skills/${n}/SKILL.md`)];
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => digest(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
const invalid = message => appError('REPRO_INVALID', message);
const object = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} 必须是对象`); return value; };
const fields = (value, allowed, label) => { object(value, label); for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${label} 未知字段: ${key}`); };
const text = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} 必须是非空文本`); return value; };

function identity(name, version) {
    if (!NAME.test(name) || !Number.isSafeInteger(Number(version)) || Number(version) < 1) throw invalid('标识必须为 name@正整数');
    return { name, version: Number(version), id: `${name}@${Number(version)}` };
}
function selectorId(value) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}@\d+$/.test(value)) throw invalid('需要 name@正整数标识');
    return identity(...value.split('@'));
}
function unique(values, label) {
    if (!Array.isArray(values) || new Set(values).size !== values.length) throw invalid(`${label} 必须是不重复的数组`);
    return values;
}
function portableText(value, label) {
    if (/(?:file:\/\/\/|(?:^|[\s"'`(=:])\/(?:Users|home|private\/var|tmp|var\/folders|opt\/homebrew)\/|["'`][A-Za-z]:\\)/m.test(value)) throw invalid(`${label} 包含主机绝对路径`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9]{24,}|AKIA[A-Z0-9]{16})\b/.test(value)) throw invalid(`${label} 包含疑似凭据`);
}
function provenance(value) {
    if (typeof value === 'string') { if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return undefined; portableText(value, '来源'); return value; }
    if (Array.isArray(value)) return value.map(provenance).filter(v => v !== undefined);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/(?:secret|token|credential|apiKey|workspace|password|runDir)/i.test(key))
        .map(([key, child]) => [key, provenance(child)]).filter(([, child]) => child !== undefined));
    return value;
}

export function validateMethodManifest(value) {
    fields(value, ['schema', 'title', 'description', 'scope', 'files', 'capabilities', 'assetPacks', 'generationContract', 'contentReview'], '方法配方');
    if (value.schema !== METHOD_SCHEMA) throw invalid('方法配方 schema 无效');
    text(value.title, '配方标题');
    if (!['same-reference', 'category'].includes(value.scope)) throw invalid('配方 scope 必须为 same-reference 或 category');
    const files = unique(value.files, '配方文件').map(file => {
        safeProjectPath(file);
        if (!(file === 'AGENTS.md' || file === 'README.md' || /^(?:methods|constraints|repair-playbooks|examples)\/.+\.md$/.test(file)
            || /^\.agents\/skills\/(?:reproduce|validate|repair)\/(?:SKILL\.md|references\/.+\.md)$/.test(file))) throw invalid(`方法配方只允许文档: ${file}`);
        return file;
    });
    for (const file of REQUIRED_DOCS) if (!files.includes(file)) throw invalid(`方法配方缺少入口: ${file}`);
    const assetPacks = unique(value.assetPacks || [], '素材包').map(id => selectorId(id).id);
    fields(value.generationContract, ['requiredGeneratedFiles', 'forbidden'], '生成合同');
    const requiredGeneratedFiles = unique(value.generationContract.requiredGeneratedFiles, '生成文件').map(file => {
        safeProjectPath(file);
        if (!file.startsWith('src/')) throw invalid('独立生成文件必须位于 src/');
        return file;
    });
    if (!requiredGeneratedFiles.length || !requiredGeneratedFiles.includes('src/index.html')) throw invalid('生成合同必须包含 src/index.html');
    const forbidden = unique(value.generationContract.forbidden || [], '禁止内容');
    if (!forbidden.includes('teacher-implementation') || !forbidden.includes('reference-pixels')) throw invalid('生成合同必须禁止教师实现和参考画面直用');
    fields(value.contentReview, ['reviewer', 'notes', 'containsTargetImplementation'], '配方内容审查');
    text(value.contentReview.reviewer, '配方审查者'); text(value.contentReview.notes, '配方审查说明');
    if (value.contentReview.reviewer === 'pending') throw invalid('配方内容审查尚未完成');
    if (value.contentReview.containsTargetImplementation !== false) throw invalid('配方必须经过无目标实现内容审查');
    portableText(json(value), '配方清单');
    return { ...value, files: [...files].sort(), capabilities: validateRequirements(value.capabilities || []), assetPacks,
        generationContract: { requiredGeneratedFiles, forbidden } };
}

function vector(value, label) {
    if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw invalid(`${label} 必须是三维有限数值`);
}
export function validateAssetManifest(value) {
    fields(value, ['schema', 'title', 'assets', 'contentReview'], '素材包');
    if (value.schema !== ASSET_SCHEMA) throw invalid('素材包 schema 无效');
    text(value.title, '素材包标题');
    fields(value.contentReview, ['reviewer', 'notes', 'targetScene', 'targetTimeline'], '素材审查');
    text(value.contentReview.reviewer, '素材审查者'); text(value.contentReview.notes, '素材审查说明');
    if (value.contentReview.reviewer === 'pending') throw invalid('素材内容审查尚未完成');
    if (value.contentReview.targetScene !== false || value.contentReview.targetTimeline !== false) throw invalid('通用素材必须排除目标场景和时间轴');
    if (!Array.isArray(value.assets) || !value.assets.length) throw invalid('素材包必须有明确素材清单');
    const seen = new Set(), ids = new Set();
    for (const asset of value.assets) {
        fields(asset, ['id', 'file', 'type', 'scope', 'source', 'license', 'units', 'scale', 'pivot', 'bounds', 'dependencies'], '素材');
        if (!NAME.test(asset.id) || ids.has(asset.id)) throw invalid('素材 id 必须安全且不重复');
        ids.add(asset.id); safeProjectPath(asset.file);
        if (seen.has(asset.file)) throw invalid('素材文件不允许重复'); seen.add(asset.file);
        if (asset.scope !== 'generic') throw invalid('素材必须声明 scope=generic');
        if (!['character', 'prop', 'geometry', 'texture', 'image', 'font', 'license'].includes(asset.type)) throw invalid('不支持的通用素材类型');
        const extension = path.extname(asset.file).toLowerCase();
        const allowed = asset.type === 'license' ? ['.txt', '.md'] : asset.type === 'font' ? ['.woff', '.woff2', '.ttf', '.otf']
            : ['texture', 'image'].includes(asset.type) ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.glb', '.gltf', '.json', '.bin'];
        if (!allowed.includes(extension)) throw invalid(`素材不允许脚本、归档、场景视频或不匹配格式: ${asset.file}`);
        text(asset.source, '素材来源'); text(asset.license, '素材许可');
        if (['character', 'prop', 'geometry'].includes(asset.type)) {
            text(asset.units, '几何素材单位');
            if (typeof asset.scale !== 'number' || !Number.isFinite(asset.scale) || asset.scale <= 0) throw invalid('几何素材必须声明正数 scale');
            vector(asset.pivot, '几何素材 pivot');
            fields(asset.bounds, ['min', 'max'], '几何素材 bounds'); vector(asset.bounds.min, 'bounds.min'); vector(asset.bounds.max, 'bounds.max');
            if (asset.bounds.min.some((n, i) => n > asset.bounds.max[i])) throw invalid('几何素材包围盒无效');
        }
        unique(asset.dependencies || [], '素材依赖').forEach(safeProjectPath);
    }
    for (const asset of value.assets) for (const dependency of asset.dependencies || []) if (!seen.has(dependency)) throw invalid(`素材依赖未列入清单: ${dependency}`);
    portableText(json(value), '素材清单');
    return value;
}

async function inventory(root, { exclude = [] } = {}) {
    const files = [];
    await safeProjectFile(root, '.inventory-probe', { create: true });
    async function walk(prefix = '') {
        for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            safeProjectPath(rel);
            if (entry.isSymbolicLink()) throw invalid(`配方和素材不接受符号链接: ${rel}`);
            if (exclude.includes(rel)) continue;
            if (entry.isDirectory()) await walk(rel);
            else if (entry.isFile()) {
                const info = await fs.stat(path.join(root, rel));
                if (info.size > 512 * 1024 * 1024) throw invalid(`单个素材过大: ${rel}`);
                if (info.mode & 0o111) throw invalid(`配方和素材不得包含可执行文件: ${rel}`);
                files.push({ path: rel, sha256: digest(await fs.readFile(path.join(root, rel))), size: info.size });
            } else throw invalid(`不支持的文件类型: ${rel}`);
        }
    }
    await walk(); files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, treeHash: hash(files) };
}
async function readJSON(root, file) {
    const source = await safeProjectFile(root, file);
    if ((await fs.stat(source)).size > 16 * 1024 * 1024) throw invalid(`清单过大: ${file}`);
    try { return JSON.parse(await fs.readFile(source, 'utf8')); } catch { throw invalid(`无法解析清单: ${file}`); }
}
async function checkMethodFiles(root, manifest, snapshot) {
    const expected = ['recipe.json', ...manifest.files].sort();
    if (JSON.stringify(snapshot.files.map(f => f.path).sort()) !== JSON.stringify(expected)) throw invalid('配方文件必须与显式允许清单完全一致');
    for (const file of manifest.files) {
        const bytes = await fs.readFile(await safeProjectFile(root, file));
        if (bytes.length > 256 * 1024 || bytes.includes(0)) throw invalid(`方法文档过大或含二进制数据: ${file}`);
        const body = bytes.toString('utf8'); portableText(body, file);
        if (/<script\b|data-composition-id\s*=|data:[^\s;]+;base64,|[A-Za-z0-9+/]{400,}={0,2}|(?:\[\s*-?\d+(?:\.\d+)?\s*,){16}/i.test(body)) throw invalid(`方法文档包含可执行画面、编码素材或实现数据: ${file}`);
        if (/^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(file)) {
            const skill = file.split('/')[2];
            if (!new RegExp(`^---\\s*\\n[\\s\\S]*?name:\\s*${skill}\\s*\\n[\\s\\S]*?description:\\s*\\S[\\s\\S]*?\\n---(?:\\s*\\n|$)`).test(body)) throw invalid(`Skill 元数据无效: ${file}`);
        }
    }
}
function glbJSON(bytes, label) {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw invalid(`无效 GLB: ${label}`);
    const size = bytes.readUInt32LE(12);
    if (bytes.readUInt32LE(16) !== 0x4e4f534a || size > bytes.length - 20) throw invalid(`GLB 缺少 JSON 块: ${label}`);
    try { return JSON.parse(bytes.subarray(20, 20 + size).toString('utf8').trim()); } catch { throw invalid(`GLB JSON 无效: ${label}`); }
}
async function checkAssetFiles(root, manifest, snapshot) {
    const expected = ['asset-pack.json', ...manifest.assets.map(a => a.file)].sort();
    if (JSON.stringify(snapshot.files.map(f => f.path).sort()) !== JSON.stringify(expected)) throw invalid('素材文件必须与显式允许清单完全一致');
    for (const asset of manifest.assets) {
        const ext = path.extname(asset.file).toLowerCase();
        const bytes = await fs.readFile(await safeProjectFile(root, asset.file));
        if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) throw invalid(`禁止伪装的归档素材: ${asset.file}`);
        if (['texture', 'image', 'font'].includes(asset.type)) {
            const valid = ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                : ['.jpg', '.jpeg'].includes(ext) ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
                    : ext === '.webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
                        : ext === '.woff' ? bytes.subarray(0, 4).toString() === 'wOFF'
                            : ext === '.woff2' ? bytes.subarray(0, 4).toString() === 'wOF2'
                                : ext === '.otf' ? bytes.subarray(0, 4).toString() === 'OTTO'
                                    : bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || bytes.subarray(0, 4).toString() === 'true';
            if (!valid) throw invalid(`素材字节与格式不匹配: ${asset.file}`);
        }
        if (['.json', '.gltf', '.glb'].includes(ext)) {
            let data;
            try { data = ext === '.glb' ? glbJSON(bytes, asset.file) : JSON.parse(bytes.toString('utf8')); }
            catch (error) { if (error.code) throw error; throw invalid(`素材 JSON 无效: ${asset.file}`); }
            object(data, `几何素材 ${asset.file}`);
            const gltf = ext === '.gltf' || ext === '.glb';
            if (gltf && (data.cameras?.length || data.animations?.length || data.nodes?.some(node => node.camera !== undefined))) throw invalid(`通用静态素材禁止相机和时间轴: ${asset.file}`);
            if (!gltf && Object.keys(data).some(key => /^(?:camera|cameras|timeline|keyframes|scenes|scene|shots|animation|animations|script|scripts)$/i.test(key))) throw invalid(`几何数据包含场景或镜头实现: ${asset.file}`);
            if (gltf) for (const resource of [...data.buffers || [], ...data.images || []]) {
                if (resource.uri === undefined) continue;
                if (typeof resource.uri !== 'string' || resource.uri.startsWith('data:') || /[?#%]/.test(resource.uri)) throw invalid(`素材必须显式列出外部资源: ${asset.file}`);
                safeProjectPath(resource.uri);
                const dependency = path.posix.join(path.posix.dirname(asset.file), resource.uri);
                if (!asset.dependencies?.includes(dependency)) throw invalid(`素材引用未声明资源: ${asset.file}: ${resource.uri}`);
            }
        } else if (asset.type === 'license') portableText(bytes.toString('utf8'), asset.file);
        // This is an admission check, not a claim that byte inspection can prove
        // semantic independence. Every pack also requires an explicit review.
    }
}

const kinds = {
    method: { folder: 'methods', input: 'recipe.json', record: 'method-record.json', schema: 'video-remake.method-record@1', validate: validateMethodManifest, check: checkMethodFiles },
    asset: { folder: 'asset-packs', input: 'asset-pack.json', record: 'asset-record.json', schema: 'video-remake.asset-record@1', validate: validateAssetManifest, check: checkAssetFiles },
};
async function destinationFor(config, kind, id) { return safeProjectFile(config.workspace, `reproductions/${kind.folder}/${id.name}/v${id.version}`, { create: true }); }
async function sourceSnapshot(root, kind) {
    const manifest = kind.validate(await readJSON(root, kind.input));
    const snapshot = await inventory(root, { exclude: [kind.record] });
    await kind.check(root, manifest, snapshot);
    return { manifest, ...snapshot };
}
async function copyFiles(source, destination, files) {
    await fs.mkdir(destination, { recursive: true });
    for (const file of files) {
        const target = await safeProjectFile(destination, file.path, { create: true });
        const bytes = await fs.readFile(await safeProjectFile(source, file.path));
        if (digest(bytes) !== file.sha256) throw appError('REPRO_CHANGED', `复制期间来源改变: ${file.path}`);
        await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    }
}
async function freeze(config, type, options) {
    const kind = kinds[type], id = identity(options.name, options.version);
    const source = path.resolve(config.workspace, options.directory || options.source || '');
    const initial = await sourceSnapshot(source, kind);
    const assetPacks = [];
    if (type === 'method') for (const selector of initial.manifest.assetPacks) {
        const pack = await loadAssetPack(config, selector);
        assetPacks.push({ id: pack.id, treeHash: pack.treeHash, metadataHash: pack.metadataHash });
    }
    const root = await destinationFor(config, kind, id);
    const temporary = path.join(path.dirname(root), `.v${id.version}-${randomUUID()}.tmp`);
    const claim = `${root}.lock`;
    let locked = false;
    try {
        await copyFiles(source, temporary, initial.files);
        const staged = await sourceSnapshot(temporary, kind);
        if (staged.treeHash !== initial.treeHash) throw appError('REPRO_CHANGED', '暂存内容不一致');
        const record = { schema: kind.schema, ...id, createdAt: new Date().toISOString(), status: 'candidate',
            manifest: staged.manifest, files: staged.files, treeHash: staged.treeHash, provenance: provenance(options.provenance || {}),
            ...(type === 'method' ? { assetPacks } : {}),
            semanticReview: 'declared-and-scanned; semantic independence requires execution audit' };
        record.metadataHash = hash(record);
        await fs.writeFile(path.join(temporary, kind.record), json(record), { flag: 'wx' });
        try { await fs.writeFile(claim, json({ pid: process.pid }), { flag: 'wx' }); locked = true; }
        catch (error) { if (error.code === 'EEXIST') throw appError('REPRO_BUSY', `版本正在冻结: ${id.id}`); throw error; }
        try { await fs.access(root); throw appError('REPRO_EXISTS', `版本已存在: ${id.id}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(temporary, root);
        return { ...record, root };
    } finally { await fs.rm(temporary, { force: true, recursive: true }); if (locked) await fs.rm(claim, { force: true }); }
}
async function load(config, type, selector) {
    const kind = kinds[type]; let root;
    if (typeof selector === 'object' && selector) root = selector.root;
    else if (typeof selector === 'string' && /^[a-z][a-z0-9_-]{0,63}@\d+$/.test(selector)) {
        const id = selectorId(selector); root = await safeProjectFile(config.workspace, `reproductions/${kind.folder}/${id.name}/v${id.version}`);
    } else if (typeof selector === 'string') root = path.resolve(config.workspace, selector);
    if (!root) throw invalid('需要标识或目录');
    const record = await readJSON(root, kind.record);
    const id = identity(record.name, record.version);
    if (record.schema !== kind.schema || record.id !== id.id) throw invalid('冻结记录类型或标识无效');
    const { metadataHash, ...unsigned } = record;
    if (metadataHash !== hash(unsigned)) throw appError('REPRO_CHANGED', '冻结元数据已变化');
    const actual = await sourceSnapshot(root, kind);
    if (actual.treeHash !== record.treeHash || hash(actual.files) !== hash(record.files) || hash(actual.manifest) !== hash(record.manifest)) throw appError('REPRO_CHANGED', '文件与冻结清单不一致');
    return { ...record, root: path.resolve(root) };
}
export const freezeMethodRecipe = (config, options) => freeze(config, 'method', options);
export const freezeAssetPack = (config, options) => freeze(config, 'asset', options);
export const loadMethodRecipe = (config, selector) => load(config, 'method', selector);
export const loadAssetPack = (config, selector) => load(config, 'asset', selector);

async function list(config, type) {
    const folder = path.join(config.workspace, 'reproductions', kinds[type].folder); const result = [];
    let names; try { names = await fs.readdir(folder); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
    for (const name of names.sort()) {
        if (!NAME.test(name)) continue;
        const parent = await safeProjectFile(config.workspace, `reproductions/${kinds[type].folder}/${name}`);
        for (const version of (await fs.readdir(parent)).sort()) {
            if (!/^v[1-9]\d*$/.test(version)) continue;
            const id = `${name}@${version.slice(1)}`;
            try { result.push({ ...await load(config, type, id), valid: true }); }
            catch (error) { result.push({ id, name, version: Number(version.slice(1)), valid: false, error: error.message }); }
        }
    }
    return result;
}
export const listMethodRecipes = config => list(config, 'method');
export const listAssetPacks = config => list(config, 'asset');

async function installGenerationInstructions(root) {
    const docs = {
        'AGENTS.md': '# Independent video generation\n\nRead task/spec.json, task/acceptance.json, reference/SOURCES.json, reproduction.json and inputs/values.json. Produce the requested video by generating your own scene, layout, timing and camera movement from the blank src/ entry. Reusable assets are listed in ASSET-LOCK.json. No task-specific method recipe is supplied in this baseline.\n\nOnly modify your generated source, derived assets, notes and outputs. Keep task/, reference/, inputs/, assets/packs/, scripts/, toolkit/, package files and Skills unchanged. Do not read teacher projects or historical trials, invoke another model, or reuse reference pixels as rendered output. Set reproduction.json status to ready after implementing src/. Use the supplied render and preview tools, then inspect actual media against the frozen acceptance.\n',
        '.agents/skills/reproduce/SKILL.md': '---\nname: reproduce\ndescription: Generate a new video implementation from a blank project using the task and reference.\n---\n\nRead AGENTS.md and the frozen task. Independently produce scene code, layout, timing and camera movement in src/. Use only declared inputs, generic assets and available tools. The public acceptance criteria define the goal. Do not import an existing completed scene or delegate implementation to another model.\n',
        '.agents/skills/validate/SKILL.md': '---\nname: validate\ndescription: Inspect generated video evidence against the public acceptance criteria.\n---\n\nRead task/acceptance.json and inspect actual rendered frames and audio. Record observed results and evidence; unavailable observations are unobserved. Self-checks do not substitute for external acceptance.\n',
        '.agents/skills/repair/SKILL.md': '---\nname: repair\ndescription: Independently repair this run\'s generated implementation after a failed check.\n---\n\nRead the failed check and evidence. Repair your generated source without changing frozen requirements, inputs, tools or assets. Render again and inspect the new output. Stay within the recorded attempt and time budgets.\n',
        'docs/workflow.md': '# Independent generation\n\nUse the frozen task, reference, declared generic assets and provided tools to generate your own implementation. There is no task-specific method recipe in the baseline. Read AGENTS.md for the execution boundaries.\n',
        'docs/troubleshooting.md': '# Runtime checks\n\nUse npm run doctor for installed dependencies and npm run check for output validation. Inspect failures and repair your own generated source without weakening the frozen task.\n',
    };
    for (const [file, body] of Object.entries(docs)) await fs.writeFile(await safeProjectFile(root, file, { create: true }), body);
    await syncSkills(root);
}
async function scaffoldFingerprint(root, snapshot) {
    // Instance labels are not a tool/scaffold difference. Everything else,
    // including dependencies, runtime code and the task, stays byte-bound.
    const files = [];
    for (const file of snapshot.files) {
        if (!['package.json', 'package-lock.json', 'reproduction.json'].includes(file.path)) { files.push(file); continue; }
        const value = await readJSON(root, file.path); value.name = '$INSTANCE';
        if (file.path === 'package-lock.json' && value.packages?.['']) value.packages[''].name = '$INSTANCE';
        const bytes = json(value); files.push({ ...file, sha256: digest(bytes), size: Buffer.byteLength(bytes) });
    }
    return hash({ schema: 'video-remake.generation-scaffold@1', files });
}

export async function instantiateMethodRecipe(config, selector, destination, { spec, name = 'method-generation', inputs = {}, assetPacks, applyMethod = true } = {}) {
    if (typeof applyMethod !== 'boolean') throw invalid('applyMethod 必须是布尔值');
    spec = validateSpec(spec);
    const recipe = await loadMethodRecipe(config, selector);
    const packs = await Promise.all((assetPacks || recipe.manifest.assetPacks).map(id => loadAssetPack(config, id)));
    if (hash(packs.map(p => p.id)) !== hash(recipe.manifest.assetPacks)) throw invalid('执行素材包必须与配方冻结声明一致');
    if (hash(packs.map(pack => ({ id: pack.id, treeHash: pack.treeHash, metadataHash: pack.metadataHash }))) !== hash(recipe.assetPacks)) throw appError('REPRO_CHANGED', '素材包已偏离方法配方冻结时的版本内容');
    await scaffoldProject(destination, { spec, name, inputs, capabilities: recipe.manifest.capabilities, toolkit: true });
    await installGenerationInstructions(destination);
    const scaffold = await snapshotProject(destination, { includeInputs: true });
    const scaffoldHash = await scaffoldFingerprint(destination, scaffold);
    const assetLock = { schema: 'video-remake.asset-lock@1', packs: packs.map(pack => ({ id: pack.id, treeHash: pack.treeHash, metadataHash: pack.metadataHash,
        assets: pack.manifest.assets.map(asset => ({ ...asset, path: `assets/packs/${pack.name}/v${pack.version}/${asset.file}`, sha256: pack.files.find(f => f.path === asset.file).sha256 })) })) };
    if (applyMethod) {
        await copyFiles(recipe.root, path.join(destination, 'method'), recipe.files);
        // Canonical instructions are exposed in the native Harness location.
        // Baseline assembly never places method guidance in either location.
        for (const file of recipe.manifest.files.filter(f => f === 'AGENTS.md' || f.startsWith('.agents/skills/'))) {
            const target = await safeProjectFile(destination, file, { create: true });
            await fs.writeFile(target, await fs.readFile(await safeProjectFile(recipe.root, file)));
        }
        await fs.writeFile(path.join(destination, 'docs/workflow.md'), '# Independent generation\n\nRead method/recipe.json and AGENTS.md. Analyze the reference and generate the scene, layout, camera paths and timing yourself. Reusable assets are listed in ASSET-LOCK.json; do not import teacher implementations or reuse reference pixels as rendered output. Only repair your own generated work.\n');
    }
    await syncSkills(destination);
    for (const pack of packs) await copyFiles(pack.root, path.join(destination, 'assets', 'packs', pack.name, `v${pack.version}`), pack.files);
    await fs.writeFile(path.join(destination, 'ASSET-LOCK.json'), json(assetLock), { flag: 'wx' });
    const initialSnapshot = await snapshotProject(destination, { includeInputs: true });
    const lockedFiles = Object.fromEntries(initialSnapshot.files.filter(file => !file.path.startsWith('src/') && !file.path.startsWith('inputs/') && file.path !== 'reproduction.json').map(file => [file.path, file.sha256]));
    const instance = { schema: 'video-remake.method-instance@1', generationMode: GENERATION_MODE, methodApplied: applyMethod,
        recipe: { id: recipe.id, treeHash: recipe.treeHash, metadataHash: recipe.metadataHash }, assetLock, assetLockHash: hash(assetLock),
        scaffoldHash, initialSnapshot, lockedFiles,
        generationContract: recipe.manifest.generationContract,
        independence: { level: 'context-only', readIsolationVerified: false, limitations: ['Fresh directory and hashes do not enforce filesystem or network read isolation.'] } };
    await fs.writeFile(path.join(destination, 'INSTANCE.json'), json(instance), { flag: 'wx' });
    return { ...instance, root: path.resolve(destination) };
}

export async function exportMethodRecipe(config, selector, { destination, includeAssets = true } = {}) {
    const record = await loadMethodRecipe(config, selector);
    if (!destination) throw invalid('需要导出目录');
    try { await fs.access(destination); throw appError('REPRO_EXISTS', '导出目录已经存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await copyFiles(record.root, path.join(destination, 'recipe'), record.files);
    const { root, ...metadata } = record;
    await fs.writeFile(path.join(destination, 'recipe/method-record.json'), json(metadata), { flag: 'wx' });
    if (includeAssets) for (const id of record.manifest.assetPacks) {
        const pack = await loadAssetPack(config, id); const target = path.join(destination, 'asset-packs', pack.name, `v${pack.version}`);
        const expected = record.assetPacks.find(item => item.id === id);
        if (pack.treeHash !== expected?.treeHash || pack.metadataHash !== expected?.metadataHash) throw appError('REPRO_CHANGED', `素材包与冻结配方不一致: ${id}`);
        await copyFiles(pack.root, target, pack.files); const { root: _root, ...data } = pack;
        await fs.writeFile(path.join(target, 'asset-record.json'), json(data), { flag: 'wx' });
    }
    return { root: path.resolve(destination), recipe: record.id, treeHash: record.treeHash, includesAssets: includeAssets };
}
export async function importMethodRecipe(config, directory, options = {}) {
    let source = path.resolve(config.workspace, directory);
    try { await fs.access(path.join(source, 'recipe/method-record.json')); source = path.join(source, 'recipe'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = await loadMethodRecipe(config, source);
    for (const id of record.manifest.assetPacks) {
        const key = selectorId(id);
        const imported = await loadAssetPack(config, path.join(path.dirname(source), 'asset-packs', key.name, `v${key.version}`));
        if (imported.treeHash !== record.assetPacks.find(item => item.id === id)?.treeHash) throw appError('REPRO_CHANGED', `导入素材包与配方不一致: ${id}`);
        let existing;
        try { existing = await loadAssetPack(config, id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing && existing.treeHash !== imported.treeHash) throw appError('REPRO_CHANGED', `已有素材包与导入内容冲突: ${id}`);
        if (!existing) await freezeAssetPack(config, { source: imported.root, name: key.name, version: key.version, provenance: imported.provenance });
    }
    return freezeMethodRecipe(config, { source, name: options.name || record.name, version: options.version || record.version,
        provenance: { ...record.provenance, importedFrom: record.id, importedTreeHash: record.treeHash, verification: 'unverified' } });
}

export async function inspectMethodMigration(config, selector) {
    const legacy = await loadTemplate(config, selector);
    const candidates = legacy.files.map(file => {
        let action = 'archive-implementation', reason = '教师工程实现只留作研究与审计，不能复制到执行工程';
        if (/\.(?:png|jpe?g|webp|glb|gltf|woff2?|ttf|otf)$/i.test(file.path) || /(?:avatar|geometry)\.json$/i.test(file.path)) {
            action = 'review-generic-asset'; reason = '需检查通用性、来源、许可、尺度和是否含相机/时间轴后单独入库';
        } else if (/^(?:task|examples)\//.test(file.path)) { action = 'review-task-facts'; reason = '提取参考事实和公开标准，排除已求解布局与实现'; }
        else if (/\.md$/.test(file.path)) { action = 'rewrite-method'; reason = '重新提炼方法和约束，不直接继承旧 Skill 或说明'; }
        else if (/vendor\//.test(file.path)) { action = 'review-generic-tool'; reason = '通用工具单独核对版本和来源后进入脚手架'; }
        return { ...file, action, reason };
    });
    return { schema: 'video-remake.method-migration-inspection@1', source: { id: legacy.id, treeHash: legacy.treeHash },
        generationMode: 'project-replay', destinationType: METHOD_SCHEMA, copiesImplementation: false, inheritsValidation: false, candidates,
        next: 'Create a new method directory and explicitly reviewed asset packs; the source template remains immutable.' };
}

export async function scaffoldMethodRecipe(directory, { title = 'Method recipe', scope = 'same-reference', assetPacks = [], capabilities = [], contentReview } = {}) {
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.readdir(directory)).length) throw appError('REPRO_EXISTS', '方法提炼输出目录必须为空');
    const docs = {
        'AGENTS.md': '# Independent video generation\n\nRead task/spec.json, method/recipe.json, and the reproduce Skill. Start from the empty src/ entry. Generate the scene construction, layout, camera paths and timing yourself. Use only declared generic assets and tools. Do not read teacher implementations, historical trials or source repositories. Do not use reference pixels as rendered scene content. Keep task/, method/, assets/packs/, scripts/, package files and Skills unchanged.\n',
        '.agents/skills/reproduce/SKILL.md': '---\nname: reproduce\ndescription: Independently analyze a video reference and generate scenes and camera motion from an empty project using a method recipe.\n---\n\nRead method/methods/workflow.md. Inspect the reference before planning; record observations and a shot plan. Implement your own scene, layout, timing and camera paths in src/. Use ASSET-LOCK.json for permitted reusable components. Render previews, inspect actual frames and audio, and repair your own work. Never import a completed teacher scene or answer implementation.\n',
        '.agents/skills/validate/SKILL.md': '---\nname: validate\ndescription: Inspect actual rendered frames and audio against frozen public acceptance criteria.\n---\n\nRead task/acceptance.json. Inspect matching reference and candidate times, including movement intermediate frames. Record evidence for each criterion; mark unavailable observations unobserved. Do not change standards or claim external acceptance from a self-check.\n',
        '.agents/skills/repair/SKILL.md': '---\nname: repair\ndescription: Diagnose acceptance failures and independently repair only this run\'s generated implementation.\n---\n\nRead failed criteria and evidence first. Distinguish environment failures from composition, motion, subtitles and audio. Follow method/repair-playbooks/diagnosis.md. Repair only your own generated source, render again and inspect fresh evidence. Do not weaken the task or request a teacher patch.\n',
        'methods/workflow.md': '# Production method\n\nObserve the reference, separate content from camera motion, plan shots, select generic assets, generate scene geometry and layout, generate camera movement, render, compare evidence and repair. Fill in reusable diagnostic procedures before freezing this recipe.\n',
        'constraints/visual.md': '# Observable constraints\n\nDescribe screen-space proportions, visibility, timing stages and visual relationships. Task-specific measured targets belong to the task. Do not provide solved world-coordinate layouts or executable camera tracks.\n',
        'repair-playbooks/diagnosis.md': '# Diagnosis\n\nMeasure the failing visual relationship in reference and candidate frames. Identify whether object scale, placement, projection or camera motion causes the discrepancy. Change one cause, sample the entire affected movement interval, and check that the repair does not introduce occlusion elsewhere.\n',
    };
    for (const [file, body] of Object.entries(docs)) await fs.writeFile(await safeProjectFile(directory, file, { create: true }), body, { flag: 'wx' });
    const manifest = { schema: METHOD_SCHEMA, title, scope, files: Object.keys(docs), capabilities, assetPacks,
        generationContract: { requiredGeneratedFiles: ['src/index.html'], forbidden: ['teacher-implementation', 'reference-pixels'] },
        contentReview: contentReview || { reviewer: 'pending', notes: 'Draft requires an explicit content review before publication.', containsTargetImplementation: false } };
    await fs.writeFile(path.join(directory, 'recipe.json'), json(manifest), { flag: 'wx' });
    return { root: path.resolve(directory), manifest };
}

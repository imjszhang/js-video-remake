import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { validateRequirements } from './capabilities.js';
import { copyProject, snapshotProject, validateProject, safeProjectFile, projectPath } from './project.js';

const SCHEMA = 'video-remake.reproduction-template@1';
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function identity(name, version) {
    if (!NAME.test(name) || !Number.isSafeInteger(Number(version)) || Number(version) < 1) throw appError('REPRO_INVALID', '模板标识必须为 name@正整数');
    return { name, version: Number(version), id: `${name}@${Number(version)}` };
}

function publicProvenance(value) {
    if (typeof value === 'string') {
        if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return undefined;
        return value;
    }
    if (Array.isArray(value)) return value.map(publicProvenance).filter(v => v !== undefined);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/(?:secret|token|credential|apiKey|runDir|workspace|password)/i.test(key))
        .map(([key, child]) => [key, publicProvenance(child)]).filter(([, child]) => child !== undefined));
    return value;
}

async function destinationFor(config, name, version) {
    const root = path.resolve(config.workspace);
    return safeProjectFile(root, `reproductions/templates/${name}/v${version}`, { create: true });
}

function returned(root, record, manifest) {
    return { ...record, root, projectRoot: root, path: root, manifest, spec: record.spec };
}

export async function freezeTemplate(config, { source, name, version, spec, provenance = {}, capabilities } = {}) {
    const id = identity(name, version);
    const validation = await validateProject(source, { requireReady: true });
    if (!validation.ok) throw appError('REPRO_INVALID', '项目未满足模板冻结条件', { data: { checks: validation.checks } });
    const requirements = validateRequirements(capabilities ?? validation.manifest.capabilities ?? []);
    if (hash(requirements) !== hash(validation.manifest.capabilities || [])) throw appError('REPRO_INVALID', '模板能力需求与项目声明不一致');
    if (!spec) {
        try { spec = JSON.parse(await fs.readFile(await safeProjectFile(source, 'task/spec.json'), 'utf8')); }
        catch { throw appError('REPRO_INVALID', '模板缺少冻结规格'); }
    }
    const projectSpec = JSON.parse(await fs.readFile(await safeProjectFile(source, 'task/spec.json'), 'utf8'));
    const projectAcceptance = JSON.parse(await fs.readFile(await safeProjectFile(source, 'task/acceptance.json'), 'utf8'));
    if (hash(projectSpec) !== hash(spec) || hash(projectAcceptance) !== hash(spec.acceptance)) throw appError('REPRO_INVALID', '模板规格、项目规格和公开验收条件不一致');
    const root = await destinationFor(config, id.name, id.version);
    try { await fs.access(root); throw appError('REPRO_EXISTS', `模板版本已存在: ${id.id}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(path.dirname(root), `.v${id.version}-${randomUUID()}.tmp`);
    const claim = `${root}.lock`;
    let locked = false;
    try {
        const snapshot = await copyProject(source, temporary);
        if (snapshot.treeHash !== validation.treeHash) throw appError('REPRO_CHANGED', '验证后源工程发生变化，请重新冻结模板');
        const staged = await validateProject(temporary, { requireReady: true });
        if (!staged.ok || staged.treeHash !== snapshot.treeHash) throw appError('REPRO_CHANGED', '暂存工程验证失败；模板版本尚未创建', { data: { checks: staged.checks } });
        const stagedSpec = JSON.parse(await fs.readFile(await safeProjectFile(temporary, 'task/spec.json'), 'utf8'));
        const stagedAcceptance = JSON.parse(await fs.readFile(await safeProjectFile(temporary, 'task/acceptance.json'), 'utf8'));
        if (hash(stagedSpec) !== hash(spec) || hash(stagedAcceptance) !== hash(spec.acceptance)
            || hash(staged.manifest.capabilities || []) !== hash(requirements)) throw appError('REPRO_CHANGED', '暂存工程规格或能力声明变化；模板版本尚未创建');
        const record = { schema: SCHEMA, ...id, createdAt: new Date().toISOString(), status: 'candidate',
            spec, provenance: publicProvenance(provenance), capabilities: requirements, ...snapshot };
        record.metadataHash = hash(record);
        await fs.writeFile(path.join(temporary, 'template.json'), json(record), { flag: 'wx' });
        // Cooperating publishers exclusively claim the version, then atomically
        // reveal its complete directory. Readers never observe a partial tree.
        try { await fs.writeFile(claim, json({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx' }); locked = true; }
        catch (error) { if (error.code === 'EEXIST') throw appError('REPRO_BUSY', `模板版本正在冻结: ${id.id}`); throw error; }
        try { await fs.access(root); throw appError('REPRO_EXISTS', `模板版本已存在: ${id.id}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(temporary, root);
        return returned(root, record, validation.manifest);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); if (locked) await fs.rm(claim, { force: true }); }
}

export async function loadTemplate(config, selector) {
    let root;
    if (typeof selector === 'object' && selector !== null) root = selector.root ?? selector.projectRoot ?? selector.path;
    else if (typeof selector === 'string' && /^[a-z][a-z0-9_-]{0,63}@\d+$/.test(selector)) {
        const [name, version] = selector.split('@');
        const id = identity(name, Number(version));
        root = await safeProjectFile(config.workspace, `reproductions/templates/${id.name}/v${id.version}`);
    } else if (typeof selector === 'string') root = path.resolve(config.workspace, selector);
    if (!root) throw appError('REPRO_INVALID', '需要模板标识或目录');
    root = path.resolve(root);
    const record = JSON.parse(await fs.readFile(await safeProjectFile(root, 'template.json'), 'utf8'));
    if (record.schema !== SCHEMA) throw appError('REPRO_INVALID', '模板清单格式无效');
    const id = identity(record.name, record.version);
    if (record.id !== id.id) throw appError('REPRO_INVALID', '模板标识与版本不一致');
    const { metadataHash, ...unsigned } = record;
    if (metadataHash !== hash(unsigned)) throw appError('REPRO_CHANGED', '模板元数据已变化');
    const actual = await snapshotProject(root);
    if (actual.treeHash !== record.treeHash || JSON.stringify(actual.files) !== JSON.stringify(record.files)) throw appError('REPRO_CHANGED', '模板文件与冻结清单不一致');
    const validation = await validateProject(root, { requireReady: true });
    if (!validation.ok) throw appError('REPRO_INVALID', '模板项目检查未通过', { data: { checks: validation.checks } });
    if (hash(validateRequirements(record.capabilities || [])) !== hash(validation.manifest.capabilities || [])) throw appError('REPRO_INVALID', '模板能力需求与项目声明不一致');
    const spec = JSON.parse(await fs.readFile(await safeProjectFile(root, 'task/spec.json'), 'utf8'));
    const acceptance = JSON.parse(await fs.readFile(await safeProjectFile(root, 'task/acceptance.json'), 'utf8'));
    if (hash(spec) !== hash(record.spec) || hash(acceptance) !== hash(record.spec.acceptance)) throw appError('REPRO_INVALID', '模板元数据与项目规格不一致');
    return returned(root, record, validation.manifest);
}

export async function instantiateTemplate(config, template, { destination, inputs = {}, inputsPath = 'inputs/values.json' } = {}) {
    const record = await loadTemplate(config, template);
    if (!destination) throw appError('REPRO_INVALID', '需要实例目标目录');
    await copyProject(record.root, destination);
    const inputFile = await safeProjectFile(destination, projectPath(inputsPath), { create: true });
    await fs.writeFile(inputFile, json(inputs), { flag: 'wx' });
    await fs.mkdir(path.join(destination, 'outputs'), { recursive: true });
    const instance = { schema: 'video-remake.reproduction-instance@1', template: record.id, templateTreeHash: record.treeHash, createdAt: new Date().toISOString() };
    await fs.writeFile(path.join(destination, 'INSTANCE.json'), json(instance), { flag: 'wx' });
    return { ...instance, root: path.resolve(destination), projectRoot: path.resolve(destination), manifest: record.manifest, spec: record.spec, template: record };
}

export async function exportTemplate(config, template, { destination } = {}) {
    const record = await loadTemplate(config, template);
    if (!destination) throw appError('REPRO_INVALID', '需要导出目录');
    await copyProject(record.root, destination);
    const { root, projectRoot, path: _path, manifest, ...metadata } = record;
    await fs.writeFile(path.join(destination, 'template.json'), json(metadata), { flag: 'wx' });
    return loadTemplate(config, path.resolve(destination));
}

export async function importTemplate(config, source, { name, version } = {}) {
    const record = await loadTemplate(config, source);
    return freezeTemplate(config, { source: record.root, name: name || record.name, version: version || record.version,
        spec: record.spec, provenance: { ...record.provenance, importedFrom: record.id, importedTreeHash: record.treeHash, verification: 'unverified' }, capabilities: record.capabilities });
}

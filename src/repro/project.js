import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appError } from '../errors.js';
import { validateRequirements } from './capabilities.js';
import { skillScaffold, syncSkills, validateSkills, portableSkillSyncScript } from './skills.js';

export { syncSkills } from './skills.js';
export const PROJECT_SCHEMA = 'video-remake.reproduction-project@1';
export const HYPERFRAMES_VERSION = '0.8.191';
const digest = value => createHash('sha256').update(value).digest('hex');
const transient = new Set(['node_modules', '.git', 'outputs', '.cache', '.work', '.DS_Store']);
const reserved = new Set(['template.json', 'INSTANCE.json', '.reproduction-capabilities.local.json']);
const json = value => `${JSON.stringify(value, null, 2)}\n`;

export function projectPath(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
        || path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)
        || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw appError('REPRO_INVALID', `项目路径必须是安全的相对路径: ${value}`);
    }
    return value;
}

export async function safeProjectFile(root, rel, { create = false } = {}) {
    projectPath(rel);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw appError('REPRO_INVALID', '项目根目录必须是普通目录');
    let current = root;
    const parts = rel.split('/');
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink()) throw appError('REPRO_INVALID', `不接受符号链接: ${rel}`);
            if (index < parts.length - 1 && !stat.isDirectory()) throw appError('REPRO_INVALID', `父路径不是目录: ${rel}`);
        } catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            if (index < parts.length - 1) await fs.mkdir(current);
        }
    }
    return current;
}

async function write(root, rel, value) {
    const destination = await safeProjectFile(root, rel, { create: true });
    await fs.writeFile(destination, typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value), { flag: 'wx' });
}

function isSecret(rel) {
    const name = path.posix.basename(rel);
    return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example'
        || /^(?:credentials|secrets|auth)\.json$/i.test(name)
        || /\.(?:pem|key|p12|pfx)$/i.test(name)
        || ['.npmrc', '.netrc', 'id_rsa', 'id_ed25519'].includes(name);
}

function checkEnvironmentExample(bytes) {
    for (const line of bytes.toString('utf8').split(/\r?\n/)) {
        const value = line.trim();
        if (!value || value.startsWith('#')) continue;
        if (!/^[A-Z][A-Z0-9_]*=(?:|""|''|<[^>]+>|\$\{[A-Z][A-Z0-9_]*\})$/.test(value)) {
            throw appError('REPRO_INVALID', '.env.example 只接受空值或占位符，不得包含实际配置或凭据');
        }
    }
}

function dependencyError(value) {
    return typeof value !== 'string' || /^(?:file:|link:|workspace:|\.\.?[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(value);
}

async function validateDependencies(root) {
    const pkg = JSON.parse(await fs.readFile(await safeProjectFile(root, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, value] of Object.entries(pkg[field] || {})) {
            if (dependencyError(value)) throw appError('REPRO_INVALID', `不可搬迁的依赖: ${name}=${value}`);
        }
    }
    if (pkg.workspaces) throw appError('REPRO_INVALID', '独立模板不接受 workspace 依赖');
    if (pkg.dependencies?.hyperframes !== HYPERFRAMES_VERSION) throw appError('REPRO_INVALID', `HyperFrames 必须精确固定为 ${HYPERFRAMES_VERSION}`);
    const lock = JSON.parse(await fs.readFile(await safeProjectFile(root, 'package-lock.json'), 'utf8'));
    if (lock.lockfileVersion !== 3 || lock.packages?.['']?.dependencies?.hyperframes !== HYPERFRAMES_VERSION
        || lock.packages?.['node_modules/hyperframes']?.version !== HYPERFRAMES_VERSION) throw appError('REPRO_INVALID', '依赖锁与项目版本不一致');
    for (const [key, value] of Object.entries(lock.packages)) {
        if (key) projectPath(key);
        if (value.link || value.resolved && !/^https:\/\//.test(value.resolved)) throw appError('REPRO_INVALID', `锁文件包含本地依赖: ${key}`);
    }
    for (const command of ['doctor', 'render', 'check']) {
        if (!pkg.scripts?.[command]) throw appError('REPRO_INVALID', `缺少项目命令: ${command}`);
    }
    for (const command of Object.values(pkg.scripts || {})) {
        if (/(?:^|\s|["'])(?:\.\.\/|\/(?:Users|home|private|tmp|opt)\/)/.test(command)) throw appError('REPRO_INVALID', '项目命令依赖目录外路径');
    }
    return { pkg, lock };
}

async function validateSourceReferences(root, snapshot) {
    for (const file of snapshot?.files || []) {
        if (!/\.(?:[cm]?js|jsx?|tsx?|html|css|svg|md|json)$/.test(file.path)) continue;
        const source = await fs.readFile(path.join(root, file.path), 'utf8');
        if (/(?:file:\/\/\/|(?:^|[\s"'`(=:])\/(?:Users|home|private\/var|tmp|var\/folders|opt\/homebrew)\/|["'`][A-Za-z]:\\)/m.test(source)) throw appError('REPRO_INVALID', `项目文件包含主机绝对路径: ${file.path}`);
        if (/\.(?:md|json)$/.test(file.path)) continue;
        const references = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\b(?:src|href)\s*=\s*)["']([^"']+)["']/g)];
        for (const [, reference] of references) {
            if (!reference.startsWith('.')) continue;
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), reference));
            if (resolved === '..' || resolved.startsWith('../')) throw appError('REPRO_INVALID', `源码引用项目外文件: ${file.path}: ${reference}`);
        }
    }
}

// Reuse the repository's already reviewed npm resolution, keeping only the
// HyperFrames dependency closure. The generated lock has no host references.
async function hyperframesLock(name) {
    const source = JSON.parse(await fs.readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    const packages = { '': { name, version: '1.0.0', dependencies: { hyperframes: HYPERFRAMES_VERSION }, engines: { node: '>=22.15.0' } } };
    const queue = ['node_modules/hyperframes'];
    const resolve = (from, dependency) => {
        let current = from;
        while (current) {
            const candidate = `${current}/node_modules/${dependency}`;
            if (source.packages[candidate]) return candidate;
            const at = current.lastIndexOf('/node_modules/');
            current = at < 0 ? '' : current.slice(0, at);
        }
        return source.packages[`node_modules/${dependency}`] ? `node_modules/${dependency}` : null;
    };
    while (queue.length) {
        const key = queue.shift();
        if (packages[key]) continue;
        const value = source.packages[key];
        if (!value) throw appError('REPRO_INVALID', `根锁文件缺少依赖: ${key}`);
        const copy = { ...value };
        delete copy.dev; delete copy.devOptional;
        packages[key] = copy;
        for (const [dependency] of Object.entries({ ...value.dependencies, ...value.optionalDependencies, ...value.peerDependencies })) {
            const resolved = resolve(key, dependency);
            if (resolved) queue.push(resolved);
            else if (value.dependencies?.[dependency] && !value.optionalDependencies?.[dependency]) throw appError('REPRO_INVALID', `根锁文件无法解析: ${dependency}`);
        }
    }
    return { name, version: '1.0.0', lockfileVersion: 3, requires: true, packages };
}

const scriptCommon = `import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const manifest = await read('reproduction.json');
const acceptance = await read('task/acceptance.json');
function local(value) {
  if (typeof value !== 'string' || !value || value.includes('\\\\') || path.isAbsolute(value) || value.split('/').some(s => !s || s === '..' || s === '.')) throw new Error('Unsafe project path: ' + value);
  return path.join(root, value);
}
function command(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(binary + ' failed with exit ' + result.status);
}
`;

const doctorScript = `${scriptCommon}
const issues = [];
if (Number(process.versions.node.split('.')[0]) < 22) issues.push('Node.js 22.15+ is required');
try {
  const installed = await read('node_modules/hyperframes/package.json');
  if (installed.version !== '${HYPERFRAMES_VERSION}') issues.push('Run npm ci to install HyperFrames ${HYPERFRAMES_VERSION}');
} catch { issues.push('Run npm ci to install local dependencies'); }
for (const tool of ['ffmpeg', 'ffprobe']) {
  const result = spawnSync(tool, ['-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) issues.push(tool + ' must be installed and on PATH');
}
try { await fs.access(local(manifest.entry)); } catch { issues.push('Missing composition: ' + manifest.entry); }
console.log(JSON.stringify({ ok: issues.length === 0, issues, status: manifest.status }, null, 2));
if (issues.length) process.exitCode = 1;
`;

const renderScript = `${scriptCommon}
if (manifest.status === 'draft') throw new Error('Draft scaffold: implement src/ and set reproduction.json status to ready before rendering.');
const output = local(acceptance.media.file);
await fs.mkdir(path.dirname(output), { recursive: true });
const cli = local('node_modules/hyperframes/bin/hyperframes.mjs');
await fs.access(cli);
const extra = process.argv.slice(2);
if (extra.includes('--plan')) {
  console.log(JSON.stringify({ executable: process.execPath, args: [cli, 'render', root, '--composition', manifest.entry, '--variables-file', local(manifest.inputsFile), '--output', output], cwd: root }, null, 2));
} else {
  command(process.execPath, [cli, 'render', root, '--composition', manifest.entry, '--variables-file', local(manifest.inputsFile), '--output', output, ...extra]);
}
`;

const checkScript = `${scriptCommon}
const checks = [];
const add = (id, passed, detail) => checks.push({ id, passed, detail });
add('implemented', manifest.status !== 'draft', manifest.status);
for (const name of acceptance.requiredFiles || []) {
  try { add('file:' + name, (await fs.stat(local(name))).isFile(), name); }
  catch { add('file:' + name, false, 'Missing required file'); }
}
let values;
try { values = await read(manifest.inputsFile); }
catch { add('inputs', false, 'Missing or invalid inputs'); }
const schema = await read('task/inputs.schema.json');
for (const name of schema.required || []) add('input:' + name, typeof values?.[name] === 'string' && values[name].length > 0, 'Required input');
for (const [name, definition] of Object.entries(schema.properties || {})) {
  if (values?.[name] !== undefined && definition['x-reproduction-type'] === 'file') {
    try { add('input-file:' + name, (await fs.stat(local(values[name]))).isFile(), values[name]); }
    catch { add('input-file:' + name, false, 'Missing input file'); }
  }
}
try {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', local(acceptance.media.file)], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('ffprobe failed');
  const media = JSON.parse(result.stdout);
  const video = media.streams.find(s => s.codec_type === 'video');
  const audio = media.streams.filter(s => s.codec_type === 'audio').length;
  add('dimensions', video?.width === acceptance.media.width && video?.height === acceptance.media.height, video ? video.width + 'x' + video.height : 'No video stream');
  const duration = Number(media.format?.duration ?? video?.duration);
  add('duration', Number.isFinite(duration) && Math.abs(duration - acceptance.media.durationSec) <= (acceptance.media.toleranceSec ?? 0.5), duration);
  add('audio', acceptance.media.audio === 'optional' || (acceptance.media.audio === 'required' ? audio > 0 : audio === 0), audio);
} catch (error) { add('media', false, error.message); }
const report = { schema: 'video-remake.project-self-check@1', ok: checks.every(c => c.passed), checks, review: (acceptance.review || []).map(c => ({ ...c, result: 'unobserved' })), externalAcceptanceRequired: true };
await fs.mkdir(path.join(root, 'outputs'), { recursive: true });
await fs.writeFile(path.join(root, 'outputs/self-check.json'), JSON.stringify(report, null, 2) + '\\n');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
`;

export async function scaffoldProject(root, { spec, inputs = {}, name = 'reproduction', capabilities = [], toolkit = false } = {}) {
    if (!spec?.acceptance?.media || !spec.inputs) throw appError('REPRO_INVALID', '创建项目需要输入和媒体验收规格');
    projectPath(spec.acceptance.media.file);
    const packageName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'reproduction';
    await fs.mkdir(root, { recursive: true });
    if ((await fs.readdir(root)).length) throw appError('REPRO_EXISTS', `项目目录不是空目录: ${root}`);
    const manifest = {
        schema: PROJECT_SCHEMA, name: packageName, status: 'draft', entry: 'src/index.html',
        inputsFile: 'inputs/values.json', output: spec.acceptance.media.file,
        commands: { doctor: 'npm run doctor', render: 'npm run render', check: 'npm run check' },
        capabilities: validateRequirements(capabilities), skills: { canonical: '.agents/skills', generated: ['.claude/skills'] },
    };
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
        properties: Object.fromEntries(Object.entries(spec.inputs).map(([key, value]) => [key, { type: 'string', minLength: 1, 'x-reproduction-type': value.type }])),
        required: Object.entries(spec.inputs).filter(([, definition]) => definition.required !== false).map(([key]) => key) };
    const examples = Object.fromEntries(Object.entries(spec.inputs).filter(([, definition]) => definition.type === 'text').map(([key]) => [key, `Example ${key}`]));
    const files = {
        'reproduction.json': manifest,
        'README.md': `# ${spec.title || packageName}\n\nA standalone reproduction project. This initial scaffold is a draft; the composition must be implemented before it can render.\n\nInstall Node.js 22.15+, FFmpeg/ffprobe, then run \`npm ci\` and \`npm run doctor\`. HyperFrames may require its browser installation on a new machine. Read task/brief.md, supply inputs/values.json, and run \`npm run render\` followed by \`npm run check\`. Open this directory in a supported Agent Harness; model credentials belong to that Harness, outside this project.\n\nThe .agents/skills directory is canonical; .claude/skills contains generated copies. After changing canonical skills, run \`npm run skills:sync\`. A template can be used without video-remake.\n\nSelf-checks do not certify visual fidelity. External validation records the tested model, Harness, inputs, output and evidence.\n`,
        'AGENTS.md': `# Reproduction project\n\nRead task/brief.md and reproduction.json. Use the reproduce skill for adaptation, validate for evidence and checks, and repair after a failure. The canonical instructions are in .agents/skills/.\n\nKeep source and assets portable. Read current inputs from inputs/values.json. Preserve task/acceptance.json. Implement draft source before setting reproduction.json status to ready. Use package.json commands; keep credentials and runtime logs outside the template.\n`,
        'CLAUDE.md': '@AGENTS.md\n',
        'package.json': { name: packageName, version: '1.0.0', private: true, type: 'module', engines: { node: '>=22.15.0' },
            scripts: { doctor: 'node scripts/doctor.mjs', render: 'node scripts/render.mjs', check: 'node scripts/check.mjs', 'skills:sync': 'node scripts/sync-skills.mjs' }, dependencies: { hyperframes: HYPERFRAMES_VERSION } },
        'package-lock.json': await hyperframesLock(packageName),
        '.gitignore': 'node_modules/\noutputs/\ninputs/*\n!inputs/.gitkeep\n.env\n.env.*\n!.env.example\n.reproduction-capabilities.local.json\n',
        '.env.example': '# Capability credentials are bound by the executing Harness.\n',
        'task/brief.md': `# ${spec.title || packageName}\n\n${spec.objective || ''}\n\n## Preserve\n\n${(spec.preserve || []).map(v => `- ${v}`).join('\n')}\n\n## Replace\n\n${(spec.replace || []).map(v => `- ${v}`).join('\n')}\n`,
        'task/inputs.schema.json': schema,
        'task/spec.json': spec,
        'task/acceptance.json': spec.acceptance,
        'examples/inputs.json': examples,
        'inputs/.gitkeep': '',
        'inputs/values.json': inputs,
        'assets/.gitkeep': '',
        'src/index.html': '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Draft reproduction</title></head><body><!-- REPRODUCTION_DRAFT: implement the reference composition before rendering. --></body></html>\n',
        'scripts/doctor.mjs': doctorScript,
        'scripts/render.mjs': renderScript,
        'scripts/check.mjs': checkScript,
        'scripts/sync-skills.mjs': portableSkillSyncScript(),
        'scripts/capability.mjs': await fs.readFile(new URL('./capability-client.mjs', import.meta.url), 'utf8'),
        'docs/workflow.md': '# Workflow\n\nThe teacher must document the scene timings, input-to-source mappings, editable boundaries, render procedure and evidence checkpoints here. This draft does not contain a completed reproduction.\n',
        'docs/troubleshooting.md': '# Troubleshooting\n\nStart with npm run doctor for dependencies and npm run check for output failures. Add observed reference-specific failures, their causes and verified repairs while developing the template.\n',
        'outputs/.gitkeep': '',
    };
    for (const [rel, value] of Object.entries(files)) await write(root, rel, value);
    for (const [skill, value] of Object.entries(skillScaffold())) await write(root, `.agents/skills/${skill}/SKILL.md`, value);
    if (toolkit) {
        const folder = new URL('../../resources/repro-toolkit/three-r186/', import.meta.url);
        const record = JSON.parse(await fs.readFile(new URL('toolkit.json', folder), 'utf8'));
        for (const [file, expected] of Object.entries(record.files)) {
            projectPath(file);
            const bytes = await fs.readFile(new URL(file, folder));
            if (digest(bytes) !== expected) throw appError('REPRO_CHANGED', '通用工具包内容已改变: ' + file);
            await write(root, 'toolkit/three/' + file, bytes);
        }
        await write(root, 'toolkit/three/toolkit.json', record);
    }
    await syncSkills(root);
    return manifest;
}

export async function snapshotProject(root, { includeInputs = false, includeOutputs = false, exclude = [] } = {}) {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw appError('REPRO_INVALID', '项目根目录必须是普通目录');
    let output;
    try { output = JSON.parse(await fs.readFile(await safeProjectFile(root, 'reproduction.json'), 'utf8')).output; } catch { /* Validation reports malformed/missing manifests. */ }
    const renderOutputs = new Set(output ? [output] : []);
    try {
        const record = JSON.parse(await fs.readFile(await safeProjectFile(root, '.hyperframes/render-outputs.json'), 'utf8'));
        for (const value of record.paths || []) renderOutputs.add(projectPath(value));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const files = [];
    async function walk(prefix = '') {
        for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            projectPath(rel);
            if (entry.isSymbolicLink()) throw appError('REPRO_INVALID', `不接受符号链接: ${rel}`);
            if (isSecret(rel)) throw appError('REPRO_INVALID', `模板中发现私密配置文件: ${rel}`);
            if (transient.has(entry.name) && !(entry.name === 'outputs' && includeOutputs) || reserved.has(rel) || exclude.includes(rel)) continue;
            // HyperFrames keeps authored Studio overrides and prepared assets
            // beside runtime caches. Preserve the former and discard history,
            // previews/check reports and machine-local render bookkeeping.
            const hfAt = rel.split('/').indexOf('.hyperframes');
            if (hfAt >= 0) {
                const tail = rel.split('/').slice(hfAt + 1);
                if (tail.length && !['studio-motion.json', 'studio-manual-edits.json', 'prepared-assets', 'requests'].includes(tail[0])) continue;
            }
            if (!includeInputs && (rel === 'INPUTS.json' || rel === 'reference' || rel === 'references' || rel.startsWith('inputs/') && rel !== 'inputs/.gitkeep')) continue;
            if (!includeOutputs && renderOutputs.has(rel)) continue;
            if (entry.isDirectory()) await walk(rel);
            else if (entry.isFile()) {
                const file = path.join(root, rel);
                const bytes = await fs.readFile(file);
                if (rel === '.env.example') checkEnvironmentExample(bytes);
                files.push({ path: rel, sha256: digest(bytes), size: bytes.length, executable: Boolean((await fs.stat(file)).mode & 0o111) });
            } else throw appError('REPRO_INVALID', `不支持的项目文件类型: ${rel}`);
        }
    }
    await walk();
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { files, treeHash: digest(JSON.stringify(files)) };
}

export async function validateProject(root, { requireReady = false, allowDraft } = {}) {
    if (allowDraft === false) requireReady = true;
    const checks = [];
    let manifest, snapshot;
    const check = async (id, operation) => {
        try { await operation(); checks.push({ id, passed: true }); }
        catch (error) { checks.push({ id, passed: false, message: error.message }); }
    };
    await check('portable-files', async () => { snapshot = await snapshotProject(root); });
    await check('manifest', async () => {
        manifest = JSON.parse(await fs.readFile(await safeProjectFile(root, 'reproduction.json'), 'utf8'));
        if (manifest.schema !== PROJECT_SCHEMA || !['draft', 'ready'].includes(manifest.status)) throw new Error('项目清单格式或状态无效');
        manifest.capabilities = validateRequirements(manifest.capabilities || []);
        projectPath(manifest.entry); projectPath(manifest.inputsFile); projectPath(manifest.output);
        if (requireReady && manifest.status !== 'ready') throw new Error('项目仍是 draft');
        const entry = await fs.readFile(await safeProjectFile(root, manifest.entry), 'utf8');
        if (requireReady && entry.includes('REPRODUCTION_DRAFT')) throw new Error('入口仍是草稿占位文件');
    });
    await check('required-files', async () => {
        for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', '.gitignore', '.env.example', 'task/brief.md', 'task/inputs.schema.json', 'task/acceptance.json', 'docs/workflow.md', 'docs/troubleshooting.md', 'scripts/doctor.mjs', 'scripts/render.mjs', 'scripts/check.mjs']) {
            if (!(await fs.stat(await safeProjectFile(root, file))).isFile()) throw new Error(`缺少项目文件: ${file}`);
        }
        const acceptance = JSON.parse(await fs.readFile(await safeProjectFile(root, 'task/acceptance.json'), 'utf8'));
        projectPath(acceptance.media.file);
        if (manifest && manifest.output !== acceptance.media.file) throw new Error('项目输出与验收路径不一致');
    });
    await check('dependencies', () => validateDependencies(root));
    await check('source-references', () => validateSourceReferences(root, snapshot));
    await check('skills', () => validateSkills(root));
    return { ok: checks.every(item => item.passed), checks, manifest, ...snapshot };
}

export async function copyProject(source, destination, options = {}) {
    const snapshot = await snapshotProject(source, options);
    const from = path.resolve(source), to = path.resolve(destination);
    if (from === to || to.startsWith(`${from}${path.sep}`)) throw appError('REPRO_INVALID', '项目副本必须在来源目录之外');
    await fs.mkdir(to, { recursive: true });
    if ((await fs.readdir(to)).length) throw appError('REPRO_EXISTS', `目标目录非空: ${to}`);
    for (const file of snapshot.files) {
        const target = await safeProjectFile(to, file.path, { create: true });
        const sourceFile = await safeProjectFile(from, file.path);
        const bytes = await fs.readFile(sourceFile);
        if (digest(bytes) !== file.sha256) throw appError('REPRO_CHANGED', `复制过程中源文件变化: ${file.path}`);
        await fs.writeFile(target, bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
    }
    return snapshot;
}

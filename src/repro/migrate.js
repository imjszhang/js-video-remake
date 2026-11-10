import fs from 'node:fs/promises';
import path from 'node:path';
import { agentStorageRoot } from '../agent-config.js';
import { appError } from '../errors.js';
import { safeProjectPath, validateSpec } from './schema.js';
import { digest, jsonHash, safeFile, readJson } from './store.js';

const MAX_TEXT = 1024 * 1024;
const legacySelector = value => {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,80})@([1-9]\d*)$/.exec(value || '');
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw appError('REPRO_INVALID', 'Legacy template selector must be name@version.');
    return { name: match[1], version: Number(match[2]) };
};

function absoluteReferences(value, at = '$', entries = []) {
    if (typeof value === 'string' && (/^(?:\/|[a-zA-Z]:[\\/]|~\/)/.test(value))) entries.push({ field: at, value });
    else if (Array.isArray(value)) value.forEach((entry, index) => absoluteReferences(entry, `${at}[${index}]`, entries));
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) absoluteReferences(entry, `${at}.${key}`, entries);
    return entries;
}

function recipeFormat(recipe) {
    if (!recipe || recipe.schema !== 'video-remake.harness-recipe@1' || !Array.isArray(recipe.steps) || !recipe.steps.length || !Array.isArray(recipe.templates) || !Array.isArray(recipe.repairs)) throw appError('REPRO_INVALID', 'Invalid legacy recipe.');
    for (const step of recipe.steps) {
        if (!step || typeof step.id !== 'string' || typeof step.instruction !== 'string' || !Array.isArray(step.outputs)) throw appError('REPRO_INVALID', 'Invalid legacy recipe step.');
        step.outputs.forEach(file => safeProjectPath(file));
    }
    const targets = new Set();
    for (const template of recipe.templates) {
        safeProjectPath(template.from); safeProjectPath(template.to);
        if (!template.from.startsWith('templates/')) throw appError('REPRO_INVALID', 'Legacy source files must be under templates/.');
        if (targets.has(template.to)) throw appError('REPRO_INVALID', `Duplicate legacy destination: ${template.to}`);
        targets.add(template.to);
    }
    for (const repair of recipe.repairs) if (!repair || typeof repair.when !== 'string' || typeof repair.instruction !== 'string') throw appError('REPRO_INVALID', 'Invalid legacy repair.');
    return recipe;
}

function destinationFor(relative) {
    // Keep generated contracts and commands intact; incompatible old files remain
    // available for deliberate integration, never loaded as project configuration.
    const protectedPath = /^(?:task|inputs|reference|references|scripts|outputs|docs|\.agents|\.claude)(?:\/|$)/.test(relative)
        || ['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'package-lock.json', 'reproduction.json', 'TASK.json', 'INPUTS.json', 'TOOLS.json', 'MIGRATION.json', '.gitignore', '.env.example'].includes(relative);
    return protectedPath ? `legacy/files/${relative}` : relative;
}

async function legacyPointers(config) {
    let root;
    try { root = await safeFile(config.workspace, 'productions'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const result = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const relative = `productions/${entry.name}/HARNESS.json`;
        try { if ((await fs.lstat(await safeFile(config.workspace, relative))).isFile()) result.push(relative); }
        catch (error) { if (error.code !== 'ENOENT') result.push({ path: relative, warning: 'Cannot inspect this legacy pointer safely.' }); }
    }
    return result;
}

async function inspect(config, selector) {
    const id = legacySelector(selector);
    const relative = `packages/harnesses/${id.name}/v${id.version}`;
    const manifest = await readJson(config.workspace, `${relative}/manifest.json`);
    if (manifest.schema !== 'video-remake.harness@1' || manifest.name !== id.name || manifest.version !== id.version) throw appError('REPRO_INVALID', 'Legacy manifest identity does not match its directory.');
    const spec = validateSpec(manifest.spec);
    const recipe = recipeFormat(manifest.recipe);
    if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw appError('REPRO_INVALID', 'Legacy manifest is missing its file hash inventory.');
    const report = {
        schema: 'video-remake.legacy-migration-report@1', selector, source: relative,
        manifestHash: jsonHash(manifest), files: [], references: [], absolutePaths: absoluteReferences(manifest),
        blockers: [], warnings: [], legacyPointers: await legacyPointers(config),
        historyRetained: true, certification: 'not-validated', receipt: { status: 'missing' },
    };
    const bytesByPath = new Map();
    for (const [file, expected] of Object.entries(manifest.files)) {
        let status = 'verified'; let bytes; let errorMessage;
        try {
            safeProjectPath(file);
            if (!/^[a-f0-9]{64}$/.test(expected)) throw appError('REPRO_INVALID', 'Invalid expected SHA256.');
            const source = await safeFile(config.workspace, `${relative}/${file}`);
            const stat = await fs.stat(source);
            if (!stat.isFile() || stat.size > MAX_TEXT) throw appError('REPRO_INVALID', 'Legacy template must be a regular text file smaller than 1 MiB.');
            bytes = await fs.readFile(source);
            if (bytes.includes(0)) throw appError('REPRO_INVALID', 'Legacy template is not text.');
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (digest(bytes) !== expected) throw appError('REPRO_INVALID', 'Legacy template SHA256 does not match its manifest.');
            bytesByPath.set(file, bytes);
        } catch (error) {
            status = error.code === 'ENOENT' ? 'missing' : 'invalid'; errorMessage = error.message;
            report.blockers.push({ type: 'file-integrity', path: file, message: errorMessage });
        }
        const mapping = recipe.templates.filter(template => template.from === file).map(template => ({ to: template.to, destination: destinationFor(template.to) }));
        report.files.push({ from: file, sha256: expected, bytes: bytes?.length ?? null, status, mappings: mapping, ...(errorMessage ? { message: errorMessage } : {}) });
        if (bytes && /(?:\/Users\/|\/home\/|[A-Za-z]:\\)/.test(bytes.toString('utf8'))) report.warnings.push({ type: 'source-local-path', path: file, message: 'Source text contains a machine path and requires manual adaptation.' });
    }
    for (const template of recipe.templates) {
        if (!Object.hasOwn(manifest.files, template.from)) report.blockers.push({ type: 'untracked-template', path: template.from, message: 'Recipe source is missing from the legacy hash inventory.' });
        if (destinationFor(template.to) !== template.to) report.warnings.push({ type: 'contract-conflict', path: template.to, message: `Preserved under ${destinationFor(template.to)} for deliberate integration.` });
    }
    report.references = (manifest.references || []).map(reference => ({ id: reference.id, sha256: reference.source?.sha256 ?? null, requiresBinding: true }));
    if (report.references.length) report.warnings.push({ type: 'reference-binding', message: 'Original reference paths are not copied. Bind reference IDs on the destination machine.' });
    try {
        const root = path.join(agentStorageRoot(config), 'harness');
        const receipt = await readJson(root, `packages/${id.name}-v${id.version}.json`);
        report.receipt = { status: receipt.manifestHash === report.manifestHash ? 'matched-historical-receipt' : 'mismatch', manifestHash: receipt.manifestHash };
        if (report.receipt.status === 'mismatch') report.blockers.push({ type: 'receipt-integrity', message: 'The historical receipt disagrees with the manifest.' });
    } catch (error) {
        if (error.code !== 'ENOENT') report.warnings.push({ type: 'receipt-unavailable', message: 'The historical receipt could not be inspected.' });
    }
    report.warnings.push({ type: 'validation-required', message: 'Legacy steps are historical evidence only. Extract methods and review reusable assets separately; old certification is never inherited.' });
    return { id, manifest, recipe, spec, report, bytesByPath };
}

export async function listLegacyTemplates(config) {
    let root;
    try { root = await safeFile(config.workspace, 'packages/harnesses'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const names = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const selectors = [];
    for (const entry of names) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(entry.name)) continue;
        for (const version of await fs.readdir(path.join(root, entry.name), { withFileTypes: true })) {
            if (version.isDirectory() && !version.isSymbolicLink() && /^v[1-9]\d*$/.test(version.name)) selectors.push(`${entry.name}@${version.name.slice(1)}`);
        }
    }
    return selectors.sort();
}

/** Inspect historical packages without writing executable projects. */
export async function migrateLegacy(config, selector, options = {}) {
    if (!selector) {
        const reports = [];
        for (const value of await listLegacyTemplates(config)) {
            try { reports.push((await inspect(config, value)).report); }
            catch (error) { reports.push({ selector: value, blockers: [{ type: 'manifest', message: error.message }], certification: 'not-validated' }); }
        }
        return { command: 'repro:migrate', status: 'dry-run', reports, historyRetained: true };
    }
    const { report } = await inspect(config, selector);
    if (!options.dryRun) throw appError('REPRO_MIGRATION_REQUIRED', 'Legacy project-copy migration is retired. Use dry-run for historical inspection, then explicitly extract a method recipe and reviewed generic assets.', { data: { command: 'repro:migrate', report, historyRetained: true } });
    return { command: 'repro:migrate', status: 'dry-run', report, historyRetained: true };
}

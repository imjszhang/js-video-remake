import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PACKAGE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v\d+$/;
const RUN_ID = /^r_[A-Za-z0-9_-]{1,80}$/;
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const ACTIVITY_STATUSES = new Set(['preparing', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function cleanSummary(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200d\u2060\ufeff⁠]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function parseActivity(text) {
    let data;
    try { data = JSON.parse(text); }
    catch { return null; }
    if (!data || data.schemaVersion !== 1 || !RUN_ID.test(data.runId || '') || !ACTIVITY_STATUSES.has(data.status)) return null;
    if (!TARGET_NAME.test(data.target || '') || Number.isNaN(Date.parse(data.startedAt)) || Number.isNaN(Date.parse(data.updatedAt))) return null;
    const continuedFrom = data.continuedFrom == null ? null : data.continuedFrom;
    if (continuedFrom !== null && !RUN_ID.test(continuedFrom)) return null;
    if (data.instruction != null && typeof data.instruction !== 'string') return null;
    const referenceId = data.referenceId == null || data.referenceId === '' ? null : data.referenceId;
    if (referenceId !== null && (typeof referenceId !== 'string' || !REFERENCE_ID.test(referenceId))) return null;
    const packages = Array.isArray(data.packages)
        ? data.packages.filter(name => typeof name === 'string' && PACKAGE_NAME.test(name)).slice(0, 40)
        : [];
    return {
        schemaVersion: 1, runId: data.runId, status: data.status, target: data.target,
        startedAt: data.startedAt, updatedAt: data.updatedAt, summary: cleanSummary(data.summary),
        instruction: cleanSummary(data.instruction), referenceId,
        continuedFrom, packages,
    };
}

async function productionDirectory(root, dir) {
    if (typeof dir !== 'string' || !dir || path.isAbsolute(dir) || dir.includes('\0') || dir.split(/[\\/]/).includes('..')) return null;
    const absolute = path.resolve(root, dir);
    if (!inside(root, absolute) || absolute === root) return null;
    let current = root;
    for (const part of path.relative(root, absolute).split(path.sep)) {
        current = path.join(current, part);
        let stat;
        try { stat = await fs.lstat(current); }
        catch { return null; }
        if (stat.isSymbolicLink()) return null;
        if (!stat.isDirectory()) return null;
    }
    return absolute;
}

async function videoPackages(directory) {
    let entries;
    try { entries = await fs.readdir(path.join(directory, 'videos'), { withFileTypes: true }); }
    catch { return []; }
    return entries
        .filter(entry => entry.isDirectory() && PACKAGE_NAME.test(entry.name))
        .map(entry => entry.name)
        .sort();
}

export async function readProductionActivity(root, dir) {
    const realRoot = await fs.realpath(root);
    const directory = await productionDirectory(realRoot, dir);
    if (!directory) return null;
    const file = path.join(directory, 'agent-activity.json');
    let stat;
    try { stat = await fs.lstat(file); }
    catch { return null; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return null;
    const real = await fs.realpath(file);
    if (!inside(directory, real)) return null;
    return parseActivity(await fs.readFile(real, 'utf8'));
}

async function writeProductionActivity(root, dir, fields) {
    const realRoot = await fs.realpath(root);
    const directory = await productionDirectory(realRoot, dir);
    if (!directory) return;
    const document = parseActivity(JSON.stringify({ ...fields, schemaVersion: 1, packages: await videoPackages(directory), updatedAt: new Date().toISOString() }));
    if (!document) return;
    const file = path.join(directory, 'agent-activity.json');
    const temporary = path.join(directory, `.agent-activity-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
    await fs.rename(temporary, file);
}

export function createActivityWriter({ root, dir, runId, target, startedAt, continuedFrom = null, instruction = '', referenceId = null }) {
    const safeReference = typeof referenceId === 'string' && REFERENCE_ID.test(referenceId) ? referenceId : null;
    let summary = '';
    let lastWrite = 0;
    let chain = Promise.resolve();
    if (!dir) return { note() {}, update() { return chain; }, finish() { return chain; } };
    const publish = (status, force) => {
        if (!ACTIVITY_STATUSES.has(status)) return chain;
        const now = Date.now();
        if (!force && now - lastWrite < 2000) return chain;
        lastWrite = now;
        chain = chain.then(() => writeProductionActivity(root, dir, {
            runId, status, target, startedAt, summary, instruction, referenceId: safeReference, continuedFrom,
        })).catch(() => {});
        return chain;
    };
    return {
        note(text) { summary = cleanSummary(text); },
        update(status, force = false) { return publish(status, force); },
        finish(status, text) {
            if (text) summary = cleanSummary(text);
            return publish(status, true);
        },
    };
}

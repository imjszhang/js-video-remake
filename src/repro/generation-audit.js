import fs from 'node:fs/promises';
import { snapshotProject, projectPath, safeProjectFile } from './project.js';
import { jsonHash } from './store.js';

const BASELINE_SCHEMA = 'video-remake.generation-baseline@1';
const AUDIT_SCHEMA = 'video-remake.generation-audit@1';
const codeFile = file => /\.(?:html|[cm]?js|jsx|ts|tsx|css)$/i.test(file);
const within = (file, root) => file === root || file.startsWith(`${root}/`);
const cleanCode = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[^]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
const hashRecord = record => jsonHash(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'baselineHash')));
const invalid = message => Object.assign(new Error(message), { code: 'REPRO_INVALID' });

/** A declared permission is not evidence of enforcement. A host probe must record all boundaries. */
export function isolationEvidence(raw = {}) {
    const required = ['outsideReadDenied', 'symlinkEscapeDenied', 'outsideWriteDenied'];
    const filesystemVerified = raw.readIsolation === 'enforced' && raw.probe?.verified === true
        && typeof raw.probe.id === 'string' && raw.probe.id.length > 0
        && required.every(key => raw.probe[key] === true);
    return { ...raw, level: filesystemVerified ? 'restricted-filesystem' : 'context-only',
        readIsolation: filesystemVerified ? 'enforced' : 'unverified', filesystemProbeVerified: filesystemVerified,
        probeVerified: filesystemVerified && raw.probe.networkRestricted === true };
}

/** Capture AFTER task/reference/input installation and BEFORE the first executor call. */
export async function captureGenerationBaseline(workspace, { identity = {}, lockedPaths = [], generatedRoots = ['src'], isolation = {} } = {}) {
    for (const rel of [...lockedPaths, ...generatedRoots]) projectPath(rel);
    const snapshot = await snapshotProject(workspace, { includeInputs: true });
    const implementation = snapshot.files.filter(file => generatedRoots.some(root => within(file.path, root)) && codeFile(file.path));
    const sourceHashes = {};
    for (const file of implementation) sourceHashes[file.path] = jsonHash(cleanCode(await fs.readFile(await safeProjectFile(workspace, file.path), 'utf8')));
    const baseline = { schema: BASELINE_SCHEMA, generationMode: 'method-generation', startingPoint: 'blank-scaffold',
        identity: structuredClone(identity), inventory: snapshot, sourceHashes,
        lockedPaths: [...new Set(lockedPaths)].sort(), generatedRoots: [...new Set(generatedRoots)].sort(),
        isolation: isolationEvidence(isolation), capturedAt: new Date().toISOString() };
    baseline.baselineHash = hashRecord(baseline);
    return baseline;
}

/** Process provenance, not a semantic proof that a model never saw an answer. */
export async function auditGeneration(workspace, { baseline, assisted = false, executionCompleted = false, executionRecords = [] } = {}) {
    if (baseline?.schema !== BASELINE_SCHEMA || baseline.startingPoint !== 'blank-scaffold'
        || baseline.generationMode !== 'method-generation' || baseline.baselineHash !== hashRecord(baseline)) throw invalid('Generation baseline is missing or changed.');
    const current = await snapshotProject(workspace, { includeInputs: true });
    const initial = new Map(baseline.inventory.files.map(file => [file.path, file]));
    const final = new Map(current.files.map(file => [file.path, file]));
    const same = (before, after) => Boolean(before && after && before.sha256 === after.sha256 && before.executable === after.executable);
    const changedFiles = [...new Set([...initial.keys(), ...final.keys()])].filter(file => !same(initial.get(file), final.get(file))).sort();
    const lockedChanges = changedFiles.filter(file => baseline.lockedPaths.some(root => within(file, root)));
    const generatedFiles = [];
    const sourceLeaks = [];
    for (const file of current.files.filter(file => baseline.generatedRoots.some(root => within(file.path, root)) && codeFile(file.path))) {
        const source = cleanCode(await fs.readFile(await safeProjectFile(workspace, file.path), 'utf8'));
        if (source.length >= 32 && jsonHash(source) !== baseline.sourceHashes[file.path]) generatedFiles.push(file.path);
        // Direct reference-media reuse is forbidden in production code. This is intentionally
        // conservative; it catches known literal paths, not obfuscation or every possible leak.
        if (/["'`](?:\.\.?\/)*(?:reference|references)\//i.test(source)) sourceLeaks.push(file.path);
    }
    const referenceHashes = new Set(baseline.inventory.files.filter(file => /^(?:reference|references)\//.test(file.path)
        && /\.(?:png|jpe?g|webp|mp4|mov|webm)$/i.test(file.path)).map(file => file.sha256));
    const copiedReferenceFiles = current.files.filter(file => !initial.has(file.path) && referenceHashes.has(file.sha256)).map(file => file.path);
    const executionIds = [...new Set(executionRecords.filter(record => record?.status === 'completed' && (record.runId || record.id)).map(record => record.runId || record.id))];
    const check = (id, passed, message) => ({ id, passed, message });
    const checks = [
        check('generation:blank-baseline', true, 'Host captured the declared blank scaffold before execution.'),
        check('generation:locked-inputs', lockedChanges.length === 0, lockedChanges.length ? `Frozen files changed: ${lockedChanges.join(', ')}` : 'Frozen task, method, assets and tools are unchanged.'),
        check('generation:implementation', generatedFiles.length > 0, generatedFiles.length ? 'Executor changed implementation code relative to the blank scaffold.' : 'No implementation was generated; notes-only and comment-only changes do not qualify.'),
        check('generation:execution', executionCompleted && executionIds.length > 0, 'Completed executor records must attribute this submission.'),
        check('generation:unassisted', !assisted, assisted ? 'External assistance was recorded.' : 'No external assistance was recorded.'),
        check('generation:reference-reuse', sourceLeaks.length === 0 && copiedReferenceFiles.length === 0, sourceLeaks.length || copiedReferenceFiles.length ? 'Known reference media was reused in output sources.' : 'No direct reference-media reuse was detected by the bounded scan.'),
    ];
    const processVerified = checks.every(item => item.passed);
    const completedRecords = executionRecords.filter(record => record?.status === 'completed' && (record.runId || record.id));
    const observedEnvironments = completedRecords.map(record => isolationEvidence(record.executionEnvironment));
    const isolation = observedEnvironments.length && observedEnvironments.every(item => item.filesystemProbeVerified)
        ? { ...observedEnvironments[0], source: 'per-execution-probes',
            probeVerified: observedEnvironments.every(item => item.probeVerified),
            probes: observedEnvironments.map(item => item.probe) }
        : isolationEvidence(baseline.isolation);
    return { schema: AUDIT_SCHEMA, baselineHash: baseline.baselineHash, sourceTreeHash: current.treeHash,
        passed: processVerified, processVerified, strictIndependent: processVerified && isolation.probeVerified,
        isolation, checks, generatedFiles, changedFiles, lockedChanges, sourceLeaks, copiedReferenceFiles, executionIds,
        limitations: ['Source changes and declarations establish process provenance, not semantic novelty.',
            'Static scans cannot prove absence of hidden implementations, obfuscated reuse or unrecorded reads.',
            ...(isolation.probeVerified ? [] : ['Complete read/network isolation was not proven; see the separate filesystem probe result.'])] };
}

/** Distinguish quality, unassisted execution, generation and enforced isolation in every consumer. */
export function generationQualification(state) {
    const mode = state.generationMode || (state.method || state.generation ? 'method-generation' : state.template ? 'project-replay' : 'legacy-unverified');
    const assisted = state.assisted === true || (state.attempts || []).some(attempt => attempt.assisted === true);
    const audit = state.generationAudit || state.attempts?.at(-1)?.generationAudit;
    const baseline = state.generation || state.attempts?.at(-1)?.generation;
    const processVerified = mode === 'method-generation' && !assisted && audit?.schema === AUDIT_SCHEMA
        && audit.passed === true && audit.processVerified === true && audit.checks?.length > 0
        && audit.checks.every(check => check.passed === true) && baseline?.schema === BASELINE_SCHEMA
        && baseline.baselineHash === hashRecord(baseline) && baseline.baselineHash === audit.baselineHash;
    const strictIndependent = Boolean(processVerified && audit.strictIndependent === true && isolationEvidence(audit.isolation).probeVerified);
    return { mode, assisted, processVerified: Boolean(processVerified), strictIndependent,
        level: assisted ? 'assisted' : mode === 'project-replay' ? 'project-replay' : strictIndependent ? 'verified-isolation' : processVerified ? 'process-audited' : 'unverified' };
}

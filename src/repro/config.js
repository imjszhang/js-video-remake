import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadAgentConfig, selectAgentTarget } from '../agent-config.js';
import { appError } from '../errors.js';

export const ROLES = Object.freeze(['teacher', 'extractor', 'executor', 'reviewer']);
export const DEFAULT_POLICY = Object.freeze({
    maxAttempts: 3, maxCalls: 12, maxDurationMs: 3_600_000,
    maxToolCalls: 200, maxRenderCalls: 20, maxTokens: null,
    maxCostUsd: null, allowTeacherAssistance: false, renderProvider: 'local', reviewSamples: 1, reviewProtocolHash: null,
});
export const STAGED_PROTOCOL = 'video-remake.staged-execution@1';
export const DEFAULT_STAGED_POLICY = Object.freeze({
    ...DEFAULT_POLICY, maxCalls: 48, maxDurationMs: 5_400_000,
    maxToolCalls: 600, maxRenderCalls: 64, reviewSamples: 2,
});
export const DEFAULT_STAGE_EXECUTION = Object.freeze({
    protocol: STAGED_PROTOCOL, feedbackMode: 'independent', maxStageRevisions: 2,
    maxFinalSubmissions: 3, maxPreviewJobs: 48, reviewerTimeoutMs: 600_000, reserveOverheadMs: 120_000,
    prototypeRequirements: Object.freeze(['character-interaction', 'complex-motion']), minPrototypeShots: 2,
});

const invalid = message => appError('CONFIG_INVALID', message);
function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object.`);
    return value;
}
function fields(value, allowed, name) {
    for (const field of Object.keys(value)) if (!allowed.includes(field)) throw invalid(`Unknown ${name} field: ${field}`);
}
function filename(value, root, name) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw invalid(`${name} must be a nonempty path.`);
    return path.resolve(root, value);
}

export function validateWorkflow(value) {
    object(value, 'Reproduction workflow');
    const schemaVersion = value.schemaVersion ?? 1;
    if (![1, 2].includes(schemaVersion)) throw invalid('Workflow schemaVersion must be 1 or 2.');
    fields(value, ['schemaVersion', 'roles', 'policy', 'capabilitiesFile', ...(schemaVersion === 2 ? ['execution'] : [])], 'workflow');
    const roles = { ...object(value.roles ?? {}, 'Workflow roles') };
    fields(roles, ROLES, 'role');
    for (const [role, name] of Object.entries(roles)) {
        if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw invalid(`Role ${role} must reference an Agent target name.`);
    }
    if (roles.extractor === undefined && roles.teacher !== undefined) roles.extractor = roles.teacher;
    const provided = object(value.policy ?? {}, 'Workflow policy');
    fields(provided, Object.keys(DEFAULT_POLICY), 'policy');
    const policy = { ...(schemaVersion === 2 ? DEFAULT_STAGED_POLICY : DEFAULT_POLICY), ...provided };
    for (const key of ['maxAttempts', 'maxCalls', 'maxDurationMs', 'maxToolCalls', 'maxRenderCalls', 'maxTokens']) {
        if (key === 'maxTokens' && policy[key] === null) continue;
        if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw invalid(`policy.${key} must be a positive integer.`);
    }
    if (policy.maxDurationMs < 1000 || policy.maxDurationMs > 86_400_000) throw invalid('policy.maxDurationMs must be between 1000 and 86400000.');
    if (policy.maxCostUsd !== null && (typeof policy.maxCostUsd !== 'number' || !Number.isFinite(policy.maxCostUsd) || policy.maxCostUsd <= 0)) throw invalid('policy.maxCostUsd must be a positive number or null.');
    if (typeof policy.allowTeacherAssistance !== 'boolean') throw invalid('policy.allowTeacherAssistance must be boolean.');
    if (!['local', 'agent'].includes(policy.renderProvider)) throw invalid('policy.renderProvider must be local or agent.');
    if (![1, 2].includes(policy.reviewSamples)) throw invalid('policy.reviewSamples must be 1 or 2.');
    if (policy.reviewProtocolHash !== null && !/^[a-f0-9]{64}$/.test(policy.reviewProtocolHash)) throw invalid('policy.reviewProtocolHash must be a SHA256 or null.');
    if (value.capabilitiesFile !== undefined && (typeof value.capabilitiesFile !== 'string' || !value.capabilitiesFile.trim() || value.capabilitiesFile.includes('\0'))) throw invalid('capabilitiesFile must be a nonempty local configuration path.');
    let execution;
    if (schemaVersion === 2) {
        const supplied = object(value.execution ?? {}, 'Workflow execution');
        fields(supplied, Object.keys(DEFAULT_STAGE_EXECUTION), 'execution');
        execution = { ...DEFAULT_STAGE_EXECUTION, ...supplied };
        execution.maxFinalSubmissions = supplied.maxFinalSubmissions ?? provided.maxAttempts ?? DEFAULT_STAGE_EXECUTION.maxFinalSubmissions;
        if (provided.maxAttempts !== undefined && supplied.maxFinalSubmissions !== undefined && provided.maxAttempts !== supplied.maxFinalSubmissions) throw invalid('policy.maxAttempts and execution.maxFinalSubmissions must agree when both are supplied.');
        policy.maxAttempts = execution.maxFinalSubmissions;
        if (execution.protocol !== STAGED_PROTOCOL) throw invalid(`execution.protocol must be ${STAGED_PROTOCOL}.`);
        if (!['independent', 'guided'].includes(execution.feedbackMode)) throw invalid('execution.feedbackMode must be independent or guided.');
        for (const key of ['maxStageRevisions', 'maxFinalSubmissions', 'maxPreviewJobs', 'reviewerTimeoutMs', 'minPrototypeShots']) {
            if (!Number.isSafeInteger(execution[key]) || execution[key] < 1) throw invalid(`execution.${key} must be a positive integer.`);
        }
        if (!Number.isSafeInteger(execution.reserveOverheadMs) || execution.reserveOverheadMs < 0) throw invalid('execution.reserveOverheadMs must be a nonnegative integer.');
        if (execution.reviewerTimeoutMs < 1000 || execution.reviewerTimeoutMs > 86_400_000) throw invalid('execution.reviewerTimeoutMs must be between 1000 and 86400000.');
        if (execution.maxFinalSubmissions > 5) throw invalid('execution.maxFinalSubmissions must not exceed 5.');
        if (execution.minPrototypeShots > 20) throw invalid('execution.minPrototypeShots must not exceed 20.');
        if (!Array.isArray(execution.prototypeRequirements) || execution.prototypeRequirements.length > 20
            || execution.prototypeRequirements.some(tag => typeof tag !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(tag))
            || new Set(execution.prototypeRequirements).size !== execution.prototypeRequirements.length) throw invalid('execution.prototypeRequirements must be a unique list of safe risk tags.');
        execution.prototypeRequirements = [...execution.prototypeRequirements];
        if (policy.reviewSamples !== 2) throw invalid('Staged execution requires two complete reviews.');
        if (execution.feedbackMode === 'independent' && policy.allowTeacherAssistance) throw invalid('Independent staged execution cannot allow teacher assistance.');
        if (policy.maxCalls < 3 || policy.maxDurationMs < execution.reviewerTimeoutMs * 2 + execution.reserveOverheadMs + 1000) {
            throw invalid('Staged budget must reserve two reviewer calls and time, host rendering/evidence, and at least one execution.');
        }
    }
    return { schemaVersion, roles, policy, ...(execution ? { execution } : {}), ...(value.capabilitiesFile === undefined ? {} : { capabilitiesFile: value.capabilitiesFile }) };
}

/** Explicit opt-in for new generation. Reading a v1 file never silently upgrades it. */
export function createStagedWorkflow(value = {}) {
    const selected = Object.fromEntries(['roles', 'policy', 'capabilitiesFile', 'execution'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    // A caller upgrading a normalized v1 workflow must intentionally choose its
    // policy; otherwise its old 1-vote/short-budget defaults remain observable.
    return validateWorkflow({ ...selected, schemaVersion: 2 });
}

/** Workflow files contain role references and policies, never credential values. */
export async function loadWorkflow(config, { workflowPath, configPath, allowMissing = true } = {}) {
    const env = config.env || process.env;
    const explicit = workflowPath ?? env.VIDEO_REMAKE_REPRO_WORKFLOW;
    const selectedPath = filename(explicit ?? 'reproduction-workflow.json', config.workspace, 'Workflow path');
    let raw;
    try {
        const stat = await fs.lstat(selectedPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw invalid('Workflow must be a regular JSON file smaller than 256 KiB.');
        raw = JSON.parse(await fs.readFile(selectedPath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' && explicit === undefined && allowMissing) raw = {};
        else if (error.code === 'CONFIG_INVALID') throw error;
        else throw invalid(`Cannot read reproduction workflow: ${selectedPath}`);
    }
    return { ...validateWorkflow(raw), workflowPath: selectedPath, ...(configPath === undefined ? {} : { agentConfig: filename(configPath, config.workspace, 'Agent configuration path') }) };
}

export function targetContext(target) {
    const native = target.harness.contextMode === 'project';
    const limitations = [];
    if (!native) limitations.push('Project instructions and Skill entry files are supplied as explicit context; native project discovery is not claimed.');
    if (native && target.harness.adapter === 'claude-code') limitations.push('Claude native project mode can also load user settings and installed skills; it is not a project-only allowlist.');
    limitations.push('Workspace write permissions are supplied by the native Harness, not an OS container managed by video-remake.');
    return { contextMode: native ? 'native-project' : 'explicit-context', limitations };
}

export async function resolveRole(config, workflow, role, { target: override, agentConfig, requireEnabled = true } = {}) {
    if (!ROLES.includes(role)) throw invalid(`Unknown reproduction role: ${role}`);
    const selected = override ?? workflow?.roles?.[role] ?? (role === 'extractor' ? workflow?.roles?.teacher : undefined);
    if (!selected) throw invalid(`No target configured for reproduction role "${role}". Set roles.${role} in reproduction-workflow.json or pass --target.`);
    const settings = await loadAgentConfig(config, { configPath: agentConfig ?? workflow?.agentConfig });
    const { target, enabled } = selectAgentTarget(settings, selected, { requireEnabled });
    if (target.harness.permission === 'bypass') throw invalid('Reproduction runs cannot use bypass permission. Choose a workspace-write or read-only target.');
    const targetHash = createHash('sha256').update(JSON.stringify(target)).digest('hex');
    return { role, target, targetHash, enabled, settings, ...targetContext(target) };
}

/** Budgets are cumulative counters owned and persisted by the workflow. */
export function remainingBudget(policy, consumed = {}) {
    const elapsedMs = consumed.elapsedMs ?? 0;
    const exhausted = [];
    for (const [counter, limit] of [['calls', 'maxCalls'], ['toolCalls', 'maxToolCalls'], ['renderCalls', 'maxRenderCalls'], ['tokens', 'maxTokens'], ['costUsd', 'maxCostUsd']]) {
        if (policy[limit] !== null && policy[limit] !== undefined && typeof consumed[counter] === 'number' && consumed[counter] >= policy[limit]) exhausted.push(counter);
    }
    const remainingMs = Math.max(0, policy.maxDurationMs - elapsedMs);
    if (remainingMs < 1000) exhausted.push('time');
    return { exhausted, remainingMs, policy, consumed };
}

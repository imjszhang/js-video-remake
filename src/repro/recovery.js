import os from 'node:os';
import { appError } from '../errors.js';
import { projectAgentStatus } from './runner.js';
import { emptyBudget, chargeBudget, settleBudgetReservation } from './budget.js';
import { snapshotProject } from './project.js';
import { auditGeneration } from './generation-audit.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exhausted']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function dead(owner) {
    if (!owner || owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
}

function appendUnique(list, agent) {
    const values = list || [];
    if (!values.some(value => (value.runId || value.id) === agent.runId)) values.push(agent);
    return values;
}

function reconcileRender(state) {
    const active = state.activeRender;
    if (!active || !dead(active.owner)) return { changed: false, state };
    // The controlling CLI may have died while its detached renderer still runs.
    // Recovery observes the child only; cancellation belongs to its live owner.
    if (active.pid !== undefined && active.pid !== null && !dead({ hostname: active.owner.hostname, pid: active.pid })) return { changed: false, state };
    if (typeof active.id !== 'string' || !active.id || !state.attempts?.at(-1)) throw appError('REPRO_RECOVERY_INVALID', 'Interrupted render has no reliable ID or prepared attempt.');
    const attempt = state.attempts.at(-1);
    const recoveredAt = new Date().toISOString();
    const record = { id: active.id, provider: active.provider || 'local-hyperframes', status: 'interrupted',
        startedAt: active.startedAt ?? null, elapsedMs: finite(active.elapsedMs) ? active.elapsedMs : null,
        elapsedComplete: false, recovered: true, recoveredAt,
        error: 'Render owner and child exited before a terminal result was persisted.' };
    if (!(attempt.renders || []).some(render => render.id === active.id)) attempt.renders = [...(attempt.renders || []), record];
    // Render calls were reserved before launch. No extra call or offline wall
    // time is charged here, and completed maker work remains reusable.
    state.budget ||= emptyBudget();
    state.budget.elapsedComplete = false;
    state.status = 'interrupted';
    delete state.review; delete state.reviewSource;
    state.interruptions = [...(state.interruptions || []), { renderId: active.id, role: 'renderer', recoveredAt,
        recordedStatus: active.status || 'running', accountingComplete: false }];
    delete state.activeRender;
    return { changed: true, state };
}

const STAGE_COUNTERS = ['calls', 'elapsedMs', 'toolCalls', 'renderCalls', 'previewJobs', 'tokens', 'costUsd'];
const STAGE_FLAGS = ['callsComplete', 'elapsedComplete', 'toolCallsComplete', 'renderCallsComplete', 'previewJobsComplete', 'usageComplete', 'costComplete'];
const recoveryError = message => appError('REPRO_RECOVERY_INVALID', message);
function childAlive(operation, owner) {
    const pid = operation?.process?.pid ?? operation?.pid;
    return pid !== undefined && pid !== null && !dead({ hostname: operation?.process?.hostname || owner?.hostname, pid });
}
function retainReview(state, at) {
    if (state.review) state.reviewHistory = [...(state.reviewHistory || []), { review: state.review, source: state.reviewSource, at, reason: 'interrupted-operation' }];
    delete state.review; delete state.reviewSource;
}
function staleStageEvidence(state, reason, stageId) {
    for (const stage of state.stageState.stages) {
        if (stage.id === 'freeze' || stage.id === stageId) continue;
        if (['complete', 'evidence-complete'].includes(stage.status) || stage.pendingPreview) { stage.status = 'stale'; stage.staleReason = reason; }
        delete stage.pendingPreview;
    }
    const episodeId = state.stageState.currentEpisodeId || state.stageState.episodeId;
    for (const submission of state.stageSubmissions || []) if (submission.episodeId === episodeId && submission.status === 'evidence-complete') { submission.status = 'stale'; submission.staleReason = reason; }
    delete state.technical;
}

/** A stage receipt and a recovered workspace are evidence, never a completed stage. */
async function reconcileStaged(config, state, deps) {
    const operation = state.activeOperation;
    const render = state.activeRender;
    const id = state.activeAgentRunId || operation?.agentRunId;
    if (!operation && !render && !id) return { changed: false, state };
    const owners = [state.executionOwner, operation?.owner, render?.owner].filter(Boolean);
    if (owners.some(owner => !dead(owner))) return { changed: false, state };
    if (childAlive(operation, operation?.owner) || childAlive(render, render?.owner)) return { changed: false, state };
    let agent;
    if (id) {
        try { agent = await (deps.projectAgentStatus || projectAgentStatus)(config, id); }
        catch (error) {
            if (error.code !== 'ENOENT' || !owners.some(dead)) throw error;
            agent = { id, runId: id, status: 'interrupted', owner: owners[0], elapsedMs: 0, usage: null, cost: null, toolCalls: null, renderCalls: null,
                error: 'Owner exited before an Agent receipt was persisted.' };
        }
        if ((agent.runId || agent.id) !== id) throw recoveryError('Staged Agent receipt does not match the active run.');
        if (agent.owner && !dead(agent.owner)) return { changed: false, state };
    }
    if (!owners.some(dead) && !dead(agent?.owner)) return { changed: false, state };
    const role = state.activeRole || agent?.role || (operation?.kind === 'final-review' ? 'reviewer' : null);
    if (id && !['teacher', 'executor', 'reviewer', 'extractor'].includes(role)) throw recoveryError('Interrupted staged run has no reliable role.');
    const stageId = operation?.stageId || state.stageState.currentStage;
    if (!state.stageState.stages.some(stage => stage.id === stageId && stage.id !== 'freeze')) throw recoveryError('Interrupted staged operation has no valid stage.');
    const maker = ['teacher', 'executor'].includes(role) || ['stage-production', 'stage-self-check'].includes(operation?.kind);
    const execution = maker ? state.stageExecutions?.findLast(item => operation?.executionId ? item.id === operation.executionId
        : (item.agentRunId || item.agent?.runId) === id && Boolean(id) || item.stageId === stageId && !item.finishedAt) : null;
    // stageOperation persists its reservation before executeMaker appends the
    // execution. An owner can die in that gap without launching a model call.
    const unstartedMaker = maker && !execution && !id && !state.activeRole
        && finite(operation?.budgetBefore?.calls) && operation.budgetBefore.calls === state.budget?.calls;
    if (maker && !execution && !unstartedMaker) throw recoveryError('Interrupted staged maker has no prepared stage execution.');
    if (operation && !state.budgetLedger?.reservations?.some(entry => entry.operationId === operation.id)) throw recoveryError('Interrupted stage operation has no budget reservation.');

    // Prepare changes on a copy so corrupt receipts cannot partly update counters.
    const next = structuredClone(state);
    const recoveredAt = new Date().toISOString();
    const stage = next.stageState.stages.find(item => item.id === stageId);
    const entry = execution && next.stageExecutions.find(item => item.id === execution.id);
    let snapshot, snapshotError, lockedChanges = [];
    try {
        const audit = await (deps.auditGeneration || auditGeneration)(next.workspace, { baseline: next.generation });
        lockedChanges = audit.lockedChanges;
        if (!Array.isArray(lockedChanges)) throw recoveryError('Frozen-input audit is incomplete.');
        snapshot = await (deps.snapshotProject || snapshotProject)(next.workspace, { includeInputs: true });
        if (!snapshot?.treeHash) throw recoveryError('Recovered workspace has no source hash.');
    } catch (error) { snapshotError = error.message; }
    const previousHash = next.stageCheckpoint?.snapshot?.treeHash;
    const recordedHash = entry?.sourceSnapshotAfter?.treeHash || previousHash;
    const sourceChanged = Boolean(snapshot && snapshot.treeHash !== previousHash);
    const unverifiedSource = Boolean(snapshot && snapshot.treeHash !== recordedHash);
    if (snapshot && !snapshotError && !lockedChanges.length) {
        next.stageCheckpoint = { snapshot, at: recoveredAt, stageId, ...(entry ? { executionId: entry.id } : {}), reason: 'owner-exit-recovery', interrupted: true,
            verified: !unverifiedSource && next.stageCheckpoint?.verified !== false, attribution: unverifiedSource ? 'unverified-after-owner-exit' : 'persisted-snapshot-match' };
        if (unverifiedSource) next.assisted = true;
        if (entry) entry.recoveredSnapshot = snapshot;
    } else {
        if (next.stageCheckpoint) next.checkpointHistory = [...(next.checkpointHistory || []), next.stageCheckpoint];
        delete next.stageCheckpoint;
        next.assisted = true;
    }
    if (sourceChanged || snapshotError || lockedChanges.length) staleStageEvidence(next, 'Workspace changed across an interrupted operation; fresh host evidence is required.', stageId);
    if (sourceChanged || snapshotError || lockedChanges.length) delete stage.pendingPreview;
    next.budget ||= emptyBudget();
    let record;
    const wasTerminal = agent && TERMINAL.has(agent.status);
    if (agent) {
        record = { ...agent, runId: id, recovered: true, recoveredAt };
        if (!wasTerminal) { record.status = 'interrupted'; record.usage = null; record.cost = null; record.elapsedComplete = false; }
        const charged = new Set(next.chargedAgentRunIds || []);
        if (!charged.has(id)) {
            const elapsedMs = wasTerminal && finite(agent.execution?.durationMs) ? agent.execution.durationMs : finite(agent.elapsedMs) ? agent.elapsedMs : 0;
            chargeBudget(next.budget, record, elapsedMs);
            if (!wasTerminal || !finite(agent.execution?.durationMs) && !finite(agent.elapsedMs)) next.budget.elapsedComplete = false;
            charged.add(id);
        }
        next.chargedAgentRunIds = [...charged];
        next.agentRuns = appendUnique(next.agentRuns, record);
        if (role === 'reviewer') next.reviewRuns = appendUnique(next.reviewRuns, record);
        if (role === 'extractor') next.extractionRuns = appendUnique(next.extractionRuns, record);
    }
    if (entry) {
        if (record) { entry.agent = record; entry.agentRunId = id; }
        entry.status = 'interrupted'; entry.recoveredAt = recoveredAt; entry.finishedAt ||= recoveredAt;
        entry.error = { code: 'REPRO_INTERRUPTED', message: 'Maker receipt recovered; stage observations and host checks still require controlled completion.' };
    }
    if (!record || !wasTerminal) { next.budget.elapsedComplete = false; next.budget.toolCallsComplete = false; next.budget.renderCallsComplete = false; }
    if (operation) {
        const reservation = next.budgetLedger.reservations.find(item => item.operationId === operation.id);
        if (['reserved', 'active'].includes(reservation.status)) {
            const baseline = operation.budgetBefore;
            const actual = baseline ? Object.fromEntries(STAGE_COUNTERS.filter(key => finite(baseline[key]) && finite(next.budget[key]))
                .map(key => [key, Math.max(0, next.budget[key] - baseline[key])])) : {};
            const accounting = Object.fromEntries(STAGE_FLAGS.map(flag => [flag, Boolean(baseline) && next.budget[flag] !== false]));
            // Never turn offline wall time or a reservation into measured use.
            if (!record || !wasTerminal) for (const flag of STAGE_FLAGS.filter(flag => flag !== 'callsComplete')) accounting[flag] = false;
            settleBudgetReservation(next.budgetLedger, operation.id, { actual, receiptId: operation.id, status: 'interrupted', accounting, at: recoveredAt });
        }
        if (!(next.operationHistory || []).some(item => item.id === operation.id)) next.operationHistory = [...(next.operationHistory || []), { ...operation, status: 'interrupted', recovered: true, finishedAt: recoveredAt }];
    }
    if (render) {
        const renderRecord = { ...render, status: 'interrupted', recovered: true, recoveredAt, elapsedComplete: false };
        next.stageRenderRuns = [...(next.stageRenderRuns || []), renderRecord];
        const attempt = next.attempts?.at(-1);
        if (attempt && !(attempt.renders || []).some(item => item.id === render.id)) attempt.renders = [...(attempt.renders || []), renderRecord];
    }
    stage.status = snapshotError || lockedChanges.length ? 'blocked' : 'interrupted';
    stage.recovery = { at: recoveredAt, operationId: operation?.id ?? null, agentRunId: id ?? null, sourceChanged, ...(unstartedMaker ? { modelCallStarted: false } : {}), sourceAttribution: next.stageCheckpoint?.attribution ?? 'unverified',
        frozenInputsUnchanged: !snapshotError && lockedChanges.length === 0, lockedChanges, ...(snapshotError ? { error: snapshotError } : {}) };
    stage.error = { code: 'REPRO_INTERRUPTED', message: 'Owner exited; recovery preserved receipts and work without accepting this stage.' };
    next.stageState.currentStage = stageId; next.status = 'interrupted';
    retainReview(next, recoveredAt);
    next.interruptions = [...(next.interruptions || []), { runId: id ?? null, operationId: operation?.id ?? null, stageId, role: role || 'host', recoveredAt,
        recordedStatus: agent?.status || 'running', accountingComplete: Boolean(wasTerminal && operation?.budgetBefore && next.budget.elapsedComplete && next.budget.toolCallsComplete && next.budget.renderCallsComplete && next.budget.usageComplete && next.budget.costComplete) }];
    delete next.activeAgentRunId; delete next.activeRole; delete next.executionOwner; delete next.activeOperation; delete next.activeRender;
    for (const key of Object.keys(state)) if (!Object.hasOwn(next, key)) delete state[key];
    Object.assign(state, next);
    return { changed: true, state };
}

/**
 * Reconcile only demonstrably dead execution owners. The caller must hold the
 * production lock and atomically persist the returned state before retrying.
 * This never resumes a session or infers successful artifact acceptance.
 */
export async function reconcileInterruptedRun(config, state, deps = {}) {
    if (state.stageState) return reconcileStaged(config, state, deps);
    if (!state.activeAgentRunId) return reconcileRender(state);
    const id = state.activeAgentRunId;
    if (state.executionOwner && !dead(state.executionOwner)) return { changed: false, state };
    let agent;
    try { agent = await (deps.projectAgentStatus || projectAgentStatus)(config, id); }
    catch (error) {
        if (error.code !== 'ENOENT' || !dead(state.executionOwner)) throw error;
        // The process can die after reserving a call but before writing run.json.
        agent = { runId: id, id, status: 'interrupted', owner: state.executionOwner, usage: null, cost: null,
            elapsedMs: 0, toolCalls: null, renderCalls: null,
            error: 'Execution owner exited before a complete Agent record was persisted.' };
    }
    if ((agent.runId || agent.id) !== id) throw appError('REPRO_RECOVERY_INVALID', 'Interrupted Agent record does not match the active run.');
    // Even when the caller died, a live independently owned worker must finish
    // normally; never recover/overwrite its accounting while it is still active.
    if (agent.owner && !dead(agent.owner)) return { changed: false, state };
    if (!dead(state.executionOwner || agent.owner)) return { changed: false, state };
    const role = state.activeRole || agent.role;
    if (!['teacher', 'executor', 'reviewer', 'extractor'].includes(role)) throw appError('REPRO_RECOVERY_INVALID', 'Interrupted run has no reliable role; inspect its record before recovery.');
    const attempt = state.attempts?.at(-1);
    if (['teacher', 'executor'].includes(role) && !attempt) throw appError('REPRO_RECOVERY_INVALID', 'Interrupted execution has no prepared attempt.');
    const record = { ...agent, runId: id, recovered: true, recoveredAt: new Date().toISOString() };
    const wasTerminal = TERMINAL.has(agent.status);
    if (!wasTerminal) {
        record.status = 'interrupted';
        record.usage = null;
        record.cost = null;
        record.error ||= 'Execution owner exited before terminal completion was recorded.';
    }
    const charged = new Set(state.chargedAgentRunIds || []);
    state.budget ||= emptyBudget();
    if (!charged.has(id)) {
        // A persisted live elapsed value is a lower bound. Do not use wall-clock
        // time since startedAt: that includes offline time after a hard crash.
        const elapsedMs = wasTerminal && finite(agent.execution?.durationMs) ? agent.execution.durationMs
            : finite(agent.elapsedMs) ? agent.elapsedMs : 0;
        chargeBudget(state.budget, record, elapsedMs);
        if (!wasTerminal || !finite(agent.elapsedMs)) state.budget.elapsedComplete = false;
        if (!finite(agent.toolCalls)) state.budget.toolCallsComplete = false;
        if (!finite(agent.renderCalls)) state.budget.renderCallsComplete = false;
        if (!wasTerminal) { state.budget.usageComplete = false; state.budget.costComplete = false; }
        charged.add(id);
    }
    state.chargedAgentRunIds = [...charged];
    state.agentRuns = appendUnique(state.agentRuns, record);
    if (role === 'reviewer') {
        state.reviewRuns = appendUnique(state.reviewRuns, record);
        delete state.review; delete state.reviewSource;
        state.status = 'external-review';
    } else if (role === 'extractor') {
        state.extractionRuns = appendUnique(state.extractionRuns, record);
        // A failed extraction does not invalidate the previously accepted
        // teacher artifact. No template or extraction success is synthesized.
    } else {
        attempt.agents = appendUnique(attempt.agents, record);
        attempt.executionCompleted = false;
        attempt.error = { code: 'REPRO_INTERRUPTED', message: 'Execution owner exited. The recorded result requires a new controlled execution and external acceptance.' };
        state.status = 'interrupted';
        delete state.review; delete state.reviewSource;
    }
    state.interruptions = [...(state.interruptions || []), { runId: id, role, recoveredAt: record.recoveredAt, recordedStatus: agent.status, accountingComplete: wasTerminal && state.budget.usageComplete && state.budget.costComplete }];
    delete state.activeAgentRunId; delete state.activeRole; delete state.executionOwner;
    return { changed: true, state };
}

import { appError } from '../errors.js';

const LEDGER_SCHEMA = 'video-remake.budget-ledger@1';
const COUNTERS = Object.freeze(['calls', 'elapsedMs', 'toolCalls', 'renderCalls', 'previewJobs', 'tokens', 'costUsd']);
const LIMITS = Object.freeze({ calls: 'maxCalls', elapsedMs: 'maxDurationMs', toolCalls: 'maxToolCalls', renderCalls: 'maxRenderCalls', previewJobs: 'maxPreviewJobs', tokens: 'maxTokens', costUsd: 'maxCostUsd' });
const badLedger = message => appError('REPRO_INVALID', message);
const exhausted = message => appError('REPRO_BUDGET_EXHAUSTED', message);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function counts(raw = {}, label = 'budget') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badLedger(`${label} must be an object.`);
    for (const key of Object.keys(raw)) if (!COUNTERS.includes(key)) throw badLedger(`Unknown ${label} counter: ${key}`);
    return Object.fromEntries(COUNTERS.map(key => {
        const value = Object.hasOwn(raw, key) ? raw[key] : 0;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'costUsd' && !Number.isSafeInteger(value))) throw badLedger(`${label}.${key} must be a nonnegative ${key === 'costUsd' ? 'number' : 'integer'}.`);
        return [key, value];
    }));
}
function operationId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw badLedger('Budget operation ID must be a safe identifier.');
    return value;
}
function ledgerEntries(ledger) {
    if (ledger?.schema !== LEDGER_SCHEMA || !Array.isArray(ledger.reservations)) throw badLedger('Invalid budget ledger.');
    const seen = new Set();
    for (const entry of ledger.reservations) {
        operationId(entry?.operationId);
        if (seen.has(entry.operationId) || !['reserved', 'active', 'settled', 'released'].includes(entry.status)) throw badLedger('Duplicate or invalid reservation record.');
        counts(entry.amount, 'reservation'); counts(entry.holdback, 'holdback');
        seen.add(entry.operationId);
    }
    return ledger.reservations;
}
function entryFor(ledger, id) {
    operationId(id);
    const entry = ledgerEntries(ledger).find(item => item.operationId === id);
    if (!entry) throw badLedger(`No budget reservation for ${id}.`);
    return entry;
}

/** Persist this alongside the run under its lock; this module performs no I/O. */
export function createBudgetLedger() { return { schema: LEDGER_SCHEMA, reservations: [] }; }

/** The caller supplies policy + execution limits; unknown limits remain uncapped. */
export function availableStageBudget(policy, used = {}, ledger = createBudgetLedger(), { holdback = {}, excludeOperationId } = {}) {
    const reserved = counts(holdback, 'holdback');
    for (const entry of ledgerEntries(ledger)) {
        if (entry.operationId === excludeOperationId || !['reserved', 'active'].includes(entry.status)) continue;
        const amount = counts(entry.amount, 'reservation');
        for (const key of COUNTERS) reserved[key] += amount[key];
    }
    const available = {};
    for (const key of COUNTERS) {
        const consumed = used[key] ?? 0;
        if (typeof consumed !== 'number' || !Number.isFinite(consumed) || consumed < 0) throw badLedger(`Invalid consumed ${key}.`);
        const limit = policy?.[LIMITS[key]];
        if (limit !== null && limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) throw badLedger(`Invalid limit ${LIMITS[key]}.`);
        available[key] = limit == null ? null : Math.max(0, limit - consumed - reserved[key]);
    }
    // Direct counter fields are convenient for schedulers; `available` also
    // keeps the complete allocation view explicit in status/report consumers.
    return { ...available, available, reserved, timeoutMs: available.elapsedMs };
}

/** Reserve BEFORE launching; amount and mandatory future holdback must both fit. */
export function reserveBudget(ledger, { operationId: id, kind, policy, used = {}, amount, holdback = {}, at = new Date().toISOString() }) {
    operationId(id);
    if (typeof kind !== 'string' || !kind.trim()) throw badLedger('Reservation kind is required.');
    const request = counts(amount, 'amount');
    const reserve = counts(holdback, 'holdback');
    const entries = ledgerEntries(ledger);
    const existing = entries.find(item => item.operationId === id);
    if (existing) {
        if (existing.kind !== kind || canonical(existing.amount) !== canonical(request) || canonical(existing.holdback) !== canonical(reserve)) throw badLedger('An operation ID cannot be reused with a different budget request.');
        return existing;
    }
    // Check un-clamped quantities as well: a zero-size request cannot conceal a
    // holdback which already exceeds the remaining allowance.
    const pending = counts(reserve);
    for (const entry of entries.filter(item => ['reserved', 'active'].includes(item.status))) {
        const allocation = counts(entry.amount, 'reservation');
        for (const key of COUNTERS) pending[key] += allocation[key];
    }
    for (const key of COUNTERS) {
        const consumed = used[key] ?? 0;
        const limit = policy?.[LIMITS[key]];
        if (typeof consumed !== 'number' || !Number.isFinite(consumed) || consumed < 0) throw badLedger(`Invalid consumed ${key}.`);
        if (limit != null && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) throw badLedger(`Invalid limit ${LIMITS[key]}.`);
        if (limit != null && consumed + pending[key] + request[key] > limit) throw exhausted(`阶段预算不足，需保留后续必需工作: ${LIMITS[key]}`);
    }
    const entry = { operationId: id, kind, status: 'reserved', amount: request, holdback: reserve, reservedAt: at };
    entries.push(entry);
    return entry;
}

export function startBudgetReservation(ledger, id, { at = new Date().toISOString() } = {}) {
    const entry = entryFor(ledger, id);
    if (entry.status === 'active') return entry;
    if (entry.status !== 'reserved') throw badLedger('Only an unstarted reservation can start.');
    entry.status = 'active'; entry.startedAt = at;
    return entry;
}

/**
 * Settlement releases the hold, records actual use, and NEVER charges state.budget.
 * The workflow atomically persists its existing idempotent runtime accounting and
 * this receipt together. This avoids charging callAgent a second time.
 */
export function settleBudgetReservation(ledger, id, { actual = {}, receiptId = id, status = 'completed', accounting = {}, at = new Date().toISOString() } = {}) {
    const entry = entryFor(ledger, id);
    if (!['completed', 'failed', 'cancelled', 'timed_out', 'budget_exhausted', 'interrupted'].includes(status)) throw badLedger('Unknown budget settlement status.');
    operationId(receiptId);
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw badLedger('Actual counters must be an object.');
    for (const key of Object.keys(actual)) if (!COUNTERS.includes(key)) throw badLedger(`Unknown actual counter: ${key}`);
    const knownActual = Object.fromEntries(Object.entries(actual).filter(([, value]) => value !== null && value !== undefined));
    const measured = counts(knownActual, 'actual');
    if (!accounting || typeof accounting !== 'object' || Array.isArray(accounting) || Object.values(accounting).some(v => typeof v !== 'boolean')) throw badLedger('Accounting completeness flags must be booleans.');
    const flags = { calls: 'callsComplete', elapsedMs: 'elapsedComplete', toolCalls: 'toolCallsComplete', renderCalls: 'renderCallsComplete', previewJobs: 'previewJobsComplete', tokens: 'usageComplete', costUsd: 'costComplete' };
    for (const flag of Object.keys(accounting)) if (!Object.values(flags).includes(flag)) throw badLedger(`Unknown accounting completeness flag: ${flag}`);
    const completeness = Object.fromEntries(Object.entries(flags).map(([counter, flag]) => [flag, Object.hasOwn(knownActual, counter) && accounting[flag] !== false]));
    const receipt = { receiptId, actual: measured, resultStatus: status, accounting: completeness };
    if (entry.status === 'settled') {
        if (canonical(entry.receipt) !== canonical(receipt)) throw badLedger('A settled operation cannot acquire a different receipt.');
        return entry;
    }
    if (!['reserved', 'active'].includes(entry.status)) throw badLedger('A released reservation cannot be settled.');
    if (ledgerEntries(ledger).some(other => other !== entry && other.receipt?.receiptId === receiptId)) throw badLedger('A runtime receipt cannot settle two operations.');
    entry.status = 'settled'; entry.receipt = receipt; entry.settledAt = at;
    return entry;
}

export function releaseBudgetReservation(ledger, id, { reason = 'cancelled-before-start', at = new Date().toISOString() } = {}) {
    const entry = entryFor(ledger, id);
    if (entry.status === 'released') {
        if (entry.releaseReason !== reason) throw badLedger('A released operation cannot change reason.');
        return entry;
    }
    if (entry.status !== 'reserved') throw badLedger('Started work must be settled from a receipt, not silently released.');
    if (typeof reason !== 'string' || !reason.trim()) throw badLedger('Release reason is required.');
    entry.status = 'released'; entry.releaseReason = reason; entry.releasedAt = at;
    return entry;
}

/** Keep all outstanding valid votes affordable, including during invalid-report retries. */
export function finalReviewReserve(workflow, { remainingVotes = 2, includeRender = true, includeEvidence = true } = {}) {
    if (!Number.isSafeInteger(remainingVotes) || remainingVotes < 0 || remainingVotes > 2) throw badLedger('Remaining review votes must be 0, 1, or 2.');
    const timeout = workflow?.execution?.reviewerTimeoutMs ?? 600_000;
    const overhead = workflow?.execution?.reserveOverheadMs ?? 120_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || !Number.isSafeInteger(overhead) || overhead < 0) throw badLedger('Invalid final review reservation settings.');
    return counts({ calls: remainingVotes, elapsedMs: remainingVotes * timeout + ((includeRender || includeEvidence) ? overhead : 0), renderCalls: includeRender ? 1 : 0 });
}

export function emptyBudget() {
    return { calls: 0, elapsedMs: 0, toolCalls: 0, renderCalls: 0, tokens: 0, costUsd: 0,
        usageComplete: true, costComplete: true, elapsedComplete: true, toolCallsComplete: true, renderCallsComplete: true };
}
export function remainingBudget(policy, used = emptyBudget()) {
    const limits = [ ['maxCalls','calls'], ['maxDurationMs','elapsedMs'], ['maxToolCalls','toolCalls'], ['maxRenderCalls','renderCalls'], ['maxTokens','tokens'], ['maxCostUsd','costUsd'] ];
    for (const [limit, count] of limits) {
        if (policy[limit] != null && used[count] >= policy[limit]) throw appError('REPRO_BUDGET_EXHAUSTED', `任务预算已用尽: ${limit}`);
    }
    return { ...used, timeoutMs: Math.max(0, policy.maxDurationMs - used.elapsedMs), limits: policy };
}
export function chargeBudget(used, agent, elapsedMs) {
    const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const elapsed = known(elapsedMs) ? elapsedMs : known(agent?.elapsedMs) ? agent.elapsedMs : null;
    if (elapsed !== null) used.elapsedMs += elapsed; else used.elapsedComplete = false;
    if (agent?.elapsedComplete === false) used.elapsedComplete = false;
    const usage = agent?.usage;
    const tokens = usage?.totalTokens ?? (known(usage?.inputTokens) && known(usage?.outputTokens) ? usage.inputTokens + usage.outputTokens : null);
    if (known(tokens)) used.tokens += tokens; else used.usageComplete = false;
    const cost = agent?.costUsd ?? agent?.cost?.usd ?? (agent?.cost?.currency === 'USD' ? agent.cost.total : agent?.cost);
    if (known(cost)) used.costUsd += cost; else used.costComplete = false;
    if (known(agent?.toolCalls)) used.toolCalls += agent.toolCalls; else used.toolCallsComplete = false;
    if (known(agent?.renderCalls)) used.renderCalls += agent.renderCalls; else used.renderCallsComplete = false;
    if (agent?.toolCallsComplete === false) used.toolCallsComplete = false;
    if (agent?.renderCallsComplete === false || agent?.observability?.renderCalls?.startsWith('unobservable-')) used.renderCallsComplete = false;
    return used;
}

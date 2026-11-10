import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudgetLedger, reserveBudget, startBudgetReservation, settleBudgetReservation, releaseBudgetReservation, finalReviewReserve, availableStageBudget } from '../src/repro/budget.js';
import { createStagedWorkflow } from '../src/repro/config.js';

const workflow = createStagedWorkflow();
const policy = { ...workflow.policy, maxPreviewJobs: workflow.execution.maxPreviewJobs };

test('stage budget preserves two full reviewer timeouts plus render/evidence overhead', () => {
    const ledger = createBudgetLedger();
    const holdback = finalReviewReserve(workflow);
    assert.equal(holdback.calls, 2); assert.equal(holdback.elapsedMs, 1_320_000); assert.equal(holdback.renderCalls, 1);
    assert.throws(() => reserveBudget(ledger, { operationId: 'stage-too-late', kind: 'executor', policy, used: { elapsedMs: 4_080_001 }, amount: { calls: 1, elapsedMs: 1 }, holdback }), { code: 'REPRO_BUDGET_EXHAUSTED' });
    assert.equal(ledger.reservations.length, 0);
    const request = { operationId: 'stage-analysis', kind: 'executor', policy, used: {}, amount: { calls: 1, elapsedMs: 60_000 }, holdback };
    const entry = reserveBudget(ledger, request);
    assert.equal(reserveBudget(ledger, request), entry);
    assert.equal(ledger.reservations.length, 1);
    assert.throws(() => reserveBudget(ledger, { ...request, amount: { calls: 2, elapsedMs: 60_000 } }), /cannot be reused/);
    assert.equal(availableStageBudget(policy, {}, ledger, { holdback }).available.calls, 45);
    startBudgetReservation(ledger, entry.operationId);
    assert.throws(() => releaseBudgetReservation(ledger, entry.operationId), /must be settled/);
});

test('settlement is idempotent, does not double-charge workflow counters, and preserves unknown accounting', () => {
    const ledger = createBudgetLedger();
    const used = { calls: 1, elapsedMs: 20_000 };
    reserveBudget(ledger, { operationId: 'execution-1', kind: 'executor', policy, amount: { calls: 1, elapsedMs: 60_000 } });
    startBudgetReservation(ledger, 'execution-1');
    const receipt = { receiptId: 'runtime-1', actual: { calls: 1, elapsedMs: 20_000, costUsd: null }, status: 'completed' };
    const settled = settleBudgetReservation(ledger, 'execution-1', receipt);
    assert.equal(settleBudgetReservation(ledger, 'execution-1', receipt), settled);
    assert.deepEqual(used, { calls: 1, elapsedMs: 20_000 });
    assert.equal(settled.receipt.accounting.elapsedComplete, true);
    assert.equal(settled.receipt.accounting.costComplete, false);
    assert.equal(settled.receipt.accounting.toolCallsComplete, false);
    assert.equal(availableStageBudget(policy, used, ledger).available.calls, 47);
    assert.throws(() => settleBudgetReservation(ledger, 'execution-1', { ...receipt, actual: { calls: 1, elapsedMs: 30_000 } }), /different receipt/);
    reserveBudget(ledger, { operationId: 'execution-2', kind: 'executor', policy, amount: { calls: 1 } });
    assert.throws(() => settleBudgetReservation(ledger, 'execution-2', receipt), /cannot settle two/);
    const roundtrip = JSON.parse(JSON.stringify(ledger));
    assert.equal(availableStageBudget(policy, used, roundtrip).available.calls, 46);
});

test('invalid review retry may only spend the allowance remaining after the other mandatory vote', () => {
    const ledger = createBudgetLedger();
    const otherVote = finalReviewReserve(workflow, { remainingVotes: 1, includeRender: false, includeEvidence: false });
    assert.equal(otherVote.elapsedMs, 600_000); assert.equal(otherVote.renderCalls, 0);
    const limited = { ...policy, maxCalls: 4, maxDurationMs: 2_000_000 };
    assert.throws(() => reserveBudget(ledger, { operationId: 'review-retry', kind: 'reviewer', policy: limited, used: { calls: 3 }, amount: { calls: 1, elapsedMs: 600_000 }, holdback: otherVote }), { code: 'REPRO_BUDGET_EXHAUSTED' });
    assert.throws(() => reserveBudget(ledger, { operationId: 'review-retry', kind: 'reviewer', policy: limited, used: { calls: 2, elapsedMs: 800_001 }, amount: { calls: 1, elapsedMs: 600_000 }, holdback: otherVote }), { code: 'REPRO_BUDGET_EXHAUSTED' });
    assert.equal(reserveBudget(ledger, { operationId: 'review-retry', kind: 'reviewer', policy: limited, used: { calls: 2, elapsedMs: 800_000 }, amount: { calls: 1, elapsedMs: 600_000 }, holdback: otherVote }).status, 'reserved');
});

test('preview allocations and unused reservations survive restart without silent release or negative credits', () => {
    const ledger = createBudgetLedger();
    const request = { operationId: 'preview-1', kind: 'preview', policy: { ...policy, maxPreviewJobs: 1 }, amount: { renderCalls: 1, previewJobs: 1 } };
    reserveBudget(ledger, request);
    assert.throws(() => reserveBudget(ledger, { ...request, operationId: 'preview-2' }), { code: 'REPRO_BUDGET_EXHAUSTED' });
    const restarted = JSON.parse(JSON.stringify(ledger));
    assert.equal(reserveBudget(restarted, request).status, 'reserved');
    releaseBudgetReservation(restarted, 'preview-1');
    assert.equal(releaseBudgetReservation(restarted, 'preview-1').status, 'released');
    assert.throws(() => startBudgetReservation(restarted, 'preview-1'), /unstarted/);
    assert.throws(() => settleBudgetReservation(restarted, 'preview-1'), /cannot be settled/);
    assert.throws(() => reserveBudget(restarted, { ...request, operationId: 'bad', amount: { calls: -1 } }), /nonnegative/);
    const malformed = createBudgetLedger(); malformed.reservations.push({ operationId: 'bad', status: 'forgotten', amount: {}, holdback: {} });
    assert.throws(() => availableStageBudget(policy, {}, malformed), /invalid reservation/);
});

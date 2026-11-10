import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyBudget, chargeBudget, remainingBudget } from '../src/repro/budget.js';

test('complete native accounting includes observed tool events and explicit zero duration', () => {
    const budget = emptyBudget();
    chargeBudget(budget, { elapsedMs: 999, usage: { totalTokens: 40 }, cost: { total: 0.2, currency: 'USD' }, toolCalls: 3, renderCalls: 1 }, 0);
    assert.equal(budget.elapsedMs, 0);
    assert.equal(budget.tokens, 40);
    assert.equal(budget.costUsd, 0.2);
    assert.equal(budget.toolCalls, 3);
    assert.equal(budget.renderCalls, 1);
    for (const flag of ['usageComplete', 'costComplete', 'elapsedComplete', 'toolCallsComplete', 'renderCallsComplete']) assert.equal(budget[flag], true);
});

test('unknown accounting remains a lower bound rather than a claim of zero and completeness is monotonic', () => {
    const budget = emptyBudget();
    chargeBudget(budget, { status: 'interrupted' });
    for (const flag of ['usageComplete', 'costComplete', 'elapsedComplete', 'toolCallsComplete', 'renderCallsComplete']) assert.equal(budget[flag], false);
    chargeBudget(budget, { elapsedMs: 10, usage: { totalTokens: 5 }, cost: 0, toolCalls: 1, renderCalls: 0 });
    assert.equal(budget.toolCalls, 1);
    assert.equal(budget.elapsedMs, 10);
    for (const flag of ['usageComplete', 'costComplete', 'elapsedComplete', 'toolCallsComplete', 'renderCallsComplete']) assert.equal(budget[flag], false);
});

test('managed render counts do not imply visibility into arbitrary Agent shell renders', () => {
    const budget = emptyBudget();
    chargeBudget(budget, { elapsedMs: 20, usage: { totalTokens: 10 }, cost: null, toolCalls: 2, renderCalls: 1,
        observability: { renderCalls: 'unobservable-inside-arbitrary-shell; only host-invoked renders can be capped reliably' } });
    assert.equal(budget.renderCalls, 1);
    assert.equal(budget.renderCallsComplete, false);
    assert.equal(budget.toolCallsComplete, true);
    assert.equal(budget.costComplete, false);
});

test('negative accounting never reduces consumed budget and observed limits still stop future calls', () => {
    const budget = emptyBudget(); budget.calls = 1; budget.tokens = 10;
    chargeBudget(budget, { elapsedMs: -2, usage: { totalTokens: -10 }, cost: -2, toolCalls: -1, renderCalls: -1 });
    assert.equal(budget.tokens, 10); assert.equal(budget.costUsd, 0); assert.equal(budget.toolCalls, 0);
    assert.equal(budget.usageComplete, false);
    assert.throws(() => remainingBudget({ maxCalls: 1, maxDurationMs: 1000 }, budget), { code: 'REPRO_BUDGET_EXHAUSTED' });
});

import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { reconcileInterruptedRun } from '../src/repro/recovery.js';
import { createStageState } from '../src/repro/stages.js';
import { createBudgetLedger, reserveBudget, startBudgetReservation, emptyBudget } from '../src/repro/budget.js';
import { createStagedWorkflow } from '../src/repro/config.js';

const deceased = { pid: 2147483647, hostname: os.hostname() };
const snapshot = hash => ({ treeHash: hash.repeat(64), files: [] });
const receipt = patch => ({ runId: 'maker_1', role: 'executor', owner: deceased, status: 'running', elapsedMs: 1500, toolCalls: 3, renderCalls: 0, usage: null, cost: null, ...patch });
function makeState(kind = 'stage-production') {
    const workflow = createStagedWorkflow();
    const budgetBefore = emptyBudget();
    const budgetLedger = createBudgetLedger();
    reserveBudget(budgetLedger, { operationId: 'op_1', kind, policy: workflow.policy, used: budgetBefore, amount: { calls: kind === 'stage-production' ? 1 : 0, elapsedMs: 120000 } });
    startBudgetReservation(budgetLedger, 'op_1');
    const stageState = createStageState({ episodeId: 'episode_1' });
    stageState.currentStage = 'shots';
    stageState.stages.find(stage => stage.id === 'prototypes').status = 'evidence-complete';
    stageState.stages.find(stage => stage.id === 'shots').status = 'running';
    return { schema: 'video-remake.reproduction-run@3', workspace: '/test/workspace', status: 'running', workflow, budgetLedger,
        budget: { ...emptyBudget(), calls: kind === 'stage-production' ? 1 : 0 }, stageState,
        activeOperation: { id: 'op_1', stageId: 'shots', kind, owner: deceased, budgetBefore, startedAt: '2020-01-01T00:00:00Z' },
        ...(kind === 'stage-production' ? { activeAgentRunId: 'maker_1', executionOwner: deceased, activeRole: 'executor' } : {}),
        stageExecutions: kind === 'stage-production' ? [{ id: 'sx_1', episodeId: 'episode_1', stageId: 'shots', purpose: 'production', sourceSnapshotBefore: snapshot('a') }] : [],
        stageSubmissions: [{ id: 'old_preview', episodeId: 'episode_1', stageId: 'prototypes', status: 'evidence-complete' }],
        stageCheckpoint: { snapshot: snapshot('a'), verified: true }, attempts: [], generation: {} };
}
const deps = (patch = {}) => ({ projectAgentStatus: async () => receipt(), auditGeneration: async () => ({ lockedChanges: [] }), snapshotProject: async () => snapshot('a'), ...patch });

test('staged recovery writes maker receipt and an attributed checkpoint without accepting the stage', async () => {
    const state = makeState();
    const frozen = structuredClone(state.stageState.stages[0]);
    await reconcileInterruptedRun({}, state, deps({ snapshotProject: async () => snapshot('b') }));
    assert.equal(state.status, 'interrupted');
    assert.equal(state.stageExecutions[0].status, 'interrupted');
    assert.equal(state.stageExecutions[0].agent.runId, 'maker_1');
    assert.equal(state.stageCheckpoint.verified, false);
    assert.equal(state.stageCheckpoint.attribution, 'unverified-after-owner-exit');
    assert.equal(state.assisted, true);
    assert.equal(state.stageSubmissions[0].status, 'stale');
    assert.deepEqual(state.stageState.stages[0], frozen);
    assert.equal(state.stageState.stages.find(stage => stage.id === 'shots').status, 'interrupted');
    assert.equal(state.budget.elapsedMs, 1500, 'never charge time since 2020');
    assert.equal(state.budget.calls, 1);
    assert.equal(state.budget.elapsedComplete, false);
    assert.equal(state.budgetLedger.reservations[0].receipt.actual.elapsedMs, 1500);
    assert.equal(state.budgetLedger.reservations[0].receipt.accounting.elapsedComplete, false);
    assert.equal(state.activeOperation, undefined);
    assert.equal((await reconcileInterruptedRun({}, state, deps())).changed, false);
    assert.equal(state.agentRuns.length, 1);
    assert.equal(state.attempts.length, 0);
});

test('terminal maker receipts account once but recovery still requires controlled host completion', async () => {
    const state = makeState();
    const result = receipt({ status: 'completed', execution: { durationMs: 1200 }, usage: { totalTokens: 10 }, cost: { total: 0.2, currency: 'USD' } });
    await reconcileInterruptedRun({}, state, deps({ projectAgentStatus: async () => result }));
    assert.equal(state.stageCheckpoint.verified, true);
    assert.equal(state.assisted, undefined);
    assert.equal(state.stageExecutions[0].agent.status, 'completed');
    assert.equal(state.stageExecutions[0].status, 'interrupted');
    assert.equal(state.budget.elapsedMs, 1200);
    assert.equal(state.budget.tokens, 10);
    assert.equal(state.budgetLedger.reservations[0].receipt.actual.calls, 1);
    const repeated = { ...state, activeAgentRunId: 'maker_1', activeRole: 'executor', executionOwner: deceased };
    await reconcileInterruptedRun({}, repeated, deps({ projectAgentStatus: async () => result }));
    assert.equal(repeated.budget.elapsedMs, 1200);
    assert.equal(repeated.agentRuns.length, 1);
});

test('staged recovery leaves live/foreign owners and detached media children alone', async () => {
    for (const change of [
        state => { state.activeOperation.owner = { ...deceased, pid: process.pid }; },
        state => { state.activeOperation.owner = { ...deceased, hostname: 'other-host' }; },
        state => { state.activeOperation.process = { pid: process.pid }; },
    ]) {
        const state = makeState(); change(state);
        const before = structuredClone(state);
        assert.equal((await reconcileInterruptedRun({}, state, deps({ projectAgentStatus: async () => { throw new Error('Must not inspect receipt'); } }))).changed, false);
        assert.deepEqual(state, before);
    }
    const state = makeState();
    assert.equal((await reconcileInterruptedRun({}, state, deps({ projectAgentStatus: async () => receipt({ owner: { ...deceased, pid: process.pid } }) }))).changed, false);
});

test('staged host operations recover without an Agent or attempt and preserve review votes', async () => {
    const state = makeState('stage-preview');
    state.reviewSession = { samples: [{ valid: true, passed: false }] };
    state.review = { passed: false }; state.reviewSource = { sourceHash: 'old' };
    await reconcileInterruptedRun({}, state, deps());
    assert.equal(state.status, 'interrupted');
    assert.equal(state.budget.calls, 0);
    assert.equal(state.budget.elapsedMs, 0);
    assert.equal(state.budget.elapsedComplete, false);
    assert.equal(state.budgetLedger.reservations[0].status, 'settled');
    assert.equal(state.budgetLedger.reservations[0].receipt.resultStatus, 'interrupted');
    assert.equal(state.reviewHistory[0].review.passed, false);
    assert.equal(state.reviewSession.samples.length, 1);
    assert.equal(state.review, undefined);
});

test('staged recovery blocks altered frozen inputs and malformed receipts cannot partly charge state', async () => {
    const state = makeState();
    await reconcileInterruptedRun({}, state, deps({ auditGeneration: async () => ({ lockedChanges: ['task/spec.json'] }) }));
    assert.equal(state.stageCheckpoint, undefined);
    assert.equal(state.checkpointHistory.length, 1);
    assert.equal(state.stageState.stages.find(stage => stage.id === 'shots').status, 'blocked');
    assert.equal(state.stageState.stages.find(stage => stage.id === 'shots').recovery.frozenInputsUnchanged, false);
    for (const change of [s => { s.stageExecutions = []; }, s => { s.budgetLedger.reservations = []; }]) {
        const broken = makeState(); change(broken); const before = structuredClone(broken);
        await assert.rejects(reconcileInterruptedRun({}, broken, deps()), { code: 'REPRO_RECOVERY_INVALID' });
        assert.deepEqual(broken, before);
    }
});

test('staged operation keeps the Agent ID through the receipt-to-stage persistence gap', async () => {
    const state = makeState();
    state.activeOperation.agentRunId = state.activeAgentRunId;
    delete state.activeAgentRunId;
    await reconcileInterruptedRun({}, state, deps());
    assert.equal(state.stageExecutions[0].agentRunId, 'maker_1');
});

test('recovery preserves historical episode submissions and handles the pre-launch save gap', async () => {
    const state = makeState();
    const historical = { id: 'prior_episode', episodeId: 'episode_0', stageId: 'prototypes', status: 'evidence-complete' };
    state.stageSubmissions.push(structuredClone(historical));
    await reconcileInterruptedRun({}, state, deps({ snapshotProject: async () => snapshot('b') }));
    assert.deepEqual(state.stageSubmissions.at(-1), historical);
    const unstarted = makeState();
    unstarted.budget.calls = 0; unstarted.stageExecutions = [];
    delete unstarted.activeAgentRunId; delete unstarted.activeRole; delete unstarted.executionOwner;
    await reconcileInterruptedRun({}, unstarted, deps({ projectAgentStatus: async () => { throw new Error('No model started'); } }));
    assert.equal(unstarted.status, 'interrupted');
    assert.equal(unstarted.stageCheckpoint.verified, true);
    assert.equal(unstarted.stageCheckpoint.interrupted, true);
    assert.equal(unstarted.stageState.stages.find(stage => stage.id === 'shots').recovery.modelCallStarted, false);
    assert.equal(unstarted.budget.calls, 0);
    assert.equal(unstarted.stageExecutions.length, 0);
    assert.equal(unstarted.budgetLedger.reservations[0].status, 'settled');
});

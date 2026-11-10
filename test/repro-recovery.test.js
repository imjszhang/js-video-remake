import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { reconcileInterruptedRun } from '../src/repro/recovery.js';
import { emptyBudget } from '../src/repro/budget.js';
import { fixture, teacher, write } from './fixtures/repro-fixture.js';
import { storage } from '../src/repro/store.js';

const deceased = { pid: 2147483647, hostname: os.hostname() };
const makeState = role => ({ activeAgentRunId: 'p_dead', executionOwner: deceased, activeRole: role,
    status: role === 'extractor' ? 'passed' : 'running', budget: { ...emptyBudget(), calls: 1 }, attempts: [{ number: 1, agents: [], executionCompleted: role === 'reviewer' || role === 'extractor' }] });
const agent = patch => ({ runId: 'p_dead', owner: deceased, status: 'interrupted', elapsedMs: 1500, usage: null, cost: null, toolCalls: 3, renderCalls: 0, ...patch });

test('recovery never steals a live, foreign or unknown execution owner', async () => {
    for (const owner of [{ pid: process.pid, hostname: os.hostname() }, { pid: deceased.pid, hostname: 'remote-host' }, { pid: -1, hostname: os.hostname() }]) {
        const state = { ...makeState('executor'), executionOwner: owner };
        const before = structuredClone(state);
        const result = await reconcileInterruptedRun({}, state, { projectAgentStatus: async () => { throw new Error('Must not inspect live owner'); } });
        assert.equal(result.changed, false); assert.deepEqual(state, before);
    }
    const state = makeState('executor');
    assert.equal((await reconcileInterruptedRun({}, state, { projectAgentStatus: async () => agent({ owner: { pid: process.pid, hostname: os.hostname() } }) })).changed, false);
});

test('interrupted maker charges only persisted elapsed lower bound and marks unknown accounting once', async () => {
    const state = makeState('executor');
    const result = await reconcileInterruptedRun({}, state, { projectAgentStatus: async () => agent({ startedAt: '2020-01-01T00:00:00Z' }) });
    assert.equal(result.changed, true);
    assert.equal(state.status, 'interrupted');
    assert.equal(state.budget.elapsedMs, 1500);
    assert.equal(state.budget.elapsedComplete, false);
    assert.equal(state.budget.usageComplete, false);
    assert.equal(state.budget.costComplete, false);
    assert.equal(state.budget.calls, 1);
    assert.equal(state.attempts[0].executionCompleted, false);
    assert.equal(state.attempts[0].agents.length, 1);
    assert.equal(state.agentRuns.length, 1);
    assert.deepEqual(state.chargedAgentRunIds, ['p_dead']);
    assert.equal(state.activeAgentRunId, undefined);
    assert.equal((await reconcileInterruptedRun({}, state)).changed, false);
    const again = { ...state, activeAgentRunId: 'p_dead', activeRole: 'executor', executionOwner: deceased };
    await reconcileInterruptedRun({}, again, { projectAgentStatus: async () => agent() });
    assert.equal(again.budget.elapsedMs, 1500);
    assert.equal(again.attempts[0].agents.length, 1);
    assert.equal(again.agentRuns.length, 1);
});

test('persisted terminal Agent result is charged exactly but cannot automatically accept source or video', async () => {
    const state = makeState('teacher');
    await reconcileInterruptedRun({}, state, { projectAgentStatus: async () => agent({ status: 'completed', elapsedMs: 2200, execution: { durationMs: 2000 }, usage: { totalTokens: 90 }, cost: { total: 0.25, currency: 'USD' } }) });
    assert.equal(state.budget.elapsedMs, 2000);
    assert.equal(state.budget.tokens, 90);
    assert.equal(state.budget.costUsd, 0.25);
    assert.equal(state.budget.usageComplete, true);
    assert.equal(state.attempts[0].executionCompleted, false);
    assert.equal(state.status, 'interrupted');
});

test('reviewer and extractor interruptions preserve completed maker work and never fabricate acceptance', async () => {
    const reviewer = makeState('reviewer'); reviewer.review = { passed: true };
    await reconcileInterruptedRun({}, reviewer, { projectAgentStatus: async () => agent() });
    assert.equal(reviewer.status, 'external-review');
    assert.equal(reviewer.attempts[0].executionCompleted, true);
    assert.equal(reviewer.attempts[0].agents.length, 0);
    assert.equal(reviewer.review, undefined);
    assert.equal(reviewer.reviewRuns.length, 1);
    const extractor = makeState('extractor'); extractor.review = { passed: true };
    await reconcileInterruptedRun({}, extractor, { projectAgentStatus: async () => agent() });
    assert.equal(extractor.status, 'passed');
    assert.deepEqual(extractor.review, { passed: true });
    assert.equal(extractor.extractionRuns.length, 1);
    assert.equal(extractor.extractions, undefined);
});

test('older records can recover through a dead Agent owner and missing preparation records stay unknown', async () => {
    const older = makeState('executor'); delete older.executionOwner; delete older.activeRole;
    await reconcileInterruptedRun({}, older, { projectAgentStatus: async () => agent({ role: 'executor' }) });
    assert.equal(older.status, 'interrupted');
    const missing = makeState('executor');
    await reconcileInterruptedRun({}, missing, { projectAgentStatus: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    assert.equal(missing.budget.elapsedMs, 0);
    assert.equal(missing.budget.usageComplete, false);
    assert.equal(missing.budget.costComplete, false);
    assert.equal(missing.budget.toolCallsComplete, false);
    assert.equal(missing.budget.renderCallsComplete, false);
});

test('invalid recovery evidence leaves the entire state unchanged before accounting', async () => {
    const state = makeState('executor');
    state.attempts = [];
    const before = structuredClone(state);
    await assert.rejects(reconcileInterruptedRun({}, state, { projectAgentStatus: async () => agent() }), error => error.code === 'REPRO_RECOVERY_INVALID');
    assert.deepEqual(state, before);
});

test('render recovery waits for both controlling owner and child to be demonstrably dead', async () => {
    for (const active of [
        { owner: { pid: process.pid, hostname: os.hostname() }, pid: deceased.pid },
        { owner: deceased, pid: process.pid },
        { owner: { ...deceased, hostname: 'remote' }, pid: deceased.pid },
        { owner: deceased, pid: -1 },
    ]) {
        const state = { budget: emptyBudget(), attempts: [{ executionCompleted: true }], activeRender: { id: 'render-1', ...active } };
        const before = structuredClone(state);
        assert.equal((await reconcileInterruptedRun({}, state)).changed, false);
        assert.deepEqual(state, before);
    }
});

test('dead render recovery preserves maker completion and reserved calls without charging offline time', async () => {
    for (const pid of [undefined, deceased.pid]) {
        const state = { status: 'rendering', budget: { ...emptyBudget(), renderCalls: 1, elapsedMs: 1200 },
            attempts: [{ executionCompleted: true, renders: [] }], review: { passed: true }, reviewSource: { sourceHash: 'old' },
            activeRender: { id: 'render-1', owner: deceased, pid, startedAt: '2020-01-01T00:00:00Z' } };
        const result = await reconcileInterruptedRun({}, state);
        assert.equal(result.changed, true);
        assert.equal(state.status, 'interrupted');
        assert.equal(state.budget.renderCalls, 1);
        assert.equal(state.budget.elapsedMs, 1200);
        assert.equal(state.budget.elapsedComplete, false);
        assert.equal(state.attempts[0].executionCompleted, true);
        assert.equal(state.attempts[0].renders[0].status, 'interrupted');
        assert.equal(state.attempts[0].renders[0].elapsedMs, null);
        assert.equal(state.review, undefined);
        assert.equal(state.activeRender, undefined);
        assert.equal((await reconcileInterruptedRun({}, state)).changed, false);
    }
});


test('workflow recover persists reconciliation and status projects live progress without charging it', async t => {
    const f = await fixture(t);
    await f.make();
    const state = await f.load(teacher);
    Object.assign(state, { activeAgentRunId: 'p_dead', executionOwner: deceased, activeRole: 'executor', status: 'running' });
    state.budget.calls += 1;
    await write(storage(f.config), `runs/${state.id}/state.json`, state);
    f.deps.projectAgentStatus = async () => agent({ status: 'running', elapsedMs: 1700 });
    const before = structuredClone(state.budget);
    const live = await f.execute('status', teacher);
    assert.equal(live.run.activeAgent.elapsedMs, 1700);
    assert.equal(live.run.activeAgentRunId, 'p_dead');
    assert.deepEqual(live.run.budget, before);
    const result = await f.execute('recover', teacher);
    assert.equal(result.recovered, true);
    assert.equal(result.run.status, 'interrupted');
    assert.equal((await f.load(teacher)).budget.elapsedMs, before.elapsedMs + 1700);
    assert.equal((await f.execute('recover', teacher)).recovered, false);
    const retried = await f.execute('retry', teacher);
    assert.equal(retried.run.status, 'external-review');
    assert.equal(retried.run.attempts.length, 2);
});

test('explicit recovery checkpoints unfinished source and resumes without consuming another attempt', async t => {
    const f = await fixture(t);
    await f.make();
    const state = await f.load(teacher);
    Object.assign(state, { activeAgentRunId: 'p_dead', executionOwner: deceased, activeRole: 'teacher', status: 'running' });
    state.budget.calls += 1;
    delete state.attempts[0].checkpoint;
    await write(storage(f.config), `runs/${state.id}/state.json`, state);
    f.deps.projectAgentStatus = async () => agent();
    await f.execute('recover', teacher);
    const recovered = await f.load(teacher);
    assert.equal(recovered.attempts[0].checkpointOrigin, 'explicit-recovery');
    assert.ok(recovered.attempts[0].checkpoint.treeHash);
    assert.equal(recovered.assisted, true);
    assert.equal(recovered.attempts[0].executionCompleted, false);
    assert.equal((await f.execute('recover', teacher)).recovered, false);
    const resumed = await f.execute('resume', teacher);
    assert.equal(resumed.run.attempts.length, 1);
    assert.equal(resumed.run.status, 'external-review');
});

test('recovered checkpoint rejects later source edits and changed frozen inputs', async t => {
    for (const frozen of [false, true]) {
        const f = await fixture(t);
        await f.make();
        const state = await f.load(teacher);
        Object.assign(state, { status: 'interrupted' });
        const attempt = state.attempts.at(-1);
        attempt.executionCompleted = false;
        attempt.error = { code: 'REPRO_INTERRUPTED' };
        delete attempt.checkpoint;
        await write(storage(f.config), `runs/${state.id}/state.json`, state);
        if (frozen) {
            await write(state.workspace, 'inputs/values.json', { title: 'Changed' });
            await assert.rejects(f.execute('recover', teacher), /冻结输入/);
            assert.equal((await f.load(teacher)).attempts.at(-1).checkpoint, undefined);
        } else {
            await f.execute('recover', teacher);
            await write(state.workspace, 'src/changed.txt', 'External edit after recovery');
            await assert.rejects(f.execute('resume', teacher), /检查点后改变/);
        }
    }
});


test('repair preserves an interrupted checkpoint and supplies focused continuation instructions', async t => {
    const f = await fixture(t);
    await f.make();
    const state = await f.load(teacher);
    state.status = 'failed';
    state.attempts.at(-1).executionCompleted = false;
    state.attempts.at(-1).error = { code: 'AGENT_TIMED_OUT' };
    state.feedback = { review: { notes: 'Preserve earlier review feedback' } };
    await write(state.workspace, 'repair-marker.txt', 'keep source');
    await write(storage(f.config), `runs/${state.id}/state.json`, state);
    const run = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (config, options) => {
        assert.match(options.instruction, /只完成剩余工作/);
        assert.match(options.instruction, /当前外部失败反馈优先于旧交接记录/);
        assert.match(options.instruction, /不要仅重跑静态检查后交接/);
        assert.match(options.instruction, /Preserve earlier review feedback/);
        return run(config, options);
    };
    const repaired = await f.execute('repair', teacher);
    assert.equal(repaired.run.attempts.length, 2);
    assert.equal(repaired.run.assisted, true);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(`${state.workspace}/repair-marker.txt`, 'utf8'), 'keep source');
});

test('explicit continuation preserves criteria, source and parent usage without fabricating acceptance', async t => {
    const f = await fixture(t);
    await f.make();
    const parent = await f.load(teacher);
    await write(parent.workspace, 'continuation-marker.txt', 'preserved');
    const next = (await f.execute('continue', teacher)).run;
    assert.notEqual(next.id, parent.id);
    assert.deepEqual(next.spec, parent.spec);
    assert.deepEqual(next.continuation.parentBudget, parent.budget);
    assert.equal(next.continuation.parentRunId, parent.id);
    assert.equal(next.budget.calls, 0);
    assert.equal(next.assisted, true);
    assert.equal(next.review, undefined);
    assert.equal(next.technical, undefined);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(`${next.continuation.archivedProject}/continuation-marker.txt`, 'utf8'), 'preserved');
    const saved = JSON.parse(await readFile(`${storage(f.config)}/runs/${parent.id}/state.json`, 'utf8'));
    assert.deepEqual(saved.budget, parent.budget);
    await f.execute('teacher', teacher);
    assert.equal(await readFile(`${parent.workspace}/continuation-marker.txt`, 'utf8'), 'preserved');
});

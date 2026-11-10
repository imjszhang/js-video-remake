import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, teacher, hash, read, write } from './fixtures/repro-fixture.js';
import { storage } from '../src/repro/store.js';

// Full-project cycling was retired. Keep its historical records readable, and
// exercise budget/recovery guarantees through the supported explicit workflow.
test('retired cycle rejects before creating work or changing historical cycle records', async t => {
    const f = await fixture(t); await f.init();
    const history = storage(f.config);
    const record = { schema: 'video-remake.reproduction-cycle@1', id: 'historical', status: 'released', release: { template: 'old@1' } };
    await write(history, 'cycles/historical.json', record);
    const before = await fs.readFile(path.join(history, 'cycles/historical.json'));
    await assert.rejects(f.execute('cycle', teacher, { name: 'demo', cases: 'missing.json' }), { code: 'REPRO_MIGRATION_REQUIRED' });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await fs.readFile(path.join(history, 'cycles/historical.json')), before);
    assert.equal((await f.load(teacher)).attempts.length, 0);
});

test('explicit teacher repair retains its implementation and frozen acceptance after failed review', async t => {
    const f = await fixture(t); const runner = f.deps.runProjectAgent; let makers = 0;
    f.deps.runProjectAgent = async (config, options) => {
        if (options.role === 'teacher' && ++makers === 2) {
            assert.equal(await fs.readFile(path.join(options.workspace, 'src/retained.txt'), 'utf8'), 'keep teacher implementation');
            assert.ok(options.instruction.includes('前次失败反馈'));
        }
        const result = await runner(config, options);
        if (options.role === 'teacher' && makers === 1) await write(options.workspace, 'src/retained.txt', 'keep teacher implementation');
        return result;
    };
    await f.make(); f.reviewStatus = 'fail'; await f.execute('judge', teacher);
    const before = await f.load(teacher);
    await f.execute('repair', teacher); f.reviewStatus = 'pass'; await f.execute('judge', teacher);
    const after = await f.load(teacher);
    assert.equal(after.status, 'passed'); assert.equal(after.specHash, before.specHash);
    assert.equal(after.attempts.length, 2); assert.equal(after.attempts[1].mode, 'repair');
    assert.equal(after.assisted, undefined); assert.equal(after.budget.calls, 4);
});

test('failed managed render can resume without another model or source rebuild', async t => {
    const f = await fixture(t, { renderProvider: 'local' });
    const runner = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (...args) => ({ ...await runner(...args), renderCalls: 0 });
    let renders = 0;
    f.deps.renderProject = async (_config, options) => {
        if (++renders === 1) throw Object.assign(new Error('Transient render failure'), { code: 'REPRO_RENDER_FAILED', data: { render: { provider: 'local-hyperframes', status: 'failed' } } });
        const file = options.spec.acceptance.media.file, bytes = 'managed media';
        await write(options.workspace, file, bytes);
        return { provider: 'local-hyperframes', status: 'completed', artifact: { file, sha256: hash(bytes) }, renderCalls: 1 };
    };
    await assert.rejects(f.make(), { code: 'REPRO_RENDER_FAILED' });
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.execute('check', teacher), { code: 'REPRO_CHECK_FAILED' });
    assert.equal((await f.load(teacher)).technical.checks.find(check => check.id === 'render:completed').passed, false);
    const result = await f.execute('render', teacher);
    assert.equal(result.run.status, 'external-review');
    assert.equal(f.calls.length, 1); assert.equal(result.run.attempts.length, 1);
    assert.equal(renders, 2);
});

test('maker render usage prevents an additional managed render when aggregate budget is exhausted', async t => {
    const f = await fixture(t, { renderProvider: 'local', maxRenderCalls: 1 });
    let renders = 0; f.deps.renderProject = async () => { renders += 1; throw new Error('Must not start'); };
    await assert.rejects(f.make(), { code: 'REPRO_BUDGET_EXHAUSTED' });
    assert.equal(renders, 0); assert.equal(f.calls.length, 1);
    assert.equal((await f.load(teacher)).budget.renderCalls, 1);
});

test('explicit workflow retains incomplete usage flags instead of inventing complete counters', async t => {
    const f = await fixture(t); const runner = f.deps.runProjectAgent;
    f.deps.runProjectAgent = async (...args) => ({ ...await runner(...args), elapsedComplete: false, toolCallsComplete: false, renderCallsComplete: false });
    const result = await f.make();
    assert.equal(result.run.budget.elapsedComplete, false);
    assert.equal(result.run.budget.toolCallsComplete, false);
    assert.equal(result.run.budget.renderCallsComplete, false);
});

test('frozen input content changes block explicit repair before another model request', async t => {
    for (const input of ['text', 'file']) {
        const f = await fixture(t, { fileInput: true }); await f.make();
        const state = await f.load(teacher);
        if (input === 'text') await write(state.workspace, 'inputs/values.json', { title: 'Changed task', logo: 'inputs/files/logo/logo.svg' });
        else await write(state.workspace, 'inputs/files/logo/logo.svg', '<svg>Changed file</svg>');
        await assert.rejects(f.execute('repair', teacher), { code: 'REPRO_NOT_READY' });
        assert.equal(f.calls.length, 1);
    }
});

test('unobserved teacher evidence prevents extraction and cannot be rerolled by changing desired verdict', async t => {
    const f = await fixture(t); await f.make(); f.reviewStatus = 'unobserved';
    const result = await f.execute('judge', teacher);
    assert.equal(result.run.status, 'needs-revision');
    await assert.rejects(f.execute('extract', teacher, { name: 'demo', version: 1 }), { code: 'REPRO_NOT_READY' });
    f.reviewStatus = 'pass';
    const cached = await f.execute('judge', teacher);
    assert.equal(cached.cached, true); assert.equal(cached.run.status, 'needs-revision');
    assert.deepEqual(f.calls.map(call => call.role), ['teacher', 'reviewer']);
    f.targetHash = hash('restored-review-capability');
    assert.equal((await f.execute('judge', teacher)).run.status, 'passed');
});

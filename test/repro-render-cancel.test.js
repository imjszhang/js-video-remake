import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, teacher, read, write } from './fixtures/repro-fixture.js';

test('CLI cancellation reaches the active managed renderer and leftover media cannot be accepted', async t => {
    const f = await fixture(t);
    const workflow = await read(f.workspace, 'reproduction-workflow.json');
    workflow.policy.renderProvider = 'local';
    await write(f.workspace, 'reproduction-workflow.json', workflow);
    await f.init();
    let begin;
    const started = new Promise(resolve => { begin = resolve; });
    f.deps.renderProject = async (_config, { signal }) => {
        begin();
        await new Promise((resolve, reject) => {
            const fail = () => reject(Object.assign(new Error('cancelled fixture renderer'), { code: 'REPRO_RENDER_CANCELLED' }));
            if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
        });
    };
    const running = f.execute('teacher', teacher);
    const failed = assert.rejects(running, { code: 'REPRO_RENDER_CANCELLED' });
    await started;
    const active = (await f.execute('status', teacher)).run.activeRender;
    assert.ok(active.id.startsWith('render-'));
    const cancel = await f.execute('cancel', teacher);
    assert.equal(cancel.id, active.id);
    assert.equal(cancel.status, 'cancellation-requested');
    await failed;
    const state = await f.load(teacher);
    assert.equal(state.status, 'cancelled');
    assert.equal(state.activeRender, undefined);
    assert.equal(state.attempts.at(-1).executionCompleted, true, 'source preparation remains available for rerender');
    await assert.rejects(f.execute('check', teacher), error => {
        assert.equal(error.code, 'REPRO_CHECK_FAILED');
        assert.equal(error.data.run.technical.checks.find(check => check.id === 'render:completed').passed, false);
        return true;
    });
});

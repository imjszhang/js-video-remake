import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_POLICY, DEFAULT_STAGED_POLICY, DEFAULT_STAGE_EXECUTION, validateWorkflow, createStagedWorkflow } from '../src/repro/config.js';

test('workflow v1 normalization remains unchanged and v2 opts into a separate staged contract', () => {
    assert.deepEqual(validateWorkflow({}), { schemaVersion: 1, roles: {}, policy: DEFAULT_POLICY });
    assert.deepEqual(validateWorkflow({ schemaVersion: 1, roles: { teacher: 'high' } }), { schemaVersion: 1, roles: { teacher: 'high', extractor: 'high' }, policy: DEFAULT_POLICY });
    const next = createStagedWorkflow({ roles: { teacher: 'high', executor: 'low', reviewer: 'review' } });
    assert.equal(next.schemaVersion, 2);
    assert.deepEqual(next.execution, DEFAULT_STAGE_EXECUTION);
    assert.deepEqual(next.policy, DEFAULT_STAGED_POLICY);
    assert.equal(next.policy.maxCalls, 48); assert.equal(next.policy.maxRenderCalls, 64);
    assert.equal(next.policy.reviewSamples, 2);
    assert.equal(next.roles.extractor, 'high');
    assert.throws(() => validateWorkflow({ schemaVersion: 1, execution: {} }), /Unknown workflow/);
});

test('staged configuration rejects impossible reviewer reserves and contradictory independence policies', () => {
    for (const fields of [
        { policy: { reviewSamples: 1 } }, { policy: { maxCalls: 2 } },
        { policy: { maxDurationMs: 1_000_000 } }, { policy: { allowTeacherAssistance: true } },
        { execution: { reviewerTimeoutMs: 0 } }, { execution: { maxStageRevisions: 0 } },
        { execution: { protocol: 'latest' } }, { execution: { maxPreviewJobs: -1 } },
        { execution: { unknown: 'ignored' } }, { execution: { reserveOverheadMs: -1 } },
        { execution: { minPrototypeShots: 0 } }, { execution: { minPrototypeShots: 21 } },
        { execution: { prototypeRequirements: ['motion', 'motion'] } }, { execution: { prototypeRequirements: 'none' } },
    ]) assert.throws(() => createStagedWorkflow(fields), { code: 'CONFIG_INVALID' });
    assert.equal(createStagedWorkflow({ execution: { feedbackMode: 'guided' }, policy: { allowTeacherAssistance: true } }).execution.feedbackMode, 'guided');
    assert.deepEqual(createStagedWorkflow({ execution: { prototypeRequirements: [], minPrototypeShots: 1 } }).execution.prototypeRequirements, []);
});

test('final submission limit retains an explicit maxAttempts alias without two contradictory ceilings', () => {
    const oldName = createStagedWorkflow({ policy: { maxAttempts: 2 } });
    assert.equal(oldName.execution.maxFinalSubmissions, 2);
    const nextName = createStagedWorkflow({ execution: { maxFinalSubmissions: 4 } });
    assert.equal(nextName.policy.maxAttempts, 4);
    assert.throws(() => createStagedWorkflow({ policy: { maxAttempts: 2 }, execution: { maxFinalSubmissions: 3 } }), /must agree/);
});

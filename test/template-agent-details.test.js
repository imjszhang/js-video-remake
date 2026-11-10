import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentProviderDetails, agentChoiceLabel, recentAgentModels } from '../src/template-agent-details.js';

test('Claude settings expose only provider origin and configured model, never credentials', async () => {
    const target = { harness: { adapter: 'claude-code' }, backend: { auth: 'claude-config', model: 'configured' } };
    const details = await agentProviderDetails({}, target, { readJson: async () => ({ env: {
        ANTHROPIC_BASE_URL: 'https://username:password@proxy.example.invalid/private-token?key=secret',
        ANTHROPIC_AUTH_TOKEN: 'auth-secret', ANTHROPIC_MODEL: 'configured-model',
    } }) });
    assert.equal(details.provider, 'proxy.example.invalid');
    assert.equal(details.providerUrl, 'https://proxy.example.invalid');
    assert.equal(details.configuredModel, 'configured-model');
    assert.equal(details.actualModel, undefined);
    assert.match(agentChoiceLabel(details), /configured-model（配置）/);
    for (const secret of ['username', 'password', 'private-token', 'secret', 'ANTHROPIC_AUTH_TOKEN']) assert(!JSON.stringify(details).includes(secret));
});

test('unspecified configured model remains unknown until a real response is recorded', async () => {
    const details = await agentProviderDetails({}, { harness: { adapter: 'claude-code' }, backend: { auth: 'claude-config', model: 'configured' } }, { readJson: async () => ({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' } }) });
    assert.equal(details.configuredModel, null);
    assert.match(agentChoiceLabel(details), /模型尚未确认/);
    assert.match(agentChoiceLabel({ ...details, actualModel: 'returned-model' }), /returned-model（最近返回）/);
});

test('last successful response model is selected per target and harness; failures are not evidence', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-display-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { workspace: path.join(root, 'project'), env: { VIDEO_REMAKE_AGENT_HOME: path.join(root, 'state') } };
    await fs.mkdir(config.workspace);
    const target = { name: 'claude', harness: { adapter: 'claude-code' } };
    for (const [id, status, model, adapter] of [
        ['r_100_old', 'completed', 'old-model', 'claude-code'],
        ['r_200_latest', 'completed', 'actual-model', 'claude-code'],
        ['r_300_failure', 'failed', 'failed-model', 'claude-code'],
        ['r_400_other', 'completed', 'other-model', 'codex'],
        ['r_500_missing', 'completed', null, 'claude-code'],
    ]) {
        const dir = path.join(root, 'state', id); await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ id, target: 'claude', status, finishedAt: '2026-01-01T00:00:00Z', execution: { responseModel: model } }));
        await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify({ target: { harness: { adapter } } }));
    }
    const result = await recentAgentModels(config, [target]);
    assert.deepEqual(result.get('claude'), { actualModel: 'actual-model', actualModelAt: '2026-01-01T00:00:00Z', actualModelRunId: 'r_200_latest' });
    assert.equal((await recentAgentModels(config, [{ ...target, name: 'new-target' }])).size, 0);
});

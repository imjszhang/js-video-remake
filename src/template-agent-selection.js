import path from 'node:path';
import { plan } from 'js-agent-runtime';
import { selectAgentTarget, agentStorageRoot } from './agent-config.js';
import { displayModel } from './template-agent-details.js';
import { providerBackend } from './template-providers.js';
import { appError } from './errors.js';

export function combineAgent(config, settings, { target, providerTarget, model } = {}) {
    const harness = selectAgentTarget(settings, target, { requireEnabled: true }).target;
    const managed = settings.providers?.find(item => item.id === (providerTarget || harness.name));
    const provider = managed ? { backend: providerBackend(managed) } : selectAgentTarget(settings, providerTarget || harness.name, { requireEnabled: true }).target;
    if (model !== undefined && model !== '' && !displayModel(model) && model !== 'configured') throw appError('INVALID_INPUT', '模型 ID 无效，请填写不含空格的模型名称。');
    const combined = { name: harness.name, harness: { ...harness.harness }, backend: { ...provider.backend, model: model || provider.backend.model } };
    // Project-mode Claude reads local provider settings; API connections use isolated settings.
    if (combined.harness.adapter === 'claude-code' && combined.backend.auth !== 'claude-config') combined.harness.contextMode = 'snapshot';
    try {
        plan({ runId: 'template-selection', workspace: config.workspace, prompt: 'Validate selection', target: combined, timeoutMs: settings.timeoutMs, stateDir: path.join(agentStorageRoot(config), 'selection-check', 'state') });
    } catch {
        throw appError('INVALID_INPUT', '所选 Harness 与 Provider 的接口协议或认证方式不兼容，请选择兼容的组合。');
    }
    return combined;
}

export function providerGroups(settings) {
    const groups = new Map();
    for (const target of settings.targets.filter(item => item.enabled)) {
        const { model, ...connection } = target.backend;
        const key = JSON.stringify(Object.entries(connection).sort(([a], [b]) => a.localeCompare(b)));
        if (!groups.has(key)) groups.set(key, { id: target.name, names: [], models: [] });
        const group = groups.get(key);
        group.names.push(target.name);
        if (!group.models.includes(model)) group.models.push(model);
    }
    return [...groups.values()];
}

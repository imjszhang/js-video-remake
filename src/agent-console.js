import { eventLog } from './template-job-log.js';
import { providerGroups } from './template-agent-selection.js';

const ACTIVE = new Set(['preparing', 'running']);
const HARNESS = { codex: 'Codex', 'claude-code': 'Claude Code', 'deepseek-harness': 'DeepSeek Harness' };
const PROVIDER = { deepseek: 'DeepSeek', 'deepseek-local': 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic' };
const AUTH = { chatgpt: 'ChatGPT 订阅', 'claude-config': 'Claude 本机登录', 'api-key': 'API' };

/** Public description of one configured agent. Paths, keys and service addresses stay out. */
export function describeAgentTarget(target, { defaultName } = {}) {
    if (!target || typeof target.name !== 'string') return null;
    const harness = HARNESS[target.harness?.adapter] || target.harness?.adapter || '未知执行器';
    const named = typeof target.backend?.provider === 'string' ? target.backend.provider : '';
    const provider = PROVIDER[named] || named || AUTH[target.backend?.auth] || '未标明服务';
    const rawModel = typeof target.backend?.model === 'string' ? target.backend.model : '';
    const model = rawModel === 'configured' || !rawModel ? '客户端当前模型' : rawModel;
    const isDefault = target.name === defaultName;
    return { name: target.name, harness, provider, model, label: `${harness} · ${provider} · ${model}`, default: isDefault };
}

export function agentExecutionCatalog(settings) {
    const targets = describeAgentTargets(settings);
    const enabled = (settings?.targets || []).filter(item => item?.enabled);
    const managed = Array.isArray(settings?.providers) ? settings.providers : [];
    const providers = providerGroups({ targets: enabled, providers: managed })
        .filter(group => !managed.some(item => item.id === group.id))
        .map(group => {
            const sample = enabled.find(item => item.name === group.id);
            const described = describeAgentTarget(sample || { name: group.id });
            return { id: group.id, label: described?.provider || group.id, models: group.models.filter(model => typeof model === 'string' && model), harnesses: [] };
        });
    for (const item of managed) {
        if (!item || typeof item.id !== 'string') continue;
        providers.push({ id: item.id, label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.id, models: Array.isArray(item.models) ? item.models.filter(model => typeof model === 'string') : [], harnesses: [] });
    }
    const harnesses = [];
    for (const item of targets) {
        const source = enabled.find(entry => entry.name === item.name);
        const adapter = source?.harness?.adapter || item.harness;
        const existing = harnesses.find(entry => entry.adapter === adapter);
        if (existing) existing.names.push(item.name);
        else harnesses.push({ name: item.name, adapter, label: item.harness, names: [item.name] });
    }
    return { harnesses, providers, targets, defaultTarget: typeof settings?.defaultTarget === 'string' ? settings.defaultTarget : null };
}

export function describeAgentTargets(settings) {
    const defaultName = typeof settings?.defaultTarget === 'string' ? settings.defaultTarget : '';
    return (settings?.targets || [])
        .filter(item => item?.enabled)
        .map(item => describeAgentTarget(item, { defaultName }))
        .filter(Boolean);
}

/** Turn a saved event log into short terminal lines. Secrets and reasoning stay out. */
export function formatAgentConsole(text, limit = 80) {
    const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 80;
    const lines = [];
    for (const row of String(text || '').split(/\n/)) {
        if (!row.trim()) continue;
        let event;
        try { event = JSON.parse(row); }
        catch { continue; }
        const entry = eventLog(event);
        if (!entry?.text) continue;
        const compact = entry.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 2).join(' · ').slice(0, 320);
        if (!compact || lines.at(-1) === compact) continue;
        lines.push(entry.kind === 'tool' ? `$ ${compact}` : compact);
    }
    return lines.slice(-count);
}

export function agentLaunchState(activity) {
    return {
        running: Boolean(activity && ACTIVE.has(activity.status)),
        canContinue: Boolean(activity?.runId) && !ACTIVE.has(activity?.status),
        canCancel: Boolean(activity?.runId) && ACTIVE.has(activity?.status),
    };
}

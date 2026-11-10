import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentStorageRoot } from './agent-config.js';
import { templateAgentLabel } from './template-agent-label.js';

export function displayModel(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,159}$/.test(value) && value !== 'configured' ? value : null;
}
function endpoint(value) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol)) return null;
        // Provider display never includes credentials, request paths or query parameters.
        return { provider: url.host, providerUrl: url.origin };
    } catch { return null; }
}
async function readJson(file) {
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { return null; }
}

/** Whitelisted display fields only. No credential fields leave this function. */
export async function agentProviderDetails(config, target, deps = {}) {
    const base = templateAgentLabel(target);
    const backend = target.backend || {};
    let provider = endpoint(backend.baseURL);
    let configuredModel = displayModel(backend.model);
    let configurationSource = '项目执行配置';
    if (backend.auth === 'claude-config') {
        const settings = await (deps.readJson || readJson)(path.join(backend.claudeConfigDir || path.join(os.homedir(), '.claude'), 'settings.json'));
        configurationSource = 'Claude Code 本机配置';
        provider = endpoint(settings?.env?.ANTHROPIC_BASE_URL);
        if (['1', 'true', true].includes(settings?.env?.CLAUDE_CODE_USE_BEDROCK)) provider = { provider: 'Amazon Bedrock', providerUrl: null };
        else if (['1', 'true', true].includes(settings?.env?.CLAUDE_CODE_USE_VERTEX)) provider = { provider: 'Google Vertex AI', providerUrl: null };
        else if (['1', 'true', true].includes(settings?.env?.CLAUDE_CODE_USE_FOUNDRY)) provider = { provider: 'Microsoft Foundry', providerUrl: null };
        provider ||= { provider: settings?.env?.ANTHROPIC_BASE_URL ? 'Provider 地址无效' : settings ? 'Anthropic（默认接口）' : '未能读取本机 Provider', providerUrl: null };
        configuredModel ||= displayModel(settings?.env?.ANTHROPIC_MODEL) || displayModel(settings?.model);
    } else if (backend.auth === 'chatgpt') provider = { provider: 'OpenAI / ChatGPT', providerUrl: null };
    else if (backend.auth === 'claude-subscription') provider = { provider: 'Anthropic / Claude 订阅', providerUrl: null };
    provider ||= { provider: displayModel(backend.provider) || '未记录 Provider', providerUrl: null };
    return { ...base, ...provider, configuredModel, configurationSource };
}

/** A past response is evidence of that run, never a promise about the next request. */
export async function recentAgentModels(config, targets) {
    const result = new Map();
    const root = agentStorageRoot(config);
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return result; }
    for (const entry of entries.filter(item => item.isDirectory() && /^r_[\w-]+$/.test(item.name)).sort((a, b) => b.name.localeCompare(a.name))) {
        const record = await readJson(path.join(root, entry.name, 'run.json'));
        const model = displayModel(record?.execution?.responseModel);
        if (record?.status !== 'completed' || !model || result.has(record.target)) continue;
        const target = targets.find(item => item.name === record.target);
        if (!target) continue;
        const task = await readJson(path.join(root, entry.name, 'task.json'));
        if (task?.target?.harness?.adapter !== target.harness.adapter) continue;
        if (target.backend && ['auth', 'provider', 'baseURL', 'apiKeyEnv', 'claudeConfigDir', 'codexHome'].some(key => task?.target?.backend?.[key] !== target.backend[key])) continue;
        result.set(record.target, { actualModel: model, actualModelAt: record.finishedAt || record.createdAt, actualModelRunId: record.id });
        if (result.size === targets.length) break;
    }
    return result;
}

export function agentChoiceLabel(details) {
    const model = details.actualModel ? `${details.actualModel}（最近返回）` : details.configuredModel ? `${details.configuredModel}（配置）` : '模型尚未确认';
    return `${details.harness} · ${details.provider} · ${model}`;
}

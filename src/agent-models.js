import { loadAgentConfig, selectAgentTarget } from './agent-config.js';
import { agentCredentialEnvironment } from './agent-credentials.js';
import { discoverCodexModels } from './codex-models.js';
import { discoverClaudeModels } from './claude-models.js';
import { displayModel } from './template-agent-details.js';
import { readTemplateProviders } from './template-providers.js';
import { httpFetch } from './http.js';
import { appError } from './errors.js';

function modelListUrls(baseURL, protocol) {
    const url = new URL(baseURL);
    const primary = new URL(url.href);
    let prefix = primary.pathname.replace(/\/$/, '');
    if (!prefix) prefix = '/v1';
    else if (protocol === 'anthropic-messages' && !/\/v\d+(?:beta\d*)?$/.test(prefix)) prefix += '/v1';
    primary.pathname = `${prefix}/models`;
    primary.search = '';
    primary.hash = '';
    const urls = [primary.href];
    for (const extra of [`${url.origin}/models`, `${url.origin}/v1/models`]) {
        if (!urls.includes(extra)) urls.push(extra);
    }
    return urls;
}

async function readModelPage(fetchImpl, href, headers, apiKey) {
    const response = await fetchImpl(href, { method: 'GET', headers, redirect: 'manual' });
    if (!response.ok) {
        await response.body?.cancel?.();
        return null;
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) return null;
    const models = [];
    for (const item of data.data) {
        const id = displayModel(item?.id);
        if (!id || id.includes(apiKey)) continue;
        models.push({ id, label: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id });
        if (models.length >= 50) break;
    }
    return models.length ? models : null;
}

async function listApiModels(config, target, deps) {
    const env = await agentCredentialEnvironment(config, target);
    const apiKey = env[target.backend.apiKeyEnv];
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
        throw appError('AGENT_MODELS_FAILED', '没有读取到这个 Provider 的密钥，暂时只能使用已配置的模型。');
    }
    const headers = target.backend.protocol === 'anthropic-messages'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' }
        : { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    const fetchImpl = httpFetch(config.proxy, deps.fetchImpl);
    for (const href of modelListUrls(target.backend.baseURL, target.backend.protocol)) {
        try {
            const models = await readModelPage(fetchImpl, href, headers, apiKey);
            if (models) return { models, source: 'api-models' };
        } catch { /* 换下一个模型列表地址。 */ }
    }
    throw appError('AGENT_MODELS_FAILED', '这个 Provider 没有返回可选模型，仍可使用已配置的模型或自定义 ID。');
}

function configuredModels(target) {
    const id = displayModel(target?.backend?.model) || (target?.backend?.model === 'configured' ? 'configured' : null);
    return id ? [{ id, label: id === 'configured' ? '客户端当前模型' : id }] : [];
}

/** Ask the selected connection which models it can run. Credentials never leave this function. */
export async function listConnectionModels(config, { target, providerTarget } = {}, deps = {}) {
    const settings = await loadAgentConfig(config);
    settings.providers = await readTemplateProviders(config);
    const providerName = providerTarget || target;
    const managed = settings.providers.find(item => item.id === providerName);
    if (managed?.apiKey && managed.baseURL) {
        const synthetic = { backend: { auth: 'api-key', protocol: managed.protocol, baseURL: managed.baseURL, apiKeyEnv: managed.keyRef, model: managed.models?.[0] } };
        try {
            const listed = await listApiModels(config, synthetic, deps);
            return { ...listed, models: mergeModels(managed.models, listed.models) };
        } catch (error) {
            return { models: (managed.models || []).map(id => ({ id, label: id })), source: 'configured', error: error.message };
        }
    }
    const selected = selectAgentTarget(settings, providerName, { requireEnabled: true }).target;
    const fallback = configuredModels(selected);
    try {
        if (selected.harness.adapter === 'codex' && selected.backend.auth === 'chatgpt') {
            const listed = await (deps.discoverCodexModels || discoverCodexModels)(config, providerName, deps);
            return { ...listed, models: mergeModels(fallback.map(item => item.id), listed.models) };
        }
        if (selected.harness.adapter === 'claude-code' && selected.backend.auth === 'claude-config') {
            const listed = await (deps.discoverClaudeModels || discoverClaudeModels)(config, providerName, deps);
            return { ...listed, models: mergeModels(fallback.map(item => item.id), listed.models) };
        }
        if (selected.backend.auth === 'api-key' && selected.backend.baseURL) {
            const listed = await listApiModels(config, selected, deps);
            return { ...listed, models: mergeModels(fallback.map(item => item.id), listed.models) };
        }
    } catch (error) {
        return { models: fallback, source: 'configured', error: error.message };
    }
    return { models: fallback, source: 'configured' };
}

function mergeModels(preferred, discovered) {
    const models = new Map();
    for (const id of preferred || []) {
        if (id === 'configured' || displayModel(id)) models.set(id, { id, label: id === 'configured' ? '客户端当前模型' : id });
    }
    for (const item of discovered || []) {
        if (!item?.id || models.has(item.id)) continue;
        models.set(item.id, { id: item.id, label: item.label || item.id });
    }
    return [...models.values()].slice(0, 50);
}

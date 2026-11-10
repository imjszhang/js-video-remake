import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError } from './errors.js';
import { displayModel } from './template-agent-details.js';

const filename = '.env.agent.providers.json';
const invalid = message => appError('INVALID_INPUT', message);
export async function readTemplateProviders(config) {
    const file = path.join(config.workspace, filename);
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw invalid('Provider 配置文件必须是本机普通文件，且不超过 256 KiB。');
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.providers)) throw invalid('Provider 配置格式无效。');
        return data.providers;
    } catch (error) { if (error.code === 'ENOENT') return []; throw invalid('无法读取本机 Provider 配置，请检查文件格式与访问权限。'); }
}
export function providerBackend(item) {
    return { auth: 'api-key', provider: item.id, protocol: item.protocol, baseURL: item.baseURL, apiKeyEnv: item.keyRef, model: item.models[0] };
}
export function publicProvider(item) {
    return { id: item.id, label: item.label, baseURL: item.baseURL, protocol: item.protocol, models: item.models, hasApiKey: Boolean(item.apiKey), managed: true };
}
export async function saveTemplateProvider(config, body, knownIds = []) {
    if (!body || typeof body !== 'object') throw invalid('请填写 Provider 信息。');
    const providers = await readTemplateProviders(config);
    const existing = providers.find(item => item.id === body.id);
    if (body.id && !existing && !knownIds.includes(body.id)) throw invalid('找不到要编辑的 Provider，请刷新后重试。');
    const id = body.id || `provider-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw invalid('Provider 标识无效。');
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80 || /[\x00-\x1f]/.test(body.label)) throw invalid('请填写 1–80 字的 Provider 名称。');
    if (!['responses', 'anthropic-messages', 'chat-completions'].includes(body.protocol)) throw invalid('请选择支持的接口协议。');
    let url;
    try { url = new URL(body.baseURL); } catch { throw invalid('请填写完整的 API 接口地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || typeof body.baseURL !== 'string' || body.baseURL.length > 2000) throw invalid('接口地址必须是 HTTP(S) 地址，不能包含账号、密码、查询参数或片段。');
    const baseURL = url.href.replace(/\/$/, '');
    const models = Array.isArray(body.models) ? [...new Set(body.models)] : [];
    if (!models.length || models.length > 50 || models.some(value => !displayModel(value))) throw invalid('请填写 1–50 个有效模型 ID，每行一个。');
    if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(body.apiKey))) throw invalid('API Key 不能包含空格或换行，长度不能超过 8192。');
    if (!body.apiKey && existing && (existing.baseURL !== baseURL || existing.protocol !== body.protocol)) throw invalid('修改接口地址或协议时，请重新填写 API Key，确认用于新的连接。');
    const apiKey = body.apiKey || existing?.apiKey;
    if (!apiKey) throw invalid('请填写 API Key。已有本机连接首次在网页保存时，也需要填写密钥。');
    const item = { id, label: body.label.trim(), baseURL, protocol: body.protocol, models, keyRef: existing?.keyRef || `REMAKE_PROVIDER_${randomUUID().replaceAll('-', '').toUpperCase()}`, apiKey };
    const next = [...providers.filter(entry => entry.id !== id), item];
    const data = JSON.stringify({ version: 1, providers: next }, null, 4);
    if (Buffer.byteLength(data) > 256 * 1024) throw invalid('Provider 配置总量超过限制。');
    const file = path.join(config.workspace, filename);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return publicProvider(item);
}

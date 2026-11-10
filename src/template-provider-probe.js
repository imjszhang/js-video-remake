import { readTemplateProviders } from './template-providers.js';
import { displayModel } from './template-agent-details.js';
import { appError } from './errors.js';
const invalid = message => appError('INVALID_INPUT', message);

export async function probeTemplateProvider(config, body, deps = {}) {
    if (!body || !['responses', 'anthropic-messages', 'chat-completions'].includes(body.protocol)) throw invalid('请选择接口协议。');
    let url;
    try { url = new URL(body.baseURL); } catch { throw invalid('请填写完整接口地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || typeof body.baseURL !== 'string' || body.baseURL.length > 2000) throw invalid('接口地址必须是 HTTP(S)，不能包含账号、密码、查询参数或片段。');
    const baseURL = url.href.replace(/\/$/, '');
    const saved = (await readTemplateProviders(config)).find(item => item.id === body.id);
    if (!body.apiKey && saved && (saved.baseURL !== baseURL || saved.protocol !== body.protocol)) throw invalid('接口地址或协议已改变，请重新填写 API Key 后再测试。');
    const apiKey = body.apiKey || saved?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(apiKey)) throw invalid('请填写有效 API Key，或选择已保存密钥的 Provider。');
    // The configured URL is an API base, not a completion endpoint. Preserve custom prefixes.
    let prefix = url.pathname.replace(/\/$/, '');
    if (!prefix) prefix = '/v1';
    else if (body.protocol === 'anthropic-messages' && !/\/v\d+(?:beta\d*)?$/.test(prefix)) prefix += '/v1';
    url.pathname = `${prefix}/models`;
    const headers = body.protocol === 'anthropic-messages'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' }
        : { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.providerProbeTimeoutMs || 15000);
    const started = Date.now();
    try {
        const response = await (deps.fetchImpl || fetch)(url.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
        if (!response.ok) {
            await response.body?.cancel();
            const status = response.status;
            const reason = status === 401 || status === 403 ? '密钥无效或没有访问权限' : status === 404 || status === 405 ? '未提供兼容的模型列表接口，请检查接口地址；也可以手动填写模型' : status === 429 ? '请求过于频繁或额度受限，请稍后重试' : status >= 300 && status < 400 ? '接口返回重定向，未向新地址转发密钥，请填写最终 API 地址' : '服务暂时不可用';
            throw invalid(`连接未通过：HTTP ${status}，${reason}。`);
        }
        if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) { await response.body?.cancel(); throw invalid('模型列表响应过大，请检查接口。'); }
        const reader = response.body?.getReader();
        if (!reader) throw invalid('接口没有返回模型列表。');
        const chunks = []; let size = 0;
        try {
            while (true) {
                const { value, done } = await reader.read(); if (done) break;
                size += value.length;
                if (size > 2 * 1024 * 1024) { await reader.cancel(); throw invalid('模型列表响应过大，请检查接口。'); }
                chunks.push(Buffer.from(value));
            }
        } finally { reader.releaseLock(); }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('接口返回的不是模型列表 JSON，请检查是否填写了网页地址。'); }
        if (!Array.isArray(data.data)) throw invalid('接口返回格式不兼容，未找到模型列表；仍可手动填写模型。');
        const all = [...new Set(data.data.map(item => displayModel(item?.id)).filter(value => value && !value.includes(apiKey)))];
        if (!all.length) throw invalid('接口已响应，但没有返回可选模型，请检查账户权限或手动填写。');
        return { ok: true, models: all.slice(0, 50), partial: Boolean(data.has_more || all.length > 50), elapsedMs: Date.now() - started, message: '连接已通过：模型列表接口可访问。尚未验证模型生成权限或实际推理能力。' };
    } catch (error) {
        if (error.code === 'INVALID_INPUT') throw error;
        throw invalid(controller.signal.aborted ? '连接超时，请检查接口地址或稍后重试。' : '连接失败，请检查网络、接口地址及 HTTPS 证书。');
    } finally { clearTimeout(timer); }
}

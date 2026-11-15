import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadAgentConfig, selectAgentTarget } from './agent-config.js';
import { displayModel } from './template-agent-details.js';
import { appError } from './errors.js';

// Only protocol responses are exposed; stderr and account credentials stay private.
export async function discoverCodexModels(config, name, deps = {}) {
    const settings = await loadAgentConfig(config);
    const { target } = selectAgentTarget(settings, name, { requireEnabled: true });
    if (target.harness.adapter !== 'codex' || target.backend.auth !== 'chatgpt') {
        throw appError('INVALID_INPUT', '账号模型发现仅支持 Codex CLI 的 ChatGPT 登录连接。');
    }
    const args = ['--no-daemon', 'app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"', '-c', 'analytics.enabled=false'];
    const env = { ...process.env, ...config.env, ...(target.backend.codexHome ? { CODEX_HOME: target.backend.codexHome } : {}) };
    const child = (deps.spawn || spawn)(target.harness.executable, args, { cwd: config.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let sequence = 0;
    let bytes = 0;
    let fatal;
    const pending = new Map();
    const fail = () => {
        fatal = appError('AGENT_MODELS_FAILED', '无法读取 Codex 账号模型列表，请检查系统 Codex 登录状态和连接后重试。');
        for (const { reject } of pending.values()) reject(fatal);
        pending.clear();
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
        bytes += Buffer.byteLength(line);
        if (bytes > 4 * 1024 * 1024) { fail(); child.kill(); return; }
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(appError('AGENT_MODELS_FAILED', 'Codex 模型查询失败，请检查登录状态或升级 Codex。'));
        else entry.resolve(message.result);
    });
    child.stderr.resume();
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    const timer = setTimeout(() => { fail(); child.kill(); }, deps.timeoutMs || 20000);
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method, params) => new Promise((resolve, reject) => {
        if (fatal) return reject(fatal);
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
    });
    try {
        await request('initialize', { clientInfo: { name: 'video_remake', version: '0.3.0' }, capabilities: {} });
        send({ method: 'initialized' });
        const account = await request('account/read', { refreshToken: false });
        if (!account?.account || account.account.type !== 'chatgpt') throw appError('AGENT_MODELS_FAILED', '系统 Codex 尚未登录 ChatGPT 账号。');
        const models = new Map();
        let cursor;
        const cursors = new Set();
        do {
            const page = await request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
            if (!Array.isArray(page?.data)) throw appError('AGENT_MODELS_FAILED', 'Codex 返回的模型列表格式无效。');
            for (const item of page.data) {
                if (!item.hidden && displayModel(item.model)) models.set(item.model, { id: item.model, label: typeof item.displayName === 'string' ? item.displayName : item.model, isDefault: item.isDefault === true });
            }
            cursor = page.nextCursor;
            if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw appError('AGENT_MODELS_FAILED', 'Codex 模型列表分页异常，请重试。');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        if (!models.size) throw appError('AGENT_MODELS_FAILED', '当前 Codex 账号未返回可选模型，可使用自定义模型 ID。');
        return { models: [...models.values()], source: 'codex-account', fetchedAt: new Date().toISOString() };
    } finally {
        clearTimeout(timer);
        lines.close();
        child.stdin.end();
        child.kill();
        const force = setTimeout(() => child.kill('SIGKILL'), 1000);
        force.unref();
        child.once('exit', () => clearTimeout(force));
    }
}

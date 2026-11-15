import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadAgentConfig, selectAgentTarget } from './agent-config.js';
import { displayModel } from './template-agent-details.js';
import { appError } from './errors.js';

export async function discoverClaudeModels(config, name, deps = {}) {
    const settings = await loadAgentConfig(config);
    const { target } = selectAgentTarget(settings, name, { requireEnabled: true });
    if (target.harness.adapter !== 'claude-code' || target.backend.auth !== 'claude-config') throw appError('INVALID_INPUT', 'Claude 模型发现需要本机 Claude 配置连接。');
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', target.harness.contextMode === 'project' ? 'user,project,local' : 'user', '--tools', ''];
    const child = (deps.spawn || spawn)(target.harness.executable, args, { cwd: config.workspace, env: { ...process.env, ...config.env, ...(target.backend.claudeConfigDir ? { CLAUDE_CONFIG_DIR: target.backend.claudeConfigDir } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    let timer;
    try {
        return await new Promise((resolve, reject) => {
            const fail = () => reject(appError('AGENT_MODELS_FAILED', '无法读取 Claude 模型列表，请检查本机登录、连接和 CLI 版本。'));
            timer = setTimeout(fail, deps.timeoutMs || 20000);
            child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
            let bytes = 0;
            lines.on('line', line => {
                bytes += Buffer.byteLength(line);
                if (bytes > 4 * 1024 * 1024) return fail();
                let message;
                try { message = JSON.parse(line); } catch { return; }
                if (message.type !== 'control_response' || message.response?.request_id !== 'models') return;
                const response = message.response;
                if (response.subtype !== 'success' || !Array.isArray(response.response?.models)) return fail();
                const models = new Map();
                for (const item of response.response.models) {
                    const id = displayModel(item.resolvedModel) || displayModel(item.value);
                    if (id && !item.disabled) models.set(id, { id, label: typeof item.displayName === 'string' ? item.displayName : id });
                }
                if (!models.size) return fail();
                resolve({ models: [...models.values()], source: 'claude-session', fetchedAt: new Date().toISOString() });
            });
            // Initialization only: no user message, tool invocation, or generation request.
            child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`);
        });
    } finally {
        clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
        const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
        child.once('exit', () => clearTimeout(force));
    }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from './errors.js';
import { parseHubUrl, probeHub, readHubToken } from './media/mcp-hub.js';

export const AGENT_HUB_TOKEN_REF = 'VIDEO_REMAKE_MCP_HUB_TOKEN';
export const AGENT_HUB_READ_TOOLS = Object.freeze([
    'server_info', 'search_templates', 'get_template', 'nodes', 'validate_workflow',
    'list_workflow_slots', 'list_workflow_notes', 'job', 'list_assets',
]);
export const AGENT_HUB_ALL_TOOLS = Object.freeze([
    ...AGENT_HUB_READ_TOOLS, 'put_asset', 'fetch_template', 'set_workflow_slot', 'upload_file',
    'run_workflow', 'run_template', 'generate_image', 'fetch_outputs',
]);
const ADAPTERS = new Set(['codex', 'claude-code', 'deepseek-harness']);

function invalid(message) {
    return appError('CONFIG_INVALID', message);
}

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// A plan may refer to a token that has not been created. Existing components
// must already be safe; checking ancestors prevents a missing leaf from hiding
// an existing symlink that points outside the project.
async function checkComponents(root, file, allowMissing) {
    let current = root;
    const parts = path.relative(root, file).split(path.sep);
    for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) {
            if (error.code === 'ENOENT' && allowMissing) return;
            throw invalid('无法检查项目 Hub 令牌路径。');
        }
        if (stat.isSymbolicLink()) throw invalid('项目 Hub 令牌及其父目录不能是符号链接。');
        if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
            throw invalid('项目 Hub 令牌必须是普通文件，父路径必须是目录。');
        }
    }
}

async function projectTokenPath(workspace, value) {
    if (typeof workspace !== 'string' || typeof value !== 'string' || !value.trim() || value.includes('\0')) {
        throw invalid('请配置当前项目内的 hubTokenFile。');
    }
    const suppliedRoot = path.resolve(workspace);
    let root;
    try { root = await fs.realpath(suppliedRoot); }
    catch { throw invalid('无法读取项目工作目录。'); }
    const supplied = path.resolve(suppliedRoot, value);
    const file = inside(suppliedRoot, supplied)
        ? path.resolve(root, path.relative(suppliedRoot, supplied)) : supplied;
    if (!inside(root, file)) throw invalid('Hub 令牌文件必须位于当前项目内。');
    await checkComponents(root, file, true);
    return file;
}

function hubServer(value) {
    const parsed = parseHubUrl(value);
    if (parsed.service !== 'comfyui') throw invalid('Agent 首版仅支持 /mcp/comfyui 专用服务入口。');
    return parsed;
}

export async function planAgentHub(config, mcpSetting, target) {
    if (mcpSetting === undefined) return undefined;
    if (!mcpSetting || typeof mcpSetting !== 'object' || Array.isArray(mcpSetting)
        || Object.keys(mcpSetting).some((key) => key !== 'projectHub')
        || (mcpSetting.projectHub !== undefined && typeof mcpSetting.projectHub !== 'boolean')) {
        throw invalid('Agent mcp 只能设置布尔值 projectHub。');
    }
    if (mcpSetting.projectHub !== true) return undefined;
    if (config.media?.video?.provider !== 'comfy-mcp') {
        throw invalid('项目 Hub 接入要求 media.video.provider 为 comfy-mcp。');
    }
    if (!ADAPTERS.has(target?.harness?.adapter)) {
        throw invalid('当前 Agent 类型尚不支持项目 MCP Hub。');
    }
    if (target.backend?.apiKeyEnv === AGENT_HUB_TOKEN_REF) {
        throw invalid('模型密钥引用不能与项目 Hub 设备令牌引用相同。');
    }
    const permission = target.harness.permission;
    if (!['read-only', 'workspace-write', 'bypass'].includes(permission)) {
        throw invalid('项目 Hub 接入需要有效的 Agent 权限配置。');
    }
    let parsed;
    try { parsed = hubServer(config.media.video.settings?.hubUrl); }
    catch { throw invalid('项目 Hub 地址必须为无凭据、查询参数及片段的 HTTP(S) /mcp/comfyui。'); }
    const tokenFile = await projectTokenPath(config.workspace, config.media.video.settings?.hubTokenFile);
    return {
        server: {
            name: 'comfy-hub', url: parsed.url, bearerTokenRef: AGENT_HUB_TOKEN_REF,
            enabledTools: [...(permission === 'read-only' ? AGENT_HUB_READ_TOOLS : AGENT_HUB_ALL_TOOLS)],
        },
        tokenFile,
    };
}

function checkedServer(server) {
    if (!server || server.name !== 'comfy-hub' || server.bearerTokenRef !== AGENT_HUB_TOKEN_REF) throw new Error();
    const { url } = hubServer(server.url);
    const enabledTools = server.enabledTools;
    if (!Array.isArray(enabledTools) || ![AGENT_HUB_READ_TOOLS, AGENT_HUB_ALL_TOOLS].some((tools) =>
        tools.length === enabledTools.length && tools.every((tool, index) => tool === enabledTools[index]))) throw new Error();
    return { name: 'comfy-hub', url, bearerTokenRef: AGENT_HUB_TOKEN_REF, enabledTools: [...enabledTools] };
}

export async function loadAgentHub(hubPlan, { fetchImpl = fetch, signal } = {}) {
    if (hubPlan === undefined) return undefined;
    try {
        signal?.throwIfAborted();
        const server = checkedServer(hubPlan.server);
        const tokenFile = hubPlan.tokenFile;
        if (typeof tokenFile !== 'string' || !path.isAbsolute(tokenFile)) throw new Error();
        // Recheck all components of the canonical plan path before execution so
        // replacing a project directory with a symlink cannot redirect the read.
        await checkComponents(path.parse(tokenFile).root, tokenFile, false);
        const token = await readHubToken(tokenFile);
        signal?.throwIfAborted();
        const readiness = await probeHub({ hubUrl: server.url, hubTokenFile: tokenFile }, {
            fetchImpl, signal, token, requiredTools: server.enabledTools,
        });
        signal?.throwIfAborted();
        return {
            token, server,
            summary: { name: server.name, service: 'comfyui', url: server.url, tools: server.enabledTools.length, version: readiness.version },
        };
    } catch {
        throw appError('AGENT_HUB_NOT_READY', '项目 MCP Hub 检查未通过；请检查设备令牌文件、工具权限、ComfyUI 桥接和远端状态。');
    }
}

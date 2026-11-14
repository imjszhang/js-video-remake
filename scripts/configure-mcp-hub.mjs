#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from '../src/config.js';
import { parseHubUrl, readHubToken } from '../src/media/mcp-hub.js';

const execFileAsync = promisify(execFile);
const SERVER = 'comfy-hub';
const CODEX_MARKER = '# Managed by scripts/configure-mcp-hub.mjs; private project configuration.';
const TARGETS = ['.codex/config.toml', '.mcp.json', '.cursor/mcp.json'];
const MAX_CONFIG_BYTES = 1024 * 1024;
const HELP = `用法：node scripts/configure-mcp-hub.mjs [--workspace DIR] [--url URL] [--token-file FILE]

默认读取本项目 media.video.hubUrl / hubTokenFile，配置 Codex、Claude Code、Cursor。
令牌必须保存在项目内、已被 Git 忽略的私有文件中；本脚本不连接 Hub、不调用生成。
已有非本脚本生成的 Codex TOML 会原样保留并报错；JSON 保留其他服务和设置。
连接配置供直接打开的 Agent 使用；agent:run 需显式设置 mcp.projectHub: true，不读取这些连接文件。
`;

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inside(workspace, file) {
    const relative = path.relative(workspace, file);
    return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function safePath(workspace, file) {
    if (!inside(workspace, file)) throw new Error('连接配置和令牌必须位于当前项目内。');
    let current = workspace;
    const parts = path.relative(workspace, file).split(path.sep);
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) {
            if (error.code === 'ENOENT') return;
            throw new Error('无法检查项目配置路径。');
        }
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
            throw new Error('项目连接目录和文件不能是符号链接，也不能指向其他项目。');
        }
    }
}

async function requireIgnored(workspace, relative) {
    try {
        await execFileAsync('git', ['-C', workspace, 'check-ignore', '--quiet', '--', relative]);
    } catch {
        throw new Error('令牌或连接配置未被 Git 忽略，或已被跟踪；请先设置项目忽略规则。');
    }
}

async function readExisting(workspace, relative) {
    const file = path.join(workspace, relative);
    await safePath(workspace, file);
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error();
        return await fs.readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error(`无法安全读取 ${relative}；原文件未覆盖。`);
    }
}

function codexConfig(current, url, token) {
    // Node has no TOML parser. Only rewrite our exact previous output; never
    // guess how an unrelated TOML document's tables or multiline values merge.
    if (current !== null && current.trim()) {
        const lines = current.split('\n');
        let own = lines.length === 7 && lines[0] === CODEX_MARKER
            && lines[1] === '[mcp_servers.comfy-hub]'
            && lines[4] === 'startup_timeout_sec = 30'
            && ['tool_timeout_sec = 300', 'tool_timeout_sec = 400'].includes(lines[5]) && lines[6] === '';
        try {
            const oldUrl = /^url = (".*")$/.exec(lines[2] || '');
            const oldHeader = /^http_headers = \{ Authorization = (".*") \}$/.exec(lines[3] || '');
            own = own && typeof JSON.parse(oldUrl?.[1]) === 'string'
                && typeof JSON.parse(oldHeader?.[1]) === 'string';
        } catch { own = false; }
        if (!own) throw new Error('已有 .codex/config.toml 不是本脚本生成的完整配置，无法安全合并 TOML；原文件未覆盖，请手动配置 comfy-hub。');
    }
    return `${CODEX_MARKER}\n[mcp_servers.comfy-hub]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\nstartup_timeout_sec = 30\ntool_timeout_sec = 400\n`;
}

function jsonConfig(current, url, token, relative) {
    let data;
    try { data = current === null ? {} : JSON.parse(current); }
    catch { throw new Error(`${relative} 不是有效 JSON；原文件未覆盖。`); }
    if (!object(data) || (data.mcpServers !== undefined && !object(data.mcpServers))) {
        throw new Error(`${relative} 的 MCP 配置结构无效；原文件未覆盖。`);
    }
    const servers = data.mcpServers || {};
    const existing = servers[SERVER] ?? {};
    if (!object(existing) || (existing.type !== undefined && existing.type !== 'http')
        || ['command', 'args', 'env', 'cwd', 'auth', 'headersHelper'].some((key) => key in existing)) {
        throw new Error(`${relative} 已有 comfy-hub 配置与 HTTP 连接冲突；原文件未覆盖。`);
    }
    if (existing.headers !== undefined && (!object(existing.headers)
        || Object.values(existing.headers).some((value) => typeof value !== 'string'))) {
        throw new Error(`${relative} 的请求头配置无效；原文件未覆盖。`);
    }
    const headers = Object.fromEntries(Object.entries(existing.headers || {})
        .filter(([key]) => key.toLowerCase() !== 'authorization'));
    const entry = { ...existing, ...(relative === '.mcp.json' ? { type: 'http' } : {}), url,
        headers: { ...headers, Authorization: `Bearer ${token}` } };
    return JSON.stringify({ ...data, mcpServers: { ...servers, [SERVER]: entry } }, null, 4) + '\n';
}

export function parseOptions(argv) {
    const options = {};
    const fields = { '--workspace': 'workspace', '--url': 'url', '--token-file': 'tokenFile' };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--help' || flag === '-h') return { help: true };
        const key = fields[flag];
        if (!key || options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
            throw new Error('参数无效；使用 --help 查看 --workspace、--url、--token-file。');
        }
        options[key] = argv[++index];
    }
    return options;
}

export async function configureMcpHub(options = {}, { env = process.env, cwd = process.cwd() } = {}) {
    const config = resolveConfig(options.workspace ? { workspace: options.workspace } : {}, env, cwd);
    const workspace = await fs.realpath(config.workspace);
    let packageJson;
    try { packageJson = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8')); }
    catch { throw new Error('请在 video-remake 项目根目录运行，或使用 --workspace 指定该项目。'); }
    if (packageJson.name !== 'video-remake') throw new Error('只允许配置 video-remake 项目，不写入全局客户端目录。');
    const settings = config.media.video.settings;
    const { url } = parseHubUrl(options.url ?? settings.hubUrl);
    const tokenValue = options.tokenFile ?? settings.hubTokenFile;
    if (!tokenValue) throw new Error('请配置 media.video.hubTokenFile 或使用 --token-file。');
    const requestedTokenFile = path.resolve(config.workspace, tokenValue);
    const tokenFile = inside(config.workspace, requestedTokenFile)
        ? path.resolve(workspace, path.relative(config.workspace, requestedTokenFile)) : requestedTokenFile;
    await safePath(workspace, tokenFile);
    const lockDir = path.join(workspace, '.secrets', 'mcp-hub-config.lock');
    await safePath(workspace, lockDir);
    for (const relative of [...TARGETS, path.relative(workspace, tokenFile), '.secrets/mcp-hub-config.lock/']) {
        await safePath(workspace, path.join(workspace, relative));
        await requireIgnored(workspace, relative);
    }
    const token = await readHubToken(tokenFile);
    await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });
    try { await fs.mkdir(lockDir, { mode: 0o700 }); }
    catch { throw new Error('另一个连接配置操作尚未结束；请稍后重试。'); }
    try {
        const plans = [];
        for (const relative of TARGETS) {
            const previous = await readExisting(workspace, relative);
            const content = relative === '.codex/config.toml' ? codexConfig(previous, url, token)
                : jsonConfig(previous, url, token, relative);
            plans.push({ relative, previous, content });
        }
        // Validate every destination before staging credentials or changing files.
        for (const [index, plan] of plans.entries()) {
            const stage = path.join(lockDir, String(index));
            await fs.writeFile(stage, plan.content, { flag: 'wx', mode: 0o600 });
            plan.stage = stage;
        }
        for (const plan of plans) {
            if (await readExisting(workspace, plan.relative) !== plan.previous) {
                throw new Error('客户端配置在准备期间发生变化；请重试。');
            }
        }
        for (const plan of plans) {
            const destination = path.join(workspace, plan.relative);
            await safePath(workspace, destination);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await fs.rename(plan.stage, destination);
        }
        return { files: [...TARGETS], server: SERVER };
    } finally {
        await fs.rm(lockDir, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const options = parseOptions(process.argv.slice(2));
        if (options.help) process.stdout.write(HELP);
        else {
            const result = await configureMcpHub(options);
            process.stdout.write(`已配置项目 MCP 服务 ${result.server}：${result.files.join('、')}。\n请重新打开本项目的 Agent 会话；agent:run 需显式设置 mcp.projectHub: true，不读取这些连接文件。\n`);
        }
    } catch (error) {
        // Never print raw filesystem/JSON errors, which may include credential text.
        process.stderr.write(`配置失败：${error.code ? '请检查项目路径、文件权限与配置。' : error.message}\n`);
        process.exitCode = 1;
    }
}

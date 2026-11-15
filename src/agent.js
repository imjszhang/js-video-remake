import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as runtime from 'js-agent-runtime';
import { loadAgentConfig, selectAgentTarget, agentStorageRoot } from './agent-config.js';
import { readCatalog, findProduction, findReference } from './catalog.js';
import { startProduction } from './start.js';
import { assertSlug } from './schema.js';
import { appError } from './errors.js';
import { agentCredentialEnvironment } from './agent-credentials.js';
import { planAgentHub, loadAgentHub, AGENT_HUB_TOKEN_REF } from './agent-hub.js';
import { startHubRelay } from './hub-relay.js';
import { codexHttpProxy } from './codex-launch.js';
import { httpFetch } from './http.js';
import { MEDIA_TASKS, getProvider, mediaProxy } from './media/config.js';
import { createActivityWriter } from './agent-activity.js';

const codexWrapper = fileURLToPath(new URL('./codex-trust-wrapper.mjs', import.meta.url));

const ACTIVE = new Set(['preparing', 'running']);
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_CONTEXT_BYTES = 1024 * 1024;
const STREAMS = { stdout: 'stdout.log', stderr: 'stderr.log', events: 'events.jsonl' };

function identifier(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
        throw appError('INVALID_INPUT', '需要有效的 Agent run ID。');
    }
    return value;
}

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Check every component, including intermediate directories, before reading task inputs or records.
async function safePath(root, relative, { optional = false } = {}) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) {
        throw appError('INVALID_INPUT', '文件必须使用工作区内的相对路径。');
    }
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute) || absolute === root) throw appError('INVALID_INPUT', `文件超出工作区: ${relative}`);
    let current = root;
    for (const part of path.relative(root, absolute).split(path.sep)) {
        current = path.join(current, part);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) {
            if (error.code === 'ENOENT' && optional) return null;
            if (error.code === 'ENOENT') throw appError('NOT_FOUND', `文件不存在: ${relative}`);
            throw error;
        }
        if (stat.isSymbolicLink()) throw appError('INVALID_INPUT', `不接受符号链接: ${relative}`);
        if (current !== absolute && !stat.isDirectory()) throw appError('INVALID_INPUT', `路径不是目录: ${relative}`);
    }
    return absolute;
}

async function inputFile(root, relative, optional = false, privateFiles = []) {
    const parts = typeof relative === 'string' ? relative.toLowerCase().split(/[\\/]/) : [];
    const resolved = typeof relative === 'string' ? path.resolve(root, relative) : '';
    if (typeof relative !== 'string' || parts.some(part =>
        /^\.env(?:\.|$)/i.test(part) || ['.git', 'node_modules', '.secrets', '.mcp', '.mcp.json', '.codex', '.codexconfig', '.cursor', '.claude', 'auth.json', 'credentials.json', 'agent-runtime.json', 'video-remake.json'].includes(part))
        || privateFiles.some(file => file && resolved.toLowerCase() === path.resolve(root, file).toLowerCase())) {
        throw appError('INVALID_INPUT', '不能将凭据、本机配置或依赖目录作为 Agent 输入。');
    }
    const file = await safePath(root, relative, { optional });
    if (!file) return null;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
        throw appError('INVALID_INPUT', `输入必须是小于 256 KiB 的文本文件: ${relative}`);
    }
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_INPUT_BYTES || bytes.includes(0)) throw appError('INVALID_INPUT', `无效文本输入: ${relative}`);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw appError('INVALID_INPUT', `输入不是 UTF-8 文本: ${relative}`); }
    return { path: path.relative(root, file).split(path.sep).join('/'), bytes: bytes.length, sha256: runtime.sha256(bytes), content };
}

function timeout(value, fallback) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number) || number < 1000 || number > 86400000) {
        throw appError('INVALID_INPUT', '--timeout-ms 必须是 1000–86400000 的整数。');
    }
    return number;
}

const MEDIA_LABELS = { image: '出图', video: '出片', speech: '语音合成', transcribe: '转写' };

// Names and invocation routes only. Settings can contain key paths and service addresses.
function mediaAuthorization(config, hubReady) {
    const media = config.media;
    if (!media || typeof media !== 'object') return '';
    const lines = MEDIA_TASKS.flatMap((task) => {
        const selected = media[task];
        if (!selected || typeof selected.provider !== 'string') return [];
        let provider;
        try { provider = getProvider(task, selected.provider); }
        catch { return []; }
        const route = provider.execution === 'program'
            ? `执行 node cli/remake.js media:${task}，由项目读取本机配置和密钥`
            : task === 'video' && hubReady
                ? '使用本次已加载的 comfy-hub MCP，不要读取令牌或客户端配置'
                : '按 remake-media 技能中该 provider 的指南使用当前会话已有工具';
        return [`- ${MEDIA_LABELS[task]} ${selected.provider}（${provider.execution}）：${route}`];
    });
    if (!lines.length) return '';
    return [
        '本次运行已授权使用下列项目素材 provider。任务需要相应素材时直接使用，不必再次询问。',
        '与本次任务无关时不要调用。用户任务明确禁止某一类生成时，以用户任务为准。',
        '不要改用未列出的渠道，不要读取或输出密钥、令牌和本机配置。',
        ...lines,
    ].join('\n');
}

function checkpointPrompt(production, timeoutMs, referenceId, pending = false) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    const bound = referenceId ? `，绑定参考 ${referenceId}` : '';
    return [
        pending
            ? `这是计划预览：真正运行时会先建立制作 ${production}${bound}。预览本身不创建目录。`
            : `工作台里的项目就是本次制作 ${production}${bound}。项目在这一轮开始前已经存在，进度会在制作过程中写回该目录。`,
        `本次运行时限约 ${minutes} 分钟。到时或中止后进程会停，已经写进项目目录的文件会留下。`,
        '每得到一段可交接的内容就立刻写入这个项目，不要等整次运行结束再集中落盘。',
        '理解原片时写入参考目录的 ANALYSIS.md 和 TIMELINE.md。开始改画面之前，用 video:new 或 video:fork 建立代码视频包。',
        `每完成一个阶段，把进度写到 productions/${production}/PROGRESS.md：一行「日期 时间 包名：一句话」，下面用「- 」列出已完成和下一步。`,
        '不要把整项工作押在同一次运行里，也不要重做已经落地的素材。',
        '中止或到时限后，用 agent:run --continue 接着做。要按新要求改已有结果时，再加上 --instruction。',
    ].join('\n');
}

function clipTask(text, max = 4000) {
    const value = String(text || '').trim();
    if (value.length <= max) return value;
    return `${value.slice(0, max)}\n…（更早的任务文本已截断）`;
}

function continuationInstruction({ id, status, priorText, original, followUp }) {
    const revise = Boolean(followUp && followUp.trim());
    return [
        revise
            ? `这是同一次制作的优化，不是新项目。上一次运行 ${id} 已结束，状态是 ${status}。磁盘上的文件和成片就是要改的结果。`
            : `这是同一次制作的续接，不是新任务。上一次运行 ${id} 已结束，状态是 ${status}。`,
        '磁盘上已经写出的文件、素材台账和代码视频包就是进度。先读 PROGRESS.md 和已有视频包，从中断处继续。',
        '不要重做已经落地的出图、出片、转写和语音。',
        priorText ? `上次结束时的说明：\n${priorText}` : '',
        revise ? `本轮要求：\n${followUp.trim()}` : '',
        `原任务:\n${clipTask(original)}`,
    ].filter(Boolean).join('\n\n');
}

function localStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function ensureRunProduction(config, options, { write = false, runId = '' } = {}) {
    if (options.continueRun) {
        if (options.reference !== undefined || options.as !== undefined) {
            throw appError('INVALID_INPUT', '续接留在原来的制作里，不要同时用 --reference 或 --as 开新项目。');
        }
        return options;
    }
    if (options.reference === undefined && options.as === undefined) return options;
    const reference = typeof options.reference === 'string' ? options.reference.trim() : '';
    const slug = typeof options.as === 'string' ? options.as.trim() : '';
    if (!reference || !slug) throw appError('INVALID_INPUT', '开启新项目需要同时提供 --reference 和 --as。');
    if (options.production !== undefined && options.production !== slug) {
        throw appError('INVALID_INPUT', '--as 与 --production 不是同一个制作。');
    }
    const name = assertSlug(slug);
    const catalogPath = config.catalogPath || path.join(config.workspace, 'catalog.json');
    let catalog;
    try { catalog = await readCatalog(catalogPath); }
    catch (error) {
        if (error.code === 'CATALOG_INVALID' && String(error.message).includes('不存在')) {
            throw appError('NOT_FOUND', `没有这条参考: ${reference}`);
        }
        throw error;
    }
    const ref = findReference(catalog, reference);
    if (!ref) throw appError('NOT_FOUND', `没有这条参考: ${reference}`);
    const existing = findProduction(catalog, name);
    if (existing) {
        if (!(existing.referenceIds || []).includes(ref.id)) {
            throw appError('ALREADY_EXISTS', `制作 ${name} 已经绑定了别的参考，不能当作这次的新项目。`);
        }
        return { ...options, production: name, referenceId: ref.id, openedProduction: false, pendingProduction: false };
    }
    if (!write) {
        return { ...options, production: name, referenceId: ref.id, openedProduction: false, pendingProduction: true };
    }
    await startProduction({ ...config, catalogPath }, { refId: ref.id, slug: name });
    if (runId) {
        const note = `\n${localStamp()} 开项：运行 ${runId} 已绑定参考 ${ref.id}。这一轮的状态写在 agent-activity.json，中止后用 agent:run --continue ${runId} 接着做。\n`;
        await fs.appendFile(path.join(config.workspace, 'productions', name, 'PROGRESS.md'), note);
    }
    return { ...options, production: name, referenceId: ref.id, openedProduction: true, pendingProduction: false };
}

const AUTO_CONTEXT = new Set(['AGENTS.md', 'README.md']);

function isAutoContext(relative, production) {
    const normalized = relative.split(path.sep).join('/');
    if (AUTO_CONTEXT.has(normalized)) return true;
    if (production && [`productions/${production}/BRIEF.md`, `productions/${production}/TREATMENT.md`, `productions/${production}/PROGRESS.md`].includes(normalized)) return true;
    return /^references\/[^/]+\/(?:SOURCE\.json|ANALYSIS\.md|TIMELINE\.md)$/.test(normalized);
}

async function prepareRunOptions(config, options) {
    if (!options.continueRun) return options;
    if (options.reference !== undefined || options.as !== undefined) {
        throw appError('INVALID_INPUT', '续接留在原来的制作里，不要同时用 --reference 或 --as 开新项目。');
    }
    if (options.instruction !== undefined && options.instructionFile !== undefined) {
        throw appError('INVALID_INPUT', '--continue 的优化要求用 --instruction 或 --instruction-file，二选一。');
    }
    const previous = await readRun(config, options.continueRun);
    if (ACTIVE.has(previous.status)) throw appError('AGENT_BUSY', `运行 ${previous.id} 还没结束，不能续接。`);
    if (options.production !== undefined && options.production !== previous.production) {
        throw appError('INVALID_INPUT', '续接必须留在同一次制作里。');
    }
    const taskFile = await safePath(agentStorageRoot(config), `${previous.id}/task.json`);
    let task;
    try { task = JSON.parse(await fs.readFile(taskFile, 'utf8')); }
    catch { throw appError('AGENT_RECORD_INVALID', `无法读取上次任务: ${previous.id}`); }
    if (typeof task.instruction !== 'string' || !task.instruction.trim()) {
        throw appError('AGENT_RECORD_INVALID', '上次任务没有可继续的指令。');
    }
    const root = await fs.realpath(config.workspace);
    const recovered = [];
    for (const input of Array.isArray(task.inputs) ? task.inputs : []) {
        if (!input || typeof input.path !== 'string' || isAutoContext(input.path, previous.production)) continue;
        const file = await safePath(root, input.path, { optional: true });
        if (!file) continue;
        const content = await fs.readFile(file, 'utf8').catch(() => null);
        if (content == null || content.trim() === task.instruction.trim()) continue;
        recovered.push(input.path);
    }
    const prior = typeof previous.execution?.text === 'string' ? previous.execution.text.replace(/\s+/g, ' ').trim().slice(0, 2000) : '';
    const original = task.instruction.trim();
    const followUp = typeof options.instruction === 'string' ? options.instruction.trim() : '';
    const resumed = {
        id: previous.id, status: previous.status, priorText: prior, original,
    };
    return {
        ...options,
        instruction: options.instructionFile !== undefined ? undefined : continuationInstruction({ ...resumed, followUp }),
        followUpText: followUp,
        previousInstruction: original,
        previousStatus: previous.status,
        previousExcerpt: prior,
        production: previous.production ?? undefined,
        target: options.target || previous.target,
        timeoutMs: options.timeoutMs ?? task.execution?.request?.timeoutMs,
        inputs: [...recovered, ...(options.inputs || [])],
        continuedFrom: previous.id,
    };
}

function unfinishedHint(record) {
    if (!record.production || record.status === 'completed') return '';
    return ` 项目文件已保留。用 agent:run --continue ${record.id} 接着做；要按新要求改结果，再加上 --instruction。`;
}

function hubFetch(config, deps) {
    return httpFetch(mediaProxy(config, 'video'), deps.fetchImpl);
}

function executionForRun(execution, { url, executable } = {}) {
    const request = execution.request;
    const target = executable ? { ...request.target, harness: { ...request.target.harness, executable } } : request.target;
    return runtime.plan({
        runId: request.runId, workspace: request.workspace, prompt: request.prompt, target,
        timeoutMs: request.timeoutMs, stateDir: execution.stateDir,
        ...(request.mcpServers ? { mcpServers: request.mcpServers.map((server, index) => index === 0 && url ? { ...server, url } : server) } : {}),
    });
}

function operationalEnv(env) {
    return Object.fromEntries(['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
        .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}

async function buildPlan(config, options, runId = 'preview') {
    options = await prepareRunOptions(config, options);
    const settings = await loadAgentConfig(config, { configPath: options.agentConfig });
    const { target, enabled } = selectAgentTarget(settings, options.target);
    const root = await fs.realpath(config.workspace);
    const hubPlan = await planAgentHub(config, settings.mcp, target);
    const privateFiles = [settings.configPath, hubPlan?.tokenFile || config.media?.video?.settings?.hubTokenFile];
    if ((options.instruction !== undefined) === (options.instructionFile !== undefined)) {
        throw appError('INVALID_INPUT', '请指定 --instruction 或 --instruction-file，二选一。');
    }
    const files = new Map();
    const add = async (relative, optional = false) => {
        const input = await inputFile(root, relative, optional, privateFiles);
        if (input) files.set(input.path, input);
        return input;
    };
    let instruction = options.instruction;
    let followUpText = options.followUpText || '';
    if (options.instructionFile !== undefined) instruction = (await add(options.instructionFile)).content;
    if (options.previousInstruction && options.instructionFile !== undefined) {
        followUpText = typeof instruction === 'string' ? instruction.trim() : '';
        instruction = continuationInstruction({
            id: options.continuedFrom, status: options.previousStatus, priorText: options.previousExcerpt,
            original: options.previousInstruction, followUp: followUpText,
        });
    }
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.includes('\0') || Buffer.byteLength(instruction) > MAX_INPUT_BYTES) {
        throw appError('INVALID_INPUT', '任务指令必须是非空文本，且不超过 256 KiB。');
    }
    await add('AGENTS.md', true);
    await add('README.md', true);
    let production = null;
    let productionDir = null;
    let referenceId = options.referenceId || null;
    if (options.production !== undefined) {
        production = assertSlug(options.production);
        const catalog = await readCatalog(config.catalogPath || path.join(root, 'catalog.json'));
        const item = findProduction(catalog, production);
        if (!item && !options.pendingProduction) throw appError('NOT_FOUND', `没有这条制作: ${production}`);
        if (item) {
            if (typeof item.dir !== 'string') throw appError('CATALOG_INVALID', '制作目录缺失。');
            productionDir = item.dir;
            if (!referenceId && Array.isArray(item.referenceIds) && item.referenceIds.length) referenceId = item.referenceIds[0];
            await add(`${item.dir}/BRIEF.md`);
            for (const name of ['TREATMENT.md', 'PROGRESS.md']) await add(`${item.dir}/${name}`, true);
            for (const id of item.referenceIds || []) {
                const ref = findReference(catalog, id);
                if (!ref || typeof ref.dir !== 'string') throw appError('CATALOG_INVALID', `制作绑定的参考不存在: ${id}`);
                await add(`${ref.dir}/SOURCE.json`);
                for (const name of ['ANALYSIS.md', 'TIMELINE.md']) await add(`${ref.dir}/${name}`, true);
            }
        } else {
            productionDir = `productions/${production}`;
            const ref = findReference(catalog, referenceId);
            if (!ref || typeof ref.dir !== 'string') throw appError('CATALOG_INVALID', `制作绑定的参考不存在: ${referenceId || ''}`);
            referenceId = ref.id;
            await add(`${ref.dir}/SOURCE.json`);
            for (const name of ['ANALYSIS.md', 'TIMELINE.md']) await add(`${ref.dir}/${name}`, true);
        }
    }
    for (const file of [...(options.inputs || []), ...(options.skills || [])]) await add(file);
    if ([...files.values()].reduce((sum, file) => sum + file.bytes, Buffer.byteLength(instruction)) > MAX_CONTEXT_BYTES) {
        throw appError('INVALID_INPUT', 'Agent 文本上下文总计不能超过 1 MiB。');
    }
    const prompt = [
        '你正在 video-remake 项目中执行用户交给你的任务。工作目录是实际项目根目录。',
        '遵守以下选定的项目规则和任务要求，只修改完成本次任务需要的文件。',
        '参考原片通过 SOURCE.json 指针读取；不要复制原片。成片和对比片使用本机 HyperFrames。',
        '保留已有制作、草稿和交付版本；不因执行成功自动定稿、发布或发送消息。',
        '如缺少工具、素材或证据，请明确报告。完成时说明修改、验证结果和未完成事项。',
        hubPlan ? '本次运行已加载项目 comfy-hub MCP 服务，连接由运行器提供。通过该服务操作 ComfyUI，沿用项目设备令牌的服务与权限限制。不要读取或输出令牌及客户端私有配置；Hub 文件上传和下载可用 node scripts/mcp-hub-files.js，它会读取项目 Hub 设置，并使用出片任务的代理。' : '',
        production ? `本次制作: ${production}` : '',
        production ? checkpointPrompt(production, timeout(options.timeoutMs, settings.timeoutMs), referenceId, Boolean(options.pendingProduction)) : '',
        ...[...files.values()].map(file => `\n--- 项目输入 ${file.path} (sha256:${file.sha256}) ---\n${file.content}\n--- 输入结束 ---`),
        mediaAuthorization(config, Boolean(hubPlan)),
        `\n用户任务:\n${instruction.trim()}`,
    ].filter(Boolean).join('\n');
    if (/mcp_hub_[A-Za-z0-9_-]{32,128}/u.test(prompt)) {
        throw appError('INVALID_INPUT', 'Agent 任务或输入中包含 Hub 设备令牌，请移除凭据后重试。');
    }
    const timeoutMs = timeout(options.timeoutMs, settings.timeoutMs);
    let execution;
    try {
        execution = runtime.plan({ runId, workspace: root, prompt, target, timeoutMs,
            ...(hubPlan ? { mcpServers: [hubPlan.server] } : {}),
        });
    } catch (error) { throw appError('CONFIG_INVALID', error.message); }
    // Validate storage without creating it, including for a dry plan.
    const storageRoot = agentStorageRoot({ ...config, workspace: root });
    return {
        schemaVersion: 1, workspace: root, production, productionDir, referenceId, pendingProduction: Boolean(options.pendingProduction),
        openedProduction: Boolean(options.openedProduction),
        activityInstruction: (followUpText || options.previousInstruction || instruction).trim(),
        continuedFrom: options.continuedFrom || null, target, enabled,
        configPath: settings.configPath, storageRoot, instruction,
        inputs: [...files.values()].map(({ content, ...input }) => input), execution,
        ...(hubPlan ? { hubPlan } : {}),
    };
}

async function writeJson(file, data) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}

function alive(owner) {
    if (owner?.hostname !== os.hostname()) return true;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

async function readRun(config, runId) {
    const id = identifier(runId);
    const root = agentStorageRoot(config);
    const file = await safePath(root, `${id}/run.json`);
    let record;
    try { record = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw appError('AGENT_RECORD_INVALID', `无法读取 Agent 运行记录: ${id}`); }
    if (record.id !== id || record.workspace !== await fs.realpath(config.workspace)) {
        throw appError('AGENT_RECORD_INVALID', '运行记录与当前项目不匹配。');
    }
    // A dead owner is evidence of interruption; never resume or signal a recorded PID.
    if (ACTIVE.has(record.status) && !alive(record.owner)) record = { ...record, status: 'interrupted' };
    return record;
}

async function acquireLock(storageRoot, record) {
    const file = path.join(storageRoot, 'active.json');
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await fs.writeFile(file, JSON.stringify({ id: record.id, owner: record.owner }), { flag: 'wx', mode: 0o600 });
            return async () => {
                const current = JSON.parse(await fs.readFile(file, 'utf8'));
                if (current.id === record.id) await fs.unlink(file);
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // Serialize stale-owner recovery. Without this guard, two launchers could
            // both read an old lock and one could unlink the other's newly acquired lock.
            const recovery = path.join(storageRoot, 'lock-recovery');
            try { await fs.mkdir(recovery, { mode: 0o700 }); }
            catch (cause) {
                if (cause.code === 'EEXIST') throw appError('AGENT_BUSY', `Agent 锁正在恢复；若持续存在，请检查 ${recovery}`);
                throw cause;
            }
            try {
                let current;
                const lockPath = await safePath(storageRoot, 'active.json', { optional: true });
                if (!lockPath) continue;
                try { current = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
                catch { throw appError('AGENT_BUSY', `存在无法确认归属的 Agent 锁，请检查 ${file}`); }
                if (alive(current.owner)) throw appError('AGENT_BUSY', `本项目已有 Agent 运行: ${current.id}`);
                await fs.unlink(file);
            } finally { await fs.rmdir(recovery); }
        }
    }
    throw appError('AGENT_BUSY', '其他 Agent 正在启动，请稍后重试。');
}

async function runAgent(config, options, deps) {
    const id = `r_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const opened = await ensureRunProduction(config, options, { write: true, runId: id });
    const task = await buildPlan(config, opened, id);
    if (!task.enabled) throw appError('CONFIG_INVALID', `目标 ${task.target.name} 已禁用；请先在本机 Agent 配置中启用。`);
    const env = await agentCredentialEnvironment(config, task.target);
    const redactor = runtime.createRedactor(Object.values(operationalEnv(env))
        .filter(value => /:\/\/[^\s/]+:[^\s/]+@/u.test(value)));
    if (task.target.backend.auth === 'api-key') {
        const key = env[task.target.backend.apiKeyEnv];
        if (typeof key !== 'string' || !key.trim() || key.includes('\0')) {
            throw appError('CONFIG_INVALID', `缺少环境变量: ${task.target.backend.apiKeyEnv}`);
        }
        redactor.add(key);
    }
    await fs.mkdir(task.storageRoot, { recursive: true, mode: 0o700 });
    const runDir = path.join(task.storageRoot, id);
    const record = {
        schemaVersion: 1, id, workspace: task.workspace, production: task.production,
        continuedFrom: task.continuedFrom, target: task.target.name, status: 'preparing', runDir,
        createdAt: new Date().toISOString(), finishedAt: null,
        owner: { pid: process.pid, hostname: os.hostname() }, execution: null,
    };
    const activity = createActivityWriter({
        root: task.workspace, dir: task.productionDir, runId: id, target: task.target.name,
        startedAt: record.createdAt, continuedFrom: task.continuedFrom,
        instruction: redactor.text(task.activityInstruction || ''), referenceId: task.referenceId,
    });
    const release = await acquireLock(task.storageRoot, record);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const save = () => writeJson(path.join(runDir, 'run.json'), redactor.value(record));
    let timer;
    let created = false;
    let relay;
    try {
        await fs.mkdir(runDir, { mode: 0o700 });
        created = true;
        await save();
        await writeJson(path.join(runDir, 'task.json'), redactor.value(task));
        await activity.update('preparing', true);
        deps.signal?.addEventListener('abort', abort, { once: true });
        if (deps.signal?.aborted) abort();
        process.once('SIGINT', abort);
        process.once('SIGTERM', abort);
        timer = setInterval(() => {
            fs.access(path.join(runDir, 'cancel.json')).then(abort).catch(error => {
                if (error.code !== 'ENOENT') abort();
            });
        }, 100);
        timer.unref();
        const hub = await loadAgentHub(task.hubPlan, { fetchImpl: hubFetch(config, deps), signal: controller.signal });
        const videoProxy = mediaProxy(config, 'video');
        if (hub && typeof videoProxy === 'string' && videoProxy.startsWith('socks5:')) relay = await startHubRelay({ proxy: videoProxy, upstream: hub.server.url, signal: controller.signal });
        const codexBin = task.target.harness.adapter === 'codex' ? task.target.harness.executable : '';
        let execution = task.execution;
        if (relay || codexBin) execution = executionForRun(task.execution, { url: relay?.url, executable: codexBin ? codexWrapper : undefined });
        if (hub) {
            redactor.add(hub.token);
            record.mcp = hub.summary;
        }
        const childEnv = operationalEnv(env);
        if (codexBin && !childEnv.HTTPS_PROXY && !childEnv.https_proxy) {
            const imageProxy = mediaProxy(config, 'image');
            const proxy = typeof imageProxy === 'string' && /^https?:/i.test(imageProxy) ? imageProxy : codexHttpProxy(task.target.backend.codexHome);
            if (proxy) {
                for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) childEnv[key] = proxy;
                childEnv.NO_PROXY = ['localhost', '127.0.0.1', '::1', childEnv.NO_PROXY].filter(Boolean).join(',');
                childEnv.no_proxy = childEnv.NO_PROXY;
            }
        }
        if (codexBin) childEnv.VIDEO_REMAKE_CODEX_BIN = codexBin;
        record.status = 'running';
        await save();
        await activity.update('running', true);
        record.execution = await runtime.run(execution, {
            signal: controller.signal, runDir: path.join(runDir, 'runtime'),
            env: childEnv,
            resolveCredential: ref => hub && ref === AGENT_HUB_TOKEN_REF ? hub.token : env[ref],
            onEvent: event => {
                const safe = redactor.value(event);
                if (safe.type === 'message' && typeof safe.data?.text === 'string') {
                    activity.note(safe.data.text);
                    void activity.update(record.status);
                }
                return deps.onEvent?.(safe);
            },
        });
        record.status = record.execution.status;
        record.finishedAt = record.execution.finishedAt;
        await save();
    } catch (error) {
        if (!created) throw error;
        record.status = controller.signal.aborted ? 'cancelled' : 'failed';
        record.error = redactor.text(error.message);
        record.finishedAt = new Date().toISOString();
        await save();
    } finally {
        clearInterval(timer);
        await relay?.close();
        deps.signal?.removeEventListener('abort', abort);
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
        await activity.finish(record.status, record.execution?.text || record.error);
        await release();
    }
    const data = { command: 'agent:run', run: redactor.value(record), ...(task.openedProduction ? { openedProduction: task.production } : {}) };
    if (record.status !== 'completed') {
        throw appError(`AGENT_${record.status.toUpperCase()}`, `${record.execution?.error || record.error || `Agent ${record.status}`}${unfinishedHint(record)}`, { data });
    }
    return data;
}

async function agentLogs(config, options) {
    const record = await readRun(config, options.runId);
    const stream = options.stream || 'stdout';
    if (!Object.hasOwn(STREAMS, stream)) throw appError('INVALID_INPUT', '--stream 必须是 stdout、stderr 或 events。');
    const lines = options.lines === undefined ? 100 : Number(options.lines);
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000) throw appError('INVALID_INPUT', '--lines 必须是 1–10000 的整数。');
    const file = await safePath(agentStorageRoot(config), `${record.id}/runtime/${STREAMS[stream]}`, { optional: true });
    let text = '';
    if (file) {
        const handle = await fs.open(file, 'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw appError('AGENT_RECORD_INVALID', '日志不是普通文件。');
            const start = Math.max(0, stat.size - MAX_CONTEXT_BYTES);
            const buffer = Buffer.alloc(stat.size - start);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            text = buffer.subarray(0, bytesRead).toString('utf8');
            if (start > 0) text = text.slice(text.indexOf('\n') + 1);
            text = text.replace(/\n$/, '').split('\n').slice(-lines).join('\n');
        } finally { await handle.close(); }
    }
    return { command: 'agent:logs', id: record.id, stream, text };
}

export async function executeAgent(config, action, options = {}, deps = {}) {
    if (action === 'config') {
        const settings = await loadAgentConfig(config, { configPath: options.agentConfig });
        return { command: 'agent:config', ...settings, storageRoot: agentStorageRoot(config) };
    }
    if (action === 'plan') {
        const opened = await ensureRunProduction(config, options, { write: false });
        return { command: 'agent:plan', plan: await buildPlan(config, opened) };
    }
    if (action === 'run') return runAgent(config, options, deps);
    if (action === 'doctor') {
        const settings = await loadAgentConfig(config, { configPath: options.agentConfig });
        const { target, enabled } = selectAgentTarget(settings, options.target);
        const env = await agentCredentialEnvironment(config, target);
        const hubPlan = await planAgentHub(config, settings.mcp, target);
        const execution = runtime.plan({ runId: 'doctor', workspace: await fs.realpath(config.workspace), prompt: 'Check CLI metadata only.', target, timeoutMs: settings.timeoutMs,
            ...(hubPlan ? { mcpServers: [hubPlan.server] } : {}),
        });
        const readiness = await runtime.probe(execution, { checkExecutable: true, checkLogin: !!options.checkLogin, env: operationalEnv(env), signal: deps.signal });
        if (target.backend.auth === 'api-key') {
            const present = typeof env[target.backend.apiKeyEnv] === 'string' && !!env[target.backend.apiKeyEnv].trim();
            readiness.checks.push({ name: 'credential', status: present ? 'passed' : 'failed', message: `${target.backend.apiKeyEnv}: ${present ? '已设置' : '未设置'}` });
            readiness.ok &&= present;
        }
        if (hubPlan) {
            try {
                const hub = await loadAgentHub(hubPlan, { fetchImpl: hubFetch(config, deps), signal: deps.signal });
                readiness.checks.push({ name: 'mcp-hub', status: 'passed', message: `comfy-hub 已就绪，${hub.summary.tools} 个授权工具 / ComfyUI ${hub.summary.version || '可用'}` });
                readiness.mcp = hub.summary;
            } catch (error) {
                readiness.checks.push({ name: 'mcp-hub', status: 'failed', message: error.message });
                readiness.ok = false;
            }
        }
        const data = { command: 'agent:doctor', target: target.name, enabled, readiness };
        if (!readiness.ok) throw appError('AGENT_NOT_READY', 'Agent 检查未通过。', { data });
        return data;
    }
    if (action === 'status') {
        if (options.runId) return { command: 'agent:status', run: await readRun(config, options.runId) };
        const root = agentStorageRoot(config);
        let entries;
        try { entries = await fs.readdir(root, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
        const runs = [];
        for (const entry of entries.filter(item => item.isDirectory() && /^r_/.test(item.name))) {
            const run = await readRun(config, entry.name);
            runs.push({ id: run.id, status: run.status, target: run.target, production: run.production, createdAt: run.createdAt, finishedAt: run.finishedAt });
        }
        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { command: 'agent:status', runs, storageRoot: root };
    }
    if (action === 'logs') return agentLogs(config, options);
    if (action === 'cancel') {
        const run = await readRun(config, options.runId);
        if (!ACTIVE.has(run.status)) return { command: 'agent:cancel', id: run.id, status: run.status };
        const runDir = await safePath(agentStorageRoot(config), run.id);
        await writeJson(path.join(runDir, 'cancel.json'), { requestedAt: new Date().toISOString() });
        return { command: 'agent:cancel', id: run.id, status: 'cancel_requested' };
    }
    throw appError('INVALID_INPUT', `未知 Agent 命令: ${action}`);
}

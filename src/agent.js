import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as runtime from 'js-agent-runtime';
import { loadAgentConfig, selectAgentTarget, agentStorageRoot } from './agent-config.js';
import { readCatalog, findProduction, findReference } from './catalog.js';
import { assertSlug } from './schema.js';
import { appError } from './errors.js';
import { agentCredentialEnvironment } from './agent-credentials.js';

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

async function inputFile(root, relative, optional = false) {
    if (typeof relative !== 'string' || relative.split(/[\\/]/).some(part =>
        /^\.env(?:\.|$)/i.test(part) || ['.git', 'node_modules', 'auth.json', 'credentials.json', 'agent-runtime.json', 'video-remake.json'].includes(part))) {
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

function operationalEnv(env) {
    return Object.fromEntries(['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
        .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}

async function buildPlan(config, options, runId = 'preview') {
    const settings = await loadAgentConfig(config, { configPath: options.agentConfig });
    const { target, enabled } = selectAgentTarget(settings, options.target);
    const root = await fs.realpath(config.workspace);
    if ((options.instruction !== undefined) === (options.instructionFile !== undefined)) {
        throw appError('INVALID_INPUT', '请指定 --instruction 或 --instruction-file，二选一。');
    }
    const files = new Map();
    const add = async (relative, optional = false) => {
        const input = await inputFile(root, relative, optional);
        if (input) files.set(input.path, input);
        return input;
    };
    let instruction = options.instruction;
    if (options.instructionFile !== undefined) instruction = (await add(options.instructionFile)).content;
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.includes('\0') || Buffer.byteLength(instruction) > MAX_INPUT_BYTES) {
        throw appError('INVALID_INPUT', '任务指令必须是非空文本，且不超过 256 KiB。');
    }
    await add('AGENTS.md', true);
    await add('README.md', true);
    let production = null;
    if (options.production !== undefined) {
        production = assertSlug(options.production);
        const catalog = await readCatalog(config.catalogPath || path.join(root, 'catalog.json'));
        const item = findProduction(catalog, production);
        if (!item) throw appError('NOT_FOUND', `没有这条制作: ${production}`);
        if (typeof item.dir !== 'string') throw appError('CATALOG_INVALID', '制作目录缺失。');
        await add(`${item.dir}/BRIEF.md`);
        for (const name of ['TREATMENT.md', 'PROGRESS.md']) await add(`${item.dir}/${name}`, true);
        for (const id of item.referenceIds || []) {
            const ref = findReference(catalog, id);
            if (!ref || typeof ref.dir !== 'string') throw appError('CATALOG_INVALID', `制作绑定的参考不存在: ${id}`);
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
        production ? `本次制作: ${production}` : '',
        ...[...files.values()].map(file => `\n--- 项目输入 ${file.path} (sha256:${file.sha256}) ---\n${file.content}\n--- 输入结束 ---`),
        `\n用户任务:\n${instruction.trim()}`,
    ].filter(Boolean).join('\n');
    const timeoutMs = timeout(options.timeoutMs, settings.timeoutMs);
    let execution;
    try {
        execution = runtime.plan({ runId, workspace: root, prompt, target, timeoutMs });
    } catch (error) { throw appError('CONFIG_INVALID', error.message); }
    // Validate storage without creating it, including for a dry plan.
    const storageRoot = agentStorageRoot({ ...config, workspace: root });
    return {
        schemaVersion: 1, workspace: root, production, target, enabled,
        configPath: settings.configPath, storageRoot, instruction,
        inputs: [...files.values()].map(({ content, ...input }) => input), execution,
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
    const task = await buildPlan(config, options, id);
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
        target: task.target.name, status: 'preparing', runDir,
        createdAt: new Date().toISOString(), finishedAt: null,
        owner: { pid: process.pid, hostname: os.hostname() }, execution: null,
    };
    const release = await acquireLock(task.storageRoot, record);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const save = () => writeJson(path.join(runDir, 'run.json'), redactor.value(record));
    let timer;
    let created = false;
    try {
        await fs.mkdir(runDir, { mode: 0o700 });
        created = true;
        await save();
        await writeJson(path.join(runDir, 'task.json'), redactor.value(task));
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
        record.status = 'running';
        await save();
        record.execution = await runtime.run(task.execution, {
            signal: controller.signal, runDir: path.join(runDir, 'runtime'),
            env: operationalEnv(env), resolveCredential: ref => env[ref], onEvent: deps.onEvent,
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
        deps.signal?.removeEventListener('abort', abort);
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
        await release();
    }
    const data = { command: 'agent:run', run: redactor.value(record) };
    if (record.status !== 'completed') {
        throw appError(`AGENT_${record.status.toUpperCase()}`, record.execution?.error || record.error || `Agent ${record.status}`, { data });
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
    if (action === 'plan') return { command: 'agent:plan', plan: await buildPlan(config, options) };
    if (action === 'run') return runAgent(config, options, deps);
    if (action === 'doctor') {
        const settings = await loadAgentConfig(config, { configPath: options.agentConfig });
        const { target, enabled } = selectAgentTarget(settings, options.target);
        const env = await agentCredentialEnvironment(config, target);
        const execution = runtime.plan({ runId: 'doctor', workspace: await fs.realpath(config.workspace), prompt: 'Check CLI metadata only.', target, timeoutMs: settings.timeoutMs });
        const readiness = await runtime.probe(execution, { checkExecutable: true, checkLogin: !!options.checkLogin, env: operationalEnv(env), signal: deps.signal });
        if (target.backend.auth === 'api-key') {
            const present = typeof env[target.backend.apiKeyEnv] === 'string' && !!env[target.backend.apiKeyEnv].trim();
            readiness.checks.push({ name: 'credential', status: present ? 'passed' : 'failed', message: `${target.backend.apiKeyEnv}: ${present ? '已设置' : '未设置'}` });
            readiness.ok &&= present;
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

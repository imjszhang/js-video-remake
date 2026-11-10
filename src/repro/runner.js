import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import * as runtime from 'js-agent-runtime';
import { agentStorageRoot } from '../agent-config.js';
import { agentCredentialEnvironment } from '../agent-credentials.js';
import { appError } from '../errors.js';
import { DEFAULT_POLICY, ROLES, loadWorkflow, remainingBudget, resolveRole } from './config.js';
import { startCapabilityBroker } from './capabilities.js';
import { prepareExecutionEnvironment } from './execution-environment.js';

const ACTIVE = new Set(['preparing', 'running']);
const MAX_TEXT = 256 * 1024;
const MAX_CONTEXT = 1024 * 1024;
const STREAMS = { stdout: 'stdout.log', stderr: 'stderr.log', events: 'events.jsonl' };
const executableMetadata = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const operationalEnv = env => Object.fromEntries(['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
const toolIdentity = event => event.data?.item?.id ?? event.data?.tool_call_id ?? event.data?.toolCallId ?? event.data?.callId ?? event.data?.id ?? `event-${event.sequence}`;

async function jsonWrite(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
}

async function regular(root, relative, { optional = false } = {}) {
    if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw appError('INVALID_INPUT', 'Project context paths must be relative and stay inside the project.');
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute) || absolute === root) throw appError('INVALID_INPUT', 'Project context path escapes its root.');
    let current = root;
    for (const part of path.relative(root, absolute).split(path.sep)) {
        current = path.join(current, part);
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) { if (error.code === 'ENOENT' && optional) return null; throw error; }
        if (stat.isSymbolicLink()) throw appError('INVALID_INPUT', `Project context cannot contain symlinks: ${relative}`);
        if (current !== absolute && !stat.isDirectory()) throw appError('INVALID_INPUT', `Invalid context directory: ${relative}`);
    }
    return absolute;
}

async function readContext(root, relative, optional = false) {
    if (typeof relative !== 'string' || relative.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part) || ['.git', 'node_modules', 'auth.json', 'credentials.json', 'agent-runtime.json', 'reproduction-capabilities.local.json'].includes(part))) throw appError('INVALID_INPUT', 'Credentials, local configuration and dependency directories cannot be Agent context.');
    const filename = await regular(root, relative, { optional });
    if (!filename) return null;
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_TEXT) throw appError('INVALID_INPUT', `Agent input must be a text file smaller than 256 KiB: ${relative}`);
    const bytes = await fs.readFile(filename);
    if (bytes.length > MAX_TEXT || bytes.includes(0)) throw appError('INVALID_INPUT', `Invalid Agent text input: ${relative}`);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw appError('INVALID_INPUT', `Agent input is not UTF-8: ${relative}`); }
    return { path: path.relative(root, filename).split(path.sep).join('/'), sha256: sha(bytes), bytes: bytes.length, content };
}

async function skillEntries(root, directory) {
    const folder = await regular(root, directory, { optional: true });
    if (!folder) return [];
    const entries = await fs.readdir(folder, { withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw appError('INVALID_INPUT', `Skill roots cannot contain symlinks: ${directory}`);
    return entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).map(entry => `${directory}/${entry.name}/SKILL.md`);
}

async function projectContext(root, selected) {
    const files = new Map();
    const add = async (relative, optional = false) => {
        const entry = await readContext(root, relative, optional);
        if (entry) files.set(entry.path, entry);
    };
    for (const filename of ['AGENTS.md', 'CLAUDE.md', 'README.md', 'reproduction.json']) await add(filename, true);
    // One canonical skill tree, with Claude-only projects supported as a fallback.
    const common = await skillEntries(root, '.agents/skills');
    const skills = common.length ? common : await skillEntries(root, '.claude/skills');
    for (const filename of skills) await add(filename, true);
    for (const filename of selected) await add(filename);
    return [...files.values()];
}

function logsRoot(config, workspace) {
    const parent = agentStorageRoot(config);
    const root = path.join(parent, 'repro-agent-logs');
    // This also resolves symlinked existing ancestors before accepting a path.
    agentStorageRoot({ workspace, env: { ...(config.env || process.env), VIDEO_REMAKE_AGENT_HOME: root } });
    agentStorageRoot({ workspace: config.workspace, env: { ...(config.env || process.env), VIDEO_REMAKE_AGENT_HOME: root } });
    return root;
}

function alive(owner) {
    if (owner?.hostname !== os.hostname()) return true;
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

async function lockWorkspace(root, workspace, id) {
    const directory = path.join(root, 'locks');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${sha(workspace)}.json`);
    const owner = { pid: process.pid, hostname: os.hostname() };
    for (let count = 0; count < 2; count++) {
        try {
            await fs.writeFile(file, JSON.stringify({ id, workspace, owner }), { flag: 'wx', mode: 0o600 });
            return async () => {
                const current = JSON.parse(await fs.readFile(file, 'utf8'));
                if (current.id === id) await fs.unlink(file);
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const recovery = `${file}.recovery`;
            try { await fs.mkdir(recovery, { mode: 0o700 }); }
            catch (cause) { if (cause.code === 'EEXIST') throw appError('AGENT_BUSY', 'The project execution lock is being recovered.'); throw cause; }
            try {
                const safe = await regular(root, path.relative(root, file), { optional: true });
                if (!safe) continue;
                let current;
                try { current = JSON.parse(await fs.readFile(file, 'utf8')); }
                catch { throw appError('AGENT_BUSY', 'Cannot establish ownership of the project execution lock.'); }
                if (alive(current.owner)) throw appError('AGENT_BUSY', `This project already has an active Agent run: ${current.id}`);
                await fs.unlink(file);
            } finally { await fs.rmdir(recovery); }
        }
    }
    throw appError('AGENT_BUSY', 'Another Agent is starting in this project.');
}

function outputSummary(record, execution) {
    const observedModel = execution?.responseModel ?? null;
    return {
        schemaVersion: 1, runId: record.runId, id: record.runId, status: record.status,
        role: record.role, purpose: record.purpose, target: record.target,
        targetHash: record.targetHash, model: record.requestedModel,
        requestedModel: record.requestedModel, observedModel, responseModel: observedModel,
        identitySource: observedModel ? 'runtime-response' : 'configured-request',
        harness: record.harness, contextMode: record.contextMode,
        contextHash: record.contextHash, contextFiles: record.contextFiles,
        limitations: record.limitations, toolVersions: record.toolVersions,
        startedAt: record.startedAt, finishedAt: record.finishedAt,
        elapsedMs: execution?.durationMs ?? Math.max(0, Date.parse(record.finishedAt || new Date().toISOString()) - Date.parse(record.startedAt)),
        usage: execution?.usage ?? null, cost: execution?.cost ?? null,
        toolCalls: record.toolCalls ?? 0, budgetExceeded: record.budgetExceeded ?? [],
        observability: record.observability, preflight: record.preflight ?? null, executionEnvironment: record.executionEnvironment ?? null,
        capabilitiesHash: record.capabilitiesHash ?? null, capabilityProviders: record.capabilityProviders ?? [],
        capabilityCalls: record.capabilityCalls ?? 0, renderCalls: record.renderCalls ?? 0,
        logMode: record.logMode ?? 'runtime-streams',
        lastEvent: record.lastEvent ?? null,
        workspace: record.workspace, ownerWorkspace: record.ownerWorkspace, owner: record.owner,
        runDir: record.runDir, error: record.error ?? execution?.error ?? null,
        execution: execution ? {
            adapter: execution.adapter, status: execution.status, exitCode: execution.exitCode,
            signal: execution.signal, durationMs: execution.durationMs,
            usage: execution.usage ?? null, cost: execution.cost ?? null,
        } : null,
    };
}

/** One generic project execution. No video-remake catalogue or host instructions enter the prompt. */
export async function runProjectAgent(config, options, deps = {}) {
    const invokedAt = Date.now();
    const engine = deps.runtime || runtime;
    const workflow = options.workflow || await loadWorkflow(config, { workflowPath: options.workflowPath, configPath: options.agentConfig });
    const role = options.role || 'executor';
    const resolved = await resolveRole(config, workflow, role, { target: options.target, agentConfig: options.agentConfig });
    const { target, targetHash } = resolved;
    if (options.expectedTargetHash !== undefined && options.expectedTargetHash !== targetHash) throw appError('CONFIG_INVALID', 'Reproduction target configuration changed during this run. Start a new run to change it.');
    if (typeof options.workspace !== 'string' || !path.isAbsolute(options.workspace) || options.workspace.includes('\0')) throw appError('INVALID_INPUT', 'Project workspace must be an absolute path.');
    const rootStat = await fs.lstat(options.workspace);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw appError('INVALID_INPUT', 'Project workspace must be an existing directory without a symlink root.');
    const workspace = await fs.realpath(options.workspace);
    const ownerWorkspace = await fs.realpath(config.workspace);
    if (workspace === ownerWorkspace || inside(workspace, ownerWorkspace)) throw appError('INVALID_INPUT', 'Use a prepared reproduction project, not the video-remake repository root or its ancestor.');
    const instruction = options.instruction;
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.includes('\0') || Buffer.byteLength(instruction) > MAX_TEXT) throw appError('INVALID_INPUT', 'Project instruction must be nonempty text smaller than 256 KiB.');
    const policy = { ...DEFAULT_POLICY, ...(workflow.policy || {}) };
    const budget = options.budget || {};
    const remaining = remainingBudget(policy, budget);
    if (remaining.exhausted.length) throw appError('BUDGET_EXHAUSTED', `Reproduction budget exhausted: ${remaining.exhausted.join(', ')}.`);
    const requestedTimeout = options.timeoutMs === undefined ? resolved.settings.timeoutMs : Number(options.timeoutMs);
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1000 || requestedTimeout > 86_400_000) throw appError('INVALID_INPUT', 'timeoutMs must be an integer between 1000 and 86400000.');
    const timeoutMs = Math.min(requestedTimeout, remaining.remainingMs);
    const selected = options.files || options.inputs || [];
    if (!Array.isArray(selected)) throw appError('INVALID_INPUT', 'Project inputs must be an array of relative paths.');
    const files = await projectContext(workspace, selected);
    const explicit = resolved.contextMode === 'explicit-context' ? files : files.filter(file => selected.includes(file.path));
    if (explicit.reduce((sum, file) => sum + file.bytes, Buffer.byteLength(instruction)) > MAX_CONTEXT) throw appError('INVALID_INPUT', 'Selected project context exceeds 1 MiB.');
    const prompt = [
        'You are executing a task in this standalone reproduction project. The working directory is the project root.',
        'Follow its project instructions and applicable skills. Use its documented commands. Report unavailable tools or evidence and do not claim unobserved validation.',
        `Execution deadline: ${new Date(invokedAt + timeoutMs).toISOString()} (${Math.floor(timeoutMs / 1000)} seconds maximum). Reserve the final 60 seconds for saving work and a concise handoff. Return normally before this deadline; a timeout cannot certify completed source. Reuse recorded analysis and dependency checks, and do not repeat a documented unavailable operation without evidence that its environment changed.`,
        resolved.contextMode === 'explicit-context' ? 'The following project instructions and Skill entries are explicitly supplied; referenced project files can be read as needed.' : 'Project instructions and skills are discovered by the native Harness in the working directory.',
        ...explicit.map(file => `\n--- Project context ${file.path} (sha256:${file.sha256}) ---\n${file.content}\n--- End project context ---`),
        `\nTask (${role}):\n${instruction.trim()}`,
    ].join('\n');
    const runId = `p_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const storage = logsRoot(config, workspace);
    const runDir = path.join(storage, runId);
    let plan;
    try { plan = engine.plan({ runId, workspace, prompt, target, timeoutMs }); }
    catch (error) { throw appError('CONFIG_INVALID', error.message); }
    let executionEnvironment = null;
    if (options.executionEnvironment?.mode && options.executionEnvironment.mode !== 'context-only') {
        const prepared = await (deps.prepareExecutionEnvironment || prepareExecutionEnvironment)({
            ...options.executionEnvironment, target, workspace, ownerWorkspace, stateDir: plan.stateDir,
            searchPath: config.env?.PATH ?? process.env.PATH,
            environmentRoot: path.join(storage, 'environments', runId),
        });
        executionEnvironment = prepared.record;
        plan = engine.plan({ runId, workspace, prompt, target: prepared.target, timeoutMs, stateDir: plan.stateDir });
    }
    const env = await agentCredentialEnvironment(config, target);
    const redactor = runtime.createRedactor(Object.values(operationalEnv(env)).filter(value => /:\/\/[^\s/]+:[^\s/]+@/u.test(value)));
    if (target.backend.auth === 'api-key') {
        const key = env[target.backend.apiKeyEnv];
        if (typeof key !== 'string' || !key.trim() || key.includes('\0')) throw appError('CONFIG_INVALID', `Missing environment variable: ${target.backend.apiKeyEnv}`);
        redactor.add(key);
    }
    const record = {
        runId, status: 'preparing', workspace, ownerWorkspace, runDir, role,
        purpose: options.purpose || role, target: target.name, targetHash,
        requestedModel: target.backend.model, harness: { adapter: target.harness.adapter, permission: target.harness.permission },
        contextMode: resolved.contextMode, limitations: resolved.limitations, executionEnvironment,
        contextFiles: files.map(({ content, ...file }) => file),
        contextHash: sha(JSON.stringify(files.map(({ content, ...file }) => file))),
        toolVersions: { runtime: plan.runtimeVersion ?? runtime.RUNTIME_VERSION, adapter: plan.adapter ?? null, cli: options.cliVersion ?? null },
        observability: {
            toolCalls: 'native-tool-events; unknown event IDs are counted conservatively',
            renderCalls: 'unobservable-inside-arbitrary-shell; only host-invoked renders can be capped reliably',
            tokens: 'stop-on-observed-usage; final accounting may arrive after work is done',
            cost: 'post-call-observed-billing; unknown charges remain null',
        },
        startedAt: new Date().toISOString(), finishedAt: null,
        owner: { pid: process.pid, hostname: os.hostname() }, toolCalls: 0, budgetExceeded: [],
    };
    const controller = new AbortController();
    const signal = options.signal || deps.signal;
    const abort = () => controller.abort();
    const toolIds = new Set();
    let execution;
    let broker;
    let saveQueue = Promise.resolve();
    const save = () => {
        const snapshot = redactor.value(outputSummary(record, execution));
        saveQueue = saveQueue.then(() => jsonWrite(path.join(runDir, 'run.json'), snapshot));
        return saveQueue;
    };
    let lastProgressSavedAt = 0;
    await fs.mkdir(storage, { recursive: true, mode: 0o700 });
    const release = await lockWorkspace(storage, workspace, runId);
    let timer;
    let deadline;
    let deadlineExpired = false;
    try {
        await fs.mkdir(runDir, { mode: 0o700 });
        await save();
        await jsonWrite(path.join(runDir, 'task.json'), redactor.value({ schemaVersion: 1, runId, workspace, role, purpose: record.purpose, configPath: resolved.settings.configPath, inputs: record.contextFiles, contextHash: record.contextHash, contextMode: record.contextMode, targetHash, execution: plan }));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        process.once('SIGINT', abort);
        process.once('SIGTERM', abort);
        deadline = setTimeout(() => { deadlineExpired = true; abort(); }, Math.max(1, timeoutMs - (Date.now() - invokedAt)));
        deadline.unref();
        timer = setInterval(() => { fs.access(path.join(runDir, 'cancel.json')).then(abort).catch(error => { if (error.code !== 'ENOENT') abort(); }); }, 100);
        timer.unref();
        if (options.capabilityRequirements?.length) {
            broker = await startCapabilityBroker(config, options.capabilityRequirements, {
                workflow, bindings: options.capabilityBindings, signal: controller.signal,
                maxCalls: Math.max(0, policy.maxToolCalls - (budget.toolCalls || 0)),
                maxRenderCalls: Math.max(0, policy.maxRenderCalls - (budget.renderCalls || 0)),
                onCall: data => { record.capabilityCalls = data.calls; record.renderCalls = data.renderCalls; },
            }, deps.capabilities || {});
            if (options.expectedCapabilitiesHash !== undefined && options.expectedCapabilitiesHash !== broker.capabilitiesHash) throw appError('CONFIG_INVALID', 'Capability bindings changed during this run. Start a new run to change them.');
            record.capabilitiesHash = broker.capabilitiesHash;
            record.capabilityProviders = broker.providers;
            if (broker.url) { redactor.add(broker.url); redactor.add(new URL(broker.url).pathname.slice(1)); }
        }
        const metadataKey = `${target.harness.adapter}\0${plan.process?.executable || target.harness.executable}\0${env.PATH || ''}`;
        let metadata = executableMetadata.get(metadataKey);
        if (!metadata) {
            metadata = await (engine.probe || runtime.probe)(plan, { checkExecutable: true, checkLogin: false, env: operationalEnv(env), signal: controller.signal, timeoutMs: Math.min(timeoutMs, 10000) });
            if (metadata.ok) executableMetadata.set(metadataKey, metadata);
        }
        record.preflight = metadata;
        record.toolVersions.cli = metadata.checks.find(check => check.name === 'executable' && check.status === 'passed')?.message ?? null;
        if (!metadata.ok) throw appError('AGENT_NOT_READY', 'Project Harness executable metadata check failed.');
        record.status = 'running';
        // The runtime has no caller-supplied redaction list. With a broker, keep
        // its bearer route out of runtime-owned raw logs and persist our own
        // redacted native-event projection instead.
        const projectedLogs = Boolean(broker?.url);
        if (projectedLogs) {
            record.logMode = 'redacted-event-projection';
            await fs.mkdir(path.join(runDir, 'runtime'), { mode: 0o700 });
            for (const file of ['stdout.log', 'stderr.log', 'events.jsonl']) await fs.writeFile(path.join(runDir, 'runtime', file), '', { flag: 'wx', mode: 0o600 });
            await jsonWrite(path.join(runDir, 'runtime', 'plan.json'), redactor.value(plan));
        }
        await save();
        await deps.onStart?.(redactor.value(outputSummary(record, execution)));
        execution = await engine.run(plan, {
            signal: controller.signal, ...(projectedLogs ? {} : { runDir: path.join(runDir, 'runtime') }),
            env: { ...operationalEnv(env), ...(broker?.url ? { VIDEO_REMAKE_CAPABILITY_URL: broker.url } : {}) }, resolveCredential: ref => env[ref],
            onEvent: async event => {
                record.lastEvent = { type: event.type, sequence: event.sequence, time: event.time || new Date().toISOString() };
                if (event.type === 'tool') {
                    const id = toolIdentity(event);
                    toolIds.add(id); record.toolCalls = toolIds.size;
                    if ((budget.toolCalls || 0) + record.toolCalls >= policy.maxToolCalls) { record.budgetExceeded = ['toolCalls']; abort(); }
                }
                if (event.type === 'usage' && policy.maxTokens !== null && Number.isFinite(event.data?.totalTokens) && (budget.tokens || 0) + event.data.totalTokens >= policy.maxTokens) { record.budgetExceeded = ['tokens']; abort(); }
                const safeEvent = redactor.value(event);
                if (projectedLogs) {
                    const line = `${JSON.stringify(safeEvent)}\n`;
                    await fs.appendFile(path.join(runDir, 'runtime', 'events.jsonl'), line, { mode: 0o600 });
                    await fs.appendFile(path.join(runDir, 'runtime', event.type === 'diagnostic' ? 'stderr.log' : 'stdout.log'), line, { mode: 0o600 });
                }
                if (Date.now() - lastProgressSavedAt >= 500) { await save(); lastProgressSavedAt = Date.now(); }
                await (deps.onEvent || options.onEvent)?.(safeEvent);
            },
        });
        if (projectedLogs) await jsonWrite(path.join(runDir, 'runtime', 'result.json'), redactor.value(execution));
        record.status = execution.status;
        if (deadlineExpired && record.status === 'cancelled') record.status = 'timed_out';
        record.finishedAt = execution.finishedAt || new Date().toISOString();
        if (policy.maxTokens !== null && execution.usage?.totalTokens !== undefined && (budget.tokens || 0) + execution.usage.totalTokens > policy.maxTokens) record.budgetExceeded.push('tokens');
        if (policy.maxCostUsd !== null && execution.cost?.currency === 'USD' && (budget.costUsd || 0) + execution.cost.total > policy.maxCostUsd) record.budgetExceeded.push('costUsd');
        record.budgetExceeded = [...new Set(record.budgetExceeded)];
        if (record.budgetExceeded.length) record.status = 'budget_exhausted';
    } catch (error) {
        record.status = record.budgetExceeded.length ? 'budget_exhausted' : deadlineExpired ? 'timed_out' : controller.signal.aborted ? 'cancelled' : 'failed';
        record.error = redactor.text(error.message);
        record.finishedAt = new Date().toISOString();
    } finally {
        if (record.status === 'timed_out') record.error = `Project Agent exceeded its ${timeoutMs} ms execution deadline; saved source requires a controlled continuation and fresh validation.`;
        clearInterval(timer);
        clearTimeout(deadline);
        await broker?.close();
        signal?.removeEventListener('abort', abort);
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
        try { await save(); } finally { await release(); }
    }
    const summary = redactor.value(outputSummary(record, execution));
    if (summary.status !== 'completed') throw appError(`AGENT_${summary.status.toUpperCase()}`, summary.error || `Project Agent ${summary.status}.`, { data: { run: summary, reproAgent: summary } });
    return summary;
}

export async function probeRole(config, options = {}, deps = {}) {
    const engine = deps.runtime || runtime;
    const workflow = options.workflow || await loadWorkflow(config, { workflowPath: options.workflowPath, configPath: options.agentConfig });
    const resolved = await resolveRole(config, workflow, options.role || 'executor', { target: options.target, agentConfig: options.agentConfig, requireEnabled: false });
    const { target } = resolved;
    const workspace = await fs.realpath(options.workspace || config.workspace);
    const execution = engine.plan({ runId: 'repro-doctor', workspace, prompt: 'Check executable and authentication metadata only. No model request.', target, timeoutMs: resolved.settings.timeoutMs });
    const env = await agentCredentialEnvironment(config, target);
    const redactor = runtime.createRedactor();
    if (target.backend.auth === 'api-key' && typeof env[target.backend.apiKeyEnv] === 'string') redactor.add(env[target.backend.apiKeyEnv]);
    const readiness = await engine.probe(execution, { checkExecutable: true, checkLogin: !!options.checkLogin, env: operationalEnv(env), signal: options.signal || deps.signal });
    readiness.checks.push({ name: 'enabled', status: resolved.enabled ? 'passed' : 'failed', message: resolved.enabled ? 'Target enabled.' : 'Target disabled.' });
    if (target.backend.auth === 'api-key') {
        const present = typeof env[target.backend.apiKeyEnv] === 'string' && !!env[target.backend.apiKeyEnv].trim();
        readiness.checks.push({ name: 'credential', status: present ? 'passed' : 'failed', message: `${target.backend.apiKeyEnv}: ${present ? 'configured' : 'missing'}` });
    }
    readiness.ok = readiness.ok && !readiness.checks.some(check => check.status === 'failed');
    return redactor.value({ role: resolved.role, target: target.name, model: target.backend.model, harness: target.harness.adapter, contextMode: resolved.contextMode, limitations: resolved.limitations, targetHash: resolved.targetHash, readiness });
}

export async function doctorWorkflow(config, options = {}, deps = {}) {
    const workflow = options.workflow || await loadWorkflow(config, { workflowPath: options.workflowPath, configPath: options.agentConfig });
    const roles = options.role ? [options.role] : ROLES;
    const reports = await Promise.all(roles.map(async role => {
        try { return await probeRole(config, { ...options, workflow, role }, deps); }
        catch (error) { return { role, readiness: { ok: false, checks: [{ name: 'configuration', status: 'failed', message: error.message }] } }; }
    }));
    return { workflowPath: workflow.workflowPath, policy: workflow.policy, ok: reports.every(report => report.readiness.ok), roles: reports };
}

function runId(value) {
    if (typeof value !== 'string' || !/^p_[a-zA-Z0-9_-]{1,100}$/.test(value)) throw appError('INVALID_INPUT', 'Invalid project Agent run ID.');
    return value;
}

export async function projectAgentStatus(config, id) {
    const root = path.join(agentStorageRoot(config), 'repro-agent-logs');
    if (!id) {
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const runs = await Promise.all(entries.filter(entry => entry.isDirectory() && /^p_/.test(entry.name)).map(entry => projectAgentStatus(config, entry.name)));
        return { runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)), storageRoot: root };
    }
    const filename = await regular(root, `${runId(id)}/run.json`);
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (record.runId !== id || record.ownerWorkspace !== await fs.realpath(config.workspace)) throw appError('AGENT_RECORD_INVALID', 'Project Agent record does not belong to this workspace.');
    if (ACTIVE.has(record.status)) {
        if (!alive(record.owner)) return { ...record, status: 'interrupted' };
        record.elapsedMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
        // Older in-flight runners persisted only at start/end. Read their
        // redacted event projection too so the UI does not show stale zeroes.
        const events = await regular(root, `${runId(id)}/runtime/events.jsonl`, { optional: true });
        if (events && (await fs.stat(events)).size <= 64 * 1024 * 1024) {
            const ids = new Set();
            const lines = createInterface({ input: createReadStream(events), crlfDelay: Infinity });
            for await (const line of lines) {
                let event; try { event = JSON.parse(line); } catch { continue; }
                if (event.type === 'tool') ids.add(toolIdentity(event));
                if (event.type) record.lastEvent = { type: event.type, sequence: event.sequence, time: event.time ?? null };
            }
            record.toolCalls = Math.max(record.toolCalls || 0, ids.size);
        }
    }
    return record;
}

export async function projectAgentCancel(config, id) {
    const record = await projectAgentStatus(config, id);
    if (!ACTIVE.has(record.status)) return { runId: id, status: record.status };
    const root = path.join(agentStorageRoot(config), 'repro-agent-logs');
    const folder = await regular(root, runId(id));
    await jsonWrite(path.join(folder, 'cancel.json'), { requestedAt: new Date().toISOString() });
    return { runId: id, status: 'cancel_requested' };
}

export async function projectAgentLogs(config, id, { stream = 'stdout', lines = 100 } = {}) {
    await projectAgentStatus(config, id);
    if (!Object.hasOwn(STREAMS, stream)) throw appError('INVALID_INPUT', 'Unknown Agent log stream.');
    lines = Number(lines);
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000) throw appError('INVALID_INPUT', 'Log lines must be an integer between 1 and 10000.');
    const root = path.join(agentStorageRoot(config), 'repro-agent-logs');
    const filename = await regular(root, `${runId(id)}/runtime/${STREAMS[stream]}`, { optional: true });
    let text = '';
    if (filename) {
        const handle = await fs.open(filename, 'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw appError('AGENT_RECORD_INVALID', 'Agent log is not a regular file.');
            const start = Math.max(0, stat.size - MAX_CONTEXT);
            const buffer = Buffer.alloc(stat.size - start);
            const result = await handle.read(buffer, 0, buffer.length, start);
            text = buffer.subarray(0, result.bytesRead).toString('utf8');
            if (start) text = text.slice(text.indexOf('\n') + 1);
            text = text.replace(/\n$/, '').split('\n').slice(-lines).join('\n');
        } finally { await handle.close(); }
    }
    return { runId: id, stream, text };
}

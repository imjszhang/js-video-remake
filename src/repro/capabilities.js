import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { createRedactor } from 'js-agent-runtime';
import { appError } from '../errors.js';

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const MAX_OUTPUT = 1024 * 1024;
const fail = message => appError('CONFIG_INVALID', message);
const obj = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${name} must be an object.`);
    return value;
};
const fields = (value, names, label) => {
    for (const name of Object.keys(value)) if (!names.includes(name)) throw fail(`Unknown ${label} field: ${name}`);
};

/** Portable declarations contain names and requirements, not machine bindings. */
export function validateRequirements(input = []) {
    if (!Array.isArray(input)) throw fail('Project capabilities must be an array.');
    const names = new Set();
    return input.map(value => {
        const requirement = typeof value === 'string' ? { id: value } : obj(value, 'Capability requirement');
        fields(requirement, ['id', 'required', 'description'], 'capability requirement');
        if (!ID.test(requirement.id)) throw fail('Capability IDs must be logical names such as asset.search.');
        if (names.has(requirement.id)) throw fail(`Duplicate capability requirement: ${requirement.id}`);
        names.add(requirement.id);
        if (requirement.required !== undefined && typeof requirement.required !== 'boolean') throw fail('Capability required must be boolean.');
        if (requirement.description !== undefined && typeof requirement.description !== 'string') throw fail('Capability description must be text.');
        return { id: requirement.id, required: requirement.required ?? true, ...(requirement.description === undefined ? {} : { description: requirement.description }) };
    });
}

function httpURL(value, label) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
        return url.href;
    } catch { throw fail(`${label} must be an HTTP(S) URL without inline credentials, query or fragment.`); }
}

function validateBinding(value, id, workspace) {
    obj(value, `Capability ${id}`);
    if (!ID.test(id)) throw fail(`Invalid capability ID: ${id}`);
    const timeoutMs = value.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw fail('Capability timeoutMs must be between 1 and 600000.');
    if (value.transport === 'mcp') {
        fields(value, ['transport', 'server', 'tool', 'timeoutMs'], 'MCP binding');
        if (typeof value.server !== 'string' || !value.server.trim() || typeof value.tool !== 'string' || !value.tool.trim()) throw fail('MCP bindings require server and tool names.');
        return { transport: 'mcp', server: value.server, tool: value.tool, timeoutMs };
    }
    if (value.transport === 'http') {
        fields(value, ['transport', 'url', 'method', 'tokenEnv', 'healthUrl', 'timeoutMs'], 'HTTP binding');
        const method = value.method ?? 'POST';
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw fail('Unsupported capability HTTP method.');
        if (value.tokenEnv !== undefined && !ENV.test(value.tokenEnv)) throw fail('Capability tokenEnv must name an environment variable.');
        return { transport: 'http', url: httpURL(value.url, 'Capability URL'), method, timeoutMs,
            ...(value.tokenEnv ? { tokenEnv: value.tokenEnv } : {}),
            ...(value.healthUrl ? { healthUrl: httpURL(value.healthUrl, 'Capability health URL') } : {}),
        };
    }
    if (value.transport === 'local') {
        fields(value, ['transport', 'command', 'args', 'cwd', 'probeArgs', 'envRefs', 'timeoutMs'], 'local binding');
        if (typeof value.command !== 'string' || !value.command.trim() || value.command.includes('\0')) throw fail('Local capability command must name an executable.');
        for (const key of ['args', 'probeArgs']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw fail(`Local capability ${key} must be a string array.`);
        const envRefs = value.envRefs ?? {};
        obj(envRefs, 'Local capability envRefs');
        for (const [name, ref] of Object.entries(envRefs)) {
            if (!ENV.test(name) || !ENV.test(ref) || /^(?:PATH|HOME|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/.test(name)) throw fail('Local capability envRefs must contain credential variable references, not execution overrides.');
        }
        if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim() || value.cwd.includes('\0'))) throw fail('Local capability cwd must be a directory path.');
        return { transport: 'local', command: value.command, args: value.args ?? [], timeoutMs, cwd: path.resolve(workspace, value.cwd ?? '.'), envRefs,
            ...(value.probeArgs === undefined ? {} : { probeArgs: value.probeArgs }),
        };
    }
    throw fail(`Unknown capability transport: ${value.transport}`);
}

export async function loadCapabilityBindings(config, { bindingsPath, workflow, allowMissing = true } = {}) {
    const env = config.env || process.env;
    const explicit = bindingsPath ?? workflow?.capabilitiesFile ?? env.VIDEO_REMAKE_REPRO_CAPABILITIES;
    const filename = path.resolve(config.workspace, explicit ?? 'reproduction-capabilities.local.json');
    let raw;
    try {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw fail('Capability bindings must be a regular JSON file smaller than 256 KiB.');
        raw = JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' && explicit === undefined && allowMissing) raw = { schemaVersion: 1, bindings: {} };
        else if (error.code === 'CONFIG_INVALID') throw error;
        else throw fail(`Cannot read capability bindings: ${filename}`);
    }
    obj(raw, 'Capability bindings'); fields(raw, ['schemaVersion', 'bindings'], 'capability bindings');
    if (raw.schemaVersion !== 1) throw fail('Capability bindings schemaVersion must be 1.');
    obj(raw.bindings, 'Capability bindings map');
    return { schemaVersion: 1, bindingsPath: filename, bindings: Object.fromEntries(Object.entries(raw.bindings).map(([id, binding]) => [id, validateBinding(binding, id, config.workspace)])) };
}

export function resolveCapabilities(requirements, configuration) {
    return validateRequirements(requirements).map(requirement => {
        const binding = configuration?.bindings?.[requirement.id];
        return { ...requirement, binding: binding ?? null,
            status: !binding ? (requirement.required ? 'missing' : 'optional-unbound') : binding.transport === 'mcp' ? 'unsupported' : 'configured',
            ...(binding?.transport === 'mcp' ? { reason: 'The installed Agent runtime disables MCP. A native runtime integration is required; a binding file alone does not enable it.' } : {}),
        };
    });
}

function credentialState(binding, env) {
    const refs = binding.tokenEnv ? [binding.tokenEnv] : Object.values(binding.envRefs || {});
    const missing = refs.filter(ref => typeof env[ref] !== 'string' || !env[ref].trim() || env[ref].includes('\0'));
    const redactor = createRedactor(refs.map(ref => env[ref]).filter(Boolean));
    return { missing, redactor };
}

async function httpRequest(binding, input, { env, signal, fetch: fetcher = globalThis.fetch, health = false }) {
    const { missing, redactor } = credentialState(binding, env);
    if (missing.length) throw fail(`Missing capability credential: ${missing.join(', ')}`);
    const headers = { Accept: 'application/json' };
    if (binding.tokenEnv) headers.Authorization = `Bearer ${env[binding.tokenEnv]}`;
    const method = health ? 'GET' : binding.method;
    const url = new URL(health ? binding.healthUrl : binding.url);
    const options = { method, headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(binding.timeoutMs), ...(signal ? [signal] : [])]) };
    if (!health && method === 'GET') {
        if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) throw appError('INVALID_INPUT', 'GET capability input must be an object.');
        for (const [key, value] of Object.entries(input || {})) {
            if (!['string', 'number', 'boolean'].includes(typeof value)) throw appError('INVALID_INPUT', 'GET capability values must be scalar.');
            url.searchParams.set(key, String(value));
        }
    } else if (!health) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(input ?? {}); }
    let response;
    try { response = await fetcher(url, options); }
    catch (error) { throw appError('CAPABILITY_FAILED', redactor.text(`Capability request failed: ${error.message}`)); }
    if (!response.ok) { await response.body?.cancel(); throw appError('CAPABILITY_FAILED', `Capability returned HTTP ${response.status}.`); }
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) {
        try {
            while (true) {
                const { value, done } = await reader.read(); if (done) break;
                size += value.length;
                if (size > MAX_OUTPUT) { await reader.cancel(); throw appError('CAPABILITY_FAILED', 'Capability response exceeds 1 MiB.'); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
    }
    const text = redactor.text(Buffer.concat(chunks).toString('utf8'));
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: 'completed', transport: 'http', httpStatus: response.status, data };
}

async function localRequest(binding, input, { env, signal, health = false, spawn: launch = spawn }) {
    const { missing, redactor } = credentialState(binding, env);
    if (missing.length) throw fail(`Missing capability credential: ${missing.join(', ')}`);
    const safeEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
    for (const [key, ref] of Object.entries(binding.envRefs || {})) safeEnv[key] = env[ref];
    if (signal?.aborted) throw appError('CAPABILITY_CANCELLED', 'Capability invocation cancelled.');
    return new Promise((resolve, reject) => {
        const child = launch(binding.command, health ? binding.probeArgs : binding.args, { cwd: binding.cwd, env: safeEnv, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        const output = [], diagnostic = []; let total = 0; let failure = null; let force;
        const terminate = sig => {
            try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {}
        };
        const kill = (kind, message) => {
            if (failure) return;
            failure = appError(kind, message);
            terminate('SIGTERM'); force = setTimeout(() => terminate('SIGKILL'), 250); force.unref();
        };
        const timer = setTimeout(() => kill('CAPABILITY_TIMED_OUT', 'Capability invocation timed out.'), binding.timeoutMs);
        const abort = () => kill('CAPABILITY_CANCELLED', 'Capability invocation cancelled.');
        signal?.addEventListener('abort', abort, { once: true });
        const collect = stream => chunk => {
            total += chunk.length;
            if (total > MAX_OUTPUT) return kill('CAPABILITY_FAILED', 'Capability output exceeds 1 MiB.');
            if (stream === 'stdout') output.push(chunk); else diagnostic.push(chunk);
        };
        child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
        child.stdin.on('error', () => {});
        child.on('error', error => { failure = appError('CAPABILITY_FAILED', redactor.text(`Cannot start capability: ${error.message}`)); });
        child.on('close', code => {
            if (failure) terminate('SIGKILL');
            clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', abort);
            if (failure) return reject(failure);
            if (code !== 0) return reject(appError('CAPABILITY_FAILED', redactor.text(`Capability exited ${code}: ${Buffer.concat(diagnostic).toString('utf8').slice(0, 1000)}`)));
            const text = redactor.text(Buffer.concat(output).toString('utf8')); let data;
            try { data = JSON.parse(text); } catch { data = text; }
            resolve({ status: 'completed', transport: 'local', exitCode: code, data });
        });
        child.stdin.end(health ? '' : `${JSON.stringify(input ?? {})}\n`);
    });
}

export async function invokeCapability(config, id, input, options = {}, deps = {}) {
    const bindings = options.bindings || await loadCapabilityBindings(config, options);
    const binding = bindings.bindings?.[id];
    if (!binding) throw appError('CAPABILITY_UNAVAILABLE', `No local binding for capability ${id}.`);
    if (binding.transport === 'mcp') throw appError('CAPABILITY_UNSUPPORTED', 'MCP is disabled by the installed Agent runtime; configure a supported local or HTTP binding.');
    const payload = JSON.stringify(input ?? {});
    if (Buffer.byteLength(payload) > MAX_OUTPUT) throw appError('INVALID_INPUT', 'Capability input exceeds 1 MiB.');
    const context = { ...deps, env: config.env || process.env, signal: options.signal || deps.signal };
    const result = binding.transport === 'http' ? await httpRequest(binding, input, context) : await localRequest(binding, input, context);
    return { id, ...result };
}

export async function doctorCapabilities(config, requirements = [], options = {}, deps = {}) {
    const bindings = options.bindings || await loadCapabilityBindings(config, options);
    const resolutions = resolveCapabilities(requirements, bindings);
    const checks = await Promise.all(resolutions.map(async resolution => {
        const { binding, ...report } = resolution;
        if (!binding || resolution.status === 'unsupported') return { ...report, status: resolution.status === 'optional-unbound' ? 'skipped' : 'failed' };
        const { missing } = credentialState(binding, config.env || process.env);
        if (missing.length) return { ...report, status: 'failed', message: `Missing credential: ${missing.join(', ')}` };
        if (options.probe !== true || (binding.transport === 'http' ? !binding.healthUrl : !binding.probeArgs)) return { ...report, status: 'configured', transport: binding.transport, message: 'Binding configured; service reachability has not been checked.' };
        try {
            const context = { ...deps, env: config.env || process.env, signal: options.signal || deps.signal, health: true };
            if (binding.transport === 'http') await httpRequest(binding, undefined, context); else await localRequest(binding, undefined, context);
            return { ...report, status: 'passed', transport: binding.transport };
        } catch (error) { return { ...report, status: 'failed', transport: binding.transport, message: error.message }; }
    }));
    return { ok: !checks.some(check => check.required && check.status === 'failed'), bindingsPath: bindings.bindingsPath, checks };
}

/** A per-run host broker keeps service credentials out of the Agent process. */
export async function startCapabilityBroker(config, requirements = [], options = {}, deps = {}) {
    const bindings = options.bindings || await loadCapabilityBindings(config, options);
    const resolved = resolveCapabilities(requirements, bindings);
    const unavailable = resolved.filter(item => item.required && ['missing', 'unsupported'].includes(item.status));
    if (unavailable.length) throw appError('CAPABILITY_UNAVAILABLE', `Required capabilities unavailable: ${unavailable.map(item => item.id).join(', ')}.`);
    const allowed = resolved.filter(item => item.status === 'configured');
    for (const item of allowed) {
        const { missing } = credentialState(item.binding, config.env || process.env);
        if (missing.length) throw fail(`Missing capability credential: ${missing.join(', ')}`);
    }
    const providers = allowed.map(item => ({ id: item.id, transport: item.binding.transport }));
    const capabilitiesHash = createHash('sha256').update(JSON.stringify(allowed.map(item => ({ id: item.id, binding: item.binding })))).digest('hex');
    if (!allowed.length) return { url: null, capabilitiesHash, providers, close: async () => {}, stats: () => ({ calls: 0, renderCalls: 0, completed: 0, failed: 0 }) };
    const accepted = new Set(allowed.map(item => item.id));
    const secretPath = `/${randomBytes(32).toString('hex')}`;
    const active = new Set();
    const counts = { calls: 0, renderCalls: 0, completed: 0, failed: 0 };
    let closing = false;
    const server = http.createServer(async (request, response) => {
        const reply = (code, value) => { if (!response.destroyed) { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); } };
        if (closing || request.method !== 'POST' || request.url !== secretPath || request.headers.origin || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
            request.resume(); reply(404, { error: 'Unavailable capability route.' }); return;
        }
        if (active.size >= (options.maxConcurrent ?? 4)) { request.resume(); reply(429, { error: 'Capability concurrency limit reached.' }); return; }
        const controller = new AbortController();
        active.add(controller);
        const disconnected = () => { if (!response.writableFinished) controller.abort(); };
        response.once('close', disconnected);
        try {
            const chunks = []; let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > MAX_OUTPUT) { reply(413, { error: 'Capability input exceeds 1 MiB.' }); return; }
                chunks.push(chunk);
            }
            let payload;
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { reply(400, { error: 'Invalid capability JSON.' }); return; }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['id', 'input'].includes(key)) || !accepted.has(payload.id)) { reply(403, { error: 'Capability is not declared for this project.' }); return; }
            if (counts.calls >= (options.maxCalls ?? 100)) { reply(429, { error: 'Capability call budget exhausted.' }); return; }
            if (payload.id.startsWith('render.') && counts.renderCalls >= (options.maxRenderCalls ?? 20)) { reply(429, { error: 'Capability render budget exhausted.' }); return; }
            counts.calls++;
            if (payload.id.startsWith('render.')) counts.renderCalls++;
            await options.onCall?.({ id: payload.id, transport: allowed.find(item => item.id === payload.id).binding.transport, ...counts });
            const result = await invokeCapability(config, payload.id, payload.input, { bindings, signal: controller.signal }, deps);
            counts.completed++;
            reply(200, result);
        } catch (error) {
            counts.failed++;
            // Invocation helpers redact declared credentials before reporting errors.
            reply(controller.signal.aborted ? 499 : 502, { error: error.message, code: error.code || 'CAPABILITY_FAILED' });
        } finally { active.delete(controller); response.removeListener('close', disconnected); }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    let closePromise;
    const close = () => {
        if (closePromise) return closePromise;
        closing = true;
        options.signal?.removeEventListener('abort', onAbort);
        for (const controller of active) controller.abort();
        closePromise = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        return closePromise;
    };
    const onAbort = () => { void close(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) await close();
    return { url: `http://127.0.0.1:${address.port}${secretPath}`, capabilitiesHash, providers, close, stats: () => ({ ...counts }) };
}

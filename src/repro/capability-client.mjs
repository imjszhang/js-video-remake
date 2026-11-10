// Copied into standalone projects. No host application imports are permitted.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBytes = 1024 * 1024;
const secrets = new Set();
function addSecret(value) {
    for (const variant of [value, encodeURIComponent(value), encodeURI(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), JSON.stringify(value).slice(1, -1)]) if (variant) secrets.add(variant);
}
const redact = text => [...secrets].sort((a, b) => b.length - a.length).reduce((value, secret) => value.split(secret).join('[REDACTED]'), String(text));
async function responseJson(response) {
    const chunks = []; let length = 0;
    for await (const bytes of response.body || []) {
        length += bytes.length;
        if (length > maxBytes) throw new Error('Response exceeds 1 MiB.');
        chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Capability returned invalid JSON.'); }
}
async function localFile(relative) {
    if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Expected a project-relative input file.');
    let file = root;
    for (const part of relative.split('/')) { file = path.join(file, part); if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Symlinks are not supported.'); }
    if ((await fs.stat(file)).size > maxBytes) throw new Error('Input exceeds 1 MiB.');
    return file;
}
function credential(name) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name || '')) throw new Error('Invalid credential environment reference.');
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    addSecret(value); return value;
}
try {
    const [id, inputFile] = process.argv.slice(2);
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id || '')) throw new Error('Usage: node scripts/capability.mjs capability.id [input.json]');
    const manifest = JSON.parse(await fs.readFile(await localFile('reproduction.json'), 'utf8'));
    if (!(manifest.capabilities || []).some(item => (typeof item === 'string' ? item : item.id) === id)) throw new Error('Capability is not declared by this project.');
    const input = inputFile ? JSON.parse(await fs.readFile(await localFile(inputFile), 'utf8')) : {};
    if (process.env.VIDEO_REMAKE_CAPABILITY_URL) {
        const endpoint = new URL(process.env.VIDEO_REMAKE_CAPABILITY_URL);
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('The managed capability broker must be local.');
        addSecret(endpoint.href); addSecret(endpoint.pathname.slice(1));
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, input }), redirect: 'error', signal: AbortSignal.timeout(600000) });
        const result = await responseJson(response);
        if (!response.ok || result.ok === false) throw new Error(result.error?.message || result.error || `Capability HTTP ${response.status}`);
        process.stdout.write(`${redact(JSON.stringify(result.data ?? result))}\n`);
        process.exit(0);
    }
    const config = JSON.parse(await fs.readFile(await localFile('.reproduction-capabilities.local.json'), 'utf8'));
    const binding = config.bindings?.[id];
    if (!binding) throw new Error(`Configure ${id} in .reproduction-capabilities.local.json.`);
    const timeoutMs = binding.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid capability timeout.');
    let result;
    if (binding.transport === 'http') {
        const url = new URL(binding.url);
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid capability endpoint.');
        const method = binding.method || 'POST';
        if (!['GET','POST','PUT','DELETE'].includes(method)) throw new Error('Unsupported HTTP method.');
        const headers = { Accept: 'application/json' };
        if (binding.tokenEnv) headers.Authorization = `Bearer ${credential(binding.tokenEnv)}`;
        const options = { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
        if (method === 'GET') {
            for (const [key, value] of Object.entries(input)) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        } else { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(input); }
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`Capability HTTP ${response.status}`);
        result = await responseJson(response);
    } else if (binding.transport === 'local') {
        if (typeof binding.command !== 'string' || !Array.isArray(binding.args || []) || (binding.args || []).some(v => typeof v !== 'string')) throw new Error('Invalid local capability command.');
        const env = Object.fromEntries(['PATH','HOME','TMPDIR'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
        for (const [key, ref] of Object.entries(binding.envRefs || {})) {
            if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /^(PATH|HOME|NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/.test(key)) throw new Error('Invalid capability environment mapping.');
            env[key] = credential(ref);
        }
        result = await new Promise((resolve, reject) => {
            const child = spawn(binding.command, binding.args || [], { cwd: path.resolve(root, binding.cwd || '.'), env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
            const chunks = []; let length = 0, failure = null, force;
            const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
            const stop = error => { if (failure) return; failure = error; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 250); };
            const timer = setTimeout(() => stop(new Error('Capability timed out.')), timeoutMs);
            const interrupted = () => stop(new Error('Capability cancelled.'));
            process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
            const cleanup = () => { clearTimeout(timer); clearTimeout(force); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); };
            child.on('error', error => { failure = error; });
            child.stdout.on('data', data => { length += data.length; if (length > maxBytes) stop(new Error('Output exceeds 1 MiB.')); else chunks.push(data); });
            // Avoid leaking service credentials in subprocess diagnostics.
            child.stderr.on('data', data => { length += data.length; if (length > maxBytes) stop(new Error('Output exceeds 1 MiB.')); });
            child.on('close', code => {
                if (failure) kill('SIGKILL');
                cleanup();
                if (failure) reject(failure);
                else if (code !== 0) reject(new Error(`Capability exited ${code}.`));
                else { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Capability returned invalid JSON.')); } }
            });
            child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
        });
    } else throw new Error('MCP requires a supported native Harness connection; this project client supports local and HTTP bindings.');
    process.stdout.write(`${redact(JSON.stringify(result))}\n`);
} catch (error) { process.stderr.write(`${redact(error.message)}\n`); process.exitCode = 1; }

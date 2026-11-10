import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { appError } from '../errors.js';
import { validateSpec } from './schema.js';
import { safeProjectFile, HYPERFRAMES_VERSION } from './project.js';
import { hashFile } from './evaluate.js';
import { precheckComposition } from '../precheck.js';

export const HYPERFRAMES_CLI = fileURLToPath(new URL('../../node_modules/hyperframes/bin/hyperframes.mjs', import.meta.url));
const TRUSTED_CLI = HYPERFRAMES_CLI;
export const HYPERFRAMES_PACKAGE = fileURLToPath(new URL('../../node_modules/hyperframes/package.json', import.meta.url));
const TRUSTED_PACKAGE = HYPERFRAMES_PACKAGE;
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

async function jsonFile(workspace, relative) {
    const file = await safeProjectFile(workspace, relative);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw appError('REPRO_INVALID', `渲染配置必须是小于 8 MiB 的普通文件: ${relative}`);
    return { file, data: JSON.parse(await fs.readFile(file, 'utf8')) };
}

/** Only operational, non-secret variables are inherited by the fixed provider. */
export function rendererEnvironment(workspace, env = process.env) {
    const allowedPath = (env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
        .split(path.delimiter).filter(value => path.isAbsolute(value) && !inside(workspace, path.resolve(value)));
    const result = { PATH: [...new Set([path.dirname(process.execPath), ...allowedPath])].join(path.delimiter),
        LANG: 'en_US.UTF-8', CI: '1', NO_COLOR: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_TELEMETRY: '1' };
    for (const key of ['TMPDIR', 'TMP', 'TEMP', 'HYPERFRAMES_BROWSER_PATH']) {
        if (typeof env[key] === 'string' && path.isAbsolute(env[key]) && !inside(workspace, path.resolve(env[key]))) result[key] = env[key];
    }
    if (process.platform === 'win32' && typeof env.SystemRoot === 'string') result.SystemRoot = env.SystemRoot;
    return result;
}

export function runFixedCommand(executable, args, { cwd, env, signal, timeoutMs, onStart, maxOutputBytes = 32 * 1024 }, deps = {}) {
    return new Promise((resolve, reject) => {
        let child, timer, killTimer, settled = false, reason;
        let stdout = '', stderr = '';
        // Keep the tail of long logs; callers that parse stdout raise the limit.
        const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-maxOutputBytes);
        const killGroup = name => {
            if (!child?.pid) return;
            try { if (process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); }
            catch (error) { if (error.code !== 'ESRCH') { try { child.kill(name); } catch { /* already gone */ } } }
        };
        const stop = nextReason => {
            if (settled || reason) return;
            reason = nextReason;
            killGroup('SIGTERM');
            killTimer = setTimeout(() => killGroup('SIGKILL'), 1500);
            killTimer.unref?.();
        };
        const abort = () => stop('cancelled');
        const finish = (error, code, childSignal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); clearTimeout(killTimer);
            signal?.removeEventListener('abort', abort);
            // A child can exit before a browser descendant responds to TERM.
            // Always terminate the remaining group before resolving cancellation.
            if (reason) killGroup('SIGKILL');
            const result = { exitCode: code ?? null, signal: childSignal ?? null, stdout, stderr, termination: reason || null };
            if (error) reject(Object.assign(error, { renderProcess: result })); else resolve(result);
        };
        if (signal?.aborted) return resolve({ exitCode: null, signal: null, stdout, stderr, termination: 'cancelled' });
        try {
            child = (deps.spawn || spawn)(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
            child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
            child.once('error', error => finish(error));
            child.once('close', (code, childSignal) => finish(null, code, childSignal));
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => stop('timeout'), timeoutMs);
            timer.unref?.();
            Promise.resolve(onStart?.({ pid: child.pid, provider: 'local-hyperframes' })).catch(() => stop('cancelled'));
            if (signal?.aborted) abort();
        } catch (error) { finish(error); }
    });
}

/** Fixed local tool provider: never executes generated npm/preparation scripts. */
export async function renderProject(config, { workspace, spec: rawSpec, timeoutMs = 600_000, signal }, deps = {}) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw appError('REPRO_INVALID', '渲染项目必须使用绝对路径。');
    const rootInfo = await fs.lstat(workspace);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw appError('REPRO_INVALID', '渲染项目必须是真实目录。');
    workspace = await fs.realpath(workspace);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000) throw appError('REPRO_INVALID', '渲染超时必须是 1–86400000 毫秒。');
    const spec = validateSpec(rawSpec || (await jsonFile(workspace, 'task/spec.json')).data);
    const { data: manifest } = await jsonFile(workspace, 'reproduction.json');
    if (manifest.schema !== 'video-remake.reproduction-project@1' || manifest.status !== 'ready' || manifest.output !== spec.acceptance.media.file) throw appError('REPRO_RENDER_NOT_READY', '工程须为 ready，且输出路径匹配冻结规格。');
    const { data: acceptance } = await jsonFile(workspace, 'task/acceptance.json');
    if (JSON.stringify(validateSpec({ ...spec, acceptance }).acceptance) !== JSON.stringify(spec.acceptance)) throw appError('REPRO_INVALID', '工程验收要求与冻结规格不一致。');
    const { data: pkg } = await jsonFile(workspace, 'package.json');
    const { data: lock } = await jsonFile(workspace, 'package-lock.json');
    const trustedPackage = JSON.parse(await fs.readFile(TRUSTED_PACKAGE, 'utf8'));
    if (pkg.dependencies?.hyperframes !== HYPERFRAMES_VERSION || lock.packages?.['']?.dependencies?.hyperframes !== HYPERFRAMES_VERSION
        || lock.packages?.['node_modules/hyperframes']?.version !== HYPERFRAMES_VERSION || lock.lockfileVersion !== 3 || trustedPackage.version !== HYPERFRAMES_VERSION) {
        throw appError('REPRO_RENDER_VERSION', `本地渲染提供方与项目锁文件必须统一为 HyperFrames ${HYPERFRAMES_VERSION}。`);
    }
    // HyperFrames loads cwd/.env before parsing its command. Refuse it instead
    // of letting a project inject NODE_OPTIONS, browser overrides or secrets.
    try { await fs.lstat(path.join(workspace, '.env')); throw appError('REPRO_INVALID', '托管渲染工程中不得存在 .env；凭据应保留在提供方之外。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entry = await safeProjectFile(workspace, manifest.entry);
    if (!(await fs.stat(entry)).isFile() || path.extname(entry).toLowerCase() !== '.html') throw appError('REPRO_INVALID', '托管渲染入口必须是项目内 HTML 文件。');
    const { file: inputFile, data: inputs } = await jsonFile(workspace, manifest.inputsFile);
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw appError('REPRO_INVALID', '渲染输入必须是对象。');
    const output = await safeProjectFile(workspace, manifest.output, { create: true });
    const extension = path.extname(output).toLowerCase();
    if (!['.mp4', '.webm', '.mov'].includes(extension)) throw appError('REPRO_INVALID', '本地渲染提供方支持 mp4、webm、mov 视频。');
    const temporary = path.join(path.dirname(output), `.repro-render-${randomUUID()}${extension}`);
    const frozen = { entrySha256: (await hashFile(entry)).sha256, inputsSha256: (await hashFile(inputFile)).sha256, cliSha256: (await hashFile(TRUSTED_CLI)).sha256 };
    const args = [TRUSTED_CLI, 'render', workspace, '--composition', manifest.entry, '--output', temporary, '--format', extension.slice(1), '--variables-file', inputFile, '--quality', 'looks', '--strict'];
    const started = performance.now();
    const record = { provider: 'local-hyperframes', version: HYPERFRAMES_VERSION, status: 'running', entry: manifest.entry,
        output: manifest.output, ...frozen, commandHash: digest(JSON.stringify([process.execPath, ...args])),
        preparation: 'agent-materialized-project', startedAt: new Date().toISOString(), renderCalls: 0 };
    try {
        const checked = await precheckComposition({
            dir: path.dirname(entry), entry: path.basename(entry), projectRoot: workspace, timeoutMs, signal,
            env: { ...process.env, ...config.env }, cancelCode: 'REPRO_RENDER_CANCELLED', timeoutCode: 'REPRO_RENDER_TIMEOUT',
        }, deps);
        record.precheck = { status: checked.hyperframesCheck, warnings: checked.warnings.length, fps: checked.fps };
        const remainingMs = Math.floor(timeoutMs - (performance.now() - started));
        if (remainingMs < 1) throw appError('REPRO_RENDER_TIMEOUT', '渲染超过时间预算。');
        record.renderCalls = 1;
        const result = await runFixedCommand(process.execPath, args, { cwd: workspace, env: rendererEnvironment(workspace, { ...process.env, ...config.env }),
            signal, timeoutMs: remainingMs, onStart: deps.onStart }, deps);
        record.process = result;
        if (result.termination) throw appError(result.termination === 'cancelled' ? 'REPRO_RENDER_CANCELLED' : 'REPRO_RENDER_TIMEOUT', result.termination === 'cancelled' ? '渲染已取消。' : '渲染超过时间预算。');
        if (result.exitCode !== 0) throw appError('REPRO_RENDER_FAILED', `固定 HyperFrames 渲染失败（退出码 ${result.exitCode}）。`);
        if ((await hashFile(entry)).sha256 !== frozen.entrySha256 || (await hashFile(inputFile)).sha256 !== frozen.inputsSha256) throw appError('REPRO_INVALID', '入口或输入在渲染期间改变。');
        const info = await fs.lstat(temporary);
        if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw appError('REPRO_RENDER_FAILED', '渲染未生成新的非空视频。');
        const artifact = await hashFile(temporary);
        await safeProjectFile(workspace, manifest.output, { create: true });
        await fs.rename(temporary, output);
        record.status = 'completed'; record.artifact = { file: manifest.output, ...artifact };
        return { ...record, elapsedMs: Math.round(performance.now() - started), finishedAt: new Date().toISOString() };
    } catch (error) {
        record.status = error.code === 'REPRO_RENDER_CANCELLED' ? 'cancelled' : error.code === 'REPRO_RENDER_TIMEOUT' ? 'timed-out' : 'failed';
        record.elapsedMs = Math.round(performance.now() - started);
        record.finishedAt = new Date().toISOString();
        if (error.renderProcess) record.process = error.renderProcess;
        throw appError(error.code?.startsWith('REPRO_') ? error.code : 'REPRO_RENDER_FAILED', error.message, { data: { render: record } });
    } finally { await fs.rm(temporary, { force: true }); }
}

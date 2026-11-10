import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectPath } from './project.js';
import { fileHash } from './store.js';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = message => Object.assign(new Error(message), { code: 'AGENT_NOT_READY' });
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const sandboxString = value => JSON.stringify(value);

/** Follow Mach-O load commands, granting files rather than an entire package-manager prefix. */
export async function resolveMediaToolReads({ searchPath = process.env.PATH || '', invoke = exec } = {}) {
    const reads = new Set();
    const systemLibrary = file => file.startsWith('/usr/lib/') || file.startsWith('/System/Library/');
    async function visit(file, executable, inheritedRpaths = []) {
        file = await fs.realpath(file);
        if (reads.has(file) || systemLibrary(file)) return;
        reads.add(file);
        const { stdout } = await invoke('/usr/bin/otool', ['-l', file], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
        const expand = value => value.replace(/^@loader_path(?=\/|$)/, path.dirname(file))
            .replace(/^@executable_path(?=\/|$)/, path.dirname(executable));
        const blocks = stdout.split(/Load command \d+\s*\n/).slice(1);
        const localRpaths = blocks.filter(block => /cmd LC_RPATH\s/.test(block))
            .map(block => block.match(/\n\s*path (.+) \(offset \d+\)/)?.[1]).filter(Boolean).map(expand);
        const rpaths = [...localRpaths, ...inheritedRpaths];
        for (const block of blocks) {
            if (!/cmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB)\s/.test(block)) continue;
            const name = block.match(/\n\s*name (.+) \(offset \d+\)/)?.[1];
            if (!name) continue;
            const candidates = name.startsWith('@rpath/') ? rpaths.map(root => path.join(root, name.slice(7))) : [expand(name)];
            let resolved;
            for (const candidate of candidates) {
                if (!path.isAbsolute(candidate)) continue;
                // System libraries may exist only in dyld's shared cache; the profile already permits them.
                if (systemLibrary(candidate)) { resolved = candidate; break; }
                try { resolved = await fs.realpath(candidate); break; }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            if (resolved) await visitSystemAware(resolved, executable, rpaths);
            else if (!/cmd LC_LOAD_WEAK_DYLIB\s/.test(block)) throw invalid(`Cannot resolve media tool library ${name} required by ${file}.`);
        }
    }
    async function visitSystemAware(file, executable, rpaths) {
        if (!systemLibrary(file)) await visit(file, executable, rpaths);
    }
    for (const name of ['ffmpeg', 'ffprobe']) {
        for (const folder of searchPath.split(path.delimiter).filter(path.isAbsolute)) {
            const candidate = path.join(folder, name);
            try { await fs.access(candidate, fs.constants.X_OK); }
            catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) continue; throw error; }
            const executable = await fs.realpath(candidate);
            await visit(executable, executable);
            break;
        }
    }
    return [...reads];
}

async function canonical(file) {
    let parent = path.resolve(file);
    const rest = [];
    while (true) {
        try { return path.join(await fs.realpath(parent), ...rest); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            rest.unshift(path.basename(parent));
            const next = path.dirname(parent);
            if (next === parent) throw error;
            parent = next;
        }
    }
}

/** File boundaries only. Outbound API/browser traffic is explicitly not certified. */
export function filesystemProfile({ readRoots, writeRoots, lockedPaths = [] }) {
    const rules = roots => [...new Set(roots)].map(root => `(subpath ${sandboxString(root)})`).join(' ');
    const ancestors = new Set();
    for (const root of readRoots) {
        let current = path.dirname(root);
        while (true) { ancestors.add(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
    }
    const readable = `${rules(readRoots)} ${[...ancestors].map(root => `(literal ${sandboxString(root)})`).join(' ')}`;
    return `(version 1)\n(allow default)\n(allow network*)\n(deny file-read-data (require-not (require-any ${readable})))\n(deny file-write* (require-not (require-any ${rules(writeRoots)})))\n${lockedPaths.length ? `(deny file-write* ${rules(lockedPaths)})\n` : ''}`;
}

/** Configuration enrichment for the exact installed Flash route; never changes model/provider. */
export function enrichDeepseekPatch(patches, model) {
    if (model !== 'deepseek-flash') return patches;
    if (!Array.isArray(patches)) throw invalid('DSH runtime patch must be an array.');
    const result = structuredClone(patches);
    const provider = result.find(item => item.id === 'llm-deepseek');
    if (!provider || !Array.isArray(provider.config?.models)) throw invalid('DSH model catalog was not found in the planned configuration.');
    const entry = provider.config.models.find(item => item.id === model);
    if (!entry) throw invalid('Requested DSH model is absent from its planned catalog.');
    entry.inputModalities = ['text', 'image'];
    return result;
}

function launcherSource({ executable, profile, model, browserExecutable, inheritedRunner }) {
    return `import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const scratch = path.join(process.env.HOME, 'tmp');
await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
process.env.TMPDIR = scratch; process.env.TMP = scratch; process.env.TEMP = scratch;
${browserExecutable ? `process.env.HYPERFRAMES_BROWSER_PATH = ${JSON.stringify(browserExecutable)};` : ''}
const model = ${JSON.stringify(model)};
const at = args.indexOf('--patch');
if (at >= 0) {
  const original = args[at + 1];
  const patches = JSON.parse(await fs.readFile(original, 'utf8'));
  if (model === 'deepseek-flash') {
    const provider = patches.find(item => item.id === 'llm-deepseek');
    const entry = provider?.config?.models?.find(item => item.id === model);
    if (!entry) throw new Error('Frozen DeepSeek model catalog is missing.');
    entry.inputModalities = ['text', 'image'];
  }
  patches.push({ id: 'sandbox', config: { runnerCommand: [${JSON.stringify(process.execPath)}, ${JSON.stringify(inheritedRunner)}], runnerFailureSignatures: ['video-remake inherited confinement failed'] } });
  const enriched = path.join(path.dirname(original), 'video-remake.image.patch.json');
  await fs.writeFile(enriched, JSON.stringify(patches), { flag: 'wx', mode: 0o600 });
  args[at + 1] = enriched;
}
const child = spawn('/usr/bin/sandbox-exec', ['-f', ${JSON.stringify(profile)}, ${JSON.stringify(executable)}, ...args], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`;
}

function inheritedRunnerSource({ workspace, canary }) {
    const expected = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', workspace, workspace, '--'];
    return `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const fail = message => { process.stderr.write('video-remake inherited confinement failed: ' + message + '\\n'); process.exit(125); };
const args = process.argv.slice(2);
const expected = ${JSON.stringify(expected)};
if (expected.some((value, index) => args[index] !== value) || args.length <= expected.length) fail('only the fixed workspace-write profile is supported');
let denied = false;
try { fs.readFileSync(${JSON.stringify(canary)}); } catch (error) { denied = ['EPERM', 'EACCES'].includes(error.code); }
if (!denied) fail('outer filesystem boundary was not inherited');
const command = args.slice(expected.length);
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', error => fail(error.message));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`;
}

/** Resolve already installed browser distributions only; never download during environment preparation. */
export async function resolveInstalledBrowser({ home = os.homedir(), preferredVersion, ownerWorkspace } = {}) {
    if (!preferredVersion && ownerWorkspace) {
        const dist = path.join(ownerWorkspace, 'node_modules/hyperframes/dist');
        for (const item of await fs.readdir(dist, { withFileTypes: true })) {
            if (!item.isFile() || !/^chunk-.*\.js$/.test(item.name)) continue;
            const file = path.join(dist, item.name);
            if ((await fs.stat(file)).size > 32768) continue;
            const match = (await fs.readFile(file, 'utf8')).match(/var CHROME_VERSION = "([0-9.]+)";/);
            if (match) { preferredVersion = match[1]; break; }
        }
    }
    const candidates = [];
    const roots = [path.join(home, '.cache/hyperframes/chrome'), path.join(home, '.cache/puppeteer/chrome-headless-shell')];
    async function walk(folder, depth = 0) {
        if (depth > 5) return;
        for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
            if (entry.isSymbolicLink()) continue;
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) await walk(file, depth + 1);
            else if (entry.isFile() && entry.name === 'chrome-headless-shell') {
                const version = file.match(/(?:mac_arm|mac|linux|win64)-([0-9.]+)\//)?.[1];
                if (version && (!preferredVersion || version === preferredVersion)) candidates.push({ executable: file, version });
            }
        }
    }
    for (const root of roots) await walk(root);
    candidates.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }) || a.executable.localeCompare(b.executable));
    return candidates[0] || null;
}

export async function probeFilesystemEnvironment({ workspace, profile, environmentRoot }, { execFile: invoke = exec } = {}) {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-isolation-probe-'));
    const relative = `.execution-probe-${randomUUID()}`;
    const own = path.join(workspace, relative);
    const link = `${own}-link`;
    const secret = path.join(outside, 'private.txt');
    await fs.writeFile(secret, 'probe data, not a credential');
    await fs.symlink(secret, link);
    const script = `const fs=require('node:fs');const result={};
fs.writeFileSync(${JSON.stringify(own)},'ok');result.workspaceAccessible=fs.readFileSync(${JSON.stringify(own)},'utf8')==='ok';
const denied=(fn)=>{try{fn();return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}};
result.outsideReadDenied=denied(()=>fs.readFileSync(${JSON.stringify(secret)}));
result.outsideWriteDenied=denied(()=>fs.writeFileSync(${JSON.stringify(path.join(outside, 'new.txt'))},'bad'));
result.symlinkEscapeDenied=denied(()=>fs.readFileSync(${JSON.stringify(link)}));
console.log(JSON.stringify(result));`;
    try {
        const { stdout } = await invoke('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', script], { cwd: workspace, timeout: 10000, maxBuffer: 32768 });
        const result = JSON.parse(stdout.trim());
        const verified = ['workspaceAccessible', 'outsideReadDenied', 'outsideWriteDenied', 'symlinkEscapeDenied'].every(key => result[key] === true);
        const probe = { id: `filesystem-${randomUUID()}`, ...result, verified, networkRestricted: false, checkedAt: new Date().toISOString() };
        await fs.writeFile(path.join(environmentRoot, 'probe.json'), `${JSON.stringify(probe, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        if (!verified) throw invalid('Filesystem boundary probe failed; model execution was not started.');
        return probe;
    } finally {
        await fs.rm(own, { force: true });
        await fs.rm(link, { force: true });
        await fs.rm(outside, { force: true, recursive: true });
    }
}

/** Trusted host launcher; no changes to node_modules, scene sources or task inputs. */
export async function prepareExecutionEnvironment({ target, workspace, ownerWorkspace, stateDir, environmentRoot, lockedPaths = [], readRoots = [], browserExecutable, searchPath, mode = 'context-only' }, deps = {}) {
    if (mode === 'context-only') return { target, record: { mode, readIsolation: 'unverified', networkIsolation: 'unverified' } };
    if (mode !== 'restricted-filesystem') throw invalid('Unknown execution environment mode.');
    if ((deps.platform || process.platform) !== 'darwin' || target.harness.adapter !== 'deepseek-harness') throw invalid('Restricted filesystem execution currently requires macOS and DeepSeek Harness.');
    await fs.access('/usr/bin/sandbox-exec', fs.constants.X_OK);
    workspace = await canonical(workspace);
    ownerWorkspace = await canonical(ownerWorkspace);
    stateDir = await canonical(stateDir);
    environmentRoot = await canonical(environmentRoot);
    if (inside(workspace, environmentRoot) || inside(workspace, stateDir)) throw invalid('Host execution state must be outside the editable project.');
    const executable = await fs.realpath(target.harness.executable);
    const dependencies = await fs.realpath(path.join(ownerWorkspace, 'node_modules'));
    if (!inside(dependencies, executable)) throw invalid('The restricted DSH executable must belong to the pinned dependency tree.');
    const metadata = JSON.parse(await fs.readFile(path.join(dependencies, '@deepseek-ai/dsh/package.json'), 'utf8'));
    if (target.backend.model === 'deepseek-flash' && metadata.version !== '0.2.1-rc.2') throw invalid('Image configuration requires a reviewed DSH capability version; revalidate before changing the pinned CLI.');
    const requestedReadRoots = await Promise.all(readRoots.map(canonical));
    if (requestedReadRoots.some(root => inside(root, ownerWorkspace) || inside(ownerWorkspace, root) && !inside(dependencies, root))) throw invalid('Additional read roots must not expose the source repository.');
    const locks = lockedPaths.map(relative => path.join(workspace, projectPath(relative)));
    const system = ['/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/private/etc', '/dev'];
    // Browser distributions are immutable tools; no personal browser profiles or user home are exposed.
    const browsers = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/hyperframes/chrome'), path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell')];
    const installedBrowser = browserExecutable ? null : await resolveInstalledBrowser({ ownerWorkspace });
    browserExecutable ||= installedBrowser?.executable;
    if (browserExecutable) {
        browserExecutable = await fs.realpath(browserExecutable);
        if (![...system, ...browsers, ...requestedReadRoots].some(root => inside(root, browserExecutable))) throw invalid('Browser executable is outside approved tool directories.');
    }
    const mediaToolReads = await resolveMediaToolReads({ searchPath });
    const permittedReads = [...system, workspace, stateDir, environmentRoot, dependencies, ...browsers, ...requestedReadRoots, ...mediaToolReads];
    const permittedWrites = [workspace, stateDir, '/dev/null', '/dev/tty'];
    const profileText = filesystemProfile({ readRoots: permittedReads, writeRoots: permittedWrites, lockedPaths: locks });
    await fs.mkdir(environmentRoot, { recursive: true, mode: 0o700 });
    const profile = path.join(environmentRoot, 'filesystem.sb');
    const launcher = path.join(environmentRoot, 'dsh-launcher.mjs');
    const wrapper = path.join(environmentRoot, 'dsh');
    const inheritedRunner = path.join(environmentRoot, 'inherited-runner.mjs');
    const canary = `${environmentRoot}.host-canary`;
    const runnerSource = inheritedRunnerSource({ workspace, canary });
    const source = launcherSource({ executable, profile, model: target.backend.model, browserExecutable, inheritedRunner });
    const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcher)} "$@"\n`;
    await fs.writeFile(profile, profileText, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(launcher, source, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(inheritedRunner, runnerSource, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(canary, 'Host boundary test; not task data.', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(wrapper, script, { flag: 'wx', mode: 0o700 });
    const probe = await probeFilesystemEnvironment({ workspace, profile, environmentRoot }, deps);
    return { target: { ...target, harness: { ...target.harness, executable: wrapper } }, record: {
        mode, readIsolation: 'enforced', networkIsolation: 'unverified', probe,
        profileHash: hash(profileText), launcherHash: hash(source + script + runnerSource), originalExecutable: executable, executable: wrapper,
        shellConfinement: 'inherited outer filesystem boundary; exact workspace-write policy; per-command canary check',
        cliVersion: metadata.version, mediaToolReads, browserExecutable: browserExecutable ?? null,
        browser: browserExecutable ? { executable: browserExecutable, version: installedBrowser?.version ?? null, sha256: await fileHash(browserExecutable) } : null,
        lockedPaths: [...lockedPaths], readRoots: permittedReads, writeRoots: permittedWrites,
        imageCapability: { model: target.backend.model, inputModalities: target.backend.model === 'deepseek-flash' ? ['text', 'image'] : ['text'],
            status: 'native-configured; provider transport unverified', source: `installed DSH ${metadata.version} catalog documentation` },
        limitations: ['Only filesystem reads/writes are probed. Network access and indirect service access are not independently certified.', 'Image catalog configuration does not prove provider acceptance or visual observation.'],
    } };
}

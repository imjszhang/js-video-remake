import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scaffoldProject } from '../src/repro/project.js';
import { renderProject, rendererEnvironment } from '../src/repro/render.js';
import { validateSpec } from '../src/repro/schema.js';

async function fixture(t) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-render-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const workspace = path.join(base, 'project');
    const spec = validateSpec({ schema: 'video-remake.reproduction@2', title: 'Test', objective: 'Render a prepared composition.',
        preserve: ['Timing'], replace: ['Title'], inputs: { title: { type: 'text' } },
        acceptance: { media: { file: 'outputs/final.mp4', width: 160, height: 120, durationSec: 2, audio: 'forbidden' },
            review: [{ id: 'layout', description: 'Compare title layout.' }] } });
    await scaffoldProject(workspace, { spec, inputs: { title: 'Hello' } });
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'reproduction.json'), 'utf8'));
    await fs.writeFile(path.join(workspace, 'reproduction.json'), JSON.stringify({ ...manifest, status: 'ready' }));
    await fs.writeFile(path.join(workspace, 'src/index.html'), '<!doctype html><html><body>Prepared composition</body></html>');
    const config = { workspace: base, env: { SECRET_API_KEY: 'do-not-inherit', NODE_OPTIONS: '--import=evil', PATH: `${workspace}/node_modules/.bin:/usr/bin:/bin` } };
    const f = { base, workspace, spec, config, calls: [] };
    f.spawn = (executable, args, options) => {
        f.calls.push({ executable, args, options });
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        queueMicrotask(async () => {
            try {
                if (args[1] === 'check') {
                    child.stdout.write(JSON.stringify({ ok: true, lint: { errorCount: 0, findings: [] }, runtime: { errorCount: 0, findings: [] }, layout: { errorCount: 0, findings: [] }, motion: { errorCount: 0, findings: [] }, contrast: { errorCount: 0, findings: [] }, craft: { errorCount: 0, findings: [] } }));
                    child.emit('close', 0, null);
                    return;
                }
                if (f.beforeExit) await f.beforeExit(args, options);
                else await fs.writeFile(args[args.indexOf('--output') + 1], 'newly rendered media');
                child.emit('close', f.exitCode || 0, null);
            } catch (error) { child.emit('error', error); }
        });
        return child;
    };
    f.render = options => renderProject(config, { workspace, spec, ...options }, { spawn: f.spawn });
    return f;
}

test('managed render uses fixed host CLI and fresh output, never generated npm scripts or project-local CLI', async t => {
    const f = await fixture(t);
    const pkgFile = path.join(f.workspace, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    pkg.scripts.render = 'node scripts/arbitrary.mjs';
    await fs.writeFile(pkgFile, JSON.stringify(pkg));
    const local = path.join(f.workspace, 'node_modules/hyperframes/bin');
    await fs.mkdir(local, { recursive: true });
    await fs.writeFile(path.join(local, 'hyperframes.mjs'), 'throw new Error("Untrusted project CLI executed")');
    await fs.writeFile(path.join(f.workspace, 'outputs/final.mp4'), 'stale video');
    const result = await f.render();
    assert.equal(result.status, 'completed');
    assert.equal(result.provider, 'local-hyperframes');
    assert.equal(result.version, '0.8.191');
    assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.artifact.file, 'outputs/final.mp4');
    assert.equal(result.renderCalls, 1);
    assert.equal(result.preparation, 'agent-materialized-project');
    assert.equal(await fs.readFile(path.join(f.workspace, 'outputs/final.mp4'), 'utf8'), 'newly rendered media');
    const renderCall = f.calls[0];
    assert.equal(f.calls.length, 1);
    assert.equal(result.precheck.status, 'skipped');
    assert.equal(renderCall.executable, process.execPath);
    assert.ok(!renderCall.args[0].startsWith(f.workspace));
    assert.ok(renderCall.args[0].endsWith('/node_modules/hyperframes/bin/hyperframes.mjs'));
    assert.ok(renderCall.args.includes('--strict'));
    assert.equal(renderCall.options.shell, false);
    assert.equal(renderCall.options.cwd, f.workspace);
    assert.ok(!renderCall.args.some(value => value.includes('arbitrary.mjs')));
    assert.equal(renderCall.options.env.SECRET_API_KEY, undefined);
    assert.equal(renderCall.options.env.NODE_OPTIONS, undefined);
    assert.ok(!renderCall.options.env.PATH.includes(f.workspace));
    assert.ok(!(await fs.readdir(path.join(f.workspace, 'outputs'))).some(value => value.startsWith('.repro-render')));
});

test('renderer environment excludes secret/injection variables and project-controlled executable paths', () => {
    const env = rendererEnvironment('/safe/project', { PATH: '/safe/project/bin:.:/usr/bin', HOME: '/private/user', CODEX_HOME: '/private/codex',
        OPENAI_API_KEY: 'secret', NODE_PATH: '/bad', NODE_OPTIONS: '--import=/bad', HTTP_PROXY: 'http://user:pass@proxy',
        HYPERFRAMES_BROWSER_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    for (const key of ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'NODE_PATH', 'NODE_OPTIONS', 'HTTP_PROXY']) assert.equal(env[key], undefined);
    assert.equal(env.DO_NOT_TRACK, '1');
    assert.equal(env.HYPERFRAMES_NO_TELEMETRY, '1');
    assert.equal(env.HYPERFRAMES_BROWSER_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    assert.ok(!env.PATH.includes('/safe/project'));
});

test('wrong pins, local dotenv, changed acceptance and unsafe entry paths reject before a process starts', async t => {
    for (const change of ['pin', 'dotenv', 'acceptance', 'entry', 'symlink']) {
        const f = await fixture(t);
        if (change === 'pin') {
            const file = path.join(f.workspace, 'package.json'); const pkg = JSON.parse(await fs.readFile(file));
            pkg.dependencies.hyperframes = '^0.8.191'; await fs.writeFile(file, JSON.stringify(pkg));
        } else if (change === 'dotenv') await fs.writeFile(path.join(f.workspace, '.env'), 'NODE_OPTIONS=--import=evil');
        else if (change === 'acceptance') {
            const file = path.join(f.workspace, 'task/acceptance.json'); const acceptance = JSON.parse(await fs.readFile(file));
            acceptance.media.width = 1; await fs.writeFile(file, JSON.stringify(acceptance));
        } else if (change === 'entry') {
            const file = path.join(f.workspace, 'reproduction.json'); const manifest = JSON.parse(await fs.readFile(file));
            manifest.entry = '../outside.html'; await fs.writeFile(file, JSON.stringify(manifest));
        } else {
            await fs.unlink(path.join(f.workspace, 'src/index.html'));
            await fs.writeFile(path.join(f.base, 'outside.html'), '<html/>');
            await fs.symlink(path.join(f.base, 'outside.html'), path.join(f.workspace, 'src/index.html'));
        }
        await assert.rejects(f.render());
        assert.equal(f.calls.length, 0, change);
    }
});

test('failed or empty render preserves old output and refuses source mutation', async t => {
    for (const failure of ['exit', 'missing', 'mutation']) {
        const f = await fixture(t);
        const output = path.join(f.workspace, 'outputs/final.mp4');
        await fs.writeFile(output, 'old artifact');
        if (failure === 'exit') f.exitCode = 7;
        else if (failure === 'missing') f.beforeExit = async () => {};
        else f.beforeExit = async args => {
            await fs.writeFile(args[args.indexOf('--output') + 1], 'new output');
            await fs.writeFile(path.join(f.workspace, 'src/index.html'), '<html>Changed during render</html>');
        };
        await assert.rejects(f.render(), error => { assert.equal(error.data.render.status, 'failed'); return true; });
        assert.equal(await fs.readFile(output, 'utf8'), 'old artifact');
    }
});

test('cancellation and timeout terminate the renderer and its child process group', { timeout: 20_000, skip: process.platform === 'win32' }, async t => {
    const inspect = promisify(execFile);
    const processState = async pid => {
        try { return (await inspect('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 2000 })).stdout.trim(); }
        catch (error) { if (error.code === 1 && !error.stdout?.trim()) return ''; throw error; }
    };
    for (const reason of ['cancelled', 'timeout']) {
        const f = await fixture(t);
        const pidFile = path.join(f.base, 'descendant.pid');
        const heartbeat = path.join(f.base, 'descendant.heartbeat');
        // Publish readiness from the descendant only after it has installed its
        // TERM handler. Killing a child before Node starts would not test the
        // renderer's forced process-group cleanup.
        const descendantScript = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),25);fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`;
        const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
        const controller = new AbortController();
        let rendererPid;
        const running = renderProject(f.config, { workspace: f.workspace, spec: f.spec, signal: controller.signal, timeoutMs: reason === 'timeout' ? 3000 : 10_000 }, {
            spawn: (_executable, args, options) => {
                if (args[1] === 'check') {
                    const child = new EventEmitter();
                    child.stdout = new PassThrough(); child.stderr = new PassThrough();
                    queueMicrotask(() => { child.stdout.write('{"ok":true,"lint":{"errorCount":0,"findings":[]},"runtime":{"errorCount":0,"findings":[]},"layout":{"errorCount":0,"findings":[]},"motion":{"errorCount":0,"findings":[]},"contrast":{"errorCount":0,"findings":[]},"craft":{"errorCount":0,"findings":[]}}'); child.emit('close', 0, null); });
                    return child;
                }
                const child = spawn(process.execPath, ['-e', script], options); rendererPid = child.pid; return child;
            },
        });
        const rejection = assert.rejects(running, { code: reason === 'cancelled' ? 'REPRO_RENDER_CANCELLED' : 'REPRO_RENDER_TIMEOUT' });
        for (let tries = 0; tries < 500; tries++) {
            try { await fs.access(pidFile); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        const descendantPid = Number(await fs.readFile(pidFile, 'utf8'));
        t.after(async () => {
            // Clean up only this fixture's own process if an assertion fails.
            const command = await inspect('/bin/ps', ['-o', 'command=', '-p', String(descendantPid)]).catch(() => ({ stdout: '' }));
            if (command.stdout.includes(pidFile)) {
                try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
        });
        if (reason === 'cancelled') controller.abort();
        await rejection;
        let state = await processState(descendantPid);
        for (let tries = 0; tries < 100 && state && !state.startsWith('Z'); tries++) {
            await new Promise(resolve => setTimeout(resolve, 25));
            state = await processState(descendantPid);
        }
        assert.throws(() => process.kill(rendererPid, 0), { code: 'ESRCH' });
        // kill(pid, 0) also succeeds for a killed orphan awaiting OS reaping;
        // that PID cannot execute. Live/sleeping/stopped processes still fail.
        assert.ok(!state || state.startsWith('Z'), `browser/ffmpeg descendant still executes (state: ${state})`);
        const lastHeartbeat = await fs.readFile(heartbeat, 'utf8');
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.equal(await fs.readFile(heartbeat, 'utf8'), lastHeartbeat, 'terminated descendants cannot keep writing output');
    }
});

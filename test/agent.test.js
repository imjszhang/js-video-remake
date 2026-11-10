import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { main } from '../cli/remake.js';
import { executeAgent } from '../src/agent.js';
import { agentCredentialEnvironment } from '../src/agent-credentials.js';

const fixtureSource = fileURLToPath(new URL('./fixtures/fake-agent.js', import.meta.url));
const secret = 'fixture-private-credential-4386';
const instruction = 'Inspect this fixture workspace and report the result.';

test('agent run and doctor load only the selected key from the project local credential file', async (t) => {
    const { config, workspace } = await fixture(t);
    delete config.env.FAKE_AGENT_KEY;
    await fs.writeFile(path.join(workspace, '.env.agent.local'), `FAKE_AGENT_KEY="${secret}"\nNODE_OPTIONS=--invalid-fixture-option\nOTHER_KEY=unselected\n`, { mode: 0o600 });
    const target = { backend: { auth: 'api-key', apiKeyEnv: 'FAKE_AGENT_KEY' } };
    const resolved = await agentCredentialEnvironment(config, target);
    assert.equal(resolved.FAKE_AGENT_KEY, secret);
    assert.equal(resolved.NODE_OPTIONS, undefined);
    assert.equal(resolved.OTHER_KEY, undefined);
    assert.equal(config.env.FAKE_AGENT_KEY, undefined);
    const planned = await executeAgent(config, 'plan', { instruction });
    assert.ok(!JSON.stringify(planned).includes(secret));
    assert.ok(!planned.plan.inputs.some(input => input.path === '.env.agent.local'));
    const doctor = await executeAgent(config, 'doctor');
    assert.equal(doctor.readiness.ok, true);
    const result = await executeAgent(config, 'run', { instruction });
    assert.equal(result.run.status, 'completed');
    for (const name of ['run.json', 'task.json', 'runtime/stdout.log', 'runtime/events.jsonl']) {
        assert.ok(!(await fs.readFile(path.join(result.run.runDir, name), 'utf8')).includes(secret));
    }
});

test('explicit credentials take precedence and native targets never load the local key file', async (t) => {
    const { config, workspace } = await fixture(t);
    await fs.mkdir(path.join(workspace, '.env.agent.local'));
    const api = { backend: { auth: 'api-key', apiKeyEnv: 'FAKE_AGENT_KEY' } };
    assert.equal(await agentCredentialEnvironment(config, api), config.env);
    assert.equal(await agentCredentialEnvironment(config, { backend: { auth: 'chatgpt' } }), config.env);
    delete config.env.FAKE_AGENT_KEY;
    await assert.rejects(agentCredentialEnvironment(config, api), { code: 'CONFIG_INVALID' });
});

test('local credentials reject symlinks but plan and config remain independent of secrets', async (t) => {
    const { config, workspace, root } = await fixture(t);
    delete config.env.FAKE_AGENT_KEY;
    const external = path.join(root, 'external.env');
    await fs.writeFile(external, `FAKE_AGENT_KEY=${secret}\n`);
    await fs.symlink(external, path.join(workspace, '.env.agent.local'));
    assert.equal((await executeAgent(config, 'plan', { instruction })).command, 'agent:plan');
    assert.equal((await executeAgent(config, 'config')).command, 'agent:config');
    await assert.rejects(executeAgent(config, 'doctor'), { code: 'CONFIG_INVALID' });
    await assert.rejects(executeAgent(config, 'run', { instruction }), { code: 'CONFIG_INVALID' });
});

async function fixture(t, { mode = 'success', enabled = true, workspaceName = 'workspace' } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'video-remake-agent-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, workspaceName);
    const agentHome = path.join(root, 'agent-home');
    await fs.mkdir(workspace);
    const executable = path.join(root, `fake-agent-${mode}.mjs`);
    const source = await fs.readFile(fixtureSource, 'utf8');
    await fs.writeFile(executable, source.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
    const runtimeConfig = {
        schemaVersion: 1,
        defaultTarget: 'fake',
        timeoutMs: 1000,
        targets: [{
            name: 'fake',
            enabled,
            harness: { adapter: 'codex', executable, permission: 'workspace-write' },
            backend: {
                auth: 'api-key', provider: 'fixture', model: 'fixture', protocol: 'responses',
                baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'FAKE_AGENT_KEY',
            },
        }],
    };
    await fs.writeFile(path.join(workspace, 'agent-runtime.json'), JSON.stringify(runtimeConfig));
    const catalogPath = path.join(workspace, 'catalog.json');
    await fs.writeFile(catalogPath, JSON.stringify({ version: 1, references: [], productions: [] }));
    const config = { workspace, catalogPath, env: { VIDEO_REMAKE_AGENT_HOME: agentHome, FAKE_AGENT_KEY: secret } };
    return { root, workspace, agentHome, config, runtimeConfig };
}

async function writeInput(workspace, relative, content) {
    const target = path.join(workspace, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
}

async function snapshot(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const values = {};
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const target = path.join(directory, entry.name);
        values[entry.name] = entry.isDirectory()
            ? await snapshot(target)
            : createHash('sha256').update(await fs.readFile(target)).digest('hex');
    }
    return values;
}

async function expectFailure(promise, code, status) {
    let failure;
    await assert.rejects(promise, (error) => {
        failure = error;
        assert.equal(error.code, code);
        assert.equal(error.data.command, 'agent:run');
        assert.equal(error.data.run.status, status);
        assert.ok(error.data.run.id);
        return true;
    });
    return failure.data.run;
}

async function assertSavedStatus(config, run, status) {
    const result = await executeAgent(config, 'status', { runId: run.id });
    assert.equal(result.command, 'agent:status');
    assert.equal(result.run.id, run.id);
    assert.equal(result.run.status, status);
    return result.run;
}

async function cli(config, argv, { json = true } = {}) {
    const stdout = [];
    const stderr = [];
    const code = await main([...argv, '--workspace', config.workspace, ...(json ? ['--json'] : [])], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
    }, { ...config.env, VIDEO_REMAKE_WORKSPACE: config.workspace });
    if (json) assert.equal(stdout.length, 1, 'JSON mode emits exactly one stdout document');
    return { code, stdout, stderr, result: json ? JSON.parse(stdout[0]) : null };
}

async function writeStaleLock(agentHome) {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(path.join(agentHome, 'active.json'), JSON.stringify({
        id: 'r_stale', owner: { pid: child.pid, hostname: os.hostname() },
    }));
}

test('agent plan assembles explicit context without writing files or reading credentials', async (t) => {
    const { config, workspace, agentHome } = await fixture(t);
    const inputs = {
        'README.md': '# Fixture project\n',
        'AGENTS.md': 'Follow fixture project rules.\n',
        'notes/request.md': 'Use this explicit input.\n',
        'skills/example/SKILL.md': 'Use this explicit skill.\n',
    };
    for (const [relative, content] of Object.entries(inputs)) await writeInput(workspace, relative, content);
    Object.defineProperty(config.env, 'FAKE_AGENT_KEY', {
        enumerable: true,
        get() { throw new Error('Planning must not resolve credentials'); },
    });
    const before = await snapshot(workspace);
    const result = await executeAgent(config, 'plan', {
        instruction, inputs: ['notes/request.md'], skills: ['skills/example/SKILL.md'],
    });
    assert.equal(result.command, 'agent:plan');
    assert.equal(result.plan.workspace, workspace);
    assert.equal(result.plan.production, null);
    assert.equal(result.plan.enabled, true);
    assert.equal(result.plan.instruction, instruction);
    for (const [relative, content] of Object.entries(inputs)) {
        const input = result.plan.inputs.find((entry) => entry.path === relative);
        assert.ok(input, `${relative} is included`);
        assert.equal(input.sha256, createHash('sha256').update(content).digest('hex'));
        assert.equal(input.bytes, Buffer.byteLength(content));
        assert.ok(result.plan.execution.process.stdin.includes(content.trim()));
    }
    assert.ok(result.plan.execution.process.stdin.includes(instruction));
    assert.deepEqual(await snapshot(workspace), before);
    await assert.rejects(fs.access(agentHome), { code: 'ENOENT' });
});

test('agent plan reads instruction files and registered production/reference context', async (t) => {
    const { config, workspace } = await fixture(t);
    await fs.writeFile(config.catalogPath, JSON.stringify({
        version: 1,
        references: [{ id: 'youtube-fixture', dir: 'references/youtube-fixture' }],
        productions: [{ slug: 'sample-film', dir: 'productions/sample-film', referenceIds: ['youtube-fixture'] }],
    }));
    const inputs = {
        'instructions.md': instruction,
        'productions/sample-film/BRIEF.md': 'Production brief fixture.',
        'productions/sample-film/TREATMENT.md': 'Production treatment fixture.',
        'productions/sample-film/PROGRESS.md': 'Production progress fixture.',
        'references/youtube-fixture/SOURCE.json': '{"title":"Fixture reference"}',
        'references/youtube-fixture/ANALYSIS.md': 'Reference analysis fixture.',
        'references/youtube-fixture/TIMELINE.md': 'Reference timeline fixture.',
    };
    for (const [relative, content] of Object.entries(inputs)) await writeInput(workspace, relative, content);
    const result = await executeAgent(config, 'plan', { production: 'sample-film', instructionFile: 'instructions.md' });
    assert.equal(result.plan.production, 'sample-film');
    assert.equal(result.plan.instruction, instruction);
    for (const content of Object.values(inputs)) assert.ok(result.plan.execution.process.stdin.includes(content));
    for (const relative of Object.keys(inputs).filter((name) => name !== 'instructions.md')) {
        assert.ok(result.plan.inputs.some((input) => input.path === relative), `${relative} is recorded`);
    }
});

test('agent doctor checks the executable and credential availability without starting a run', async (t) => {
    const { config, workspace, agentHome } = await fixture(t);
    const before = await snapshot(workspace);
    const result = await executeAgent(config, 'doctor', { checkLogin: true });
    assert.equal(result.command, 'agent:doctor');
    assert.equal(result.readiness.ok, true);
    assert.ok(result.readiness.checks.some((check) => check.name === 'executable' && check.status === 'passed'));
    assert.ok(result.readiness.checks.some((check) => check.name === 'credential' && check.status === 'passed'));
    assert.ok(result.readiness.checks.some((check) => check.name === 'login' && check.status === 'skipped'));
    assert.ok(!JSON.stringify(result).includes(secret));
    delete config.env.FAKE_AGENT_KEY;
    await assert.rejects(executeAgent(config, 'doctor'), (error) => {
        assert.equal(error.code, 'AGENT_NOT_READY');
        assert.equal(error.data.readiness.ok, false);
        return true;
    });
    await assert.rejects(executeAgent(config, 'run', { instruction }), { code: 'CONFIG_INVALID' });
    assert.deepEqual(await snapshot(workspace), before);
    await assert.rejects(fs.access(agentHome), { code: 'ENOENT' });
});

test('agent run executes the real runtime, persists status, and redacts all log streams', async (t) => {
    const { config, workspace } = await fixture(t);
    const events = [];
    const result = await executeAgent(config, 'run', { instruction }, { onEvent: (event) => events.push(event) });
    assert.equal(result.command, 'agent:run');
    assert.equal(result.run.status, 'completed');
    assert.match(result.run.execution.text, /fixture completed/);
    assert.ok(result.run.execution.text.includes(instruction));
    assert.equal(result.run.execution.sessionId, 'fixture-thread');
    assert.equal(result.run.execution.usage.totalTokens, 16);
    assert.equal(result.run.execution.exitCode, 0);
    assert.ok(events.some((event) => event.type === 'message'));
    assert.ok(events.some((event) => event.type === 'completed'));
    assert.ok(!JSON.stringify({ result, events }).includes(secret));
    assert.ok(!result.run.runDir.startsWith(`${workspace}${path.sep}`));
    const saved = await assertSavedStatus(config, result.run, 'completed');
    assert.equal(saved.execution.text, result.run.execution.text);
    const listed = await executeAgent(config, 'status');
    assert.ok(listed.runs.some((run) => run.id === result.run.id && run.status === 'completed'));
    for (const stream of ['stdout', 'stderr', 'events']) {
        const log = await executeAgent(config, 'logs', { runId: result.run.id, stream });
        assert.equal(log.command, 'agent:logs');
        assert.equal(log.id, result.run.id);
        assert.equal(log.stream, stream);
        assert.ok(log.text.includes('[REDACTED]'));
        assert.ok(!log.text.includes(secret));
    }
    const tail = await executeAgent(config, 'logs', { runId: result.run.id, stream: 'stdout', lines: 1 });
    assert.equal(tail.text.trim().split('\n').length, 1);
    assert.match(tail.text, /turn.completed/);
    const cancelled = await executeAgent(config, 'cancel', { runId: result.run.id });
    assert.equal(cancelled.status, 'completed');
    await assertSavedStatus(config, result.run, 'completed');
});

test('agent prevents overlapping workspace runs and releases the lock after completion', async (t) => {
    const { config } = await fixture(t);
    let checkedBusy = false;
    const first = await executeAgent(config, 'run', { instruction }, {
        async onEvent(event) {
            if (event.type === 'started') {
                await assert.rejects(executeAgent(config, 'run', { instruction }), { code: 'AGENT_BUSY' });
                checkedBusy = true;
            }
        },
    });
    assert.equal(checkedBusy, true);
    const second = await executeAgent(config, 'run', { instruction });
    assert.equal(second.run.status, 'completed');
    assert.notEqual(second.run.id, first.run.id);
});

test('agent preserves paths, timestamps, and logs when NO_PROXY is a dot', async (t) => {
    const { config, workspace } = await fixture(t, { workspaceName: 'workspace.with.dots' });
    config.env.NO_PROXY = '.';
    const result = await executeAgent(config, 'run', { instruction });
    assert.equal(result.run.workspace, workspace);
    assert.ok(Number.isFinite(Date.parse(result.run.createdAt)));
    assert.ok(Number.isFinite(Date.parse(result.run.finishedAt)));
    assert.ok(result.run.execution.text.includes(instruction));
    assert.ok(!JSON.stringify(result).includes(secret));
    const saved = await assertSavedStatus(config, result.run, 'completed');
    assert.equal(saved.workspace, workspace);
    assert.equal(saved.createdAt, result.run.createdAt);
    const task = JSON.parse(await fs.readFile(path.join(saved.runDir, 'task.json'), 'utf8'));
    assert.equal(task.workspace, workspace);
    for (const stream of ['stdout', 'events']) {
        const log = await executeAgent(config, 'logs', { runId: saved.id, stream });
        assert.ok(log.text.includes(instruction));
        assert.ok(log.text.includes('[REDACTED]'));
        assert.ok(!log.text.includes(secret));
    }
});

test('agent recovers a dead owner lock and cleans the recovery guard after completion', async (t) => {
    const { config, agentHome } = await fixture(t);
    await writeStaleLock(agentHome);
    const result = await executeAgent(config, 'run', { instruction });
    assert.equal(result.run.status, 'completed');
    for (const entry of ['active.json', 'lock-recovery']) {
        await assert.rejects(fs.access(path.join(agentHome, entry)), { code: 'ENOENT' });
    }
});

test('concurrent stale-lock recovery starts exactly one agent and cancellation releases its lock', { timeout: 10000 }, async (t) => {
    const { config, agentHome } = await fixture(t, { mode: 'slow' });
    await writeStaleLock(agentHome);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const started = Promise.withResolvers();
    let starts = 0;
    const deps = {
        signal: controller.signal,
        onEvent(event) {
            if (event.type === 'raw' && event.data.type === 'thread.started') {
                starts += 1;
                started.resolve();
            }
        },
    };
    const attempts = [0, 1].map(() => executeAgent(config, 'run', { instruction, timeoutMs: 5000 }, deps)
        .then(value => ({ value }), error => ({ error })));
    try {
        const rejected = await Promise.race(attempts);
        assert.equal(rejected.error?.code, 'AGENT_BUSY');
        await started.promise;
    } finally {
        controller.abort();
    }
    const outcomes = await Promise.all(attempts);
    assert.equal(starts, 1);
    assert.deepEqual(outcomes.map(({ error }) => error?.code).sort(), ['AGENT_BUSY', 'AGENT_CANCELLED']);
    const run = outcomes.find(({ error }) => error.code === 'AGENT_CANCELLED').error.data.run;
    await assertSavedStatus(config, run, 'cancelled');
    for (const entry of ['active.json', 'lock-recovery']) {
        await assert.rejects(fs.access(path.join(agentHome, entry)), { code: 'ENOENT' });
    }
});

for (const mode of ['nonzero', 'incomplete', 'failed']) {
    test(`agent ${mode} execution fails and retains the failed run`, async (t) => {
        const { config } = await fixture(t, { mode });
        const run = await expectFailure(executeAgent(config, 'run', { instruction }), 'AGENT_FAILED', 'failed');
        assert.equal(run.execution.status, 'failed');
        if (mode === 'nonzero') assert.equal(run.execution.exitCode, 7);
        if (mode === 'incomplete') assert.match(run.execution.error, /terminal completion event/);
        if (mode === 'failed') assert.match(run.execution.error, /fixture reported failure/);
        assert.ok(!JSON.stringify(run).includes(secret));
        await assertSavedStatus(config, run, 'failed');
    });
}

test('agent timeout stops a running executable and persists timed_out', { timeout: 10000 }, async (t) => {
    const { config } = await fixture(t, { mode: 'slow' });
    const run = await expectFailure(
        executeAgent(config, 'run', { instruction, timeoutMs: 1000 }), 'AGENT_TIMED_OUT', 'timed_out',
    );
    await assertSavedStatus(config, run, 'timed_out');
});

test('agent AbortSignal cancellation persists cancelled', { timeout: 10000 }, async (t) => {
    const { config } = await fixture(t, { mode: 'slow' });
    const controller = new AbortController();
    const run = await expectFailure(executeAgent(config, 'run', { instruction, timeoutMs: 5000 }, {
        signal: controller.signal,
        onEvent(event) {
            if (event.type === 'raw' && event.data.type === 'thread.started') controller.abort();
        },
    }), 'AGENT_CANCELLED', 'cancelled');
    await assertSavedStatus(config, run, 'cancelled');
});

test('agent cancel requests are observed by an active run', { timeout: 10000 }, async (t) => {
    const { config } = await fixture(t, { mode: 'slow' });
    let cancellation;
    const run = await expectFailure(executeAgent(config, 'run', { instruction, timeoutMs: 5000 }, {
        async onEvent(event) {
            if (event.type === 'raw' && event.data.type === 'thread.started') {
                cancellation = await executeAgent(config, 'cancel', { runId: event.runId });
            }
        },
    }), 'AGENT_CANCELLED', 'cancelled');
    assert.equal(cancellation.command, 'agent:cancel');
    assert.equal(cancellation.id, run.id);
    assert.equal(cancellation.status, 'cancel_requested');
    await assertSavedStatus(config, run, 'cancelled');
});

test('agent rejects missing/ambiguous instructions and unsafe file paths before execution', async (t) => {
    const { config, workspace, root, agentHome } = await fixture(t);
    await writeInput(workspace, 'instructions.md', instruction);
    await fs.writeFile(path.join(root, 'outside.md'), 'This is outside the workspace.');
    await fs.symlink(path.join(root, 'outside.md'), path.join(workspace, 'linked.md'));
    for (const options of [
        {},
        { instruction: '   ' },
        { instruction, instructionFile: 'instructions.md' },
        { instructionFile: '../outside.md' },
        { instructionFile: 'linked.md' },
        { instruction, inputs: ['../outside.md'] },
        { instruction, skills: ['../outside.md'] },
    ]) {
        await assert.rejects(executeAgent(config, 'run', options), (error) => {
            assert.equal(typeof error.code, 'string');
            assert.ok(!error.code.startsWith('ENO'), 'input rejection is an application error');
            return true;
        });
    }
    await assert.rejects(fs.access(agentHome), { code: 'ENOENT' });
});

test('agent rejects disabled and unknown targets without creating run state', async (t) => {
    const { config, agentHome } = await fixture(t, { enabled: false });
    for (const options of [{ instruction }, { instruction, target: 'missing' }]) {
        await assert.rejects(executeAgent(config, 'run', options), (error) => typeof error.code === 'string');
    }
    await assert.rejects(fs.access(agentHome), { code: 'ENOENT' });
});

test('agent status, logs, and cancel reject unknown or traversing run IDs', async (t) => {
    const { config, agentHome } = await fixture(t);
    for (const action of ['status', 'logs', 'cancel']) {
        for (const runId of ['missing-run', '../outside']) {
            await assert.rejects(executeAgent(config, action, { runId }), (error) => typeof error.code === 'string');
        }
    }
    const listed = await executeAgent(config, 'status');
    assert.deepEqual(listed.runs, []);
    await assert.rejects(fs.access(agentHome), { code: 'ENOENT' });
});

test('CLI routes agent plans and preserves every repeated input and skill flag', async (t) => {
    const { config, workspace, agentHome } = await fixture(t);
    const files = ['notes/first.md', 'notes/second.md', 'skills/first/SKILL.md', 'skills/second/SKILL.md'];
    for (const relative of files) await writeInput(workspace, relative, `Context from ${relative}.`);
    const { code, result, stderr } = await cli(config, [
        'agent:plan', '--instruction', instruction,
        '--input', files[0], `--input=${files[1]}`,
        '--skill', files[2], `--skill=${files[3]}`,
    ]);
    assert.equal(code, 0);
    assert.equal(result.ok, true);
    assert.equal(result.data.command, 'agent:plan');
    assert.equal(result.data.plan.workspace, workspace);
    assert.deepEqual(result.data.plan.inputs.map((input) => input.path).sort(), [...files].sort());
    assert.deepEqual(stderr, []);
    await assert.rejects(fs.access(agentHome), { code: 'ENOENT' });
});

test('CLI direct entrypoint drains a large JSON plan through its stdout pipe before exiting', async (t) => {
    const { config, workspace, agentHome } = await fixture(t);
    const largeInstruction = `${'详细任务'.repeat(12000)}\n最后一条指令必须完整保留。`;
    await writeInput(workspace, 'large-instruction.md', largeInstruction);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL('../cli/remake.js', import.meta.url)),
        'agent:plan', '--workspace', workspace,
        '--instruction-file', 'large-instruction.md', '--json',
    ], {
        cwd: workspace,
        env: { ...config.env, VIDEO_REMAKE_WORKSPACE: workspace },
        maxBuffer: 2 * 1024 * 1024,
    });
    assert.ok(Buffer.byteLength(stdout) > 64 * 1024);
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.data.plan.instruction, largeInstruction);
    assert.ok(result.data.plan.execution.process.stdin.endsWith(largeInstruction));
    await assert.rejects(fs.access(agentHome), { code: 'ENOENT' });
});

test('CLI routes agent runs, status, and logs with a single JSON result and separates human progress', async (t) => {
    const { config } = await fixture(t);
    const success = await cli(config, ['agent:run', '--instruction', instruction]);
    assert.equal(success.code, 0);
    assert.equal(success.result.ok, true);
    assert.equal(success.result.data.run.status, 'completed');
    assert.deepEqual(success.stderr, []);
    const id = success.result.data.run.id;
    const status = await cli(config, ['agent:status', id]);
    assert.equal(status.code, 0);
    assert.equal(status.result.data.run.id, id);
    assert.equal(status.result.data.run.status, 'completed');
    const log = await cli(config, ['agent:logs', id, '--stream', 'stdout', '--lines', '1']);
    assert.equal(log.code, 0);
    assert.match(log.result.data.text, /turn.completed/);
    const human = await cli(config, ['agent:run', '--instruction', instruction], { json: false });
    assert.equal(human.code, 0);
    assert.equal(human.stderr.length, 1);
    assert.match(human.stderr[0], /Agent 已启动: r_/);
    assert.ok(human.stdout.some((line) => line.includes('completed')));
    assert.ok(!human.stdout.some((line) => line.includes('Agent 已启动:')));
});

test('CLI failed agent runs return exit 1 and retain the inspectable run record', async (t) => {
    const { config } = await fixture(t, { mode: 'nonzero' });
    const failure = await cli(config, ['agent:run', '--instruction', instruction]);
    assert.equal(failure.code, 1);
    assert.equal(failure.result.ok, false);
    assert.equal(failure.result.error.code, 'AGENT_FAILED');
    assert.equal(failure.result.data.command, 'agent:run');
    assert.equal(failure.result.data.run.status, 'failed');
    assert.equal(failure.result.data.run.execution.exitCode, 7);
    assert.deepEqual(failure.stderr, []);
    assert.ok(!JSON.stringify(failure.result).includes(secret));
    const status = await cli(config, ['agent:status', failure.result.data.run.id]);
    assert.equal(status.code, 0);
    assert.equal(status.result.data.run.status, 'failed');
});

test('CLI requires log run IDs and handles check-login as a boolean', async (t) => {
    const { config } = await fixture(t);
    const missingId = await cli(config, ['agent:logs']);
    assert.equal(missingId.code, 1);
    assert.equal(missingId.result.error.code, 'INVALID_INPUT');
    for (const flags of [['--check-login=false'], ['--check-login', 'false']]) {
        const response = await cli(config, ['agent:doctor', ...flags]);
        assert.equal(response.code, 0);
        assert.ok(!response.result.data.readiness.checks.some((check) => check.name === 'login'));
    }
    const checked = await cli(config, ['agent:doctor', '--check-login']);
    assert.equal(checked.code, 0);
    assert.ok(checked.result.data.readiness.checks.some((check) => check.name === 'login' && check.status === 'skipped'));
    const invalid = await cli(config, ['agent:doctor', '--check-login=maybe']);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.result.error.code, 'INVALID_INPUT');
});

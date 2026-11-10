import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import * as runtime from 'js-agent-runtime';
import { DEFAULT_POLICY, loadWorkflow, resolveRole, validateWorkflow } from '../src/repro/config.js';
import { runProjectAgent, doctorWorkflow, projectAgentStatus, projectAgentLogs, projectAgentCancel } from '../src/repro/runner.js';
import { validateRequirements, loadCapabilityBindings, resolveCapabilities, invokeCapability, doctorCapabilities, startCapabilityBroker } from '../src/repro/capabilities.js';

const secret = 'repro-selected-private-credential-72819';

async function fixture(t, { native = false, permission = 'workspace-write', mode = 'success', enabled = true } = {}) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-runtime-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'host');
    const workspace = path.join(project, 'productions', 'example', 'project');
    const storage = path.join(directory, 'state');
    await fs.mkdir(workspace, { recursive: true });
    const executable = path.join(directory, `fake-agent-${mode}.mjs`);
    const source = await fs.readFile(new URL('./fixtures/fake-agent.js', import.meta.url), 'utf8');
    await fs.writeFile(executable, source.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
    const target = { name: 'selected', enabled, harness: { adapter: native ? 'claude-code' : 'codex', executable, permission, ...(native ? { contextMode: 'project' } : {}) },
        backend: native ? { auth: 'claude-config', model: 'configured' } : { auth: 'api-key', provider: 'fixture', protocol: 'responses', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'FIXTURE_API_KEY', model: 'requested-fixture-model' } };
    // Most tests exercise contracts, not startup latency. Leave room for the
    // full suite's parallel native CLI/browser probes; the deadline test below
    // supplies its own explicit 1000 ms limit.
    const settings = { schemaVersion: 1, timeoutMs: 10000, targets: [target] };
    await fs.writeFile(path.join(project, 'agent-runtime.json'), JSON.stringify(settings));
    await fs.writeFile(path.join(project, '.env.agent.local'), `FIXTURE_API_KEY=${secret}\nOTHER_API_KEY=must-not-load\nNODE_OPTIONS=must-not-load\n`);
    await fs.writeFile(path.join(project, 'README.md'), 'HOST PRIVATE CONTEXT');
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Project-local entry instructions.');
    await fs.writeFile(path.join(workspace, 'README.md'), 'Standalone project.');
    await fs.mkdir(path.join(workspace, '.agents', 'skills', 'reproduce'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.agents', 'skills', 'reproduce', 'SKILL.md'), '---\nname: reproduce\ndescription: Reproduce using this project.\n---\nProject-specific skill.');
    await fs.writeFile(path.join(workspace, 'INPUTS.json'), '{"title":"new content"}');
    const config = { workspace: project, env: { VIDEO_REMAKE_AGENT_HOME: storage } };
    const workflow = validateWorkflow({ roles: { teacher: 'selected', executor: 'selected', reviewer: 'selected' } });
    const options = { workspace, workflow, role: 'executor', instruction: 'Produce outputs using project instructions.', files: ['INPUTS.json'] };
    return { directory, project, storage, workspace, executable, config, workflow, options, target, settings };
}

const completed = plan => ({ schemaVersion: 1, runtimeVersion: runtime.RUNTIME_VERSION, runId: plan.request.runId, planHash: plan.planHash, adapter: plan.adapter, status: 'completed', text: `PRIVATE RESPONSE ${secret}`, usage: null, cost: null, responseModel: null, exitCode: 0, signal: null, error: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 2 });

test('workflow defaults extractor to teacher and validates bounded policy without loading target secrets', async t => {
    const f = await fixture(t);
    const missing = await loadWorkflow(f.config);
    assert.deepEqual(missing.roles, {});
    assert.deepEqual(missing.policy, DEFAULT_POLICY);
    await assert.rejects(resolveRole(f.config, missing, 'teacher'), /No target configured.*teacher/);
    assert.equal((await resolveRole(f.config, missing, 'teacher', { target: 'selected' })).target.name, 'selected');
    await fs.writeFile(path.join(f.project, 'reproduction-workflow.json'), JSON.stringify({ schemaVersion: 1, roles: { teacher: 'selected' }, policy: { maxCalls: 2 } }));
    const loaded = await loadWorkflow(f.config);
    assert.equal(loaded.roles.extractor, 'selected');
    assert.equal(loaded.policy.maxCalls, 2);
    assert.throws(() => validateWorkflow({ roles: { opus: 'selected' } }), /Unknown role/);
    assert.throws(() => validateWorkflow({ policy: { maxCalls: 0 } }), /positive integer/);
    assert.throws(() => validateWorkflow({ policy: { maxCostUsd: -1 } }), /positive number/);
    assert.throws(() => validateWorkflow({ apiKey: secret }), /Unknown workflow/);
    assert.equal(validateWorkflow({}).policy.renderProvider, 'local');
    assert.equal(validateWorkflow({ policy: { renderProvider: 'agent' } }).policy.renderProvider, 'agent');
    assert.throws(() => validateWorkflow({ policy: { renderProvider: 'shell' } }), /local or agent/);
});

test('explicit project execution supplies only local context, preserves unknown accounting and redacts all records', async t => {
    const f = await fixture(t);
    const signal = new AbortController().signal;
    let started;
    const result = await runProjectAgent(f.config, { ...f.options, signal }, { onStart: record => { started = record; }, runtime: {
        plan: runtime.plan,
        run: async (plan, options) => {
            assert.match(plan.process.stdin, /Project-local entry instructions/);
            assert.match(plan.process.stdin, /Execution deadline:.*seconds maximum/);
            assert.match(plan.process.stdin, /Return normally before this deadline/);
            assert.match(plan.process.stdin, /Project-specific skill/);
            assert.ok(!plan.process.stdin.includes('HOST PRIVATE CONTEXT'));
            assert.ok(!plan.process.stdin.includes('SOURCE.json'));
            assert.equal(options.resolveCredential('FIXTURE_API_KEY'), secret);
            assert.equal(options.resolveCredential('OTHER_API_KEY'), undefined);
            assert.equal(options.env.NODE_OPTIONS, undefined);
            await options.onEvent({ type: 'message', sequence: 1, data: secret });
            return completed(plan);
        },
    } });
    assert.equal(started.runId, result.runId);
    assert.equal(result.contextMode, 'explicit-context');
    assert.equal(result.identitySource, 'configured-request');
    assert.equal(result.observedModel, null);
    assert.equal(result.usage, null);
    assert.equal(result.cost, null);
    assert.match(result.toolVersions.cli, /fixture-1.0.0/);
    assert.equal(result.execution.text, undefined);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal((await projectAgentStatus(f.config, result.runId)).status, 'completed');
    assert.equal((await projectAgentStatus(f.config)).runs.length, 1);
    assert.equal((await projectAgentCancel(f.config, result.runId)).status, 'completed');
    for (const name of ['run.json', 'task.json']) assert.ok(!(await fs.readFile(path.join(result.runDir, name), 'utf8')).includes(secret));
});

test('native project mode does not pretend that the explicit-context adapter enables discovery', async t => {
    const f = await fixture(t, { native: true });
    await fs.rm(path.join(f.project, '.env.agent.local'));
    await fs.mkdir(path.join(f.project, '.env.agent.local'));
    const result = await runProjectAgent(f.config, f.options, { runtime: { plan: runtime.plan, run: async plan => {
        assert.equal(plan.request.target.harness.contextMode, 'project');
        assert.ok(!plan.process.stdin.includes('Project-specific skill.'));
        assert.match(plan.process.stdin, /new content/);
        return { ...completed(plan), responseModel: 'reported-native-model' };
    } } });
    assert.equal(result.contextMode, 'native-project');
    assert.equal(result.observedModel, 'reported-native-model');
    assert.equal(result.identitySource, 'runtime-response');
    assert.ok(result.limitations.some(text => text.includes('user settings')));
});

test('execution rejects bypass, disabled targets, changed identities, secrets and symlink context before runtime', async t => {
    const f = await fixture(t);
    const forbidden = await fixture(t, { native: true, permission: 'bypass' });
    const disabled = await fixture(t, { enabled: false });
    let calls = 0;
    const deps = { runtime: { plan: runtime.plan, run: async () => { calls++; } } };
    await assert.rejects(runProjectAgent(forbidden.config, forbidden.options, deps), /cannot use bypass/);
    await assert.rejects(runProjectAgent(disabled.config, disabled.options, deps), /disabled/);
    await assert.rejects(runProjectAgent(f.config, { ...f.options, expectedTargetHash: 'incorrect' }, deps), /configuration changed/);
    await assert.rejects(runProjectAgent(f.config, { ...f.options, files: ['.env.agent.local'] }, deps), /Credentials/);
    await fs.symlink(path.join(f.project, 'README.md'), path.join(f.workspace, 'escape.txt'));
    await assert.rejects(runProjectAgent(f.config, { ...f.options, files: ['escape.txt'] }, deps), /symlinks/);
    await assert.rejects(runProjectAgent(f.config, { ...f.options, workspace: f.project }, deps), /prepared reproduction/);
    assert.equal(calls, 0);
});

test('completed and failed real runtime attempts retain inspectable external logs', async t => {
    const f = await fixture(t);
    const result = await runProjectAgent(f.config, f.options);
    assert.equal(result.status, 'completed');
    assert.equal(result.usage.totalTokens, 16);
    const logs = await projectAgentLogs(f.config, result.runId);
    assert.match(logs.text, /turn.completed/);
    assert.ok(!logs.text.includes(secret));
    const failed = await fixture(t, { mode: 'nonzero' });
    let summary;
    await assert.rejects(runProjectAgent(failed.config, failed.options), error => {
        summary = error.data.reproAgent;
        return error.code === 'AGENT_FAILED' && summary.execution.exitCode === 7;
    });
    assert.equal((await projectAgentStatus(failed.config, summary.runId)).status, 'failed');
    assert.deepEqual(await fs.readdir(path.join(failed.storage, 'repro-agent-logs', 'locks')), []);
});

test('cumulative budgets prevent launching and observed tool/token limits abort the attempt', async t => {
    const f = await fixture(t);
    let calls = 0;
    const blocked = { runtime: { plan: runtime.plan, run: async () => { calls++; } } };
    await assert.rejects(runProjectAgent(f.config, { ...f.options, budget: { calls: 12 } }, blocked), { code: 'BUDGET_EXHAUSTED' });
    await assert.rejects(runProjectAgent(f.config, { ...f.options, budget: { elapsedMs: 3600000 } }, blocked), { code: 'BUDGET_EXHAUSTED' });
    assert.equal(calls, 0);
    const workflow = validateWorkflow({ roles: f.workflow.roles, policy: { maxToolCalls: 1 } });
    await assert.rejects(runProjectAgent(f.config, { ...f.options, workflow }, { runtime: { plan: runtime.plan, run: async (plan, options) => {
        await options.onEvent({ type: 'tool', sequence: 1, data: { id: 'one' } });
        assert.equal(options.signal.aborted, true);
        return completed(plan);
    } } }), error => error.code === 'AGENT_BUDGET_EXHAUSTED' && error.data.reproAgent.toolCalls === 1);
});

test('project-level locks allow different projects concurrently and cancellation targets one run', async t => {
    const f = await fixture(t);
    let started;
    let resolveStarted;
    const ready = new Promise(resolve => { resolveStarted = resolve; });
    const first = runProjectAgent(f.config, f.options, { onStart: record => { started = record; resolveStarted(); }, runtime: { plan: runtime.plan, run: async (plan, options) => {
        await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); });
        return { ...completed(plan), status: 'cancelled' };
    } } });
    const rejected = assert.rejects(first, { code: 'AGENT_CANCELLED' });
    await ready;
    await assert.rejects(runProjectAgent(f.config, f.options), { code: 'AGENT_BUSY' });
    const secondProject = path.join(f.project, 'productions', 'another', 'project');
    await fs.mkdir(secondProject, { recursive: true });
    const second = await runProjectAgent(f.config, { ...f.options, workspace: secondProject, files: [] }, { runtime: { plan: runtime.plan, run: async plan => completed(plan) } });
    assert.equal(second.status, 'completed');
    assert.equal((await projectAgentCancel(f.config, started.runId)).status, 'cancel_requested');
    await rejected;
    assert.equal((await projectAgentStatus(f.config, started.runId)).status, 'cancelled');
});

test('workflow doctor reports each role and metadata without issuing a model request', async t => {
    const f = await fixture(t);
    const report = await doctorWorkflow(f.config, { workflow: f.workflow }, { runtime: { plan: runtime.plan, probe: async () => ({ ok: true, checks: [{ name: 'executable', status: 'passed', message: 'fixture 1' }] }) } });
    assert.equal(report.ok, true);
    assert.equal(report.roles.length, 4);
    assert.ok(report.roles.every(role => role.contextMode === 'explicit-context'));
    assert.ok(!JSON.stringify(report).includes(secret));
});

test('active status reflects live elapsed time and persisted tool progress before completion', async t => {
    const f = await fixture(t);
    let activeId, entered, finish;
    const ready = new Promise(resolve => { entered = resolve; });
    const done = new Promise(resolve => { finish = resolve; });
    const pending = runProjectAgent(f.config, f.options, { onStart: value => { activeId = value.runId; }, runtime: {
        plan: runtime.plan, run: async (plan, options) => {
            await options.onEvent({ type: 'tool', sequence: 1, time: new Date().toISOString(), data: { id: 'read-input', name: 'read' } });
            entered(); await done; return completed(plan);
        },
    } });
    await ready;
    const status = await projectAgentStatus(f.config, activeId);
    assert.equal(status.status, 'running');
    assert.equal(status.toolCalls, 1);
    assert.equal(status.lastEvent.type, 'tool');
    assert.ok(status.elapsedMs >= 10);
    const stored = JSON.parse(await fs.readFile(path.join(status.runDir, 'run.json'), 'utf8'));
    assert.equal(stored.toolCalls, 1);
    finish(); await pending;
});

test('portable capabilities reject inline bindings and explicitly report unavailable MCP', async t => {
    const f = await fixture(t);
    assert.throws(() => validateRequirements([{ id: 'asset.search', url: 'http://local/' }]), /Unknown capability requirement/);
    await fs.writeFile(path.join(f.project, 'reproduction-capabilities.local.json'), JSON.stringify({ schemaVersion: 1, bindings: { 'asset.search': { transport: 'mcp', server: 'assets', tool: 'search' } } }));
    const bindings = await loadCapabilityBindings(f.config);
    const resolved = resolveCapabilities(['asset.search', { id: 'speech.generate', required: false }], bindings);
    assert.equal(resolved[0].status, 'unsupported');
    assert.equal(resolved[1].status, 'optional-unbound');
    assert.equal((await doctorCapabilities(f.config, ['asset.search'], { bindings })).ok, false);
    await assert.rejects(invokeCapability(f.config, 'asset.search', {}, { bindings }), { code: 'CAPABILITY_UNSUPPORTED' });
});

test('HTTP capabilities bind trusted endpoint and selected credentials, never follow redirects or expose tokens', async t => {
    const f = await fixture(t);
    f.config.env.MEDIA_TOKEN = secret;
    await fs.writeFile(path.join(f.project, 'reproduction-capabilities.local.json'), JSON.stringify({ schemaVersion: 1, bindings: { 'asset.search': { transport: 'http', url: 'http://127.0.0.1:8888/assets/search', method: 'POST', tokenEnv: 'MEDIA_TOKEN', healthUrl: 'http://127.0.0.1:8888/health' } } }));
    const result = await invokeCapability(f.config, 'asset.search', { query: 'city' }, {}, { fetch: async (url, options) => {
        assert.equal(url.href, 'http://127.0.0.1:8888/assets/search');
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        assert.equal(options.redirect, 'error');
        assert.deepEqual(JSON.parse(options.body), { query: 'city' });
        return new Response(JSON.stringify({ assets: ['asset-1'], diagnostic: secret }));
    } });
    assert.deepEqual(result.data.assets, ['asset-1']);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal((await doctorCapabilities(f.config, ['asset.search'])).checks[0].status, 'configured');
});

test('local capabilities use JSON stdin and explicit executable arguments without shell interpolation', async t => {
    const f = await fixture(t);
    const script = path.join(f.directory, 'capability.mjs');
    await fs.writeFile(script, 'let input=""; for await (const chunk of process.stdin) input+=chunk; process.stdout.write(JSON.stringify({value:JSON.parse(input).value,secret:process.env.SELECTED_SECRET,other:process.env.OTHER_API_KEY??null}));');
    f.config.env.MEDIA_TOKEN = secret;
    f.config.env.OTHER_API_KEY = 'not-inherited';
    await fs.writeFile(path.join(f.project, 'reproduction-capabilities.local.json'), JSON.stringify({ schemaVersion: 1, bindings: { 'asset.search': { transport: 'local', command: process.execPath, args: [script], envRefs: { SELECTED_SECRET: 'MEDIA_TOKEN' } } } }));
    const result = await invokeCapability(f.config, 'asset.search', { value: '$(do-not-execute)' });
    assert.equal(result.data.value, '$(do-not-execute)');
    assert.equal(result.data.other, null);
    assert.ok(!JSON.stringify(result).includes(secret));
});

test('capability broker serves only declared IDs, bounds calls and exposes no provider credentials', async t => {
    const f = await fixture(t);
    f.config.env.MEDIA_TOKEN = secret;
    const bindings = { bindings: { 'asset.search': { transport: 'http', url: 'http://127.0.0.1:8888/search', method: 'POST', tokenEnv: 'MEDIA_TOKEN', timeoutMs: 1000 }, 'speech.generate': { transport: 'http', url: 'http://127.0.0.1:8888/speech', method: 'POST', timeoutMs: 1000 } } };
    const broker = await startCapabilityBroker(f.config, ['asset.search'], { bindings, maxCalls: 1 }, { fetch: async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        return new Response(JSON.stringify({ found: true, diagnostic: secret }));
    } });
    t.after(() => broker.close());
    assert.equal(new URL(broker.url).hostname, '127.0.0.1');
    const request = (url, id) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, input: {} }) });
    assert.equal((await request(broker.url.replace(/\/[a-f0-9]+$/, '/wrong'), 'asset.search')).status, 404);
    assert.equal((await request(broker.url, 'speech.generate')).status, 403);
    const response = await request(broker.url, 'asset.search');
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(secret));
    assert.equal((await request(broker.url, 'asset.search')).status, 429);
    assert.deepEqual(broker.stats(), { calls: 1, renderCalls: 0, completed: 1, failed: 0 });
    assert.deepEqual(broker.providers, [{ id: 'asset.search', transport: 'http' }]);
    await broker.close();
    await assert.rejects(request(broker.url, 'asset.search'));
});

test('capability broker cancellation aborts in-flight provider work and failures remain redacted', async t => {
    const f = await fixture(t);
    f.config.env.MEDIA_TOKEN = secret;
    const bindings = { bindings: { 'asset.search': { transport: 'http', url: 'http://127.0.0.1:8888/search', method: 'POST', tokenEnv: 'MEDIA_TOKEN', timeoutMs: 1000 } } };
    const control = new AbortController();
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    let providerSignal;
    const broker = await startCapabilityBroker(f.config, ['asset.search'], { bindings, signal: control.signal }, { fetch: async (_url, options) => {
        providerSignal = options.signal; started();
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(`cancelled ${secret}`)), { once: true }));
    } });
    const pending = fetch(broker.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"asset.search","input":{}}' });
    const rejected = assert.rejects(pending);
    await entered; control.abort(); await rejected; await broker.close();
    assert.equal(providerSignal.aborted, true);
    const failed = await startCapabilityBroker(f.config, ['asset.search'], { bindings }, { fetch: async () => { throw new Error(`secret ${secret}`); } });
    try {
        const response = await fetch(failed.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"asset.search","input":{}}' });
        assert.equal(response.status, 502);
        assert.ok(!(await response.text()).includes(secret));
    } finally { await failed.close(); }
});

test('runner brokers selected capabilities through permitted runtime environment and redacts the session route before persistence', async t => {
    const f = await fixture(t);
    f.config.env.MEDIA_TOKEN = secret;
    const bindings = { bindings: { 'asset.search': { transport: 'http', url: 'http://127.0.0.1:8888/search', method: 'POST', tokenEnv: 'MEDIA_TOKEN', timeoutMs: 1000 } } };
    let brokerURL;
    const result = await runProjectAgent(f.config, { ...f.options, capabilityRequirements: ['asset.search'], capabilityBindings: bindings }, {
        capabilities: { fetch: async () => new Response('{"found":true}') },
        runtime: { plan: runtime.plan, run: async (plan, options) => {
            brokerURL = options.env.VIDEO_REMAKE_CAPABILITY_URL;
            assert.ok(brokerURL);
            assert.equal(options.env.MEDIA_TOKEN, undefined);
            assert.equal(options.runDir, undefined);
            const response = await fetch(brokerURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"asset.search","input":{}}' });
            assert.equal(response.status, 200);
            await options.onEvent({ type: 'message', sequence: 1, data: `Session ${brokerURL}` });
            // Real runtime validation must accept only the broker URL, with no renamed keys.
            return runtime.run(plan, options);
        } },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.logMode, 'redacted-event-projection');
    assert.equal(result.capabilityCalls, 1);
    assert.match(result.capabilitiesHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.capabilityProviders, [{ id: 'asset.search', transport: 'http' }]);
    for (const name of ['run.json', 'task.json', 'runtime/stdout.log', 'runtime/stderr.log', 'runtime/events.jsonl', 'runtime/result.json']) {
        const text = await fs.readFile(path.join(result.runDir, name), 'utf8');
        assert.ok(!text.includes(secret)); assert.ok(!text.includes(brokerURL));
        assert.ok(!text.includes(new URL(brokerURL).pathname.slice(1)));
    }
    await assert.rejects(fetch(brokerURL));
});

async function copiedClient(f, binding) {
    const root = path.join(f.directory, 'standalone');
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.copyFile(new URL('../src/repro/capability-client.mjs', import.meta.url), path.join(root, 'scripts/capability.mjs'));
    await fs.writeFile(path.join(root, 'reproduction.json'), '{"capabilities":["asset.search"]}');
    await fs.writeFile(path.join(root, 'input.json'), '{"query":"中文内容"}');
    if (binding) await fs.writeFile(path.join(root, '.reproduction-capabilities.local.json'), JSON.stringify({ schemaVersion: 1, bindings: { 'asset.search': binding } }));
    return { root, run: (env = {}) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, 'scripts/capability.mjs'), 'asset.search', 'input.json'], { cwd: f.directory, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
        child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    }) };
}

test('copied standalone capability client calls managed broker without host imports or credential exposure', async t => {
    const f = await fixture(t);
    f.config.env.MEDIA_TOKEN = secret;
    const bindings = { bindings: { 'asset.search': { transport: 'http', url: 'http://127.0.0.1:8888/search', method: 'POST', tokenEnv: 'MEDIA_TOKEN', timeoutMs: 1000 } } };
    const broker = await startCapabilityBroker(f.config, ['asset.search'], { bindings }, { fetch: async (_url, options) => new Response(JSON.stringify({ query: JSON.parse(options.body).query, secret })) });
    try {
        const client = await copiedClient(f);
        const result = await client.run({ VIDEO_REMAKE_CAPABILITY_URL: broker.url });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).query, '中文内容');
        assert.ok(!result.stdout.includes(secret));
        assert.ok(!result.stdout.includes(broker.url));
        assert.equal(result.stderr, '');
    } finally { await broker.close(); }
});

test('copied standalone capability client invokes direct local binding and redacts selected credentials', async t => {
    const f = await fixture(t);
    const client = await copiedClient(f, { transport: 'local', command: process.execPath, args: ['service.mjs'], cwd: '.', envRefs: { MEDIA_SECRET: 'MEDIA_TOKEN' } });
    await fs.writeFile(path.join(client.root, 'service.mjs'), 'let raw="";for await(const data of process.stdin)raw+=data;process.stdout.write(JSON.stringify({query:JSON.parse(raw).query,secret:process.env.MEDIA_SECRET}));');
    const result = await client.run({ MEDIA_TOKEN: secret });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).query, '中文内容');
    assert.ok(!result.stdout.includes(secret));
    assert.equal(result.stderr, '');
});

test('copied standalone direct HTTP client preserves split UTF-8 and redacts raw and encoded credentials', async t => {
    const f = await fixture(t);
    const encoded = Buffer.from(secret).toString('base64');
    const server = http.createServer(async (request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${secret}`);
        request.resume();
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
        const text = JSON.stringify({ query: '中文内容', secret, encoded });
        const bytes = Buffer.from(text), index = bytes.indexOf(Buffer.from('中'));
        response.write(bytes.subarray(0, index + 1));
        await new Promise(resolve => setTimeout(resolve, 30));
        response.end(bytes.subarray(index + 1));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const client = await copiedClient(f, { transport: 'http', url: `http://127.0.0.1:${server.address().port}/search`, method: 'POST', tokenEnv: 'MEDIA_TOKEN' });
        const result = await client.run({ MEDIA_TOKEN: secret });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).query, '中文内容');
        assert.ok(!result.stdout.includes(secret));
        assert.ok(!result.stdout.includes(encoded));
        assert.equal(result.stderr, '');
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('deadline expiration reports a timeout rather than a user cancellation', async t => {
    const f = await fixture(t);
    await assert.rejects(runProjectAgent(f.config, { ...f.options, timeoutMs: 1000 }, { runtime: {
        plan: runtime.plan,
        run: async (plan, options) => {
            await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
            return { ...completed(plan), status: 'cancelled', error: 'Run cancelled' };
        },
    } }), error => error.code === 'AGENT_TIMED_OUT' && /1000 ms execution deadline/.test(error.message));
});

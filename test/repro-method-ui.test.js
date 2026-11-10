import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgv, HELP } from '../src/args.js';
import { printHuman } from '../src/format.js';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('method CLI selects explicit generation and replay without swallowing boolean run', () => {
    const value = parseArgv(['repro:generate', 'method@1', '--as', 'trial', '--spec', 'task.json', '--ref', 'reference', '--run']);
    assert.equal(value.command, 'repro:generate');
    assert.deepEqual(value.positionals, ['method@1']);
    assert.deepEqual(value.flags, { as: 'trial', spec: 'task.json', ref: 'reference', run: true });
    for (const command of ['repro:method-freeze', 'repro:asset-freeze', 'repro:method-migrate', 'repro:replay']) assert.equal(parseArgv([command, 'sample']).command, command);
    assert.match(HELP, /repro:replay/);
    assert.doesNotMatch(HELP, /repro:cycle/);
    assert.match(HELP, /Import an unverified method recipe/);
});

test('human output separates quality, process audit and unverified read isolation', () => {
    const lines = [];
    printHuman({ ok: true, data: { command: 'repro:status', run: {
        production: 'trial', kind: 'trial', status: 'passed', method: { id: 'method@1' },
        generationMode: 'method-generation', attempts: [], generationAudit: { passed: true, processVerified: true,
            isolation: { level: 'native-project', readIsolation: false, probeVerified: false } },
    } } }, line => lines.push(line));
    assert.match(lines.join('\n'), /从空工程生成/);
    assert.match(lines.join('\n'), /过程审计通过；读取隔离: 未验证/);
    assert.doesNotMatch(lines.join('\n'), /独立生成通过/);
    const old = [];
    printHuman({ ok: true, data: { command: 'repro:status', run: { production: 'old', kind: 'trial', status: 'passed', template: { id: 'old@6' }, attempts: [] } } }, line => old.push(line));
    assert.match(old.join('\n'), /历史工程回放/);
});

test('verified filesystem confinement is shown separately from uncertified networking', () => {
    const lines = [];
    printHuman({ ok: true, data: { command: 'repro:status', run: {
        production: 'isolated-trial', kind: 'trial', status: 'external-review', method: { id: 'method@1' },
        generationMode: 'method-generation', attempts: [], generationAudit: { passed: true, processVerified: true, strictIndependent: false,
            isolation: { level: 'restricted-filesystem', readIsolation: 'enforced', filesystemProbeVerified: true, probeVerified: false,
                probe: { networkRestricted: false } } },
    } } }, line => lines.push(line));
    assert.match(lines.join('\n'), /读取隔离: 已验证；网络隔离: 未验证/);
    assert.doesNotMatch(lines.join('\n'), /独立生成通过/);
});

test('stage scopes and method revision feedback preserve explicit CLI semantics', () => {
    const stage = parseArgv(['repro:run', 'trial', '--stage', 'shots', '--shot', 'shot-02', '--until', 'integration', '--step']);
    assert.deepEqual(stage.flags, { stage: 'shots', shot: 'shot-02', until: 'integration', step: true });
    assert.equal(parseArgv(['repro:run', 'trial', '--step=false']).flags.step, false);
    assert.throws(() => parseArgv(['repro:run', 'trial', '--step=perhaps']), /true or false/);
    const revision = parseArgv(['repro:method-revise', 'method@1', '--feedback', 'first,second', '--feedback', 'third', '--version', '2']);
    assert.deepEqual(revision.flags.feedback, ['first', 'second', 'third']);
    assert.equal(parseArgv(['repro:extract', 'teacher', '--feedback', 'old-trial']).flags.feedback, 'old-trial');
});

test('stage output distinguishes host checks, self-checks, stale evidence and final submissions', () => {
    const lines = [];
    printHuman({ ok: true, data: { command: 'repro:status', run: { schema: 'video-remake.reproduction-run@3', production: 'trial', kind: 'trial', status: 'needs-revision', method: { id: 'method@1' },
        stageExecutions: [{}, {}, {}], stageSubmissions: [{}, {}], finalSubmissions: [],
        stageState: { currentStage: 'shots', stages: [{ id: 'shots', title: '逐镜头制作', shotId: 'shot-02', status: 'stale', staleReason: '共享场景已改变', hostChecks: [{ id: 'media', passed: true, message: '媒体可读取' }], selfCheck: { status: 'pass' } }] },
        allowedActions: ['repair', 'check'], blockedReasons: { judge: '整合证据尚未完成' },
    } } }, line => lines.push(line));
    const text = lines.join('\n');
    assert.match(text, /阶段调用: 3；阶段提交: 2；整片提交: 0/);
    assert.match(text, /共享场景已改变/);
    assert.match(text, /不替代最终质量评审/);
    assert.match(text, /暂不可执行 judge: 整合证据尚未完成/);
    assert.doesNotMatch(text, /视觉验收通过|双评审通过/);
});

test('browser run summary shows the active requested model and harness before its first completion', async () => {
    const source = await fs.readFile(new URL('../web/repro.js', import.meta.url), 'utf8');
    const summaryFunction = source.slice(source.indexOf('function showRunSummary(run) {'), source.indexOf('\nasync function loadConfiguration()'));
    const element = (tag, text) => ({ tag, text, children: [], append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; } });
    const containers = { 'detail-summary': element('section'), 'review-summary': element('section') };
    const context = { $: id => containers[id], node: element, runModeLabel: () => '从空工程生成', stagedRun: () => true };
    vm.runInNewContext(`${summaryFunction}\nthis.show = showRunSummary;`, context);
    const run = { activeAgent: { requestedModel: 'deepseek-flash', observedModel: null, harness: { adapter: 'deepseek-harness' } },
        stageExecutions: [{ id: 'sx_first' }], attempts: [], spec: { acceptance: { review: [] } } };
    context.show(run);
    const texts = containers['detail-summary'].children[0].children.map(item => item.text).join('\n');
    assert.match(texts, /deepseek-flash（实际返回：未知）/); assert.match(texts, /deepseek-harness/); assert.doesNotMatch(texts, /尚未执行|尚未记录/);
    run.stageExecutions.push({ agent: { requestedModel: 'previous-model', observedModel: 'previous-model', harness: 'previous-harness' } });
    context.show(run);
    assert.doesNotMatch(containers['detail-summary'].children[0].children.map(item => item.text).join('\n'), /previous-model|previous-harness/);
});

test('detail actions expose backend-authorized cancellation for CLI runs and reuse an owned UI job cancellation', async () => {
    const source = await fs.readFile(new URL('../web/repro.js', import.meta.url), 'utf8');
    const labels = source.slice(source.indexOf('const actionLabels = '), source.indexOf('\n', source.indexOf('const actionLabels = ')));
    const actions = source.slice(source.indexOf('function renderRunActions(run) {'), source.indexOf('\nfunction appendStageMedia('));
    const cancel = source.slice(source.indexOf('async function cancelRun(subject) {'), source.indexOf('\nasync function pollJob()'));
    const element = () => ({ children: [], append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; } });
    const containers = { 'detail-actions': element(), 'action-reasons': element() }, calls = [];
    const context = { $: id => containers[id], node: (_tag, text) => ({ text }), button: (label, handler) => ({ label, handler }),
        stagedRun: run => Boolean(run.stageState), notice: () => {}, activeJob: null,
        launch: async (...args) => calls.push(['launch', ...args]), post: async (...args) => calls.push(['post', ...args]),
        api: async () => ({ status: 'running', subject: 'trial' }) };
    vm.runInNewContext(`${labels}\n${actions}\n${cancel}\nthis.render = renderRunActions;`, context);
    const run = { production: 'trial', stageState: {}, allowedActions: ['status', 'logs', 'cancel'] };
    context.render(run);
    assert.deepEqual(containers['detail-actions'].children.map(item => item.label), ['停止当前执行']);
    await containers['detail-actions'].children[0].handler();
    assert.deepEqual(calls, [['launch', 'cancel', 'trial']]);
    calls.length = 0; context.activeJob = 'owned-ui-job';
    await containers['detail-actions'].children[0].handler();
    assert.equal(calls[0][0], 'post'); assert.equal(calls[0][1], '/jobs/owned-ui-job/cancel'); assert.equal(calls.length, 1);
    context.render({ ...run, allowedActions: ['status', 'logs'] });
    assert.equal(containers['detail-actions'].children.length, 0);
    context.render({ production: 'finished-legacy', attempts: [] });
    assert.ok(!containers['detail-actions'].children.some(item => item.label === '停止当前执行'));
});

test('stage cards can revise earlier analysis only with repair permission, valid predecessors and no active work', async () => {
    const source = await fs.readFile(new URL('../web/repro.js', import.meta.url), 'utf8');
    const statuses = source.slice(source.indexOf('const stageStatuses = '), source.indexOf('\n', source.indexOf('const stageStatuses = ')));
    const stageFunction = source.slice(source.indexOf('function showStages(run, evidence = []) {'), source.indexOf('\nfunction showRunSummary('));
    const element = (tag, text) => ({ tag, text, children: [], append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; } });
    const containers = Object.fromEntries(['stage-navigation', 'stage-cards', 'stage-progress', 'stage-note'].map(id => [id, element('section')]));
    const calls = [];
    const context = { $: id => containers[id], node: element, button: (label, handler) => ({ tag: 'button', label, handler }),
        appendStageMedia: () => {}, activeJob: null, launch: async (...args) => calls.push(JSON.parse(JSON.stringify(args))) };
    vm.runInNewContext(`${statuses}\n${stageFunction}\nthis.render = showStages;`, context);
    const stages = ['freeze', 'analysis', 'prototypes', 'shots', 'integration', 'submission', 'review'].map((id, index) => ({ id, status: index < 2 ? 'evidence-complete' : index === 2 ? 'needs-revision' : 'pending' }));
    const run = { production: 'trial', status: 'needs-revision', allowedActions: ['check', 'repair'], stageState: { currentStage: 'prototypes', stages },
        shotPlan: { shots: [{ id: 'shot-02', startSec: 2, endSec: 4 }] } };
    const card = id => containers['stage-cards'].children.find(item => item.id === `stage-${id}`);
    const buttons = value => [value, ...(value.children || []).flatMap(buttons)].filter(item => item.tag === 'button' && /^(修订|修复)/.test(item.label));
    context.render(run);
    assert.equal(buttons(card('analysis'))[0].label, '修订参考分析');
    assert.equal(buttons(card('prototypes'))[0].label, '修复本阶段');
    assert.equal(buttons(card('shots')).length, 0); assert.equal(buttons(card('integration')).length, 0);
    await buttons(card('analysis'))[0].handler();
    assert.deepEqual(calls[0], ['repair', 'trial', { stage: 'analysis', step: true }]);
    stages[2].status = 'evidence-complete'; stages[3].status = 'needs-revision'; run.stageState.currentStage = 'shots'; context.render(run);
    await buttons(card('shots')).find(item => item.label === '修复此镜头').handler();
    assert.deepEqual(calls[1], ['repair', 'trial', { stage: 'shots', shot: 'shot-02', step: true }]);
    stages[3].status = 'evidence-complete'; context.render(run);
    await buttons(card('integration'))[0].handler();
    assert.deepEqual(calls[2], ['repair', 'trial', { stage: 'integration', step: true }]);
    stages[1].status = 'pending'; context.render(run); assert.equal(buttons(card('prototypes')).length, 0);
    stages[1].status = 'stale'; context.render(run); assert.equal(buttons(card('prototypes')).length, 1, 'stale predecessor recheck follows the existing backend repair policy');
    for (const busy of [{ activeOperation: {} }, { activeAgentRunId: 'p_active' }, { activeRender: {} }, { status: 'running' }]) {
        context.render({ ...run, ...busy }); assert.equal(buttons(containers['stage-cards']).length, 0);
    }
    context.activeJob = 'ui-job'; context.render(run); assert.equal(buttons(containers['stage-cards']).length, 0); context.activeJob = null;
    context.render({ ...run, allowedActions: ['check'] }); assert.equal(buttons(containers['stage-cards']).length, 0);
    assert.equal(calls.length, 3, 'rendering cards never starts a repair');
});

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { appError } from '../errors.js';
import { storage, jsonHash, fileHash, readJson, writeJson, safeFile } from './store.js';
import { snapshotProject, safeProjectFile, copyProject } from './project.js';
import { captureGenerationBaseline, auditGeneration } from './generation-audit.js';
import { installStageOverlay, PLAN_FILE } from './stage-project.js';
import { STAGE_PROTOCOL, STAGE_IDS, createStageState, stageProtocolFingerprint, validateShotPlan, validateSelfCheck, selectPrototypeShots, shotPlanHash, isStageComplete } from './stages.js';
import { createBudgetLedger, reserveBudget, startBudgetReservation, settleBudgetReservation, finalReviewReserve, availableStageBudget } from './budget.js';
import { previewStage, prepareStageReference, validateStageEvidence } from './stage-preview.js';

const now = () => new Date().toISOString();
const invalid = message => appError('REPRO_STAGE_INVALID', message);
const notReady = message => appError('REPRO_NOT_READY', message);
const stageRecord = (state, id) => state.stageState.stages.find(stage => stage.id === id);
const done = stage => isStageComplete(stage);
const sourceStages = ['prototypes', 'shots', 'integration'];
const refs = state => [...new Set([...(state.spec.acceptance.evidence.timestampsSec || []), ...(state.spec.acceptance.evidence.boundariesSec || [])])];
const sourceSnapshot = workspace => snapshotProject(workspace, { includeInputs: true });
const stageRoot = (config, state, stageId, id) => path.join(storage(config), 'runs', state.id, 'stages', stageId, id);
const roleOf = state => state.kind === 'teacher' ? 'teacher' : 'executor';
const checkIds = (state, id) => ['framing', 'action', 'motion', ...(id === 'integration' && state.spec.acceptance.review.some(c => /caption/.test(c.id)) ? ['captions'] : []), ...(id === 'integration' && state.spec.acceptance.media.audio === 'required' ? ['sound'] : [])];

export function stagedSummary(state) {
    if (!state.stageState) return {};
    const stage = stageRecord(state, state.stageState.currentStage);
    const active = Boolean(state.activeOperation || state.activeAgentRunId || state.activeRender);
    let allowedActions = ['status', 'logs'];
    const blockedReasons = {};
    if (active) allowedActions.push('cancel');
    else if (state.status === 'passed') { /* accepted artifacts are immutable */ }
    else if (state.status === 'budget-exhausted') blockedReasons.run = '总预算已用尽；历史材料保留。';
    else if (state.status === 'interrupted' || state.status === 'cancelled') allowedActions.push('recover', ...(state.stageCheckpoint ? ['resume'] : []));
    else if (stage?.id === 'review') allowedActions.push('check', 'judge', ...(state.review ? ['repair'] : []));
    else if (stage?.status === 'needs-revision') allowedActions.push('check', 'repair', ...(stage.id === 'submission' ? ['render'] : []), ...(stage.pendingPreview ? ['run'] : []));
    else if (stage?.status === 'blocked') allowedActions.push('render', 'check', 'run', ...(sourceStages.includes(stage.id) ? ['repair'] : []));
    else allowedActions.push('run', 'check', ...(sourceStages.includes(stage?.id) ? ['render'] : []));
    const checkable = stage?.id === 'analysis' ? Boolean(state.shotPlan) : ['submission','review'].includes(stage?.id) ? Boolean(state.attempts?.length) : Boolean(stage?.pendingPreview || state.stageSubmissions?.some(s => s.episodeId === state.stageState.currentEpisodeId && s.stageId === stage?.id && s.status === 'evidence-complete'));
    if (!checkable) { allowedActions = allowedActions.filter(action => action !== 'check'); blockedReasons.check = '当前阶段尚无可检查的提交材料。'; }
    if (sourceStages.includes(stage?.id) && !stage.implementationExecutionId && !stage.pendingPreview && stage.status !== 'stale') { allowedActions = allowedActions.filter(action => action !== 'render'); blockedReasons.render = '制作模型完成本阶段实现后才可单独预览。'; }
    if (!active && state.status !== 'passed' && state.status !== 'budget-exhausted') allowedActions.push('retry');
    for (const action of ['run', 'repair', 'render', 'check', 'judge', 'resume', 'recover', 'retry']) if (!allowedActions.includes(action)) blockedReasons[action] ||= active ? '当前有活动操作。' : '当前阶段或前置材料不允许此操作。';
    return { stageState: state.stageState, shotPlan: state.shotPlan, stageExecutions: state.stageExecutions, stageSubmissions: state.stageSubmissions,
        finalSubmissions: state.finalSubmissions, episodes: state.episodes, budgetLedger: state.budgetLedger, activeOperation: state.activeOperation,
        executionProtocolHash: state.executionProtocolHash, stagePolicyHash: state.stagePolicyHash, feedbackMode: state.feedbackMode,
        checkerProfileHash: state.checkerProfileHash, budgetPolicyHash: state.budgetPolicyHash, baseScaffoldHash: state.baseScaffoldHash,
        executionOverlayHash: state.executionOverlayHash, allowedActions: [...new Set(allowedActions)], blockedReasons };
}

export async function initializeStagedRun(config, state, bridge) {
    const protocolHash = await stageProtocolFingerprint();
    const overlay = await installStageOverlay(state.workspace, { protocol: STAGE_PROTOCOL.id, execution: state.workflow.execution, methodApplied: state.methodApplied !== false });
    state.schema = 'video-remake.reproduction-run@3';
    state.executionProtocolHash = protocolHash;
    state.stagePolicyHash = jsonHash(state.workflow.execution);
    state.feedbackMode = state.workflow.execution.feedbackMode;
    if (state.feedbackMode === 'guided') state.assisted = true;
    state.baseScaffoldHash = state.baseScaffoldHash || state.scaffoldHash;
    state.executionOverlayHash = overlay.overlayHash;
    state.scaffoldHash = jsonHash({ base: state.baseScaffoldHash, overlay: overlay.overlayHash });
    state.checkerProfileHash = await checkerProfileFingerprint(state.workflow.policy.reviewProtocolHash);
    state.budgetPolicyHash = jsonHash({ ...state.workflow.policy, maxAttempts: state.workflow.execution.maxFinalSubmissions });
    state.methodAssembly ||= { lockedFiles: {}, assetLockHash: jsonHash([]) };
    Object.assign(state.methodAssembly.lockedFiles, overlay.lockedFiles);
    state.budgetLedger ||= createBudgetLedger();
    state.stageExecutions ||= []; state.stageSubmissions ||= []; state.finalSubmissions ||= [];
    state.episodes ||= [];
    const episodeId = `e_${randomUUID()}`;
    state.stageState = createStageState({ protocolHash, episodeId, at: now() });
    state.stageState.currentEpisodeId = episodeId;
    state.frozenStageInputs = await bridge.installInputs(config, state);
    const lockedPaths = [...new Set([...Object.keys(state.methodAssembly.lockedFiles), ...Object.keys(state.frozenStageInputs), 'method', '.agents', '.claude', 'task', 'inputs', 'reference', 'toolkit', 'assets/packs', 'scripts', 'STAGE-CONTRACT.json', 'docs/stages.md'])];
    state.generation = await captureGenerationBaseline(state.workspace, { identity: { method: state.method, methodApplied: state.methodApplied !== false,
        scaffoldHash: state.scaffoldHash, assetLockHash: state.methodAssembly.assetLockHash, toolProfileHash: state.toolProfileHash,
        specHash: state.specHash, inputsHash: state.inputsHash, executionProtocolHash: protocolHash }, lockedPaths, isolation: state.executionIsolation });
    const snapshot = await sourceSnapshot(state.workspace);
    state.episodes.push({ id: episodeId, startedAt: now(), baselineHash: state.generation.baselineHash, startingPoint: 'blank-scaffold', generation: state.generation, initialSnapshot: snapshot });
    state.stageCheckpoint = { snapshot, at: now(), reason: 'blank-start', verified: true };
    state.preparedSnapshot = snapshot;
    state.status = 'prepared';
    await bridge.save(config, state);
}

async function assertStageIdentity(state, bridge) {
    if (state.executionProtocolHash !== await stageProtocolFingerprint()) throw notReady('冻结阶段协议已改变；创建新实验以使用新协议。');
    await bridge.assertReferences(state);
    const audit = await auditGeneration(state.workspace, { baseline: state.generation });
    if (audit.lockedChanges.length) throw notReady(`冻结输入已改变: ${audit.lockedChanges.join(', ')}`);
    const current = await sourceSnapshot(state.workspace);
    if (state.stageCheckpoint && current.treeHash !== state.stageCheckpoint.snapshot.treeHash) throw notReady('工程在执行检查点后被外部修改；不能作为原独立运行继续。');
    return current;
}
function nextStage(state) {
    const stage = state.stageState.stages.find(item => !done(item));
    state.stageState.currentStage = stage?.id || 'review';
    return stage;
}
function staleSource(state, reason, except) {
    for (const stage of state.stageState.stages) if ([...sourceStages, 'submission', 'review'].includes(stage.id) && stage.id !== except && (done(stage) || stage.pendingPreview)) {
        stage.status = 'stale'; stage.staleReason = reason; delete stage.pendingPreview;
    }
    for (const record of state.stageSubmissions) if (record.episodeId === state.stageState.currentEpisodeId && record.kind !== 'analysis' && record.status === 'evidence-complete') { record.status = 'stale'; record.staleReason = reason; }
    if (state.review) { state.reviewHistory ||= []; state.reviewHistory.push({ review: state.review, source: state.reviewSource, at: now() }); }
    delete state.review; delete state.reviewSource; delete state.technical;
}
function settleStatus(error) { return /TIME/.test(error?.code || '') ? 'timed_out' : /CANCEL/.test(error?.code || '') ? 'cancelled' : /BUDGET/.test(error?.code || '') ? 'budget_exhausted' : 'failed'; }
function budgetDelta(before, after) { return Object.fromEntries(['calls','elapsedMs','toolCalls','renderCalls','tokens','costUsd'].map(key => [key, Math.max(0, (after[key] || 0) - (before[key] || 0))])); }

export async function stageOperation(config, state, bridge, { stageId, kind, amount, holdback = finalReviewReserve(state.workflow), options = {} }, work) {
    const operationId = `op_${randomUUID()}`;
    const before = { ...state.budget };
    reserveBudget(state.budgetLedger, { operationId, kind, policy: state.workflow.policy, used: state.budget, amount, holdback });
    state.activeOperation = { id: operationId, stageId, kind, owner: { pid: process.pid, hostname: os.hostname() }, startedAt: now(), budgetBefore: before, inputSnapshot: state.stageCheckpoint?.snapshot.treeHash };
    startBudgetReservation(state.budgetLedger, operationId);
    state.stageState.currentStage = stageId;
    await bridge.save(config, state);
    let result, error;
    try { result = await work(operationId); return result; }
    catch (caught) { error = caught; throw caught; }
    finally {
        settleBudgetReservation(state.budgetLedger, operationId, { actual: budgetDelta(before, state.budget), receiptId: operationId, status: error ? settleStatus(error) : 'completed',
            accounting: { toolCallsComplete: state.budget.toolCallsComplete !== false, renderCallsComplete: state.budget.renderCallsComplete !== false, usageComplete: state.budget.usageComplete !== false, costComplete: state.budget.costComplete !== false, elapsedComplete: state.budget.elapsedComplete !== false } });
        state.operationHistory ||= []; state.operationHistory.push({ ...state.activeOperation, finishedAt: now(), status: error ? settleStatus(error) : 'completed', error: error ? { code: error.code, message: error.message } : null });
        delete state.activeOperation;
        await bridge.save(config, state);
    }
}
function makerTimeout(state, options) {
    const available = availableStageBudget(state.workflow.policy, state.budget, state.budgetLedger, { holdback: finalReviewReserve(state.workflow) });
    return Math.max(0, Math.min(Number(options.timeoutMs) || 900000, available.elapsedMs));
}
async function executeMaker(config, state, bridge, deps, stageId, instruction, options, { selfCheck = false, shotIds = [], reportFile } = {}) {
    const timeoutMs = makerTimeout(state, options);
    if (timeoutMs < 1000) throw appError('REPRO_BUDGET_EXHAUSTED', '剩余预算需保留最终渲染和双评审。');
    const before = await assertStageIdentity(state, bridge);
    const execution = { id: `sx_${randomUUID()}`, episodeId: state.stageState.currentEpisodeId, stageId, shotIds, purpose: selfCheck ? 'self-check' : 'production', startedAt: now(), inputSnapshot: before.treeHash, sourceSnapshotBefore: before };
    return stageOperation(config, state, bridge, { stageId, kind: selfCheck ? 'stage-self-check' : 'stage-production', amount: { calls: 1, elapsedMs: timeoutMs } }, async () => {
        state.stageExecutions.push(execution); state.activeOperation.executionId = execution.id; state.status = 'running';
        let error;
        try {
            const agent = await bridge.callAgent(config, state, { ...options, timeoutMs }, deps, { workspace: state.workspace, role: roleOf(state), target: state.target,
                expectedTargetHash: state.targetHash, purpose: `stage:${stageId}:${execution.purpose}`, instruction,
                readOnlyPaths: ['.work/stage-evidence', ...(selfCheck ? before.files.map(file => file.path) : [])], stageId, shotIds, selfCheck, reportFile });
            execution.agent = agent; execution.agentRunId = agent.runId;
            if (agent.targetHash) state.targetHash = agent.targetHash;
            if (agent.status !== 'completed') throw notReady('阶段模型调用未完成。');
            execution.status = 'completed';
            return agent;
        } catch (caught) { error = caught; execution.status = settleStatus(caught); execution.error = { code: caught.code, message: caught.message };
            execution.agent ||= caught.data?.reproAgent || state.agentRuns?.at(-1); throw caught;
        } finally {
            const after = await sourceSnapshot(state.workspace);
            execution.sourceSnapshotAfter = after; execution.finishedAt = now();
            state.stageCheckpoint = { snapshot: after, at: now(), stageId, executionId: execution.id, verified: true, interrupted: Boolean(error) };
            const audit = await auditGeneration(state.workspace, { baseline: state.generation });
            if (audit.lockedChanges.length) throw notReady('阶段执行改变了冻结输入。');
            if (before.treeHash !== after.treeHash) staleSource(state, '实现或分析材料改变，需要新的证据。', stageId);
            if (selfCheck && before.treeHash !== after.treeHash) throw invalid('自检调用改变了实现；该自检不能用于原预览。');
        }
    });
}

async function exposeEvidence(state, record) {
    const relative = `.work/stage-evidence/${record.id}`;
    const root = await safeProjectFile(state.workspace, relative, { create: true });
    await fs.mkdir(root, { recursive: true });
    const items = [];
    for (const item of record.items || []) {
        const from = await safeFile(record.evidenceRoot, item.path);
        if (await fileHash(from) !== item.sha256) throw invalid('宿主阶段证据内容已改变。');
        const to = await safeProjectFile(root, item.path, { create: true });
        await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to);
        items.push({ ...item, file: `${relative}/${item.path}` });
    }
    if (record.artifact?.file) {
        const file = path.join(root, 'candidate.mp4'); await fs.copyFile(record.artifact.file, file);
        if (await fileHash(file) !== record.artifact.sha256) throw invalid('预览视频副本不一致。');
    }
    const view = { schema: 'video-remake.stage-evidence-view@1', evidenceManifestSha256: record.evidenceManifestSha256, sourceTreeHash: record.sourceTreeHash,
        items, ...(record.artifact ? { candidate: `${relative}/candidate.mp4` } : {}) };
    await writeJson(root, 'EVIDENCE.json', view);
    return { relative: `${relative}/EVIDENCE.json`, view, root };
}
async function referenceEvidence(config, state, bridge, deps) {
    if (state.stageReference) { await (deps.validateStageEvidence || validateStageEvidence)(state.stageReference, { protocolHash: state.executionProtocolHash }); return state.stageReference; }
    const timeoutMs = Math.min(120000, makerTimeout(state, {}));
    if (timeoutMs < 1000) throw appError('REPRO_BUDGET_EXHAUSTED', '参考证据预算不足。');
    return stageOperation(config, state, bridge, { stageId: 'analysis', kind: 'reference-evidence', amount: { elapsedMs: timeoutMs } }, async id => {
        const started = Date.now();
        let receipt;
        try {
            const record = await controlledMedia(config, state, bridge, deps, mediaDeps => (deps.prepareStageReference || prepareStageReference)({ references: state.references, spec: state.spec, evidenceRoot: stageRoot(config, state, 'reference', id), protocolHash: state.executionProtocolHash, workspace: state.workspace, signal: mediaDeps.signal, timeoutMs }, mediaDeps));
            receipt = record; state.stageReference = record; return record;
        } catch (error) { receipt = error.data?.stageEvidence; throw error; } finally { chargeMedia(state, receipt); state.budget.elapsedMs += Date.now() - started; }
    });
}
async function readPlan(state) {
    const plan = validateShotPlan(await readJson(state.workspace, PLAN_FILE), { durationSec: state.spec.acceptance.media.durationSec, requiredAnchors: refs(state), evidenceIds: state.stageReference.items.map(item => item.id) });
    for (const shot of plan.shots) for (const observation of shot.observations) {
        const item = state.stageReference.items.find(item => item.id === observation.evidenceId);
        if (item?.kind === 'video' && observation.timeSec > item.durationSec) throw invalid('观察时间超出被冻结原片的可观察范围。');
        if (item?.kind === 'frame' && Math.abs(observation.timeSec - (item.timeSec ?? item.requestedTimeSec)) > 0.05) throw invalid('观察时间与引用帧的实际 seek 时间不一致；短镜头可引用已提供的完整原片 video ID。');
    }
    return plan;
}
async function analyse(config, state, bridge, deps, options) {
    const stage = stageRecord(state, 'analysis');
    const previousPlanHash = state.planHash;
    const evidence = await referenceEvidence(config, state, bridge, deps);
    const view = await exposeEvidence(state, evidence);
    const revision = (stage.revision || 0) + 1;
    if (revision > 1 + state.workflow.execution.maxStageRevisions) throw appError('REPRO_STAGE_LIMIT', '参考分析修订次数已用尽。');
    assertMakerBudget(state, options);
    stage.revision = revision; stage.status = 'running';
    const instruction = commonInstruction(state) + `\n当前阶段是参考分析，仅生成观察与镜头计划。先读 ${view.relative} 并实际查看图像，必要时查看 reference/media 原片。写 ${PLAN_FILE}、ANALYSIS.md、TIMELINE.md，不要在此阶段制作场景源码。JSON格式见docs/stages.md。镜头覆盖0至${state.spec.acceptance.media.durationSec}秒，不重叠不留空；每个镜头至少有一条观察，只引用提供的reference evidence ID。固定帧未覆盖短镜头时，实际查看原片相应时刻并引用已提供的完整视频ID（<reference-id>:video）；不要填空观察表。dependencies只填此前镜头ID，无依赖填[]，不得填素材名称、文件或包ID。保留人物交互与复杂运动的真实风险标签供关键镜头选取。该片确无相应风险时如实报告，不虚构。`;
    await executeMaker(config, state, bridge, deps, 'analysis', instruction, options);
    const plan = await readPlan(state);
    const prototypeShotIds = selectPrototypeShots(plan, { requirements: state.workflow.execution.prototypeRequirements, minShots: state.workflow.execution.minPrototypeShots || 2 });
    state.shotPlan = plan; state.planHash = shotPlanHash(plan); state.prototypeShotIds = prototypeShotIds;
    stage.status = 'evidence-complete'; stage.hostChecks = [{ id: 'analysis:coverage', passed: true, message: '观察表覆盖完整任务时间，引用宿主参考证据。' }];
    stage.sourceTreeHash = state.stageCheckpoint.snapshot.treeHash; stage.planHash = state.planHash; stage.shotIds = plan.shots.map(s => s.id);
    stage.completedAt = now(); state.stageState.revision++;
    const id = `ss_${randomUUID()}`; const root = stageRoot(config, state, 'analysis', id);
    await fs.mkdir(root, { recursive: true });
    await writeJson(root, 'shot-plan.json', plan);
    state.stageSubmissions.push({ id, episodeId: state.stageState.currentEpisodeId, stageId: 'analysis', kind: 'analysis', revision, status: stage.status,
        sourceTreeHash: stage.sourceTreeHash, planHash: state.planHash, shotIds: stage.shotIds, evidenceRoot: root, items: [], hostChecks: stage.hostChecks, plan, createdAt: now() });
    for (const item of state.stageState.stages) if (sourceStages.includes(item.id) || ['submission','review'].includes(item.id)) {
        if (previousPlanHash && previousPlanHash !== state.planHash) {
            // A new plan requires new implementation even when its shot IDs
            // remain the same. Keep cumulative revisions and historical records.
            item.status = 'pending'; item.staleReason = '镜头计划改变，需要按新计划重新制作。';
            item.invalidatedByPlanHash = state.planHash;
            delete item.producedShotIds; delete item.implementationExecutionId; delete item.pendingPreview;
        } else if (done(item)) { item.status = 'stale'; item.staleReason = '参考分析修订'; }
    }
}
function repairFeedback(state, targetId) {
    const origin = stageRecord(state, state.stageState.currentStage);
    const target = stageRecord(state, targetId);
    const episodeId = state.stageState.currentEpisodeId;
    const submission = state.stageSubmissions.findLast(item => item.episodeId === episodeId && item.stageId === origin.id
        && (origin.selfCheck ? item.selfCheck && jsonHash(item.selfCheck) === jsonHash(origin.selfCheck) : item.revision === origin.revision));
    const execution = state.stageExecutions.findLast(item => item.episodeId === episodeId && item.stageId === origin.id);
    return structuredClone({ id: `rf_${randomUUID()}`, createdAt: now(),
        technical: state.technical?.checks || null, review: state.review || null,
        stage: target.selfCheck || target.error || null,
        target: { stageId: targetId, revision: target.revision, planHash: state.planHash || null },
        origin: { stageId: origin.id, revision: origin.revision, selfCheck: origin.selfCheck || null, error: origin.error || null,
            source: { episodeId, revision: submission?.revision ?? origin.revision, submissionId: submission?.id || null,
                errorExecutionId: origin.error && execution?.error?.code === origin.error.code && execution.error.message === origin.error.message ? execution.id : null,
                sourceTreeHash: submission?.sourceTreeHash || execution?.sourceSnapshotAfter?.treeHash || origin.sourceTreeHash || null,
                planHash: submission?.planHash || origin.planHash || state.planHash || null,
                evidenceManifestSha256: submission?.evidenceManifestSha256 || null } },
    });
}
function commonInstruction(state) {
    return `你是本次唯一制作模型。执行冻结的分阶段独立复刻流程，角色配置保持不变，不调用其他模型，不读取教师项目或历史试跑。阅读AGENTS.md、STAGE-CONTRACT.json、docs/stages.md和当前Skill。参考与输入只用本工程文件；若method/存在按其方法制作。不得修改冻结的task/、inputs/、reference/、method/、assets/packs/、toolkit/、依赖、scripts/和Skills。你可以修改自己的src/、派生素材、planning/和制作说明。最终质量由两份外部完整评审决定。\n${state.feedback ? `已有失败反馈（只用于自行修复，不改变标准）：${JSON.stringify(state.feedback)}` : ''}`;
}
async function renderStage(config, state, bridge, deps, stageId, shotIds, options) {
    const snapshot = await assertStageIdentity(state, bridge);
    if ((state.previewJobs || 0) >= state.workflow.execution.maxPreviewJobs) throw appError('REPRO_BUDGET_EXHAUSTED', '阶段预览次数已用尽。');
    const timeoutMs = Math.min(Number(options.timeoutMs) || 300000, makerTimeout(state, options));
    if (timeoutMs < 1000) throw appError('REPRO_BUDGET_EXHAUSTED', '阶段预览预算不足。');
    return stageOperation(config, state, bridge, { stageId, kind: 'stage-preview', amount: { renderCalls: 1, elapsedMs: timeoutMs } }, async id => {
        state.status = 'rendering'; await bridge.save(config, state);
        const started = Date.now();
        let receipt;
        try {
            const record = await controlledMedia(config, state, bridge, deps, mediaDeps => (deps.previewStage || previewStage)(config, { workspace: state.workspace, spec: state.spec, references: state.references, stageId,
                shots: state.shotPlan.shots, shotIds, evidenceRoot: stageRoot(config, state, stageId, id), protocolHash: state.executionProtocolHash,
                inputsHash: state.inputsHash, assetLockHash: state.methodAssembly.assetLockHash, sourceSnapshot: snapshot, timeoutMs, signal: mediaDeps.signal, includeAudio: stageId === 'integration' }, mediaDeps));
            receipt = record;
            if (record.status !== 'completed' || record.checks?.some(c => !c.passed)) throw notReady('阶段预览未生成有效证据。');
            stageRecord(state, stageId).pendingPreview = record;
            return record;
        } catch (error) { receipt = error.data?.preview; stageRecord(state, stageId).previewFailure = receipt || { error: error.message }; throw error; } finally { chargeMedia(state, receipt); state.budget.elapsedMs += Date.now() - started; }
    });
}
async function selfCheck(config, state, bridge, deps, stageId, record, shotIds, options) {
    const view = await exposeEvidence(state, record);
    const reportFile = `.work/stage-reports/${stageId}-${randomUUID()}.json`;
    const criteria = checkIds(state, stageId);
    const specimen = { schema: 'video-remake.stage-self-check@1', stageId, sourceTreeHash: record.sourceTreeHash, planHash: state.planHash, shotIds,
        checks: shotIds.flatMap(shotId => criteria.map(id => ({ id, shotId, status: 'pass|fail|unobserved', observationStatus: 'observed|unobserved', evidenceIds: ['actual supplied IDs'], notes: '具体观察及问题；不能凭文件存在声称已看过' }))), unresolved: [] };
    const instruction = commonInstruction(state) + `\n${options.reportError ? `上次自检报告结构不合规：${options.reportError}。重新观察并提交有效报告；不能为取得通过而改变实际观察。` : ''}\n当前是${stageId}的只读自检。读取.agents/skills/validate/SKILL.md及${view.relative}，实际打开原片/候选配对图像和运动阶段；integration也检查音频与字幕。只允许写${reportFile}，不要改源码、镜头计划、制作说明或资产。问题存在时填fail并说明，等待单独修复调用。逐镜头覆盖所有检查ID。framing/action/captions各引用本镜头至少一对同一requestedTimeSec的subject与reference帧；motion必须引用本镜头前、中、后三个阶段的配对帧，至少6个ID，实际seek要对齐且不可用fallback替代；sound引用一对PCM音频ID。报告严格JSON格式：${JSON.stringify(specimen)}。sourceTreeHash与planHash直接使用给定值；它们绑定宿主记录，不是你做质量认证。`;
    await executeMaker(config, state, bridge, deps, stageId, instruction, options, { selfCheck: true, shotIds, reportFile });
    for (const item of view.view.items) if (await fileHash(await safeProjectFile(state.workspace, item.file)) !== item.sha256) throw invalid('执行者修改了观察证据副本。');
    await (deps.validateStageEvidence || validateStageEvidence)(record, { workspace: state.workspace, spec: state.spec, protocolHash: state.executionProtocolHash });
    const check = validateSelfCheck(await readJson(state.workspace, reportFile), { stageId, shotIds, evidenceIds: record.items.map(item => item.id), sourceTreeHash: record.sourceTreeHash, planHash: state.planHash, requiredCheckIds: criteria, evidenceItems: record.items, shots: state.shotPlan.shots });
    for (const item of check.checks.filter(item => item.observationStatus === 'observed')) {
        const cited = record.items.filter(e => item.evidenceIds.includes(e.id));
        if (!cited.some(e => e.sourceId === 'subject') || !cited.some(e => e.sourceId !== 'subject')) throw invalid('已观察的自检必须引用原片和候选的配对证据。');
    }
    const execution = state.stageExecutions.at(-1);
    let observationAccess = 'unverified';
    if (execution.agent?.runDir) {
        try { const text = await fs.readFile(path.join(execution.agent.runDir, 'runtime', 'events.jsonl'), 'utf8');
            if (/read_image|view_image|image_url|emitImage/.test(text) && text.includes('stage-evidence')) observationAccess = 'recorded-tool-access';
        } catch { /* Unknown access never becomes independent visual approval. */ }
    }
    return { ...check, observationAccess, qualityStatus: 'self-reported-only' };
}
async function produceStage(config, state, bridge, deps, stageId, options, { repair = false, renderOnly = false } = {}) {
    const stage = stageRecord(state, stageId);
    if (!state.shotPlan) throw notReady('先完成参考分析。');
    const allShots = state.shotPlan.shots.map(s => s.id);
    let shotIds = stageId === 'prototypes' ? state.prototypeShotIds : allShots;
    if (options.shot) {
        if (!shotIds.includes(options.shot)) throw invalid('镜头不在当前阶段范围内。');
        shotIds = [options.shot];
    }
    if (stage.pendingPreview) {
        const pendingIds = stage.pendingPreview.scope?.ranges?.map(s => s.id) || stage.pendingPreview.scope?.shotIds;
        if (!pendingIds?.length || pendingIds.some(id => !shotIds.includes(id))) throw notReady('待自检证据的镜头范围不匹配；先按原范围完成自检。');
        shotIds = pendingIds;
    }
    const produced = new Set(stage.producedShotIds || []);
    const missing = shotIds.filter(id => !produced.has(id));
    if (!repair && !options.shot && !stage.pendingPreview && produced.size && missing.length) shotIds = missing;
    const recheck = stage.status === 'stale' && !missing.length || stage.status === 'blocked' && Boolean(stage.implementationExecutionId);
    if (!recheck && !stage.pendingPreview && !renderOnly) {
        assertMakerBudget(state, options);
        stage.shotRevisions ||= {};
        if (shotIds.some(id => (stage.shotRevisions[id] || 0) >= 1 + state.workflow.execution.maxStageRevisions)) throw appError('REPRO_STAGE_LIMIT', '本次镜头的制作修订次数已用尽。');
        for (const id of shotIds) stage.shotRevisions[id] = (stage.shotRevisions[id] || 0) + 1;
        stage.revision = (stage.revision || 0) + 1;
        stage.status = 'running';
        const instruction = commonInstruction(state) + `\n当前阶段${stageId}，本次范围${JSON.stringify(shotIds)}。${repair ? '依据失败记录修复自己的实现。' : '实现本阶段所需的场景、动作、镜头。'}本阶段不得修改planning/镜头计划；若计划有误，保留问题报告并要求单独修订analysis，不自行改变切点、镜头区间或计划内容。本次先提交实现，不提交宿主证据自检。保持完整根时间线为${state.spec.acceptance.media.durationSec}秒，以便按原片绝对时间取样。${stageId === 'integration' ? '整合全片、字幕、声音和转场，完成必需制作记录后将reproduction.json设为ready。' : '只完成指定镜头；不要因其他未制作区间空白而改任务时长。'}如没有node_modules，运行npm ci和npm run doctor，禁止升级。最终渲染由宿主完成，你可先自行预览，但不能用参考画面作输出。镜头计划：${JSON.stringify(state.shotPlan)}${stage.selfCheck ? `\n上次自检：${JSON.stringify(stage.selfCheck)}` : ''}`;
        await executeMaker(config, state, bridge, deps, stageId, instruction, options, { shotIds });
        stage.implementationExecutionId = state.stageExecutions.at(-1).id;
        stage.producedShotIds = [...new Set([...(stage.producedShotIds || []), ...shotIds])];
        const plan = await readPlan(state);
        if (shotPlanHash(plan) !== state.planHash) throw invalid('制作阶段改变了镜头计划；需显式修订分析并重查下游。');
    }
    stage.shotIds = shotIds;
    const record = stage.pendingPreview || await renderStage(config, state, bridge, deps, stageId, shotIds, options);
    if (renderOnly) { stage.status = 'awaiting-self-check'; state.status = 'prepared'; return; }
    let check;
    for (let retry = 0; retry < 2; retry++) {
        try { check = await selfCheck(config, state, bridge, deps, stageId, record, shotIds, options); break; }
        catch (error) {
            stage.invalidSelfChecks ||= []; stage.invalidSelfChecks.push({ executionId: state.stageExecutions.at(-1)?.id, error: { code: error.code, message: error.message }, at: now() });
            if (error.code !== 'REPRO_STAGE_INVALID' || retry || (await sourceSnapshot(state.workspace)).treeHash !== record.sourceTreeHash) throw error;
            options = { ...options, reportError: error.message };
        }
    }
    const clean = check.unresolved.length === 0 && check.checks.every(c => c.status === 'pass');
    const id = `ss_${randomUUID()}`;
    const submission = { id, episodeId: state.stageState.currentEpisodeId, stageId, kind: 'stage-preview', revision: stage.revision,
        shotIds, sourceTreeHash: record.sourceTreeHash, planHash: state.planHash, evidenceRoot: record.evidenceRoot,
        evidenceManifestSha256: record.evidenceManifestSha256, items: record.items, preview: record, hostChecks: record.checks,
        selfCheck: check, qualityStatus: 'not-independently-evaluated', status: clean ? 'evidence-complete' : 'needs-revision', createdAt: now() };
    state.stageSubmissions.push(submission); state.stageState.revision++;
    stage.submissions ||= []; stage.submissions.push(id); stage.selfCheck = check; stage.hostChecks = record.checks;
    stage.sourceTreeHash = record.sourceTreeHash; stage.planHash = state.planHash; stage.completedAt = now(); delete stage.pendingPreview;
    // A partial shot scope does not complete the entire shots stage.
    const covered = new Set(state.stageSubmissions.filter(s => s.episodeId === state.stageState.currentEpisodeId && s.stageId === stageId && s.status === 'evidence-complete' && s.sourceTreeHash === record.sourceTreeHash && s.planHash === state.planHash).flatMap(s => s.shotIds));
    const required = stageId === 'prototypes' ? state.prototypeShotIds : allShots;
    stage.status = clean && required.every(id => covered.has(id)) ? 'evidence-complete' : clean ? 'stale' : 'needs-revision';
    state.status = clean ? 'prepared' : 'needs-revision';
}

async function validateCompletedStages(state, deps) {
    const snapshot = await sourceSnapshot(state.workspace);
    if (shotPlanHash(await readPlan(state)) !== state.planHash) throw invalid('镜头计划与已登记版本不一致。');
    for (const id of sourceStages) {
        const stage = stageRecord(state, id);
        if (!done(stage) || stage.sourceTreeHash !== snapshot.treeHash || stage.planHash !== state.planHash) throw notReady(`${id} 阶段证据已过期或未完成。`);
        const records = state.stageSubmissions.filter(s => s.episodeId === state.stageState.currentEpisodeId && s.stageId === id && s.status === 'evidence-complete' && s.sourceTreeHash === snapshot.treeHash && s.planHash === state.planHash);
        const required = id === 'prototypes' ? state.prototypeShotIds : state.shotPlan.shots.map(s => s.id);
        if (!required.every(shotId => records.some(record => record.shotIds.includes(shotId)))) throw notReady(`${id} 缺少完整镜头证据。`);
        for (const record of records) await (deps.validateStageEvidence || validateStageEvidence)(record.preview, { workspace: state.workspace, spec: state.spec, protocolHash: state.executionProtocolHash });
    }
}
function syncFinal(state) {
    state.finalSubmissions = state.attempts.map(attempt => ({ id: attempt.id || `final-${attempt.number}`, number: attempt.number, episodeId: attempt.episodeId,
        executionCompleted: attempt.executionCompleted, technical: attempt.technical, review: attempt.review, sourceTreeHash: attempt.sourceSnapshot?.treeHash,
        artifact: attempt.artifact, reviewSource: attempt.reviewSource, status: attempt.review?.passed ? 'passed' : attempt.review ? 'needs-revision' : 'submitted' }));
}
async function submit(config, state, bridge, deps, options) {
    await assertStageIdentity(state, bridge); await validateCompletedStages(state, deps);
    const stage = stageRecord(state, 'submission');
    const source = await snapshotProject(state.workspace);
    let attempt = state.attempts.find(item => item.id === stage.submissionAttemptId && item.episodeId === state.stageState.currentEpisodeId && item.sourceSnapshot?.treeHash === source.treeHash);
    if (!attempt && state.attempts.length >= Math.min(state.spec.maxAttempts, state.workflow.execution.maxFinalSubmissions)) throw appError('REPRO_BUDGET_EXHAUSTED', '正式成片提交次数已用尽。');
    const overhead = state.workflow.execution.reserveOverheadMs;
    await stageOperation(config, state, bridge, { stageId: 'submission', kind: 'final-render', amount: { renderCalls: 1, elapsedMs: overhead },
        holdback: finalReviewReserve(state.workflow, { includeRender: false, includeEvidence: false }) }, async () => {
        if (!attempt) {
            attempt = { id: `final_${randomUUID()}`, number: state.attempts.length + 1, episodeId: state.stageState.currentEpisodeId, mode: 'staged-submission', startedAt: now(),
                frozenInputs: state.frozenStageInputs, agents: state.stageExecutions.filter(e => e.episodeId === state.stageState.currentEpisodeId && e.agent?.status === 'completed').map(e => e.agent),
                executionCompleted: true, sourceSnapshot: source, generation: state.generation };
            state.attempts.push(attempt); stage.submissionAttemptId = attempt.id;
        }
        delete state.review; delete state.reviewSource; delete state.technical;
        await bridge.save(config, state);
        const deadlineAt = Date.now() + Math.max(1, overhead - 1000);
        await bridge.managedRender(config, state, { ...options, timeoutMs: Math.max(1, deadlineAt - Date.now()) }, deps);
        const checkStart = Date.now();
        try { await bridge.check(config, state, { ...deps, deadlineAt }, { evidence: true }); } finally { state.budget.elapsedMs += Date.now() - checkStart; }
    });
    attempt.artifact = state.technical?.artifact; attempt.finishedAt = now();
    attempt.archivedProject = path.join(storage(config), 'runs', state.id, `final-${attempt.number}`, 'project');
    if (!attempt.archivedAt) { await copyProject(state.workspace, attempt.archivedProject, { includeInputs: true, includeOutputs: true }); attempt.archivedAt = now(); }
    syncFinal(state);
    if (!state.technical?.passed) { stage.status = 'needs-revision'; throw notReady('完整成片技术或来源检查失败。'); }
    stageRecord(state, 'submission').status = 'evidence-complete';
    stageRecord(state, 'submission').hostChecks = state.technical.checks;
    stageRecord(state, 'review').status = 'pending';
    state.stageState.currentStage = 'review'; state.status = 'external-review';
}

export async function executeStaged(config, state, action, options, deps, bridge) {
    if (!state.stageState) throw invalid('缺少阶段状态。');
    if (options.stage && !STAGE_IDS.includes(options.stage)) throw invalid('未知阶段。');
    if (options.until && !STAGE_IDS.includes(options.until)) throw invalid('未知停止阶段。');
    if (options.stage && ['run','render','resume'].includes(action)) {
        const next = state.stageState.stages.find(item => !done(item));
        if (next?.id !== options.stage) throw notReady(`下一合法阶段为${next?.id}，不能跳到${options.stage}。`);
    }
    if (action === 'render') {
        const selected = stageRecord(state, options.stage || state.stageState.currentStage);
        if (sourceStages.includes(selected?.id) && !selected.implementationExecutionId && !selected.pendingPreview && selected.status !== 'stale') throw notReady('先由制作模型完成本阶段实现。');
    }
    if (action === 'judge' && !done(stageRecord(state, 'submission'))) throw notReady('完整提交检查未完成，不能跳到双评审。');
    if (state.activeOperation) throw appError('REPRO_BUSY', '当前阶段仍有活动操作；异常退出请先恢复。');
    if (state.status === 'passed' && !['check','judge'].includes(action)) throw notReady('已经验收通过；修改需要新的运行。');
    try {
        if (action === 'retry') await bridge.assertReferences(state);
        else await assertStageIdentity(state, bridge);
        if (action === 'judge') {
            if (!done(stageRecord(state, 'submission'))) throw notReady('完整提交检查未完成，不能跳到双评审。');
            await validateCompletedStages(state, deps);
            const result = await bridge.review(config, state, { ...options, timeoutMs: options.timeoutMs || state.workflow.execution.reviewerTimeoutMs }, deps, true);
            const attempt = state.attempts.at(-1); attempt.reviewSource = state.reviewSource;
            stageRecord(state, 'review').status = state.status === 'passed' ? 'complete' : 'needs-revision';
            stageRecord(state, 'review').qualityStatus = state.status;
            syncFinal(state); await bridge.save(config, state); return result;
        }
        if (action === 'check') {
            if (options.stage === 'analysis' || (!options.stage && state.stageState.currentStage === 'analysis')) await readPlan(state);
            else if (state.stageState.currentStage === 'review' || options.stage === 'submission') { await validateCompletedStages(state, deps); await bridge.check(config, state, deps, { evidence: !!options.evidence }); }
            else {
                const stage = stageRecord(state, options.stage || state.stageState.currentStage);
                const record = stage.pendingPreview || state.stageSubmissions.findLast(s => s.stageId === stage.id && s.status === 'evidence-complete')?.preview;
                if (!record) throw notReady('此阶段没有已登记预览；先运行阶段。');
                await (deps.validateStageEvidence || validateStageEvidence)(record, { workspace: state.workspace, spec: state.spec, protocolHash: state.executionProtocolHash });
            }
            return { command: 'repro:check', run: bridge.summarizeRun(state) };
        }
        if (action === 'retry') { await retryEpisode(config, state, bridge); if (options.step) return { command: 'repro:retry', run: bridge.summarizeRun(state) }; }
        if (action === 'resume' && !state.stageCheckpoint?.interrupted) throw notReady('没有可恢复的阶段检查点。');
        if (action === 'repair') {
            const target = options.stage || (state.stageState.currentStage === 'review' || state.stageState.currentStage === 'submission' ? 'integration' : state.stageState.currentStage);
            if (!['analysis', ...sourceStages].includes(target)) throw notReady('此阶段不能由制作模型修复。');
            const targetIndex = STAGE_IDS.indexOf(target);
            if (state.stageState.stages.some(s => STAGE_IDS.indexOf(s.id) < targetIndex && !done(s) && s.status !== 'stale')) throw notReady('前置阶段尚未完成，不能跳跃修复。');
            state.feedback = repairFeedback(state, target);
            state.repairHistory ||= []; state.repairHistory.push(state.feedback);
            const selected = stageRecord(state, target); selected.status = 'needs-revision'; delete selected.pendingPreview; delete selected.implementationExecutionId;
            state.stageState.currentStage = target;
            if (target === 'analysis') await analyse(config, state, bridge, deps, options);
            else await produceStage(config, state, bridge, deps, target, options, { repair: true });
            if (!done(selected) || options.step || options.stage || options.shot || options.until === target) { await bridge.save(config, state); return { command: 'repro:repair', run: bridge.summarizeRun(state) }; }
        }
        let count = 0;
        while (++count < 40) {
            if (deps.signal?.aborted) throw appError('REPRO_CANCELLED', '阶段已取消。');
            const stage = nextStage(state);
            if (!stage || stage.id === 'review') break;
            if (options.stage && stage.id !== options.stage) throw notReady(`下一合法阶段为${stage.id}，不能跳到${options.stage}。`);
            if (stage.status === 'needs-revision' && action !== 'resume' && !(action === 'render' && stage.id === 'submission')) throw notReady('当前阶段需要修复；使用 repair。');
            if (stage.id === 'analysis') await analyse(config, state, bridge, deps, options);
            else if (sourceStages.includes(stage.id)) await produceStage(config, state, bridge, deps, stage.id, options, { renderOnly: action === 'render' });
            else if (stage.id === 'submission') await submit(config, state, bridge, deps, options);
            if (stage.status === 'needs-revision') { state.status = 'needs-revision'; break; }
            await bridge.save(config, state);
            if (options.step || options.stage || options.shot || action === 'render' || options.until === stage.id) { nextStage(state); break; }
        }
        if (count >= 40) throw appError('REPRO_STAGE_LIMIT', '阶段重查次数达到运行保护上限。');
        if (state.stageState.currentStage !== 'review' && state.status !== 'needs-revision') state.status = 'prepared';
        await bridge.save(config, state);
        return { command: `repro:${action}`, run: bridge.summarizeRun(state) };
    } catch (error) {
        const stage = stageRecord(state, state.stageState.currentStage);
        stage.error = { code: error.code || 'FAILED', message: error.message };
        if (/BUDGET/.test(error.code || '')) state.status = 'budget-exhausted';
        else if (/CANCEL|TIMEOUT|TIMED_OUT/.test(error.code || '')) {
            state.status = /CANCEL/.test(error.code) ? 'cancelled' : 'interrupted';
            if (state.stageCheckpoint && (await sourceSnapshot(state.workspace)).treeHash === state.stageCheckpoint.snapshot.treeHash) state.stageCheckpoint.interrupted = true;
        }
        else { state.status = 'needs-revision'; if (stage.id === 'submission') stage.status = 'needs-revision'; if (!['submission','review'].includes(stage.id)) stage.status = /REPRO_(RENDER|STAGE_MEDIA|STAGE_PREVIEW)/.test(error.code || '') ? 'blocked' : 'needs-revision'; }
        await bridge.save(config, state);
        throw appError(error.code || 'REPRO_STAGE_FAILED', error.message, { data: { run: bridge.summarizeRun(state) } });
    }
}

function assertMakerBudget(state, options) {
    reserveBudget(structuredClone(state.budgetLedger), { operationId: `probe_${randomUUID()}`, kind: 'preflight', policy: state.workflow.policy, used: state.budget,
        amount: { calls: 1, elapsedMs: makerTimeout(state, options) }, holdback: finalReviewReserve(state.workflow) });
}
function chargeMedia(state, receipt) {
    if (!receipt) { state.budget.toolCallsComplete = false; state.budget.renderCallsComplete = false; return; }
    state.previewJobs = (state.previewJobs || 0) + (receipt.previewJobs || 0);
    state.budget.renderCalls += receipt.renderCalls || 0;
    if (Number.isFinite(receipt.hostToolCalls)) state.budget.toolCalls += receipt.hostToolCalls;
    else state.budget.toolCallsComplete = false;
}
async function controlledMedia(config, state, bridge, deps, work) {
    const controller = new AbortController();
    const cancellation = path.join(storage(config), 'stage-cancellations', `${state.activeOperation.id}.json`);
    const abort = () => controller.abort();
    deps.signal?.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    if (deps.signal?.aborted) abort();
    const poll = setInterval(() => { fs.access(cancellation).then(abort).catch(error => { if (error.code !== 'ENOENT') abort(); }); }, 250);
    poll.unref?.();
    try { return await work({ ...deps, signal: controller.signal, onStart: async info => { state.activeOperation.process = info; await bridge.save(config, state); } }); }
    finally { clearInterval(poll); deps.signal?.removeEventListener('abort', abort); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); await fs.rm(cancellation, { force: true }); }
}
async function retryEpisode(config, state, bridge) {
    assertMakerBudget(state, {});
    if (!state.method) throw notReady('空工程重试当前仅支持方法生成运行；教师制作请创建新的任务。');
    const previous = state.episodes.at(-1);
    const prepared = `${state.workspace}.blank-${randomUUID()}`;
    const archive = path.join(storage(config), 'runs', state.id, 'episodes', previous.id, 'project');
    const assembled = await bridge.instantiateMethodRecipe(config, state.method.id, prepared, { spec: state.spec, name: state.production, applyMethod: state.methodApplied !== false });
    if (assembled.scaffoldHash !== state.baseScaffoldHash) throw notReady('空工程基础版本已改变；不能混入本次实验。');
    const overlay = await installStageOverlay(prepared, { protocol: STAGE_PROTOCOL.id, execution: state.workflow.execution, methodApplied: state.methodApplied !== false });
    if (overlay.overlayHash !== state.executionOverlayHash) throw notReady('阶段工具版本已改变；不能混入本次实验。');
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.rename(state.workspace, archive);
    try { await fs.rename(prepared, state.workspace); } catch (error) { await fs.rename(archive, state.workspace); throw error; }
    previous.finishedAt = now(); previous.status = state.status; previous.archivedProject = archive;
    previous.stageState = state.stageState; previous.shotPlan = state.shotPlan; previous.lastCheckpoint = state.stageCheckpoint;
    state.methodAssembly = { lockedFiles: assembled.lockedFiles, assetLockHash: assembled.assetLockHash };
    for (const key of ['generationAudit','stageReference','shotPlan','planHash','prototypeShotIds','feedback','technical','review','reviewSource','reviewSession','stageCheckpoint']) delete state[key];
    await initializeStagedRun(config, state, bridge);
}

export async function checkerProfileFingerprint(finalProtocolHash) {
    const files = {};
    for (const file of ['stages.js','stage-evidence.js','evaluate.js','schema.js','generation-audit.js']) files[file] = jsonHash(await fs.readFile(new URL(file, import.meta.url), 'utf8'));
    return jsonHash({ files, finalProtocolHash });
}

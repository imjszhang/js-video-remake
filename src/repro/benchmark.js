import fs from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../errors.js';
import { safeFile, jsonHash } from './store.js';
import { generationQualification } from './generation-audit.js';
import { validateReview } from './judge.js';

const ARMS = ['baseline', 'template', 'withoutSkills'];
const COMPARISON_TYPES = ['method-presence', 'method-version', 'workflow-ablation'];
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function agentsOf(run) {
    const agents = [...(run.attempts || []).flatMap(attempt => attempt.agents || []), ...(run.reviewRuns || []),
        ...(run.extractionRuns || []), ...(run.agentRuns || []),
        ...(run.stageExecutions || []).flatMap(execution => execution.agent ? [execution.agent] : execution.agents || [])];
    return [...new Map(agents.map((agent, index) => [agent.runId || agent.id || `unknown-${index}`, agent])).values()];
}
function usd(agent) {
    if (finite(agent.costUsd)) return agent.costUsd;
    if (finite(agent.cost?.usd)) return agent.cost.usd;
    if (agent.cost?.currency === 'USD' && finite(agent.cost.total)) return agent.cost.total;
    return null;
}
function accounting(run) {
    const agents = agentsOf(run);
    const knownCosts = agents.map(usd).filter(value => value !== null);
    const knownUsage = agents.map(agent => agent.usage?.totalTokens).filter(finite);
    const budget = run.budget || {};
    const calls = finite(budget.calls) ? budget.calls : agents.length;
    const missingCalls = Math.max(0, calls - agents.length);
    const costComplete = typeof budget.costComplete === 'boolean' ? budget.costComplete : agents.length > 0 && !missingCalls && knownCosts.length === agents.length && !(run.extractions?.length && !run.agentRuns?.length && !run.extractionRuns?.length);
    const usageComplete = typeof budget.usageComplete === 'boolean' ? budget.usageComplete : agents.length > 0 && !missingCalls && knownUsage.length === agents.length;
    const observedCostUsd = finite(budget.costUsd) ? budget.costUsd : knownCosts.reduce((sum, value) => sum + value, 0);
    const observedTokens = finite(budget.tokens) ? budget.tokens : knownUsage.reduce((sum, value) => sum + value, 0);
    const measured = (field, flag, valid = agent => finite(agent[field])) => {
        const known = agents.filter(valid);
        const complete = typeof budget[flag] === 'boolean' ? budget[flag] : agents.length > 0 && !missingCalls && known.length === agents.length;
        const observed = finite(budget[field]) ? budget[field] : agents.reduce((sum, agent) => sum + (finite(agent[field]) ? agent[field] : 0), 0);
        return { observed, value: complete ? observed : null, complete,
            unknownCalls: Math.max(agents.length - known.length + missingCalls, complete ? 0 : 1) };
    };
    const elapsed = measured('elapsedMs', 'elapsedComplete', agent => finite(agent.elapsedMs) && agent.elapsedComplete !== false && agent.status !== 'interrupted');
    const tools = measured('toolCalls', 'toolCallsComplete', agent => finite(agent.toolCalls) && agent.toolCallsComplete !== false);
    const renders = measured('renderCalls', 'renderCallsComplete', agent => finite(agent.renderCalls) && agent.renderCallsComplete !== false && !agent.observability?.renderCalls?.startsWith('unobservable-'));
    return { calls, elapsedMs: elapsed.value, observedElapsedMs: elapsed.observed, elapsedComplete: elapsed.complete, unknownElapsedCalls: elapsed.unknownCalls,
        toolCalls: tools.value, observedToolCalls: tools.observed, toolCallsComplete: tools.complete, unknownToolCalls: tools.unknownCalls,
        renderCalls: renders.value, observedRenderCalls: renders.observed, renderCallsComplete: renders.complete, unknownRenderCalls: renders.unknownCalls,
        observedCostUsd, costUsd: costComplete ? observedCostUsd : null, costComplete,
        observedTokens, tokens: usageComplete ? observedTokens : null, usageComplete,
        unknownCostCalls: Math.max(agents.filter(agent => usd(agent) === null).length + missingCalls, costComplete ? 0 : 1),
        unknownUsageCalls: Math.max(agents.filter(agent => !finite(agent.usage?.totalTokens)).length + missingCalls, usageComplete ? 0 : 1),
    };
}
function reviewed(run) {
    const quality = ['passed', 'published'].includes(run.status) && run.technical?.passed === true && Array.isArray(run.review?.checks)
        && run.review.checks.length > 0 && run.review.checks.every(check => check.status === 'pass');
    if (!quality || generationQualification(run).mode !== 'method-generation') return quality;
    const source = run.reviewSource;
    if (source?.kind !== 'model' || source.samples !== 2 || source.votes?.length !== 2
        || new Set(source.votes.map(vote => vote.runId).filter(Boolean)).size !== 2) return false;
    try {
        return validateReview(run.review, run.spec, run.technical.artifact?.sha256, run.technical).passed
            && source.votes.every(vote => validateReview(vote.review, run.spec, run.technical.artifact?.sha256, run.technical).passed);
    } catch { return false; }
}
function attemptPassed(attempt, last, run) {
    if (attempt.review?.passed !== undefined) return attempt.executionCompleted === true && attempt.technical?.passed === true && attempt.review.passed === true;
    if (attempt.review?.checks) return attempt.executionCompleted === true && attempt.technical?.passed === true && attempt.review.checks.every(check => check.status === 'pass');
    if (last) return reviewed(run);
    return null;
}
function runMetrics(run) {
    const attempts = run.finalSubmissions || run.attempts || [];
    const passes = attempts.map((attempt, index) => attemptPassed(attempt, index === attempts.length - 1, run));
    const success = reviewed(run);
    const qualification = generationQualification(run);
    const assisted = qualification.assisted;
    return { runId: run.id, production: run.production, kind: run.kind, status: run.status, template: run.template?.id ?? null, method: run.method?.id ?? null,
        generationMode: qualification.mode, methodApplied: run.methodApplied ?? null, independenceLevel: qualification.level,
        success, unassistedSuccess: success && !assisted, processGenerationSuccess: success && qualification.processVerified,
        independentSuccess: success && qualification.strictIndependent, assisted,
        attempts: attempts.length, retries: Math.max(0, attempts.length - 1), firstPass: passes.length ? passes[0] : false,
        successfulAttempts: passes.filter(value => value === true).length, unobservedAttempts: passes.filter(value => value === null).length,
        accounting: accounting(run),
        stageExecutions: run.stageExecutions?.length ?? null,
        stageSubmissions: run.stageSubmissions?.length ?? null,
        finalSubmissions: run.finalSubmissions?.length ?? null,
        currentStage: run.stageState?.currentStage ?? null,
        staleStages: (Array.isArray(run.stageState?.stages) ? run.stageState.stages : []).filter(stage => stage.status === 'stale' || stage.stale === true).map(stage => stage.id),
        attemptResults: attempts.map((attempt, index) => ({ number: attempt.number ?? index + 1, passed: passes[index],
            executionCompleted: attempt.executionCompleted === true, error: attempt.error ?? null,
            resumptions: attempt.resumptions || 0, agents: (attempt.agents || []).map(agent => ({ runId: agent.runId || agent.id, status: agent.status,
                requestedModel: agent.requestedModel ?? agent.model ?? null, observedModel: agent.observedModel ?? agent.responseModel ?? null,
                harness: agent.harness ?? null, elapsedMs: agent.elapsedMs ?? null, usage: agent.usage ?? null, cost: agent.cost ?? null,
            })),
        })),
    };
}

function comparisonIdentity(run) {
    const makerAgents = [...new Map([...(run.attempts || []).flatMap(attempt => attempt.agents || []),
        ...(run.agentRuns || []).filter(agent => ['executor', 'teacher'].includes(agent.role)),
        ...(run.stageExecutions || []).flatMap(execution => execution.agent ? [execution.agent] : execution.agents || [])].map(agent => [agent.runId || agent.id, agent])).values()];
    const targetHashes = [...new Set([run.targetHash, ...makerAgents.map(agent => agent.targetHash)].filter(Boolean))];
    const contextModes = [...new Set(makerAgents.map(agent => agent.contextMode).filter(Boolean))];
    const versions = [...new Set(makerAgents.map(agent => stable(agent.toolVersions ?? null)))];
    const requestedModels = [...new Set(makerAgents.map(agent => agent.requestedModel ?? agent.model).filter(Boolean))];
    const observedModels = [...new Set(makerAgents.map(agent => agent.observedModel ?? agent.responseModel).filter(Boolean))];
    return { specHash: run.specHash ?? null, inputsHash: run.inputsHash ?? null,
        references: jsonHash((run.references || []).map(reference => ({ id: reference.id, sha256: reference.source?.sha256 ?? reference.sha256 ?? null })).sort((a, b) => String(a.id).localeCompare(String(b.id)))),
        targetHash: targetHashes.length === 1 ? targetHashes[0] : null, targetChanged: targetHashes.length > 1,
        contextMode: contextModes.length === 1 ? contextModes[0] : null, contextChanged: contextModes.length > 1,
        toolVersions: versions.length === 1 ? versions[0] : null,
        requestedModel: requestedModels.length === 1 ? requestedModels[0] : null,
        observedModel: observedModels.length === 1 ? observedModels[0] : null,
        modelChanged: requestedModels.length > 1 || observedModels.length > 1,
        policy: run.workflow?.policy ?? run.policy ?? null,
        generationMode: generationQualification(run).mode,
        generationIdentity: run.generation?.identity ?? null,
        startingPoint: run.generation?.startingPoint ?? null,
        isolationLevel: run.generation?.isolation?.level ?? null,
        protocolVersion: run.reviewSource?.protocol ?? run.reviewSource?.protocolVersion ?? run.review?.protocolVersion ?? null,
        protocolImplementationHash: run.reviewSource?.implementationHash ?? run.workflow?.policy?.reviewProtocolHash ?? null,
        reviewer: run.reviewSource ? { kind: run.reviewSource.kind, requestedModel: run.reviewSource.requestedModel ?? null, observedModel: run.reviewSource.observedModel ?? null,
            harness: run.reviewSource.harness ?? null, samples: run.reviewSource.samples ?? null,
            targets: [...new Set((run.reviewRuns || []).map(agent => agent.targetHash).filter(Boolean))].sort() } : null,
        staged: run.schema === 'video-remake.reproduction-run@3' || Boolean(run.stageState),
        executionProtocolHash: run.executionProtocolHash ?? run.stageState?.protocol?.hash ?? null,
        stagePolicyHash: run.stagePolicyHash ?? run.stageState?.protocol?.stagePolicyHash ?? null,
        feedbackMode: run.feedbackMode ?? run.workflow?.execution?.feedbackMode ?? null,
        checkerProfileHash: run.checkerProfileHash ?? run.stageState?.protocol?.checkerProfileHash ?? null,
        budgetPolicyHash: run.budgetPolicyHash ?? run.stageState?.protocol?.budgetPolicyHash ?? null,
        baseScaffoldHash: run.baseScaffoldHash ?? run.generation?.identity?.baseScaffoldHash ?? null,
        executionOverlayHash: run.executionOverlayHash ?? run.generation?.identity?.executionOverlayHash ?? null,
    };
}

function comparable(first, second, comparisonType = 'method-presence') {
    const a = comparisonIdentity(first), b = comparisonIdentity(second), reasons = [];
    const workflowAblation = comparisonType === 'workflow-ablation';
    for (const key of ['specHash', 'inputsHash', 'targetHash', 'contextMode', 'policy']) {
        if (!a[key] || !b[key]) reasons.push(`Missing ${key} evidence.`);
        else if (stable(a[key]) !== stable(b[key])) reasons.push(`Different ${key}.`);
    }
    if (a.generationMode === 'method-generation' || b.generationMode === 'method-generation') {
        if (a.generationMode !== b.generationMode) reasons.push('Different generation modes; replay cannot benchmark independent generation.');
        for (const key of ['assetLockHash', ...(workflowAblation ? [] : ['scaffoldHash']), 'toolProfileHash']) {
            const av = a.generationIdentity?.[key], bv = b.generationIdentity?.[key];
            if (!av || !bv) reasons.push(`Missing generation ${key} evidence.`);
            else if (av !== bv) reasons.push(`Different generation ${key}.`);
        }
        if (a.startingPoint !== 'blank-scaffold' || b.startingPoint !== 'blank-scaffold') reasons.push('Generation comparison requires two blank scaffolds.');
        if (a.isolationLevel !== b.isolationLevel) reasons.push('Different execution isolation levels.');
        if (!a.protocolVersion || a.protocolVersion !== b.protocolVersion) reasons.push('Different or missing review protocol versions.');
        if (!a.protocolImplementationHash || a.protocolImplementationHash !== b.protocolImplementationHash) reasons.push('Different or missing review protocol implementation hashes.');
        if (!a.reviewer || !b.reviewer || stable(a.reviewer) !== stable(b.reviewer)) reasons.push('Different or missing reviewer configurations.');
    }
    if (a.staged || b.staged || workflowAblation) {
        for (const key of ['executionProtocolHash', 'stagePolicyHash', 'feedbackMode', 'checkerProfileHash', 'budgetPolicyHash']) {
            if (!a[key] || !b[key]) reasons.push(`Missing ${key} evidence.`);
            else if (!(workflowAblation && ['executionProtocolHash', 'stagePolicyHash'].includes(key)) && a[key] !== b[key]) reasons.push(`Different ${key}.`);
        }
        if (workflowAblation) {
            if (!a.baseScaffoldHash || !b.baseScaffoldHash || a.baseScaffoldHash !== b.baseScaffoldHash) reasons.push('Workflow ablation requires the same recorded base scaffold.');
            if (!a.executionOverlayHash || !b.executionOverlayHash) reasons.push('Workflow ablation requires recorded execution overlays.');
            if (a.executionProtocolHash && a.executionProtocolHash === b.executionProtocolHash) reasons.push('Workflow ablation requires different execution protocols.');
        }
    }
    if (a.references !== b.references) reasons.push('Different reference media.');
    if (a.targetChanged || b.targetChanged) reasons.push('An executor target changed across attempts.');
    if (a.contextChanged || b.contextChanged) reasons.push('A Harness context mode changed across attempts.');
    if (a.requestedModel !== b.requestedModel || !a.requestedModel || !b.requestedModel) reasons.push('Different or missing requested model evidence.');
    if (a.observedModel !== b.observedModel) reasons.push('Different reported models.');
    if ((a.requestedModel === 'configured' && !a.observedModel) || (b.requestedModel === 'configured' && !b.observedModel)) reasons.push('Configured model alias has no reported model identity.');
    if (a.modelChanged || b.modelChanged) reasons.push('A model changed across attempts.');
    if (a.toolVersions !== b.toolVersions) reasons.push('Different or changing tool versions.');
    return { comparable: reasons.length === 0, reasons };
}

function aggregate(metrics) {
    const knownFirst = metrics.filter(run => run.firstPass !== null);
    const completeCost = metrics.every(run => run.accounting.costComplete);
    const completeUsage = metrics.every(run => run.accounting.usageComplete);
    const observedCostUsd = metrics.reduce((sum, run) => sum + run.accounting.observedCostUsd, 0);
    const observedTokens = metrics.reduce((sum, run) => sum + run.accounting.observedTokens, 0);
    const measure = (observedField, completeField, unknownField, unit) => {
        const observed = metrics.reduce((sum, run) => sum + run.accounting[observedField], 0);
        const complete = metrics.length > 0 && metrics.every(run => run.accounting[completeField]);
        return { [`observedSubtotal${unit}`]: observed, [`total${unit}`]: complete ? observed : null, complete,
            unknownCalls: metrics.reduce((sum, run) => sum + run.accounting[unknownField], 0) };
    };
    return { runs: metrics.length, successfulRuns: metrics.filter(run => run.success).length,
        independentSuccessfulRuns: metrics.filter(run => run.independentSuccess).length,
        unassistedSuccessfulRuns: metrics.filter(run => run.unassistedSuccess).length,
        processGenerationSuccessfulRuns: metrics.filter(run => run.processGenerationSuccess).length,
        generationModes: Object.fromEntries([...new Set(metrics.map(run => run.generationMode))].map(mode => [mode, metrics.filter(run => run.generationMode === mode).length])),
        successRate: metrics.length ? metrics.filter(run => run.success).length / metrics.length : null,
        independentSuccessRate: metrics.length ? metrics.filter(run => run.independentSuccess).length / metrics.length : null,
        processGenerationSuccessRate: metrics.length ? metrics.filter(run => run.processGenerationSuccess).length / metrics.length : null,
        firstPassRuns: metrics.filter(run => run.firstPass === true).length, firstPassKnownRuns: knownFirst.length,
        firstPassRate: knownFirst.length ? metrics.filter(run => run.firstPass === true).length / knownFirst.length : null,
        attempts: metrics.reduce((sum, run) => sum + run.attempts, 0), retries: metrics.reduce((sum, run) => sum + run.retries, 0),
        assistedRuns: metrics.filter(run => run.assisted).length,
        calls: metrics.reduce((sum, run) => sum + run.accounting.calls, 0),
        meanElapsedMs: mean(metrics.map(run => run.accounting.elapsedMs).filter(value => value !== null)),
        unknownTimeRuns: metrics.filter(run => run.accounting.elapsedMs === null).length,
        elapsed: measure('observedElapsedMs', 'elapsedComplete', 'unknownElapsedCalls', 'Ms'),
        tools: measure('observedToolCalls', 'toolCallsComplete', 'unknownToolCalls', 'Calls'),
        renders: measure('observedRenderCalls', 'renderCallsComplete', 'unknownRenderCalls', 'Calls'),
        cost: { observedSubtotalUsd: observedCostUsd, totalUsd: metrics.length && completeCost ? observedCostUsd : null, complete: metrics.length > 0 && completeCost, unknownCalls: metrics.reduce((sum, run) => sum + run.accounting.unknownCostCalls, 0) },
        usage: { observedSubtotalTokens: observedTokens, totalTokens: metrics.length && completeUsage ? observedTokens : null, complete: metrics.length > 0 && completeUsage, unknownCalls: metrics.reduce((sum, run) => sum + run.accounting.unknownUsageCalls, 0) },
    };
}

/** Summarize every selected attempt. Invalid pairs remain visible but never enter a lift calculation. */
export function summarizeBenchmark(cases, { teacher = null, amortizeUses = null } = {}) {
    if (!Array.isArray(cases) || !cases.length) throw appError('REPRO_INVALID', 'A benchmark needs at least one paired case.');
    if (amortizeUses !== null && (!Number.isSafeInteger(amortizeUses) || amortizeUses < 1)) throw appError('REPRO_INVALID', 'amortizeUses must be a positive integer.');
    const ids = new Set();
    const selectedRuns = new Set();
    const comparisonTypes = [...new Set(cases.map(entry => entry?.comparisonType || 'method-presence'))];
    if (comparisonTypes.length !== 1 || !COMPARISON_TYPES.includes(comparisonTypes[0])) throw appError('REPRO_INVALID', 'Use one explicit comparison type per benchmark: method-presence, method-version, or workflow-ablation.');
    const comparisonType = comparisonTypes[0];
    const reports = cases.map(entry => {
        if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id) || !entry.baseline || !entry.template) throw appError('REPRO_INVALID', 'Benchmark cases need unique IDs and baseline/template runs.');
        ids.add(entry.id);
        for (const arm of ARMS) if (entry[arm]) {
            const id = entry[arm].id ?? entry[arm].production;
            if (!id || selectedRuns.has(id)) throw appError('REPRO_INVALID', 'Each benchmark arm must use a distinct independent run.');
            selectedRuns.add(id);
        }
        const comparison = comparable(entry.baseline, entry.template, comparisonType);
        if (comparisonType === 'method-presence' && (entry.baseline.kind !== 'baseline' || entry.baseline.template || entry.baseline.method && entry.baseline.methodApplied !== false)) comparison.reasons.push('Baseline is not recorded as a fresh run without method guidance.');
        if (comparisonType !== 'method-presence') {
            if (!entry.baseline.method || !entry.template.method || entry.baseline.methodApplied !== true || entry.template.methodApplied !== true) comparison.reasons.push('Both comparison arms must explicitly apply a method recipe.');
            if (comparisonType === 'workflow-ablation' && (entry.baseline.method?.id !== entry.template.method?.id || entry.baseline.method?.treeHash !== entry.template.method?.treeHash)) comparison.reasons.push('Workflow ablation must keep the same frozen method recipe.');
            if (comparisonType === 'method-version' && entry.baseline.method?.treeHash === entry.template.method?.treeHash) comparison.reasons.push('Method-version comparison requires different frozen method contents.');
            if (entry.baseline.assisted || entry.template.assisted) comparison.reasons.push('Assisted runs cannot estimate independent method or workflow improvements.');
        }
        if (entry.template.method && entry.template.methodApplied !== true) comparison.reasons.push('Treatment has no recorded method guidance application.');
        if (!['trial', 'generation'].includes(entry.template.kind) || !(entry.template.template?.id || entry.template.method?.id)) comparison.reasons.push('Method/template arm is not a recorded trial.');
        comparison.comparable = comparison.reasons.length === 0;
        let ablation = null;
        if (entry.withoutSkills) {
            ablation = comparable(entry.template, entry.withoutSkills);
            if (entry.withoutSkills.ablation !== 'without-skills' && entry.withoutSkills.withoutSkills !== true) ablation.reasons.push('Skill removal was not recorded by the workflow.');
            if ((entry.template.method || entry.template.template)?.id !== (entry.withoutSkills.method || entry.withoutSkills.template)?.id || (entry.template.method || entry.template.template)?.treeHash !== (entry.withoutSkills.method || entry.withoutSkills.template)?.treeHash) ablation.reasons.push('Ablation does not use the same frozen template.');
            ablation.comparable = ablation.reasons.length === 0;
        }
        return { id: entry.id, comparisonType, comparison, ablation,
            ...Object.fromEntries(ARMS.filter(arm => entry[arm]).map(arm => [arm, runMetrics(entry[arm])])),
        };
    });
    const arms = Object.fromEntries(ARMS.map(arm => [arm, aggregate(reports.map(report => report[arm]).filter(Boolean))]));
    const paired = reports.filter(report => report.comparison.comparable);
    const matchedBaseline = aggregate(paired.map(report => report.baseline)), matchedTemplate = aggregate(paired.map(report => report.template));
    const build = teacher ? accounting(teacher) : null;
    const meanTemplateCost = arms.template.cost.complete ? arms.template.cost.totalUsd / arms.template.runs : null;
    return { schema: 'video-remake.reproduction-benchmark@2', generatedAt: new Date().toISOString(), comparisonType,
        comparisonMeaning: { 'method-presence': 'Effect of supplying method guidance under the same workflow.', 'method-version': 'Effect of changed method contents under the same workflow.', 'workflow-ablation': 'Effect of the execution workflow with the same frozen method; not a method recipe lift.' }[comparisonType],
        cases: reports, arms, comparableCases: paired.length, excludedCases: reports.length - paired.length,
        comparison: { baseline: matchedBaseline, template: matchedTemplate,
            successRateDelta: paired.length ? matchedTemplate.successRate - matchedBaseline.successRate : null,
            independentSuccessRateDelta: paired.length ? matchedTemplate.independentSuccessRate - matchedBaseline.independentSuccessRate : null,
        },
        construction: build ? { teacher: teacher.production ?? teacher.id, ...build } : null,
        amortization: amortizeUses === null ? null : { uses: amortizeUses,
            buildCostPerUseUsd: build?.costUsd !== null && build?.costUsd !== undefined ? build.costUsd / amortizeUses : null,
            meanTemplateExecutionCostUsd: meanTemplateCost,
            estimatedTotalPerUseUsd: build?.costUsd !== null && build?.costUsd !== undefined && meanTemplateCost !== null ? build.costUsd / amortizeUses + meanTemplateCost : null,
        },
        limitations: ['Independent success requires blank generation, process audit and verified enforced isolation; unassisted legacy replay is reported separately.', 'A different input hash alone does not prove a held-out task; reference and extraction lineage must be checked.', 'Results cover only the selected cases, models, Harness versions and budgets.', 'Observed cost subtotals exclude unknown billing and must not be read as total cost.', 'Metadata and successful execution alone do not establish visual quality; passing requires external technical and review evidence.'],
    };
}

export async function runBenchmark(config, filename, { loadRun, ...options } = {}) {
    if (typeof loadRun !== 'function') throw appError('REPRO_INVALID', 'Benchmark requires the authoritative run loader.');
    const absolute = await safeFile(config.workspace, filename);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw appError('REPRO_INVALID', 'Benchmark definition must be a JSON file smaller than 1 MiB.');
    let definition;
    try { definition = JSON.parse(await fs.readFile(absolute, 'utf8')); }
    catch { throw appError('REPRO_INVALID', 'Invalid benchmark JSON.'); }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition) || Object.keys(definition).some(key => !['schemaVersion', 'cases', 'teacher', 'amortizeUses'].includes(key)) || (definition.schemaVersion !== undefined && definition.schemaVersion !== 1) || !Array.isArray(definition.cases) || !definition.cases.length || definition.cases.length > 100) throw appError('REPRO_INVALID', 'Invalid benchmark definition.');
    const records = await Promise.all(definition.cases.map(async entry => {
        if (!entry || Object.keys(entry).some(key => !['id', 'comparisonType', ...ARMS].includes(key))) throw appError('REPRO_INVALID', 'Unknown benchmark case field.');
        const values = {};
        for (const arm of ARMS) if (entry[arm] !== undefined) {
            if (typeof entry[arm] !== 'string' || !entry[arm]) throw appError('REPRO_INVALID', 'Benchmark arms must name production runs.');
            values[arm] = await loadRun(config, entry[arm]);
        }
        return { id: entry.id, ...(entry.comparisonType ? { comparisonType: entry.comparisonType } : {}), ...values };
    }));
    const teacher = definition.teacher ? await loadRun(config, definition.teacher) : null;
    if (teacher && teacher.kind !== 'teacher') throw appError('REPRO_INVALID', 'Construction cost must come from a teacher run.');
    return { command: 'repro:benchmark', path: path.resolve(absolute), report: summarizeBenchmark(records, { ...options, teacher, amortizeUses: definition.amortizeUses ?? null }) };
}

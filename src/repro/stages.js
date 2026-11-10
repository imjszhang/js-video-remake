import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { appError } from '../errors.js';

export const SHOT_PLAN_SCHEMA = 'video-remake.shot-plan@1';
export const SELF_CHECK_SCHEMA = 'video-remake.stage-self-check@1';
export const STAGE_STATE_SCHEMA = 'video-remake.stage-state@1';
export const STAGE_IDS = Object.freeze(['freeze', 'analysis', 'prototypes', 'shots', 'integration', 'submission', 'review']);
export const STAGE_TITLES = Object.freeze({ freeze: '冻结与准备', analysis: '参考分析', prototypes: '关键镜头验证', shots: '分镜制作', integration: '全片整合', submission: '提交检查', review: '最终双评审' });
export const PROTOTYPE_REQUIREMENTS = Object.freeze(['character-interaction', 'complex-motion']);
export const EXECUTION_PROTOCOL_FILES = Object.freeze(['stages.js', 'stage-workflow.js', 'stage-preview.js', 'stage-evidence.js', 'stage-project.js']);
export const STAGE_PROTOCOL = Object.freeze({
    schema: 'video-remake.execution-protocol@1', id: 'video-remake.staged-execution@1',
    version: 1, stages: STAGE_IDS, reviewSamples: 2,
    rules: Object.freeze([
        'Frozen task, method, assets, tools, model and final acceptance remain unchanged within an episode.',
        'Analysis and shot plans are executor-authored revisions. Changing them invalidates downstream evidence.',
        'Stage completion records host-verified material/evidence completeness, never independent visual quality.',
        'Executor visual self-checks remain declarations; no self-reported pass substitutes for two final reviews.',
        'Each preview and self-check is bound to its source tree, plan and host evidence identities.',
        'Public reference anchors and beginning/middle/end motion samples cannot be omitted by a model plan.',
        'Higher-capability intervention during production is guided/assisted and is not an independent-method result.',
        'Two complete independent reviews of the same final artifact are mandatory; valid adverse votes are retained.',
        'Operation reservations and settlements are idempotent and cannot reset cumulative budgets.',
    ]),
});
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const DENIED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const EPS = 1e-6;
const invalid = message => appError('REPRO_STAGE_INVALID', message);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = value => createHash('sha256').update(value).digest('hex');
function object(value, label, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid(`${label} must be an object.`);
    if (allowed) for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`Unknown ${label} field: ${key}`);
    return value;
}
function text(value, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw invalid(`${label} must be nonempty text under 16 KiB.`);
    return value.trim();
}
function identifier(value, label) {
    if (typeof value !== 'string' || !ID.test(value) || DENIED_IDS.has(value)) throw invalid(`${label} must be a safe identifier.`);
    return value;
}
function finite(value, label, { min = 0, max = Infinity, positive = false } = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (positive && value === 0)) throw invalid(`${label} must be a finite number in range.`);
    return value;
}
function list(value, label, { min = 0, max = 1000 } = {}) {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw invalid(`${label} must contain ${min}–${max} items.`);
    return value;
}
function unique(values, label) {
    if (new Set(values).size !== values.length) throw invalid(`${label} must not contain duplicates.`);
    return values;
}
function stringList(value, label, options) { return unique(list(value, label, options).map(v => text(v, label)), label); }
function ids(value, label, options) { return unique(list(value, label, options).map(v => identifier(v, label)), label); }
function sha(value, label, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !SHA.test(value)) throw invalid(`${label} must be a SHA-256.`);
    return value;
}
function stageId(value) {
    if (!STAGE_IDS.includes(value)) throw invalid(`Unknown stage: ${value}`);
    return value;
}
function timestamp(value) { return Math.round(value * 1e6) / 1e6; }
function covers(shot, time, duration) { return time >= shot.startSec - EPS && (time < shot.endSec - EPS || (Math.abs(time - duration) <= EPS && Math.abs(shot.endSec - duration) <= EPS)); }

/** Hash the contract and implementation, keeping historical execution identities distinct. */
export async function stageProtocolFingerprint() {
    const files = Object.fromEntries(await Promise.all(EXECUTION_PROTOCOL_FILES.map(async file => [file, hash(await fs.readFile(new URL(file, import.meta.url)))])));
    return hash(canonical({ protocol: STAGE_PROTOCOL, files }));
}
export function shotPlanHash(plan) { return hash(canonical(plan)); }

/** Canonical requests; these do not claim the resulting frames were observed. */
export function shotSampleTimes(shot, { durationSec, requiredAnchors = [] } = {}) {
    const duration = durationSec ?? shot.endSec;
    const span = shot.endSec - shot.startSec;
    if (!(span > 0)) throw invalid('Shot sample interval must have positive duration.');
    const endSample = shot.endSec - Math.min(0.04, span / 4);
    const generated = [shot.startSec, (shot.startSec + shot.endSec) / 2, endSample].map(timestamp);
    // Frozen public requests retain their exact identity; only generated phase
    // times are rounded. Media extraction may clamp the separate actual seek.
    return [...new Set([...generated, ...(shot.sampleTimesSec || []),
        ...requiredAnchors.filter(time => covers(shot, time, duration))])].sort((a, b) => a - b);
}
export function requiredShotSamples(plan, { requiredAnchors = [] } = {}) {
    return Object.fromEntries(plan.shots.map(shot => [shot.id, shotSampleTimes(shot, { durationSec: plan.durationSec, requiredAnchors })]));
}

export function validateShotPlan(raw, { durationSec, requiredAnchors = [], evidenceIds } = {}) {
    object(raw, 'shot plan', ['schema', 'durationSec', 'shots']);
    if (raw.schema !== SHOT_PLAN_SCHEMA) throw invalid(`Shot plan schema must be ${SHOT_PLAN_SCHEMA}.`);
    const duration = finite(raw.durationSec, 'durationSec', { positive: true });
    if (durationSec !== undefined && Math.abs(duration - finite(durationSec, 'task durationSec', { positive: true })) > EPS) throw invalid('Shot plan duration differs from frozen task.');
    const anchors = [...new Set(list(requiredAnchors, 'required anchors').map(time => finite(time, 'required anchor', { max: duration })))];
    const knownEvidence = evidenceIds === undefined ? null : new Set(evidenceIds);
    const shots = list(raw.shots, 'shots', { min: 1, max: 100 }).map((value, index) => {
        object(value, `shot ${index}`, ['id', 'startSec', 'endSec', 'title', 'subject', 'action', 'cameraIntent', 'composition', 'observations', 'sampleTimesSec', 'riskTags', 'dependencies', 'uncertainties']);
        const id = identifier(value.id, 'shot id');
        const startSec = finite(value.startSec, `${id}.startSec`, { max: duration });
        const endSec = finite(value.endSec, `${id}.endSec`, { max: duration });
        if (endSec <= startSec) throw invalid(`${id} must have a positive time interval.`);
        const shot = { id, startSec, endSec };
        for (const key of ['title', 'subject', 'action', 'cameraIntent', 'composition']) shot[key] = text(value[key], `${id}.${key}`);
        shot.observations = list(value.observations, `${id}.observations`, { min: 1, max: 200 }).map(observation => {
            object(observation, 'observation', ['timeSec', 'evidenceId', 'claim', 'certainty']);
            const timeSec = finite(observation.timeSec, 'observation.timeSec', { min: startSec, max: endSec });
            const evidenceId = text(observation.evidenceId, 'observation.evidenceId');
            if (knownEvidence && !knownEvidence.has(evidenceId)) throw invalid(`Unknown reference evidence ID: ${evidenceId}`);
            if (!['observed', 'inferred', 'uncertain'].includes(observation.certainty)) throw invalid('Observation certainty must be observed, inferred or uncertain.');
            return { timeSec, evidenceId, claim: text(observation.claim, 'observation.claim'), certainty: observation.certainty };
        });
        shot.sampleTimesSec = unique(list(value.sampleTimesSec ?? [], `${id}.sampleTimesSec`, { max: 200 }).map(time => finite(time, 'shot sample time', { min: startSec, max: endSec })), 'shot sample times');
        shot.riskTags = ids(value.riskTags ?? [], `${id}.riskTags`, { max: 20 });
        shot.dependencies = ids(value.dependencies ?? [], `${id}.dependencies`, { max: 400 });
        shot.uncertainties = stringList(value.uncertainties ?? [], `${id}.uncertainties`, { max: 100 });
        return shot;
    });
    const seen = new Set();
    for (const [index, shot] of shots.entries()) {
        if (seen.has(shot.id)) throw invalid('Duplicate shot IDs.');
        const expectedStart = index ? shots[index - 1].endSec : 0;
        if (Math.abs(shot.startSec - expectedStart) > EPS) throw invalid('Shots must be ordered and cover the full timeline without gaps or overlaps.');
        for (const dependency of shot.dependencies) if (!seen.has(dependency)) throw invalid(`${shot.id} dependency ${dependency} must refer to an earlier shot; cycles and unknown dependencies are not allowed.`);
        seen.add(shot.id);
        shot.sampleTimesSec = shotSampleTimes(shot, { durationSec: duration, requiredAnchors: anchors });
    }
    if (Math.abs(shots.at(-1).endSec - duration) > EPS) throw invalid('Shot plan does not cover the complete frozen duration.');
    return { schema: SHOT_PLAN_SCHEMA, durationSec: duration, shots };
}

/** Choose distinct examples where possible; caller-visible selection is deterministic. */
export function selectPrototypeShots(plan, { requirements = PROTOTYPE_REQUIREMENTS, minShots = 2 } = {}) {
    if (!Number.isSafeInteger(minShots) || minShots < 1) throw invalid('Prototype minimum must be positive.');
    const required = ids([...requirements], 'prototype requirements', { min: 0, max: 20 });
    const assign = (index, selected) => {
        if (index === required.length) return selected;
        for (const shot of plan.shots.filter(shot => shot.riskTags.includes(required[index]) && !selected.includes(shot.id))) {
            const result = assign(index + 1, [...selected, shot.id]);
            if (result) return result;
        }
        return null;
    };
    const selected = assign(0, []);
    if (!selected) throw invalid(`Distinct prototype shots must cover: ${required.join(', ')}.`);
    for (const shot of plan.shots) {
        if (selected.length >= minShots) break;
        if (!selected.includes(shot.id)) selected.push(shot.id);
    }
    if (selected.length < minShots) throw invalid(`At least ${minShots} distinct prototype shots are required.`);
    return selected;
}

export function validateSelfCheck(raw, { stageId: expectedStage, shotIds = [], evidenceIds, evidenceItems, shots, sourceTreeHash, planHash, requiredCheckIds = [] } = {}) {
    object(raw, 'self-check', ['schema', 'stageId', 'sourceTreeHash', 'planHash', 'shotIds', 'checks', 'unresolved']);
    if (raw.schema !== SELF_CHECK_SCHEMA) throw invalid(`Self-check schema must be ${SELF_CHECK_SCHEMA}.`);
    stageId(raw.stageId);
    if (expectedStage && raw.stageId !== expectedStage) throw invalid('Self-check belongs to another stage.');
    sha(raw.sourceTreeHash, 'self-check sourceTreeHash'); sha(raw.planHash, 'self-check planHash');
    if (sourceTreeHash && raw.sourceTreeHash !== sourceTreeHash) throw invalid('Self-check source snapshot is stale.');
    if (planHash && raw.planHash !== planHash) throw invalid('Self-check plan is stale.');
    const scope = ids(raw.shotIds, 'self-check shotIds', { min: 1, max: 400 });
    if (shotIds.length && canonical([...scope].sort()) !== canonical([...shotIds].sort())) throw invalid('Self-check must cover exactly the submitted shots.');
    const knownEvidence = evidenceIds === undefined ? (evidenceItems ? new Set(evidenceItems.map(item => item.id)) : null) : new Set(evidenceIds);
    const checks = list(raw.checks, 'self-check checks', { min: 1, max: 4000 }).map(check => {
        object(check, 'self-check item', ['id', 'shotId', 'status', 'observationStatus', 'evidenceIds', 'notes']);
        identifier(check.id, 'self-check ID'); identifier(check.shotId, 'self-check shotId');
        if (!scope.includes(check.shotId)) throw invalid('Self-check refers to an out-of-scope shot.');
        if (!['pass', 'fail', 'unobserved'].includes(check.status) || !['observed', 'unobserved'].includes(check.observationStatus)
            || (check.status === 'unobserved') !== (check.observationStatus === 'unobserved')) throw invalid('Self-check observation and status contradict.');
        const references = stringList(check.evidenceIds, 'self-check evidenceIds', { min: check.observationStatus === 'observed' ? 1 : 0, max: 500 });
        if (knownEvidence && references.some(id => !knownEvidence.has(id))) throw invalid('Self-check cites unknown or stale host evidence.');
        const normalized = { id: check.id, shotId: check.shotId, status: check.status, observationStatus: check.observationStatus, evidenceIds: references, notes: text(check.notes, 'self-check notes') };
        if (evidenceItems && normalized.observationStatus === 'observed') validateCheckEvidence(normalized, evidenceItems, shots);
        return normalized;
    });
    unique(checks.map(check => `${check.shotId}:${check.id}`), 'self-check shot/criterion pairs');
    for (const id of scope) {
        if (!checks.some(check => check.shotId === id)) throw invalid(`Missing self-check for ${id}.`);
        for (const checkId of requiredCheckIds) if (!checks.some(check => check.shotId === id && check.id === checkId)) throw invalid(`Missing self-check ${id}/${checkId}.`);
    }
    return { schema: SELF_CHECK_SCHEMA, stageId: raw.stageId, sourceTreeHash: raw.sourceTreeHash, planHash: raw.planHash, shotIds: scope,
        checks, unresolved: stringList(raw.unresolved ?? [], 'unresolved issues', { max: 1000 }) };
}

function validateCheckEvidence(check, items, shots) {
    const cited = check.evidenceIds.map(id => items.find(item => item.id === id));
    if (cited.some(item => !item)) throw invalid('Self-check evidence metadata is unavailable.');
    const audio = ['sound', 'audio'].includes(check.id);
    const kind = audio ? 'audio' : 'frame';
    const selected = cited.filter(item => (item.kind || item.type) === kind);
    const shot = shots?.find(item => item.id === check.shotId);
    if (shots && !shot) throw invalid('Self-check shot is absent from the frozen plan.');
    const motion = ['motion', 'motion-timing', 'camera-motion'].includes(check.id);
    const time = item => item.requestedTimeSec ?? item.sampleTimeSec ?? item.timing?.requestedTimeSec;
    const actual = item => item.timeSec ?? item.timing?.seekTimeSec;
    const inShot = item => !shot || (Number.isFinite(time(item)) && time(item) >= shot.startSec - EPS && time(item) <= shot.endSec + EPS
        && Number.isFinite(actual(item)) && actual(item) >= shot.startSec - EPS && actual(item) <= shot.endSec + EPS);
    const pairs = [];
    for (const subject of selected.filter(item => item.sourceId === 'subject')) {
        if (!Number.isFinite(time(subject)) || (!audio && !inShot(subject))) continue;
        const references = selected.filter(item => item.sourceId && item.sourceId !== 'subject' && Number.isFinite(time(item))
            && Math.abs(time(subject) - time(item)) <= EPS && (audio || inShot(item)));
        for (const reference of references) {
            if (motion && (!Number.isFinite(actual(subject)) || !Number.isFinite(actual(reference)) || Math.abs(actual(subject) - actual(reference)) > EPS
                || Math.abs(subject.timing?.fallbackOffsetSec || 0) > EPS || Math.abs(reference.timing?.fallbackOffsetSec || 0) > EPS)) continue;
            pairs.push({ subject, reference, time: time(subject) });
        }
    }
    // Sound is an integration-wide contract. Its paired excerpts can support
    // several shot declarations; this does not pretend each shot was sampled.
    if (!pairs.length) throw invalid(audio ? 'Sound self-check needs a paired audio excerpt at a common requested time.' : 'Visual self-check needs paired evidence within the declared shot at a common requested time.');
    if (motion) {
        if (!shot) throw invalid('Motion self-check needs the frozen shot interval.');
        const times = [...new Set(pairs.map(pair => pair.time))];
        const endInside = Math.max(shot.startSec, shot.endSec - 0.04);
        const span = endInside - shot.startSec;
        const phases = new Set(times.map(t => span > 0 ? Math.max(0, Math.min(2, Math.floor((t - shot.startSec) / span * 3))) : 0));
        if (times.length < 3 || phases.size < 3) throw invalid('Motion self-check needs beginning, middle and end paired samples with aligned actual seeks; fallback frames cannot prove motion synchronization.');
    }
}

export function createStageState({ protocolHash = null, episodeId = null, at = null } = {}) {
    sha(protocolHash, 'protocol hash', { nullable: true });
    return { schema: STAGE_STATE_SCHEMA, protocol: STAGE_PROTOCOL.id, protocolHash, episodeId, revision: 0, currentStage: 'analysis',
        stages: STAGE_IDS.map(id => ({ id, title: STAGE_TITLES[id], status: id === 'freeze' ? 'complete' : 'pending', revision: id === 'freeze' ? 1 : 0,
            qualityStatus: 'not-evaluated', hostChecks: [], selfCheck: null, shotIds: [], submissions: [], ...(id === 'freeze' ? { completedAt: at } : {}) })) };
}
function stageState(value) {
    if (value?.schema !== STAGE_STATE_SCHEMA || !Array.isArray(value.stages) || canonical(value.stages.map(stage => stage.id)) !== canonical(STAGE_IDS)) throw invalid('Invalid staged workflow state.');
    return value;
}
export function stagesOf(value) { return stageState(value).stages; }
export function isStageComplete(stage) { return ['complete', 'evidence-complete'].includes(stage?.status); }
export function stageRequirements(state, id) {
    stageState(state); stageId(id);
    const index = STAGE_IDS.indexOf(id);
    const prerequisites = STAGE_IDS.slice(0, index);
    const missing = prerequisites.filter(required => !isStageComplete(state.stages.find(stage => stage.id === required)));
    return { stageId: id, prerequisites, missing, ready: missing.length === 0 };
}
export function allowedStageActions(state, { active = false, blockedReasons = {} } = {}) {
    stageState(state);
    if (active) return { allowedActions: ['status', 'logs', 'cancel'], blockedReasons: { ...blockedReasons, run: '已有活动阶段，等待结束或取消。', repair: '已有活动阶段。' }, currentStage: state.currentStage };
    const current = state.stages.find(stage => stage.id === state.currentStage);
    const allowedActions = ['status', 'logs'];
    const reasons = { ...blockedReasons };
    if (current) {
        const readiness = stageRequirements(state, current.id);
        if (readiness.ready && !reasons.run) allowedActions.push('run');
        else reasons.run ||= `前置阶段尚未完成：${readiness.missing.join(', ')}`;
        if (readiness.ready && ['needs-revision', 'stale', 'blocked', 'interrupted'].includes(current.status) && !reasons.repair) allowedActions.push('repair');
        if (current.status === 'interrupted') allowedActions.push('resume', 'recover');
        if (current.id === 'review' && readiness.ready && !reasons.judge) allowedActions.push('judge');
    }
    return { allowedActions: [...new Set(allowedActions)], blockedReasons: reasons, currentStage: state.currentStage };
}

/** Only the host calls this after its own checks; never deserialize actor pass flags here. */
export function recordStageSubmission(state, submission, { maxRevisions = 2 } = {}) {
    stageState(state);
    object(submission, 'host stage submission', ['id', 'stageId', 'shotIds', 'revision', 'episodeId', 'sourceTreeHash', 'planHash', 'evidenceRoot', 'items', 'hostChecks', 'selfCheck', 'status', 'createdAt']);
    const id = stageId(submission.stageId);
    if (id === 'freeze') throw invalid('The initialized frozen record cannot be replaced by a stage submission.');
    identifier(submission.id, 'stage submission ID');
    sha(submission.sourceTreeHash, 'submission sourceTreeHash');
    if (submission.planHash !== undefined && submission.planHash !== null) sha(submission.planHash, 'submission planHash');
    if (!Number.isSafeInteger(maxRevisions) || maxRevisions < 1) throw invalid('Stage revisions must be a positive integer.');
    const original = state.stages.find(stage => stage.id === id);
    const old = original.submissions.find(item => item.id === submission.id);
    if (old) {
        if (canonical(old) !== canonical(submission)) throw invalid('A stage submission ID cannot change contents.');
        return structuredClone(state);
    }
    if (!stageRequirements(state, id).ready) throw invalid('Cannot submit a stage before its prerequisites.');
    // maxRevisions counts repairs after the initial submission, matching the
    // scheduler's frozen maxStageRevisions policy.
    if (original.revision >= 1 + maxRevisions) throw appError('REPRO_BUDGET_EXHAUSTED', '阶段修订次数已用尽。');
    if (submission.revision !== original.revision + 1) throw invalid('Stage revision must increment exactly once.');
    if (state.episodeId && submission.episodeId !== state.episodeId) throw invalid('Stage submission belongs to another episode.');
    const hostChecks = list(submission.hostChecks, 'host checks', { min: 1, max: 1000 }).map(check => {
        object(check, 'host check');
        if (typeof check.passed !== 'boolean' || typeof check.id !== 'string' || !check.id) throw invalid('Host checks require ID and boolean outcome.');
        if (check.kind && !['structural', 'technical', 'evidence', 'provenance'].includes(check.kind)) throw invalid('Stage gates cannot promote actor visual quality claims.');
        return structuredClone(check);
    });
    const passed = hostChecks.every(check => check.passed);
    if (submission.status !== (passed ? 'evidence-complete' : 'needs-revision')) throw invalid('Stage status must follow host checks, not actor assertions.');
    const next = structuredClone(state);
    const stage = next.stages.find(stage => stage.id === id);
    Object.assign(stage, { status: submission.status, revision: submission.revision, hostChecks, selfCheck: submission.selfCheck || null,
        shotIds: submission.shotIds || [], qualityStatus: 'not-evaluated', sourceTreeHash: submission.sourceTreeHash, planHash: submission.planHash || null });
    delete stage.staleReason;
    stage.submissions.push(structuredClone(submission));
    if (original.revision > 0) for (const downstream of next.stages.slice(STAGE_IDS.indexOf(id) + 1)) {
        if (downstream.status !== 'pending') downstream.status = 'stale';
        downstream.staleReason = `Upstream ${id} revision changed.`;
    }
    next.revision += 1;
    const subsequent = STAGE_IDS[STAGE_IDS.indexOf(id) + 1];
    next.currentStage = passed ? subsequent || null : id;
    return next;
}

/** Conservative invalidation preserves evidence records; no deleted or rewritten history. */
export function invalidateStages(state, { fromStage = 'analysis', reason, sourceTreeHash = null, includeCurrent = true } = {}) {
    stageState(state); stageId(fromStage); text(reason, 'invalidation reason');
    sha(sourceTreeHash, 'changed sourceTreeHash', { nullable: true });
    const next = structuredClone(state);
    const start = STAGE_IDS.indexOf(fromStage) + (includeCurrent ? 0 : 1);
    for (const stage of next.stages.slice(start)) {
        if (stage.id === 'freeze') continue;
        if (stage.status !== 'pending') stage.status = 'stale';
        stage.staleReason = reason;
        stage.invalidatedBySourceTreeHash = sourceTreeHash;
    }
    next.revision += 1;
    next.currentStage = STAGE_IDS[Math.max(1, start)] || null;
    return next;
}

/** Prompt documentation example, with placeholders rather than target implementation. */
export function exampleShotPlan({ durationSec = 10, evidenceIds = ['reference:frame:0', 'reference:frame:1'] } = {}) {
    const middle = durationSec / 2;
    return { schema: SHOT_PLAN_SCHEMA, durationSec, shots: [[0, middle], [middle, durationSec]].map(([startSec, endSec], i) => ({
        id: `shot-0${i + 1}`, startSec, endSec, title: 'Replace with the observed shot title', subject: 'Describe the visible focal subject',
        action: 'Describe the observed physical action and its phases', cameraIntent: 'Describe observed camera movement, separately from object motion',
        composition: 'Record relative subject scale, foreground/middle/background, visible surfaces and occlusion',
        observations: [{ timeSec: startSec, evidenceId: evidenceIds[i] || evidenceIds[0], claim: 'Replace with an actual observation tied to this evidence', certainty: 'uncertain' }],
        sampleTimesSec: [], riskTags: [PROTOTYPE_REQUIREMENTS[i]], dependencies: [], uncertainties: ['Replace with unresolved observations; do not invent certainty'],
    })) };
}

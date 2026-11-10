import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { appError } from '../errors.js';
import { validateSpec } from './schema.js';
import { HYPERFRAMES_VERSION, safeProjectFile, snapshotProject } from './project.js';
import { precheckComposition, readDeclaredFps } from '../precheck.js';
import { runFixedCommand } from './render.js';
import { hashFile } from './evaluate.js';
import { stageSamplingPlan, createStageEvidenceDirectory, stageCommandContext, stageProbeMedia, stageReferenceSources,
    collectStageFrames, collectStageAudio, finishStageEvidence, STAGE_EVIDENCE_SCHEMA } from './stage-evidence.js';

export { prepareStageReference, validateStageEvidence } from './stage-evidence.js';

const TRUSTED_CLI = fileURLToPath(new URL('../../node_modules/hyperframes/bin/hyperframes.mjs', import.meta.url));
const TRUSTED_PACKAGE = fileURLToPath(new URL('../../node_modules/hyperframes/package.json', import.meta.url));
const invalid = message => appError('REPRO_STAGE_PREVIEW_INVALID', message);
const digest = value => createHash('sha256').update(value).digest('hex');

async function jsonFile(workspace, relative) {
    const file = await safeProjectFile(workspace, relative);
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw invalid('阶段预览配置必须是小于 8 MiB 的普通文件。');
    return { file, value: JSON.parse(await fs.readFile(file, 'utf8')) };
}
async function previewProject(workspace, spec) {
    const { value: manifest } = await jsonFile(workspace, 'reproduction.json');
    if (manifest.schema !== 'video-remake.reproduction-project@1' || !['draft', 'ready'].includes(manifest.status)
        || manifest.output !== spec.acceptance.media.file) throw invalid('阶段预览工程清单与冻结任务不匹配。');
    const { value: acceptance } = await jsonFile(workspace, 'task/acceptance.json');
    if (JSON.stringify(validateSpec({ ...spec, acceptance }).acceptance) !== JSON.stringify(spec.acceptance)) throw invalid('阶段预览不得改变最终验收规格。');
    const { value: pkg } = await jsonFile(workspace, 'package.json');
    const { value: lock } = await jsonFile(workspace, 'package-lock.json');
    const installed = JSON.parse(await fs.readFile(TRUSTED_PACKAGE, 'utf8'));
    if (pkg.dependencies?.hyperframes !== HYPERFRAMES_VERSION || lock.lockfileVersion !== 3
        || lock.packages?.['']?.dependencies?.hyperframes !== HYPERFRAMES_VERSION
        || lock.packages?.['node_modules/hyperframes']?.version !== HYPERFRAMES_VERSION || installed.version !== HYPERFRAMES_VERSION) throw appError('REPRO_RENDER_VERSION', '阶段预览必须使用同一锁定 HyperFrames 版本。');
    try { await fs.lstat(path.join(workspace, '.env')); throw invalid('阶段预览不得加载工程 .env。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entry = await safeProjectFile(workspace, manifest.entry);
    if (!(await fs.stat(entry)).isFile() || path.extname(entry).toLowerCase() !== '.html') throw invalid('阶段预览入口必须是工程内 HTML 文件。');
    if ((await fs.readFile(entry, 'utf8')).includes('REPRODUCTION_DRAFT')) throw invalid('阶段预览入口仍为空白占位文件。');
    const { file: inputsFile, value: inputs } = await jsonFile(workspace, manifest.inputsFile);
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw invalid('阶段预览输入必须是对象。');
    return { manifest, inputsFile, entry };
}

/**
 * Host-owned draft preview. Pinned 0.8.191 snapshot cannot select an HTML entry
 * plus variable file, so render the exact entry/inputs into a private video and
 * sample its root timeline. This intentionally records the full render cost.
 */
export async function previewStage(config, { workspace, spec: rawSpec, references, stageId, shots, shotIds, evidenceRoot,
    protocolHash = null, inputsHash = null, assetLockHash = null, sourceSnapshot, includeAudio = stageId === 'integration', timeoutMs = 600_000, signal }, deps = {}) {
    const started = performance.now();
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || typeof stageId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,120}$/.test(stageId)) throw invalid('阶段预览需要绝对工程路径及有效阶段 ID。');
    const rootInfo = await fs.lstat(workspace);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw invalid('阶段预览工程必须是真实目录。');
    workspace = await fs.realpath(workspace);
    const spec = validateSpec(rawSpec || (await jsonFile(workspace, 'task/spec.json')).value);
    const { manifest, inputsFile, entry } = await previewProject(workspace, spec);
    const before = await snapshotProject(workspace, { includeInputs: true });
    if (sourceSnapshot && before.treeHash !== sourceSnapshot.treeHash) throw invalid('执行者提交后源码已变化，不能生成阶段证据。');
    const scope = stageSamplingPlan(spec, { shots, shotIds });
    const directory = await createStageEvidenceDirectory(evidenceRoot, { workspace });
    const temporary = path.join(directory.root, 'media', 'subject.mp4');
    await fs.mkdir(path.dirname(temporary));
    const scratch = path.join(directory.root, 'scratch');
    await fs.mkdir(scratch);
    const env = { ...process.env, ...config?.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    const context = stageCommandContext({ workspace, timeoutMs, signal, env, onStart: deps.onStart }, deps);
    const record = { id: directory.id, stageId, status: 'running', provider: 'local-hyperframes', version: HYPERFRAMES_VERSION,
        strategy: 'full-render-and-sample', scope, sourceTreeHash: before.treeHash, inputsHash, assetLockHash, protocolHash,
        evidenceRoot: directory.root, startedAt: new Date().toISOString(), previewJobs: 0, renderCalls: 0,
        limitations: ['This draft preview renders the whole declared timeline before sampling; its full render time is charged.',
            'Stage evidence and execution self-checks do not certify visual fidelity.'] };
    try {
        const refs = await stageReferenceSources(references, context, deps);
        const entryHtml = await fs.readFile(entry, 'utf8');
        const windowStart = Math.min(...scope.ranges.map((range) => range.startSec));
        const windowEnd = Math.max(...scope.ranges.map((range) => range.endSec));
        context.remaining();
        const runCommand = deps.runCommand || runFixedCommand;
        const checked = await precheckComposition({
            dir: path.dirname(entry), entry: path.basename(entry), projectRoot: workspace, fps: readDeclaredFps(entryHtml) ?? 30,
            range: `${windowStart},${windowEnd}`, timeoutMs: context.remaining(), signal, env,
            cancelCode: 'REPRO_STAGE_CANCELLED', timeoutCode: 'REPRO_STAGE_TIMEOUT',
        }, { ...deps, runCommand: (...args) => { context.hostToolCalls++; return runCommand(...args); } });
        record.precheck = { status: checked.hyperframesCheck, warnings: checked.warnings.length };
        const args = [TRUSTED_CLI, 'render', workspace, '--composition', manifest.entry, '--output', temporary,
            '--format', 'mp4', '--variables-file', inputsFile, '--quality', 'draft', '--strict'];
        record.cliSha256 = (await hashFile(TRUSTED_CLI)).sha256;
        record.commandHash = digest(JSON.stringify([process.execPath, ...args]));
        context.remaining();
        record.previewJobs = 1; record.renderCalls = 1;
        record.process = await context.run(process.execPath, args);
        const media = await stageProbeMedia(temporary, context, deps);
        const lastSample = scope.samples.at(-1).requestedTimeSec;
        if (media.width !== spec.acceptance.media.width || media.height !== spec.acceptance.media.height
            || media.durationSec + 0.04 < lastSample) throw invalid('阶段预览的尺寸或时长没有覆盖请求的镜头与相邻转场。');
        if (includeAudio && spec.acceptance.media.audio === 'required' && !media.audioStreams) throw invalid('整合阶段预览缺少要求的音轨。');
        const artifact = await hashFile(temporary);
        const source = { id: 'subject', file: temporary, ...artifact, media };
        const sources = [source, ...refs];
        const items = await collectStageFrames(directory.root, sources, scope.samples, context, deps);
        if (includeAudio && spec.acceptance.media.audio !== 'forbidden') items.push(...await collectStageAudio(directory.root, sources, scope, spec, context, deps));
        const after = await snapshotProject(workspace, { includeInputs: true });
        if (after.treeHash !== before.treeHash) throw invalid('源码、素材或输入在阶段预览期间发生变化。');
        const evidence = { schema: STAGE_EVIDENCE_SCHEMA, id: directory.id, kind: 'stage-preview', stageId, protocolHash,
            sourceTreeHash: before.treeHash, inputsHash, assetLockHash, strategy: record.strategy, scope,
            sources: sources.map(({ file, ...item }) => item), items,
            audio: { requested: includeAudio, required: includeAudio && spec.acceptance.media.audio === 'required' }, qualityStatus: 'not-evaluated' };
        return await finishStageEvidence({ ...record, artifact: { file: temporary, path: 'media/subject.mp4', ...artifact, media }, sourceFiles: sources,
            elapsedMs: Math.round(performance.now() - started), hostToolCalls: context.hostToolCalls,
            checks: [{ id: 'preview:precheck', passed: true }, { id: 'preview:host-render', passed: true }, { id: 'preview:media', passed: true },
                { id: 'preview:source-unchanged', passed: true }, { id: 'preview:paired-evidence', passed: true }] }, evidence);
    } catch (error) {
        const failure = { ...record, status: error.code === 'REPRO_STAGE_CANCELLED' ? 'cancelled' : error.code === 'REPRO_STAGE_TIMEOUT' ? 'timed-out' : 'failed',
            elapsedMs: Math.round(performance.now() - started), hostToolCalls: context.hostToolCalls,
            error: { code: error.code || 'REPRO_STAGE_PREVIEW_FAILED', message: error.message }, process: error.renderProcess || record.process };
        await fs.writeFile(path.join(directory.root, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' });
        throw appError(error.code || 'REPRO_STAGE_PREVIEW_FAILED', error.message, { data: { preview: failure, stageEvidence: failure } });
    }
}

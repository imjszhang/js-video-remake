import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appError } from '../errors.js';
import { validateSpec } from './schema.js';
import { safeProjectFile, snapshotProject } from './project.js';
import { hashFile, verifyFrozenFile } from './evaluate.js';
import { rendererEnvironment, runFixedCommand } from './render.js';

export const STAGE_EVIDENCE_SCHEMA = 'video-remake.stage-evidence@1';
const SHA256 = /^[a-f0-9]{64}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,120}$/;
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const fail = message => appError('REPRO_STAGE_EVIDENCE_INVALID', message);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const round = value => Math.round(value * 1000) / 1000;

export function stageSamplingPlan(rawSpec, { shots, shotIds, maxSamples = 200 } = {}) {
    const spec = validateSpec(rawSpec);
    const duration = spec.acceptance.media.durationSec;
    const bounded = (value, exact) => {
        const time = Math.max(0, Math.min(duration, value));
        return exact ? time : round(time);
    };
    let ranges;
    if (shots !== undefined) {
        if (!Array.isArray(shots) || !shots.length || shots.length > 100) throw fail('阶段镜头表必须包含 1–100 个镜头。');
        const ids = new Set();
        const all = shots.map((shot, index) => {
            const id = shot.id ?? shot.shotId ?? `shot-${index + 1}`;
            const startSec = shot.startSec ?? shot.start;
            const endSec = shot.endSec ?? shot.end;
            if (!idPattern.test(id) || ids.has(id) || !Number.isFinite(startSec) || !Number.isFinite(endSec)
                || startSec < 0 || endSec <= startSec || endSec > duration + 0.0001) throw fail('阶段镜头标识或时间区间无效。');
            ids.add(id);
            return { id, startSec, endSec };
        });
        if (shotIds !== undefined && (!Array.isArray(shotIds) || !shotIds.length || new Set(shotIds).size !== shotIds.length || shotIds.some(id => !ids.has(id)))) throw fail('阶段镜头选择不在已验证镜头表内。');
        ranges = shotIds ? all.filter(shot => shotIds.includes(shot.id)) : all;
    } else {
        if (shotIds?.length) throw fail('选择镜头需要提供镜头表。');
        ranges = [{ id: 'whole-timeline', startSec: 0, endSec: duration }];
    }
    const times = new Map();
    const add = (time, reason, exact = false) => {
        const value = bounded(time, exact);
        const entry = times.get(value) || { requestedTimeSec: value, reasons: [] };
        if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
        times.set(value, entry);
    };
    for (const range of ranges) {
        const endInside = Math.max(range.startSec, range.endSec - 0.04);
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) add(range.startSec + (endInside - range.startSec) * fraction, `shot:${range.id}`);
        for (const boundary of [range.startSec, range.endSec]) for (const delta of [-0.08, 0, 0.08]) add(boundary + delta, `transition:${range.id}`);
    }
    const inScope = time => ranges.some(range => time >= range.startSec - 0.08 && time <= range.endSec + 0.08);
    for (const time of spec.acceptance.evidence.timestampsSec || []) if (inScope(time)) add(time, 'frozen-anchor', true);
    for (const time of spec.acceptance.evidence.boundariesSec || []) {
        for (const delta of [-0.08, 0, 0.08]) if (inScope(time + delta)) add(time + delta, 'frozen-boundary', delta === 0);
    }
    if (times.size > maxSamples) throw fail(`阶段需要 ${times.size} 个采样，超过 ${maxSamples} 个上限；请拆分镜头组，不得丢弃必查锚点。`);
    return { ranges, samples: [...times.values()].sort((a, b) => a.requestedTimeSec - b.requestedTimeSec),
        sourceTimeBasis: 'absolute-root-timeline', sampling: 'five-phases-plus-boundaries-and-frozen-anchors' };
}

export async function createStageEvidenceDirectory(evidenceRoot, { workspace, prefix = 'stage-evidence' } = {}) {
    if (typeof evidenceRoot !== 'string' || !path.isAbsolute(evidenceRoot)) throw fail('阶段证据目录必须使用绝对路径。');
    await fs.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(evidenceRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('阶段证据目录必须是真实目录。');
    const parent = await fs.realpath(evidenceRoot);
    if (workspace && inside(await fs.realpath(workspace), parent)) throw fail('阶段证据必须保存在执行工程之外。');
    const id = `${prefix}_${randomUUID()}`;
    const root = path.join(parent, id);
    await fs.mkdir(root, { mode: 0o700 });
    return { id, root };
}

export function stageCommandContext({ workspace, timeoutMs = 120_000, signal, env, onStart }, deps = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw fail('阶段采样超时无效。');
    const deadline = performance.now() + timeoutMs;
    const context = { hostToolCalls: 0, signal, remaining() {
        if (signal?.aborted) throw appError('REPRO_STAGE_CANCELLED', '阶段证据生成已取消。');
        const value = Math.floor(deadline - performance.now());
        if (value < 1) throw appError('REPRO_STAGE_TIMEOUT', '阶段证据生成超过时间预算。');
        return value;
    }, async run(executable, args, options = {}) {
        const remaining = context.remaining();
        context.hostToolCalls++;
        const result = await (deps.runCommand || runFixedCommand)(executable, args, {
            ...options, cwd: workspace, env: rendererEnvironment(workspace || process.cwd(), env || process.env), signal,
            timeoutMs: Math.min(remaining, options.timeoutMs || remaining), onStart,
        }, deps);
        context.remaining();
        if (result.termination) throw Object.assign(appError(result.termination === 'cancelled' ? 'REPRO_STAGE_CANCELLED' : 'REPRO_STAGE_TIMEOUT', '阶段媒体工具被取消或超过预算。'), { renderProcess: result });
        if (result.exitCode !== 0) throw Object.assign(appError('REPRO_STAGE_MEDIA_FAILED', `阶段媒体工具失败（退出码 ${result.exitCode}）。`), { renderProcess: result });
        return result;
    } };
    return context;
}

export async function stageProbeMedia(file, context, deps = {}) {
    if (deps.probeMedia) return checkedMedia(await deps.probeMedia(file));
    const result = await context.run(deps.ffprobePath || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', file], { timeoutMs: 15_000 });
    const raw = JSON.parse(result.stdout);
    const video = raw.streams?.find(stream => stream.codec_type === 'video');
    return checkedMedia({ width: Number(video?.width), height: Number(video?.height), durationSec: Number(raw.format?.duration ?? video?.duration),
        audioStreams: raw.streams?.filter(stream => stream.codec_type === 'audio').length || 0 });
}
function checkedMedia(value) {
    if (!value || !Number.isSafeInteger(value.width) || value.width <= 0 || !Number.isSafeInteger(value.height) || value.height <= 0
        || !Number.isFinite(value.durationSec) || value.durationSec <= 0 || !Number.isSafeInteger(value.audioStreams) || value.audioStreams < 0) throw fail('阶段媒体探测未返回有效视频。');
    return value;
}

export async function stageReferenceSources(references, context, deps = {}) {
    if (!Array.isArray(references) || !references.length) throw fail('阶段证据需要冻结参考视频。');
    const ids = new Set(['subject']);
    const sources = [];
    for (const reference of references) {
        const value = reference.source || reference;
        if (!idPattern.test(reference.id) || ids.has(reference.id) || !SHA256.test(value.sha256 || '')) throw fail('参考 ID 或冻结哈希无效。');
        ids.add(reference.id);
        const file = value.assetRoot && value.relVideo ? await safeProjectFile(value.assetRoot, value.relVideo) : value.videoPath || value.file;
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('参考视频需要绝对文件路径。');
        await verifyFrozenFile(path.dirname(file), path.basename(file), value.sha256);
        sources.push({ id: reference.id, file, sha256: value.sha256, media: await stageProbeMedia(file, context, deps) });
    }
    return sources;
}

async function pngInfo(file) {
    const bytes = await fs.readFile(file);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('阶段采样没有产生有效 PNG 文件。');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) throw fail('阶段采样 PNG 尺寸无效。');
    return { width, height };
}

async function extractFrame(file, output, initialSeekTimeSec, context, deps) {
    if (deps.extractFrame) return deps.extractFrame(file, output, initialSeekTimeSec, { signal: context.signal, timeoutMs: context.remaining() });
    const attempts = [...new Set([initialSeekTimeSec, Math.max(0, initialSeekTimeSec - 0.25), Math.max(0, initialSeekTimeSec - 1), 0])];
    for (const timeSec of attempts) {
        await context.run(deps.ffmpegPath || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-ss', String(timeSec), '-i', file,
            '-map', '0:v:0', '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", output], { timeoutMs: 30_000 });
        const info = await fs.lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (info?.isSymbolicLink()) throw fail('阶段截图不得为符号链接。');
        if (info?.isFile() && info.size) return { timeSec, framePtsSec: null };
        if (info) await fs.unlink(output);
    }
    throw fail('无法从视频提取有效阶段画面。');
}

export async function collectStageFrames(root, sources, samples, context, deps = {}) {
    const items = [];
    for (const [sourceIndex, source] of sources.entries()) {
        // Source IDs are metadata, not paths supplied by the maker.
        const folder = path.join('frames', `source-${sourceIndex}`);
        await fs.mkdir(path.join(root, folder), { recursive: true });
        for (const [index, sample] of samples.entries()) {
            context.remaining();
            const relative = path.join(folder, `frame-${String(index).padStart(3, '0')}.png`);
            const output = path.join(root, relative);
            const requestedTimeSec = sample.requestedTimeSec;
            const initialSeekTimeSec = Math.min(requestedTimeSec, Math.max(0, source.media.durationSec - 0.04));
            const captured = await extractFrame(source.file, output, initialSeekTimeSec, context, deps);
            context.remaining();
            const timeSec = captured?.timeSec;
            if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec > source.media.durationSec || timeSec > initialSeekTimeSec + 0.0001) throw fail('采样器返回无效的实际 seek 时间。');
            const info = await fs.lstat(output);
            if (!info.isFile() || info.isSymbolicLink() || !info.size) throw fail('阶段截图必须是新生成的非空普通文件。');
            items.push({ id: `${source.id}:frame:${index}`, sourceId: source.id, kind: 'frame', path: relative.split(path.sep).join('/'),
                ...(await hashFile(output)), ...(await pngInfo(output)), requestedTimeSec, sampleTimeSec: requestedTimeSec, timeSec,
                framePtsSec: Number.isFinite(captured.framePtsSec) ? captured.framePtsSec : null,
                timing: { requestedTimeSec, initialSeekTimeSec, seekTimeSec: timeSec, fallbackOffsetSec: initialSeekTimeSec - timeSec,
                    requestOffsetSec: requestedTimeSec - timeSec, framePtsSec: Number.isFinite(captured.framePtsSec) ? captured.framePtsSec : null },
                reasons: sample.reasons });
        }
    }
    context.remaining();
    for (const source of sources) await verifyFrozenFile(path.dirname(source.file), path.basename(source.file), source.sha256);
    return items;
}

function wavInfo(bytes) {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw fail('音频采样不是有效 PCM WAV。');
    let rate, channels, bits, dataBytes = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
        if (start + size > bytes.length) throw fail('音频采样块不完整。');
        if (kind === 'fmt ' && size >= 16) {
            if (bytes.readUInt16LE(start) !== 1) throw fail('音频采样必须是无压缩 PCM。');
            channels = bytes.readUInt16LE(start + 2); rate = bytes.readUInt32LE(start + 4); bits = bytes.readUInt16LE(start + 14);
        }
        if (kind === 'data') dataBytes += size;
        offset = start + size + size % 2;
    }
    if (rate !== 16000 || channels !== 1 || bits !== 16 || !dataBytes) throw fail('音频采样须为非空 16kHz 单声道 16 位 PCM。');
    return { sampleRate: rate, channels, bitsPerSample: bits, durationSec: dataBytes / (rate * channels * bits / 8) };
}

export async function collectStageAudio(root, sources, scope, spec, context, deps = {}) {
    const clipSec = Math.min(spec.acceptance.evidence.audioClipSec || 8, spec.acceptance.media.durationSec);
    const start = Math.min(...scope.ranges.map(range => range.startSec));
    const end = Math.max(...scope.ranges.map(range => range.endSec));
    const requests = [...new Set([start, Math.max(start, (start + end - clipSec) / 2), Math.max(start, end - clipSec)])];
    const items = [];
    for (const [sourceIndex, source] of sources.entries()) {
        if (!source.media.audioStreams) continue;
        const folder = path.join('audio', `source-${sourceIndex}`);
        await fs.mkdir(path.join(root, folder), { recursive: true });
        for (const [index, requestedTimeSec] of requests.entries()) {
            const durationSec = Math.min(clipSec, source.media.durationSec);
            const timeSec = Math.min(requestedTimeSec, Math.max(0, source.media.durationSec - durationSec));
            const relative = path.join(folder, `audio-${index}.wav`), output = path.join(root, relative);
            if (deps.extractAudio) await deps.extractAudio(source.file, output, timeSec, durationSec, { signal: context.signal, timeoutMs: context.remaining() });
            else await context.run(deps.ffmpegPath || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-ss', String(timeSec),
                '-i', source.file, '-t', String(durationSec), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], { timeoutMs: 30_000 });
            const info = await fs.lstat(output);
            if (!info.isFile() || info.isSymbolicLink()) throw fail('音频证据必须是新生成的普通文件。');
            items.push({ id: `${source.id}:audio:${index}`, sourceId: source.id, kind: 'audio', path: relative.split(path.sep).join('/'),
                ...(await hashFile(output)), ...wavInfo(await fs.readFile(output)), requestedTimeSec, sampleTimeSec: requestedTimeSec, timeSec,
                requestedDurationSec: durationSec, timing: { requestedTimeSec, seekTimeSec: timeSec, requestOffsetSec: requestedTimeSec - timeSec, samplePtsSec: null } });
        }
    }
    context.remaining();
    for (const source of sources) await verifyFrozenFile(path.dirname(source.file), path.basename(source.file), source.sha256);
    return items;
}

export async function finishStageEvidence(record, manifest) {
    const file = path.join(record.evidenceRoot, 'manifest.json');
    await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { ...record, status: 'completed', kind: manifest.kind, items: manifest.items, manifest, evidence: manifest,
        evidenceManifestSha256: (await hashFile(file)).sha256, qualityStatus: 'not-evaluated', finishedAt: new Date().toISOString() };
}

/** Full frozen source media lets analysis cite times between the fixed frame samples. */
async function collectReferenceVideos(root, sources, context) {
    const items = [];
    await fs.mkdir(path.join(root, 'videos'));
    for (const [index, source] of sources.entries()) {
        context.remaining();
        const relative = `videos/source-${index}.mp4`;
        const output = path.join(root, relative);
        const original = await hashFile(await verifyFrozenFile(path.dirname(source.file), path.basename(source.file), source.sha256));
        await fs.copyFile(source.file, output, constants.COPYFILE_EXCL);
        await fs.chmod(output, 0o600);
        const copied = await hashFile(output);
        if (copied.sha256 !== source.sha256 || copied.bytes !== original.bytes) throw fail('完整参考视频副本与冻结原片不一致。');
        await verifyFrozenFile(path.dirname(source.file), path.basename(source.file), source.sha256);
        context.remaining();
        source.bytes = original.bytes;
        items.push({ id: `${source.id}:video`, sourceId: source.id, kind: 'video', path: relative, ...copied,
            width: source.media.width, height: source.media.height, durationSec: source.media.durationSec,
            startSec: 0, endSec: source.media.durationSec, sourceTimeBasis: 'absolute-root-timeline', purpose: 'reference-observation-only' });
    }
    return items;
}

export async function prepareStageReference({ references, spec: rawSpec, evidenceRoot, signal, timeoutMs = 120_000, workspace, env, protocolHash = null }, deps = {}) {
    const spec = validateSpec(rawSpec);
    const started = performance.now();
    const directory = await createStageEvidenceDirectory(evidenceRoot, { workspace, prefix: 'reference-evidence' });
    const context = stageCommandContext({ workspace: directory.root, timeoutMs, signal, env, onStart: deps.onStart }, deps);
    const record = { id: directory.id, evidenceRoot: directory.root, status: 'running', previewJobs: 0, renderCalls: 0, startedAt: new Date().toISOString() };
    try {
        const sources = await stageReferenceSources(references, context, deps);
        const scope = stageSamplingPlan(spec);
        const items = await collectStageFrames(directory.root, sources, scope.samples, context, deps);
        items.push(...await collectReferenceVideos(directory.root, sources, context));
        const manifest = { schema: STAGE_EVIDENCE_SCHEMA, id: directory.id, kind: 'reference', protocolHash, scope,
            sources: sources.map(({ file, ...source }) => source), items, qualityStatus: 'not-evaluated' };
        return await finishStageEvidence({ ...record, scope, sourceFiles: sources, elapsedMs: Math.round(performance.now() - started), hostToolCalls: context.hostToolCalls,
            checks: [{ id: 'reference:integrity', passed: true }, { id: 'reference:host-samples', passed: true }, { id: 'reference:complete-media', passed: true }] }, manifest);
    } catch (error) {
        throw appError(error.code || 'REPRO_STAGE_EVIDENCE_FAILED', error.message, { data: { stageEvidence: { ...record,
            status: error.code === 'REPRO_STAGE_CANCELLED' ? 'cancelled' : error.code === 'REPRO_STAGE_TIMEOUT' ? 'timed-out' : 'failed',
            elapsedMs: Math.round(performance.now() - started), hostToolCalls: context.hostToolCalls, error: { code: error.code, message: error.message } } } });
    }
}

/** Revalidate host evidence. Maker-written self checks never satisfy this function. */
export async function validateStageEvidence(record, { workspace, protocolHash, verifySources = true } = {}) {
    if (record?.status !== 'completed' || !path.isAbsolute(record.evidenceRoot || '') || !SHA256.test(record.evidenceManifestSha256 || '')) throw fail('阶段证据没有完整宿主回执。');
    await verifyFrozenFile(record.evidenceRoot, 'manifest.json', record.evidenceManifestSha256);
    const manifest = JSON.parse(await fs.readFile(await safeProjectFile(record.evidenceRoot, 'manifest.json'), 'utf8'));
    if (manifest.schema !== STAGE_EVIDENCE_SCHEMA || manifest.id !== record.id || !['reference', 'stage-preview'].includes(manifest.kind)
        || !Array.isArray(manifest.items) || !manifest.items.length || canonical(manifest) !== canonical(record.manifest)
        || canonical(manifest.items) !== canonical(record.items)) throw fail('阶段证据回执与冻结清单不一致。');
    if (protocolHash !== undefined && manifest.protocolHash !== protocolHash) throw fail('阶段证据协议不匹配。');
    if (manifest.kind === 'stage-preview' && (record.sourceTreeHash !== manifest.sourceTreeHash || record.protocolHash !== manifest.protocolHash
        || canonical(record.scope) !== canonical(manifest.scope) || record.inputsHash !== manifest.inputsHash || record.assetLockHash !== manifest.assetLockHash)) throw fail('阶段源码、范围或身份回执与清单不一致。');
    if (workspace && record.sourceTreeHash && (await snapshotProject(workspace, { includeInputs: true })).treeHash !== record.sourceTreeHash) throw fail('源码已变化，阶段证据过期。');
    const ids = new Set();
    for (const item of manifest.items) {
        if (!idPattern.test(item.sourceId) || ids.has(item.id) || !['frame', 'audio', 'video'].includes(item.kind)
            || !SHA256.test(item.sha256 || '')) throw fail('阶段证据项目无效。');
        if (item.kind === 'video') {
            const sourceIndex = manifest.sources?.findIndex(source => source.id === item.sourceId);
            const source = sourceIndex >= 0 ? manifest.sources[sourceIndex] : null;
            if (manifest.kind !== 'reference' || !source || source.id === 'subject' || item.id !== `${source.id}:video`
                || item.path !== `videos/source-${sourceIndex}.mp4` || item.sha256 !== source.sha256
                || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes !== source.bytes
                || item.width !== source.media?.width || item.height !== source.media?.height || item.durationSec !== source.media?.durationSec
                || item.startSec !== 0 || item.endSec !== source.media?.durationSec || item.sourceTimeBasis !== 'absolute-root-timeline'
                || item.purpose !== 'reference-observation-only') throw fail('完整参考视频必须绑定冻结原片及其完整时间范围。');
        } else if (!Number.isFinite(item.requestedTimeSec) || !Number.isFinite(item.timeSec)) throw fail('阶段采样时间无效。');
        ids.add(item.id);
        const file = await verifyFrozenFile(record.evidenceRoot, item.path, item.sha256);
        if (item.kind === 'video' && (await fs.stat(file)).size !== item.bytes) throw fail('完整参考视频字节数与冻结回执不一致。');
    }
    if (verifySources) {
        if (!Array.isArray(record.sourceFiles) || canonical(record.sourceFiles.map(({ file, ...source }) => source)) !== canonical(manifest.sources)) throw fail('阶段原始媒体清单不匹配。');
        for (const source of record.sourceFiles) await verifyFrozenFile(path.dirname(source.file), path.basename(source.file), source.sha256);
    }
    if (manifest.kind === 'stage-preview') {
        const subject = manifest.items.filter(item => item.sourceId === 'subject' && item.kind === 'frame');
        const references = manifest.sources.filter(source => source.id !== 'subject');
        if (!subject.length || !references.length || subject.length !== manifest.scope.samples.length
            || subject.some(item => references.some(source => !manifest.items.some(ref => ref.kind === 'frame' && ref.sourceId === source.id && ref.requestedTimeSec === item.requestedTimeSec)))) throw fail('阶段证据缺少配对画面。');
        if (manifest.audio?.required && !manifest.items.some(item => item.sourceId === 'subject' && item.kind === 'audio')) throw fail('整合阶段缺少要求的音频证据。');
    }
    return manifest;
}

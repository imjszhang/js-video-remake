import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateSpec } from './schema.js';

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_SCHEMA = 'video-remake.reproduction-evidence@1';
const digest = value => createHash('sha256').update(value).digest('hex');
const EVALUATOR_SHA256 = digest(await fs.readFile(new URL(import.meta.url)));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function invalid(message) {
    return Object.assign(new Error(message), { code: 'REPRO_INVALID' });
}

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function relativePath(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\\\x00-\x1f]/.test(value)
        || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
        || value.split('/').some(part => !part || part === '.' || part === '..'
            || /^(?:\.git|node_modules|secrets?|credentials|\.ssh|\.aws|\.env(?:\..*)?)$/i.test(part))) {
        throw invalid('Evidence and media paths must be safe relative paths.');
    }
    return value;
}

async function regularFile(root, relative) {
    relativePath(relative);
    let current = path.resolve(root);
    const rootInfo = await fs.lstat(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw invalid('Artifact root must be a real directory.');
    const parts = relative.split('/');
    for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
            throw invalid(`Expected a regular ${index < parts.length - 1 ? 'directory' : 'file'} without symlinks: ${relative}`);
        }
    }
    return current;
}

/** Hash an open regular file and reject replacement or mutation while hashing. */
export async function hashFile(file) {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = await handle.stat();
        if (!before.isFile()) throw invalid('Media or evidence must be a regular file.');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat();
        const current = await fs.lstat(file);
        if (current.isSymbolicLink() || [after, current].some(info => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => info[key] !== before[key]))) {
            throw invalid('Media or evidence changed during hashing.');
        }
        return { sha256: hash.digest('hex'), bytes: before.size };
    } finally { await handle.close(); }
}

export async function verifyFrozenFile(root, relative, sha256) {
    if (!SHA256.test(sha256 || '')) throw invalid(`Missing frozen SHA256: ${relative}`);
    const file = await regularFile(root, relative);
    if ((await hashFile(file)).sha256 !== sha256) throw invalid(`Frozen media or evidence changed: ${relative}`);
    return file;
}

async function verifyAbsoluteFile(file, sha256) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw invalid('Frozen media must use an absolute runtime path.');
    return verifyFrozenFile(path.dirname(file), path.basename(file), sha256);
}

function mediaInfo(value) {
    if (!value || !Number.isInteger(value.width) || value.width <= 0
        || !Number.isInteger(value.height) || value.height <= 0
        || !Number.isFinite(value.durationSec) || value.durationSec <= 0
        || !Number.isInteger(value.audioStreams) || value.audioStreams < 0) {
        throw invalid('Media probe returned invalid dimensions, duration or audio stream count.');
    }
    return { width: value.width, height: value.height, durationSec: value.durationSec, audioStreams: value.audioStreams };
}

function mediaCommandOptions(options = {}, timeout = 30000) {
    const remaining = options.deadlineAt === undefined ? timeout : options.deadlineAt - Date.now();
    if (options.signal?.aborted || remaining <= 0) throw invalid('Media evidence cancelled or exceeded the reserved host deadline.');
    return { timeout: Math.min(timeout, remaining), maxBuffer: 1024 * 1024, windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) };
}
async function probe(file, binary = 'ffprobe', options = {}) {
    const { stdout } = await execFileAsync(binary, [
        '-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', file,
    ], mediaCommandOptions(options, 15_000));
    const value = JSON.parse(stdout);
    if (!Array.isArray(value.streams)) throw invalid('ffprobe did not return media streams.');
    const video = value.streams.find(stream => stream.codec_type === 'video');
    if (!video) throw invalid('No video stream.');
    return mediaInfo({
        width: Number(video.width), height: Number(video.height),
        durationSec: Number(value.format?.duration ?? video.duration),
        audioStreams: value.streams.filter(stream => stream.codec_type === 'audio').length,
    });
}

function errorMessage(error, relative) {
    if (error?.code === 'ENOENT') return `File or executable not found: ${relative}`;
    if (error?.killed || error?.code === 'ETIMEDOUT') return 'Media operation exceeded its timeout.';
    return String(error?.message ?? error).slice(0, 500);
}

function timestamps(spec, duration) {
    const policy = spec.acceptance.evidence || {};
    // Include opening, closing and intermediate motion phases. Explicit cut
    // boundaries contribute frames on both sides; cap work deterministically.
    const candidates = [0, ...[0.1, 0.25, 0.5, 0.75, 0.9].map(fraction => duration * fraction), duration - 0.08,
        ...(policy.timestampsSec || []), ...(policy.boundariesSec || []).flatMap(time => [time - 0.08, time, time + 0.08])];
    return [...new Set(candidates.filter(Number.isFinite).map(time => Math.round(Math.max(0, Math.min(duration - 0.04, time)) * 1000) / 1000))]
        .sort((a, b) => a - b).slice(0, 200);
}

async function defaultExtractFrame(file, output, timeSec, options = {}) {
    const { ffmpegPath = 'ffmpeg' } = options;
    // Sparse/variable-rate clips may have no frame after a seek very near EOF.
    // Record the actual fallback seek rather than inventing a captured time.
    for (const actualTime of [...new Set([timeSec, Math.max(0, timeSec - 0.25), Math.max(0, timeSec - 1), 0])]) {
        await execFileAsync(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-ss', String(actualTime), '-i', file,
            '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=\'min(1280,iw)\':-2', output],
        mediaCommandOptions(options));
        const info = await fs.stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (info?.size > 0) return { timeSec: actualTime };
        if (info) await fs.unlink(output);
    }
    throw invalid('The video did not yield an inspectable frame.');
}

async function defaultExtractAudio(file, output, timeSec, durationSec, options = {}) {
    const { ffmpegPath = 'ffmpeg' } = options;
    await execFileAsync(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-ss', String(timeSec), '-i', file,
        '-t', String(durationSec), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
    mediaCommandOptions(options));
}

async function evidenceBundle(workspace, spec, artifact, options) {
    if (!Array.isArray(options.references) || !options.references.length) throw invalid('Paired evidence needs a frozen reference video.');
    const resolvedWorkspace = await fs.realpath(workspace);
    await fs.mkdir(options.evidenceRoot, { recursive: true });
    const parent = await fs.realpath(options.evidenceRoot);
    if (inside(resolvedWorkspace, parent)) throw invalid('Evidence must be outside the mutable project workspace.');
    const sources = [{ id: 'subject', ...artifact, file: await regularFile(workspace, artifact.file) }];
    const probeMedia = options.probeMedia || (file => probe(file, options.ffprobePath, options));
    for (const reference of options.references) {
        if (!reference || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(reference.id || '') || reference.id === 'subject'
            || sources.some(source => source.id === reference.id)) throw invalid('References need unique safe IDs.');
        const value = reference.source || reference;
        const file = value.videoPath || value.file || (value.assetRoot && value.relVideo && await regularFile(value.assetRoot, value.relVideo));
        await verifyAbsoluteFile(file, value.sha256);
        const snapshot = await hashFile(file);
        sources.push({ id: reference.id, file, ...snapshot, media: mediaInfo(await probeMedia(file)) });
    }
    const root = path.join(parent, `evidence_${randomUUID()}`);
    await fs.mkdir(root, { mode: 0o700 });
    const manifest = { schema: EVIDENCE_SCHEMA, evaluator: 'video-remake/evaluate@1', evaluatorSha256: EVALUATOR_SHA256,
        specSha256: digest(canonical(spec)), sources, items: [] };
    const times = timestamps(spec, artifact.media.durationSec);
    const extractFrame = options.extractFrame || defaultExtractFrame;
    const extractAudio = options.extractAudio || defaultExtractAudio;
    for (const source of sources) {
        await fs.mkdir(path.join(root, source.id));
        for (const [index, requestedTime] of times.entries()) {
            const initialSeekTimeSec = Math.max(0, Math.min(source.media.durationSec - 0.04, requestedTime));
            let timeSec = initialSeekTimeSec;
            const relative = `${source.id}/frame-${String(index).padStart(3, '0')}.png`;
            const extracted = await extractFrame(source.file, path.join(root, relative), timeSec, options);
            if (Number.isFinite(extracted?.timeSec)) timeSec = extracted.timeSec;
            const file = await regularFile(root, relative);
            const frozen = await hashFile(file);
            if (frozen.bytes === 0) throw invalid(`Empty frame evidence: ${relative}`);
            await fs.chmod(file, 0o400);
            manifest.items.push({ id: `${source.id}:frame:${index}`, kind: 'frame', source: source.id, sourceSha256: source.sha256,
                path: relative, timeSec, sampleTimeSec: requestedTime,
                timing: { basis: 'decoder-seek', requestedTimeSec: requestedTime, initialSeekTimeSec, seekTimeSec: timeSec,
                    requestOffsetSec: timeSec - requestedTime, fallbackOffsetSec: timeSec - initialSeekTimeSec,
                    fallbackApplied: timeSec !== initialSeekTimeSec, framePtsSec: null }, ...frozen });
        }
        if (source.media.audioStreams > 0) {
            const clipSec = Math.min(30, spec.acceptance.evidence?.audioClipSec || 10, source.media.durationSec);
            const starts = [...new Set([0, Math.max(0, (source.media.durationSec - clipSec) / 2), Math.max(0, source.media.durationSec - clipSec)])];
            for (const [index, timeSec] of starts.entries()) {
                const relative = `${source.id}/audio-${index}.wav`;
                await extractAudio(source.file, path.join(root, relative), timeSec, clipSec, options);
                const file = await regularFile(root, relative);
                const frozen = await hashFile(file);
                if (frozen.bytes === 0) throw invalid(`Empty audio evidence: ${relative}`);
                await fs.chmod(file, 0o400);
                manifest.items.push({ id: `${source.id}:audio:${index}`, kind: 'audio', source: source.id, sourceSha256: source.sha256,
                    path: relative, timeSec, endTimeSec: timeSec + clipSec, ...frozen });
            }
        }
    }
    for (const source of sources) await verifyAbsoluteFile(source.file, source.sha256);
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await fs.writeFile(path.join(root, 'manifest.json'), text, { flag: 'wx', mode: 0o400 });
    return { evidenceRoot: root, evidenceManifestSha256: digest(text), evidence: manifest };
}

/** Revalidate durable evidence and its source media before accepting any review. */
export async function validateEvidenceReport(report, { verifySources = true, spec } = {}) {
    if (!report || !path.isAbsolute(report.evidenceRoot || '') || !SHA256.test(report.evidenceManifestSha256 || '')) {
        throw invalid('A frozen external evidence manifest is required.');
    }
    const manifestFile = await verifyFrozenFile(report.evidenceRoot, 'manifest.json', report.evidenceManifestSha256);
    const stat = await fs.stat(manifestFile);
    if (stat.size > 4 * 1024 * 1024) throw invalid('Evidence manifest exceeds 4 MiB.');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    if (canonical(manifest) !== canonical(report.evidence) || manifest.schema !== EVIDENCE_SCHEMA
        || !SHA256.test(manifest.specSha256 || '') || !Array.isArray(manifest.sources) || !Array.isArray(manifest.items)) {
        throw invalid('Evidence manifest does not match the frozen report.');
    }
    if (manifest.evaluatorSha256 !== undefined && !SHA256.test(manifest.evaluatorSha256)) throw invalid('Invalid evaluator implementation SHA256.');
    if (spec && digest(canonical(validateSpec(spec))) !== manifest.specSha256) throw invalid('Evidence belongs to a different frozen specification.');
    const ids = new Set();
    const sources = new Map();
    for (const source of manifest.sources) {
        if (!source || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(source.id || '') || sources.has(source.id)
            || !SHA256.test(source.sha256 || '') || !Number.isSafeInteger(source.bytes) || source.bytes <= 0) throw invalid('Invalid frozen evidence source.');
        mediaInfo(source.media);
        if (verifySources) await verifyAbsoluteFile(source.file, source.sha256);
        sources.set(source.id, source);
    }
    if (!sources.has('subject') || sources.size < 2 || sources.get('subject').sha256 !== report.artifact?.sha256) {
        throw invalid('Evidence must bind the evaluated subject and at least one reference.');
    }
    for (const item of manifest.items) {
        const source = sources.get(item?.source);
        if (!item || typeof item.id !== 'string' || ids.has(item.id) || !source
            || item.sourceSha256 !== source.sha256 || !['frame', 'audio'].includes(item.kind)
            || !Number.isFinite(item.timeSec) || item.timeSec < 0 || item.timeSec >= source.media.durationSec
            || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
            || (item.kind === 'audio' && (!Number.isFinite(item.endTimeSec) || item.endTimeSec <= item.timeSec || item.endTimeSec > source.media.durationSec + 0.001))) {
            throw invalid('Invalid evidence item or source binding.');
        }
        if (item.kind === 'frame' && item.timing !== undefined) {
            const timing = item.timing;
            const equal = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
            const initialSeek = Math.max(0, Math.min(source.media.durationSec - 0.04, item.sampleTimeSec));
            if (!timing || timing.basis !== 'decoder-seek' || timing.framePtsSec !== null
                || !Number.isFinite(item.sampleTimeSec) || item.sampleTimeSec < 0
                || !equal(timing.requestedTimeSec, item.sampleTimeSec) || !equal(timing.initialSeekTimeSec, initialSeek)
                || !equal(timing.seekTimeSec, item.timeSec) || !equal(timing.requestOffsetSec, item.timeSec - item.sampleTimeSec)
                || !equal(timing.fallbackOffsetSec, item.timeSec - initialSeek)
                || timing.fallbackApplied !== (item.timeSec !== initialSeek)) throw invalid('Invalid frame seek/fallback timing metadata; decoded frame PTS is not measured.');
        }
        ids.add(item.id);
        const file = await verifyFrozenFile(report.evidenceRoot, item.path, item.sha256);
        if ((await fs.stat(file)).size !== item.bytes) throw invalid('Evidence size changed.');
    }
    for (const source of sources.values()) {
        if (!manifest.items.some(item => item.source === source.id && item.kind === 'frame')) throw invalid('Each source requires frame evidence.');
        if (source.media.audioStreams > 0 && !manifest.items.some(item => item.source === source.id && item.kind === 'audio')) throw invalid('Audio sources require audio evidence.');
    }
    return manifest;
}

/** Frozen technical checks; optional paired evidence is generated by the host. */
export async function evaluateArtifacts(workspace, rawSpec, options = {}) {
    const spec = validateSpec(rawSpec);
    const checks = [];
    const add = (id, passed, message) => checks.push({ id, passed, message });
    for (const relative of spec.acceptance.requiredFiles || []) {
        try { await regularFile(workspace, relative); add(`required-file:${relative}`, true, `Present: ${relative}`); }
        catch (error) { add(`required-file:${relative}`, false, errorMessage(error, relative)); }
    }
    const expected = spec.acceptance.media;
    const report = { schema: 'video-remake.reproduction-evaluation@1', evaluatorSha256: EVALUATOR_SHA256, passed: false, checks, artifact: null };
    try {
        const file = await regularFile(workspace, expected.file);
        add('media:file', true, `Present: ${expected.file}`);
        const frozen = await hashFile(file);
        const media = mediaInfo(await (options.probeMedia || (file => probe(file, options.ffprobePath, options)))(file));
        await verifyFrozenFile(workspace, expected.file, frozen.sha256);
        report.artifact = { file: expected.file, ...frozen, media };
        add('media:probe', true, 'Media metadata and SHA256 verified.');
    } catch (error) {
        add('media:probe', false, errorMessage(error, expected.file));
        return report;
    }
    const media = report.artifact.media;
    add('media:width', media.width === expected.width, `Width ${media.width}; expected ${expected.width}`);
    add('media:height', media.height === expected.height, `Height ${media.height}; expected ${expected.height}`);
    add('media:duration', Math.abs(media.durationSec - expected.durationSec) <= (expected.toleranceSec ?? 0.5) + 1e-6,
        `Duration ${media.durationSec}s; expected ${expected.durationSec}s ± ${expected.toleranceSec ?? 0.5}s`);
    const audioPassed = expected.audio === 'optional' || (expected.audio === 'required' ? media.audioStreams > 0 : media.audioStreams === 0);
    add('media:audio', audioPassed, `Audio streams ${media.audioStreams}; ${expected.audio}`);
    if (options.evidenceRoot && checks.every(check => check.passed)) {
        try {
            Object.assign(report, await evidenceBundle(workspace, spec, report.artifact, options));
            await validateEvidenceReport(report, { spec });
            add('evidence:frozen', true, 'Paired frame/audio evidence generated outside the project and hash-verified.');
        } catch (error) { add('evidence:frozen', false, errorMessage(error, 'evidence')); }
    }
    report.passed = checks.every(check => check.passed);
    return report;
}

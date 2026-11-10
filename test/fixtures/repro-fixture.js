import { REVIEW_PROTOCOL } from '../../src/repro/review-protocol.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeRepro, loadRun } from '../../src/repro/workflow.js';
import { freezeTemplate } from '../../src/repro/template-store.js';

const exec = promisify(execFile);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const teacher = 'teacher-demo';
export const template = 'demo@1';
export async function write(root, relative, value) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === 'object' && !Buffer.isBuffer(value) ? `${JSON.stringify(value, null, 2)}\n` : value);
    return file;
}
export async function read(root, relative) { return JSON.parse(await fs.readFile(path.join(root, relative), 'utf8')); }
export async function files(root, prefix = '') {
    const result = [];
    for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) result.push(...await files(root, relative)); else result.push(relative);
    }
    return result.sort();
}
export const renderer = `import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = JSON.parse(await fs.readFile(path.join(root, 'inputs/values.json'), 'utf8'));
const color = inputs.title.startsWith('Teacher') ? 'navy' : 'teal';
await fs.mkdir(path.join(root, 'outputs'), {recursive:true});
const result = spawnSync('ffmpeg', ['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c='+color+':s=160x120:r=10:d=2','-c:v','libx264','-pix_fmt','yuv420p',path.join(root,'outputs/final.mp4')], {stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
`;

export async function fixture(t, { realMedia = false, maxCalls = 30, maxAttempts = 3, maxRenderCalls, renderProvider = 'agent', fileInput = false } = {}) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repro-workflow-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'host');
    const agentHome = path.join(directory, 'state');
    const assetRoot = path.join(directory, 'assets');
    await fs.mkdir(workspace);
    await fs.mkdir(assetRoot);
    const videoPath = path.join(assetRoot, 'reference.mp4');
    if (realMedia) {
        await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=160x120:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
    } else await fs.writeFile(videoPath, 'reference media');
    const referenceId = 'youtube-fixture';
    await write(workspace, `references/${referenceId}/SOURCE.json`, { schema: 'video-remake.source@1', platform: 'youtube', archiveVideoId: 'fixture', assetRoot, videoPath, relVideo: 'reference.mp4', sha256: hash(await fs.readFile(videoPath)) });
    await write(workspace, `productions/${teacher}/BRIEF.md`, 'Replace the title.');
    const catalogPath = await write(workspace, 'catalog.json', { version: 1, references: [{ id: referenceId, archiveVideoId: 'fixture', dir: `references/${referenceId}` }], productions: [{ slug: teacher, dir: `productions/${teacher}`, referenceIds: [referenceId], status: 'commissioned' }] });
    const spec = {
        schema: 'video-remake.reproduction@2', title: 'Fixture video', objective: 'Reproduce the layout with a new title.',
        preserve: ['Composition and timing'], replace: ['Title'], inputs: { title: { type: 'text', required: true }, logo: { type: 'file', required: false } },
        acceptance: { media: { file: 'outputs/final.mp4', width: 160, height: 120, durationSec: 2, toleranceSec: 0.1, audio: 'forbidden' },
            requiredFiles: ['src/index.html'], review: [{ id: 'layout', description: 'The layout matches.', modality: 'visual' }] }, maxAttempts,
    };
    await write(workspace, 'spec.json', spec);
    await write(workspace, 'teacher-inputs.json', { title: 'Teacher product', ...(fileInput ? { logo: 'assets/logo.svg' } : {}) });
    await write(workspace, 'student-inputs.json', { title: 'Student product', ...(fileInput ? { logo: 'assets/logo.svg' } : {}) });
    if (fileInput) await write(workspace, 'assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await write(workspace, 'reproduction-workflow.json', { schemaVersion: 1, roles: { teacher: 'high', extractor: 'high', executor: 'small', reviewer: 'reviewer' }, policy: { maxCalls, maxAttempts, maxRenderCalls, renderProvider } });
    const config = { workspace, catalogPath, assetRoot, env: { VIDEO_REMAKE_AGENT_HOME: agentHome } };
    const f = { directory, workspace, agentHome, config, spec, realMedia, calls: [], model: 'fixture-model', targetHash: null, fail: false, sameMedia: false };
    f.deps = realMedia ? {} : {
        probeMedia: async () => ({ width: 160, height: 120, durationSec: 2, audioStreams: 0 }),
        extractFrame: async (file, output, time) => fs.writeFile(output, `${file}:frame:${time}`),
    };
    f.deps.runProjectAgent = async (_config, options) => {
        const call = { ...options, filesBefore: await files(options.workspace) };
        f.calls.push(call);
        const target = options.target || options.workflow?.roles?.[options.role];
        const targetHash = f.targetHash || hash(target);
        if (options.expectedTargetHash && options.expectedTargetHash !== targetHash) throw Object.assign(new Error('Frozen target configuration changed.'), { code: 'CONFIG_CHANGED' });
        if (options.role === 'reviewer') {
            const evidence = await read(options.workspace, 'EVIDENCE.json');
            const subject = await read(options.workspace, 'SUBJECT.json');
            const task = await read(options.workspace, 'TASK.json');
            await write(options.workspace, 'REVIEW.json', { schema: 'video-remake.reproduction-review@2', protocolVersion: REVIEW_PROTOCOL.version, reviewer: 'model',
                artifactSha256: subject.artifactSha256, evidenceManifestSha256: evidence.evidenceManifestSha256,
                checks: task.acceptance.review.map(criterion => ({ id: criterion.id, status: f.reviewStatus || 'pass', observationStatus: f.reviewStatus === 'unobserved' ? 'unobserved' : 'observed', modalities: f.reviewStatus === 'unobserved' ? [] : ['visual'], notes: f.reviewStatus === 'unobserved' ? 'Unavailable visual inspection.' : 'Observed matching title layout in paired frames.',
                    evidenceIds: f.reviewStatus === 'unobserved' ? [] : evidence.items.filter(item => item.kind === 'frame' && item.id.endsWith(':0')).map(item => item.id) })) });
        } else if (options.role === 'extractor') {
            call.teacherMediaPresent = call.filesBefore.includes('outputs/final.mp4');
            call.teacherInputPresent = call.filesBefore.includes('inputs/values.json');
            await fs.appendFile(path.join(options.workspace, '.agents/skills/reproduce/SKILL.md'), '\nMaintain title anchoring; use font reduction for longer replacement text.\n');
            const recipe = await read(options.workspace, 'recipe.json');
            recipe.contentReview = { reviewer: 'fixture-extractor', notes: 'Methods only; no target implementation.', containsTargetImplementation: false };
            await write(options.workspace, 'recipe.json', recipe);
            if (f.extractMutation) await f.extractMutation(options.workspace);
        } else {
            const input = await read(options.workspace, 'inputs/values.json');
            call.inputs = input;
            await write(options.workspace, 'src/index.html', '<!doctype html><html><body><main id="title">Title template</main></body></html>');
            const manifest = await read(options.workspace, 'reproduction.json');
            await write(options.workspace, 'reproduction.json', { ...manifest, status: 'ready' });
            await write(options.workspace, 'scripts/render.mjs', renderer);
            if (realMedia) await exec(process.execPath, ['scripts/render.mjs'], { cwd: options.workspace });
            else await write(options.workspace, 'outputs/final.mp4', `rendered:${f.sameMedia ? 'constant' : input.title}`);
            if (f.mutate) await f.mutate(options.workspace);
        }
        return { runId: `agent-${f.calls.length}`, status: f.fail && options.role !== 'reviewer' ? 'failed' : 'completed', target, targetHash,
            role: options.role, requestedModel: f.model, observedModel: f.model, model: f.model,
            harness: 'fixture-harness', contextMode: 'explicit-context', usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, costUsd: 0.001, toolCalls: 2, renderCalls: options.role === 'teacher' || options.role === 'executor' ? 1 : 0 };
    };
    f.deps.resolveRole = async (_config, workflow, role, options) => ({ targetHash: f.targetHash || hash(options.target || workflow.roles[role]) });
    f.execute = (action, subject, options = {}) => executeRepro(config, action, subject, options, f.deps);
    f.load = slug => loadRun(config, slug);
    f.init = options => f.execute('init', teacher, { spec: 'spec.json', inputs: 'teacher-inputs.json', ...options });
    f.make = async () => { await f.init(); return f.execute('teacher', teacher); };
    f.candidate = async () => {
        await f.make();
        await f.execute('judge', teacher);
        // Build a historical archive fixture directly. Product creation now
        // extracts methods; compatibility tests must explicitly use replay.
        const state = await f.load(teacher);
        const record = await freezeTemplate(config, { source: state.workspace, name: 'demo', version: 1, spec: state.spec,
            provenance: { teacher: { runId: state.id, inputsHash: state.inputsHash }, references: state.references, developmentInputs: [state.inputsHash] } });
        return { template: record.id, path: record.root, treeHash: record.treeHash, status: 'candidate', generationMode: 'project-replay' };
    };
    f.trial = (slug = 'student-demo', options = {}) => f.execute('replay', template, { as: slug, inputs: 'student-inputs.json', run: true, ...options });
    f.acceptTrial = async (slug = 'student-demo', options = {}) => { await f.trial(slug, options); return f.execute('judge', slug); };
    return f;
}

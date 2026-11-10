#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgv, HELP } from '../src/args.js';
import { resolveConfig } from '../src/config.js';
import { fail, ok, printHuman } from '../src/format.js';
import { bindVideo } from '../src/bind.js';
import { scanReferences } from '../src/reference-scan.js';
import { downloadReference, downloadDoctor } from '../src/downloads/index.js';
import { importReference, listReferences } from '../src/references.js';
import { ingestUrl } from '../src/ingest.js';
import { getEntry, listCatalog, startProduction } from '../src/start.js';
import { projectPaths } from '../src/paths.js';
import { deliverProduction } from '../src/deliver.js';
import { compareProduction } from '../src/compare.js';
import { writeCaptions } from '../src/captions.js';
import { normalizeAsset } from '../src/normalize.js';
import { studioProduction, timelineProduction } from '../src/studio.js';
import { runDoctor } from '../src/doctor.js';
import { appError } from '../src/errors.js';
import { mediaDoctor, mediaPrepare, mediaImage, mediaVideo, mediaLand, mediaTranscribe } from '../src/media/index.js';
import { addVideoAsset, checkVideo, forkVideo, importVideo, listVideosCommand, newVideo, packVideo, renderVideo, unpackVideo, remixTemplate } from '../src/videos.js';

export async function execute(parsed, env = process.env, deps = {}) {
    if (parsed.help || !parsed.command) return { help: true };
    const quality = parsed.flags.quality;
    const config = resolveConfig({
        ...parsed.config,
        quality: quality || parsed.config.quality,
    }, env);
    config.env = env;

    if (parsed.command.startsWith('repro:') || parsed.command.startsWith('harness:')) {
        const legacy = parsed.command.startsWith('harness:');
        const action = parsed.command.split(':')[1];
        const expected = ['list', 'config', 'doctor'].includes(action) ? 0 : 1;
        if (parsed.positionals.length !== expected) throw appError('INVALID_INPUT', `${parsed.command} ${expected ? '需要一个制作 slug、模板标识或路径' : '不接受位置参数'}。`);
        if (legacy && action !== 'status') throw appError('REPRO_MIGRATION_REQUIRED', '旧配方执行已移除。先用 repro:migrate name@version --dry-run 检查迁移；新项目使用 repro:* 命令。');
        const { executeRepro } = await import('../src/repro/workflow.js');
        const data = await executeRepro(config, action, parsed.positionals[0], parsed.flags, deps);
        if (legacy) data.warning = 'harness:* 已弃用，请使用 repro:*；旧 HARNESS.json 历史记录由 repro:migrate 读取。';
        return ok(data);
    }

    if (parsed.command.startsWith('agent:')) {
        const action = parsed.command.slice('agent:'.length);
        const count = parsed.positionals.length;
        const expected = ['logs', 'cancel'].includes(action) ? 1 : 0;
        if (action === 'status' ? count > 1 : count !== expected) {
            throw appError('INVALID_INPUT', `${parsed.command} ${action === 'status' ? '接受可选 run ID' : expected ? '需要一个 run ID' : '不接受位置参数'}。`);
        }
        const { executeAgent } = await import('../src/agent.js');
        return ok(await executeAgent(config, action, {
            agentConfig: parsed.flags.agentConfig,
            target: parsed.flags.target,
            instruction: parsed.flags.instruction,
            instructionFile: parsed.flags.instructionFile,
            production: parsed.flags.production,
            inputs: parsed.flags.input,
            skills: parsed.flags.skill,
            timeoutMs: parsed.flags.timeoutMs,
            runId: parsed.positionals[0],
            stream: parsed.flags.stream,
            lines: parsed.flags.lines,
            checkLogin: parsed.flags.checkLogin,
        }, deps));
    }

    if (parsed.command === 'doctor') return ok(await runDoctor(config, { ...deps, env }));
    if (parsed.command === 'reference:scan') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'reference:scan 需要一个文件夹路径。');
        return ok(await scanReferences(config, {
            directory: parsed.positionals[0], recursive: !!parsed.flags.recursive,
            import: !!parsed.flags.import, select: parsed.flags.select || [],
        }));
    }
    if (parsed.command === 'reference:download') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'reference:download 需要一个视频链接。');
        return ok(await downloadReference(config, { url: parsed.positionals[0], quality: quality || config.quality }, deps));
    }
    if (parsed.command === 'download:doctor') {
        if (parsed.positionals.length) throw appError('INVALID_INPUT', 'download:doctor 不接受位置参数。');
        const data = await downloadDoctor(config, deps);
        if (!data.ready) throw appError('DOCTOR_FAILED', '下载工具尚未就绪。', { data });
        return ok(data);
    }
    if (parsed.command === 'reference:list') {
        if (parsed.positionals.length) throw appError('INVALID_INPUT', 'reference:list 不接受位置参数。');
        return ok(await listReferences(config));
    }
    if (parsed.command === 'reference:import') {
        if (parsed.positionals.length > 1) throw appError('INVALID_INPUT', 'reference:import 只接受一个本地文件，或 --manifest FILE。');
        return ok(await importReference(config, {
            file: parsed.positionals[0], manifest: parsed.flags.manifest,
            id: parsed.flags.id, title: parsed.flags.title,
        }));
    }
    if (parsed.command === 'ingest') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'ingest requires exactly one URL.');
        return ok(await ingestUrl(config, {
            url: parsed.positionals[0],
            force: !!parsed.flags.force,
            quality: quality || config.quality,
        }));
    }
    if (parsed.command === 'bind') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'bind requires a video ID.');
        return ok(await bindVideo(config, parsed.positionals[0], {
            requestedQuality: quality || config.quality,
        }));
    }
    if (parsed.command === 'start') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'start requires a reference id.');
        if (!parsed.flags.as) throw appError('INVALID_INPUT', 'start requires --as <slug>.');
        return ok(await startProduction(config, {
            refId: parsed.positionals[0],
            slug: parsed.flags.as,
            width: parsed.flags.width,
            height: parsed.flags.height,
            fps: parsed.flags.fps,
            duration: parsed.flags.duration,
        }));
    }
    if (parsed.command === 'list') {
        if (parsed.positionals.length) throw appError('INVALID_INPUT', 'list does not take a positional argument.');
        return ok(await listCatalog(config));
    }
    if (parsed.command === 'get') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'get requires a reference id or production slug.');
        return ok(await getEntry(config, parsed.positionals[0]));
    }
    if (parsed.command === 'paths') return ok(await projectPaths(config, { env }));
    if (parsed.command === 'deliver') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'deliver requires a production slug.');
        return ok(await deliverProduction(config, {
            slug: parsed.positionals[0],
            from: parsed.flags.from,
            build: parsed.flags.build,
            output: parsed.flags.output,
        }));
    }
    if (parsed.command === 'compare') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'compare requires a production slug.');
        if (!parsed.flags.top) throw appError('INVALID_INPUT', 'compare requires --top <file>.');
        return ok(await compareProduction(config, {
            slug: parsed.positionals[0],
            top: parsed.flags.top,
            bottom: parsed.flags.bottom,
            topLabel: parsed.flags.topLabel,
            bottomLabel: parsed.flags.bottomLabel,
            audio: parsed.flags.audio,
            topStart: parsed.flags.topStart,
            bottomStart: parsed.flags.bottomStart,
            duration: parsed.flags.duration,
        }));
    }
    if (parsed.command.startsWith('media:')) {
        const action = parsed.command.slice('media:'.length);
        const expected = ['doctor', 'prepare', 'image', 'video'].includes(action) ? 0 : 1;
        if (parsed.positionals.length !== expected) throw appError('INVALID_INPUT', `${parsed.command} ${expected ? '需要一个制作 slug' : '不接受位置参数'}。`);
        const slug = parsed.positionals[0];
        if (action === 'doctor') return ok(await mediaDoctor(config, { task: parsed.flags.task }, deps));
        if (action === 'prepare') return ok(await mediaPrepare(config, { task: parsed.flags.task, request: parsed.flags.request }, deps));
        if (action === 'image') return ok(await mediaImage(config, parsed.flags, deps));
        if (action === 'video') return ok(await mediaVideo(config, parsed.flags, deps));
        if (action === 'transcribe') {
            return ok(await mediaTranscribe(config, {
                slug, from: parsed.flags.from, id: parsed.flags.id, language: parsed.flags.language, force: parsed.flags.force, require: parsed.flags.require,
            }, deps));
        }
        return ok(await mediaLand(config, {
            slug, kind: parsed.flags.kind, from: parsed.flags.from, intent: parsed.flags.intent, provider: parsed.flags.provider, id: parsed.flags.id,
        }));
    }
    if (parsed.command === 'video:unpack') {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', 'video:unpack 需要一个 .video 文件路径。');
        return ok(await unpackVideo(config, { file: parsed.positionals[0], slug: parsed.flags.as }, deps));
    }
    if (parsed.command.startsWith('video:')) {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', `${parsed.command} 需要一个制作 slug。`);
        const slug = parsed.positionals[0];
        const { flags } = parsed;
        const action = parsed.command.slice('video:'.length);
        if (action === 'generate') {
            const { generateTemplate } = await import('../src/template-agent.js');
            return ok(await generateTemplate(config, { slug, name: flags.video, title: flags.title, prompt: flags.prompt, subtitleScript: flags.subtitleScript, target: flags.target, mode: flags.mode }, deps));
        }
        if (action === 'remix') {
            let style;
            if (flags.style) {
                try { style = JSON.parse(await fs.readFile(path.resolve(config.workspace, flags.style), 'utf8')); }
                catch { throw appError('INVALID_INPUT', '--style 需要有效的样式 JSON 文件。'); }
            }
            return ok(await remixTemplate(config, { slug, name: flags.video, title: flags.title, style }, deps));
        }
        if (action === 'new') {
            return ok(await newVideo(config, {
                slug, name: flags.as, width: flags.width, height: flags.height, fps: flags.fps, duration: flags.duration, skipInstall: flags.skipInstall,
            }, deps));
        }
        if (action === 'fork') return ok(await forkVideo(config, { slug, from: flags.video, name: flags.as, skipInstall: flags.skipInstall }, deps));
        if (action === 'list') return ok(await listVideosCommand(config, { slug }));
        if (action === 'render') return ok(await renderVideo(config, { slug, name: flags.video }, deps));
        if (action === 'import') return ok(await importVideo(config, { slug, name: flags.video, force: flags.force }, deps));
        if (action === 'pack') return ok(await packVideo(config, { slug, name: flags.video, out: flags.out, force: flags.force }, deps));
        return ok(await addVideoAsset(config, { slug, name: flags.video, id: flags.id, force: flags.force }));
    }
    if (['check', 'captions', 'normalize', 'studio', 'timeline'].includes(parsed.command)) {
        if (parsed.positionals.length !== 1) throw appError('INVALID_INPUT', `${parsed.command} 需要一个制作 slug。`);
        const slug = parsed.positionals[0];
        const video = parsed.flags.video;
        if (parsed.command === 'check') return ok(await checkVideo(config, { slug, name: video }, deps));
        if (parsed.command === 'captions') return ok(await writeCaptions(config, { slug, video, from: parsed.flags.from, maxChars: parsed.flags.maxChars, fps: parsed.flags.fps }, deps));
        if (parsed.command === 'normalize') return ok(await normalizeAsset(config, { slug, id: parsed.flags.id, duration: parsed.flags.duration, fps: parsed.flags.fps, alpha: parsed.flags.alpha }, deps));
        if (parsed.command === 'studio') return ok(await studioProduction(config, { slug, video, stop: parsed.flags.stop, status: parsed.flags.status }, deps));
        return ok(await timelineProduction(config, { slug, video, json: parsed.flags.json }, deps));
    }
    throw appError('INVALID_INPUT', `Unknown command: ${parsed.command}`);
}

export async function main(argv = process.argv.slice(2), io = {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
}, env = process.env) {
    try {
        const parsed = parseArgv(argv);
        if (parsed.help || !parsed.command) {
            io.stdout(HELP);
            return 0;
        }
        const result = await execute(parsed, env, {
            onEvent: (event) => {
                if (event.type === 'started' && !parsed.flags.json) io.stderr(`Agent 已启动: ${event.runId}（可用 agent:status / agent:logs 查看进度）`);
            },
        });
        if (result.help) {
            io.stdout(HELP);
            return 0;
        }
        if (parsed.flags.json) io.stdout(JSON.stringify(result));
        else printHuman(result, io.stdout);
        return result.ok ? 0 : 1;
    } catch (error) {
        const result = fail(error);
        if (argv.includes('--json')) io.stdout(JSON.stringify(result));
        else printHuman(result, io.stdout);
        return 1;
    }
}

function isDirectRun() {
    try {
        return !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
    } catch {
        return false;
    }
}

if (isDirectRun()) {
    // Let stdout/stderr drain: execution plans can exceed a pipe's buffer.
    main().then((code) => { process.exitCode = code; });
}

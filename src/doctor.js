import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createSourceProvider } from './sources/index.js';
import { WORKSPACE_DIRS } from './config.js';
import { appError } from './errors.js';
import { normalizeCatalog } from './schema.js';
import { HYPERFRAMES_VERSION } from './repro/project.js';
import { HYPERFRAMES_CLI, HYPERFRAMES_PACKAGE } from './repro/render.js';
import { STUDIO_PORT, studioPortOpen } from './studio.js';

async function readableDir(dir) {
    try {
        await fs.access(dir);
        const stat = await fs.stat(dir);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

export function nodeInfo(version = process.version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
    const major = Number(match?.[1]);
    const minor = Number(match?.[2]);
    return { version, ok: Boolean(match) && (major > 22 || (major === 22 && minor >= 15)) };
}

export function whichCommand(bin, { spawnImpl = spawn, env = process.env } = {}) {
    return new Promise((resolve) => {
        const child = spawnImpl('which', [bin], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.on('error', () => resolve(''));
        child.on('close', (code) => resolve(code === 0 ? stdout.trim() : ''));
    });
}

async function commandTool(name, options, warnings) {
    const found = await whichCommand(name, options);
    const tool = {
        name,
        path: found,
        available: Boolean(found),
        hint: found ? '' : `${name} 未找到。对比片和成片检查需要它。`,
    };
    if (!tool.available) warnings.push(tool.hint);
    return tool;
}

async function hyperframesTool(warnings) {
    try {
        await fs.access(HYPERFRAMES_CLI);
        const pkg = JSON.parse(await fs.readFile(HYPERFRAMES_PACKAGE, 'utf8'));
        const available = pkg.version === HYPERFRAMES_VERSION;
        const tool = {
            name: 'hyperframes',
            path: HYPERFRAMES_CLI,
            version: pkg.version,
            expected: HYPERFRAMES_VERSION,
            available,
            hint: available ? '' : `需要锁定的 hyperframes@${HYPERFRAMES_VERSION}，当前是 ${pkg.version}。`,
        };
        if (!available) warnings.push(tool.hint);
        return tool;
    } catch {
        const tool = {
            name: 'hyperframes',
            path: HYPERFRAMES_CLI,
            version: '',
            expected: HYPERFRAMES_VERSION,
            available: false,
            hint: `未安装锁定的 hyperframes@${HYPERFRAMES_VERSION}，请运行 npm ci。`,
        };
        warnings.push(tool.hint);
        return tool;
    }
}

export async function localTools(options = {}) {
    const warnings = [];
    const [ffmpeg, ffprobe, hyperframes] = await Promise.all([
        commandTool('ffmpeg', options, warnings),
        commandTool('ffprobe', options, warnings),
        hyperframesTool(warnings),
    ]);
    return { ffmpeg, ffprobe, hyperframes, warnings };
}

export async function runDoctor(config, options = {}) {
    const warnings = [];
    const node = nodeInfo();
    const dirs = {};
    for (const name of WORKSPACE_DIRS) {
        dirs[name] = await readableDir(`${config.workspace}/${name}`);
    }
    const workspaceOk = Object.values(dirs).every(Boolean);
    let catalog = { path: config.catalogPath, ok: false };
    try {
        const raw = JSON.parse(await fs.readFile(config.catalogPath, 'utf8'));
        normalizeCatalog(raw);
        catalog = { path: config.catalogPath, ok: true };
    } catch (error) {
        catalog = { path: config.catalogPath, ok: false, error: error.message };
    }

    const assetReadable = await readableDir(config.assetRoot);
    const assetRequired = config.source.provider !== 'local';
    const provider = createSourceProvider(config, options);
    let source;
    try {
        source = { provider: provider.kind, location: provider.location, available: true, health: await provider.health() };
    } catch (error) {
        source = { provider: provider.kind, location: provider.location, available: false, hint: error.message };
    }

    const tools = await localTools(options);
    warnings.push(...tools.warnings);
    if (await studioPortOpen(STUDIO_PORT, options)) warnings.push(`Studio 端口 ${STUDIO_PORT} 已被占用。`);

    const data = {
        command: 'doctor',
        node,
        workspace: { path: config.workspace, ok: workspaceOk, dirs },
        catalog,
        assetRoot: { path: config.assetRoot, readable: assetReadable, required: assetRequired },
        source,
        tools: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, hyperframes: tools.hyperframes },
        warnings,
    };

    if (!node.ok) throw Object.assign(appError('DOCTOR_FAILED', '需要 Node.js >= 22.15.0'), { data });
    if (!workspaceOk) throw Object.assign(appError('DOCTOR_FAILED', '工作台目录不完整'), { data });
    if (!catalog.ok) throw Object.assign(appError('DOCTOR_FAILED', 'catalog.json 无效'), { data });
    if (assetRequired && !assetReadable) throw Object.assign(appError('DOCTOR_FAILED', `asset-root 不可读: ${config.assetRoot}`), { data });
    if (!source.available) throw Object.assign(appError('DOCTOR_FAILED', '素材数据源不可用'), { data });
    return data;
}

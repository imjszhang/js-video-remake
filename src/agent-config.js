import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { plan, validateTarget } from 'js-agent-runtime';
import { appError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 86_400_000;

function invalid(message) {
    return appError('CONFIG_INVALID', message);
}

function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalid(`${label} must be an object.`);
    }
    return value;
}

function fields(value, allowed, label) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw invalid(`Unknown ${label} field: ${key}`);
    }
}

function resolvePath(value, base, label) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
        throw invalid(`${label} must be a nonempty path.`);
    }
    const expanded = value === '~' ? os.homedir()
        : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
    return path.resolve(base, expanded);
}

// Resolve existing ancestors too: a new log directory may sit under a symlink.
function canonicalPath(filePath) {
    let current = filePath;
    const suffix = [];
    while (true) {
        try {
            return path.join(fs.realpathSync(current), ...suffix);
        } catch (error) {
            if (error.code !== 'ENOENT') throw invalid(`Cannot resolve agent storage path: ${filePath}`);
            const parent = path.dirname(current);
            if (parent === current) throw invalid(`Cannot resolve agent storage path: ${filePath}`);
            suffix.unshift(path.basename(current));
            current = parent;
        }
    }
}

function contains(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(first, second) {
    return contains(first, second) || contains(second, first);
}

export function agentStorageRoot(config, env = config.env || process.env) {
    const workspace = resolvePath(config.workspace, process.cwd(), 'workspace');
    const canonicalWorkspace = canonicalPath(workspace);
    const workspaceId = createHash('sha256').update(canonicalWorkspace).digest('hex').slice(0, 16);
    const stateHome = env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
    const root = env.VIDEO_REMAKE_AGENT_HOME !== undefined
        ? resolvePath(env.VIDEO_REMAKE_AGENT_HOME, process.cwd(), 'VIDEO_REMAKE_AGENT_HOME')
        : path.join(resolvePath(stateHome, process.cwd(), 'XDG_STATE_HOME'), 'video-remake', 'agents', workspaceId);
    if (overlaps(workspace, root) || overlaps(canonicalWorkspace, canonicalPath(root))) {
        throw invalid('Agent storage must be outside the workspace and must not contain it. Set VIDEO_REMAKE_AGENT_HOME to a separate directory.');
    }
    return root;
}

export async function loadAgentConfig(config, { configPath, env = config.env || process.env } = {}) {
    const workspace = resolvePath(config.workspace, process.cwd(), 'workspace');
    const selectedPath = resolvePath(
        configPath ?? env.VIDEO_REMAKE_AGENT_CONFIG ?? path.join(workspace, 'agent-runtime.json'),
        workspace,
        'Agent configuration path',
    );
    let raw;
    try {
        raw = JSON.parse(await readFile(selectedPath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw invalid(`Agent configuration does not exist: ${selectedPath}. Copy agent-runtime.example.json to agent-runtime.json and enable the target you want to use.`);
        }
        throw invalid(`Cannot read or parse agent configuration: ${selectedPath}`);
    }
    object(raw, 'Agent configuration');
    fields(raw, ['schemaVersion', 'defaultTarget', 'timeoutMs', 'targets', 'mcp'], 'agent configuration');
    if (raw.schemaVersion !== 1) throw invalid('Agent configuration schemaVersion must be 1.');
    if (raw.mcp !== undefined) {
        object(raw.mcp, 'Agent mcp');
        fields(raw.mcp, ['projectHub'], 'agent mcp');
        if (raw.mcp.projectHub !== undefined && typeof raw.mcp.projectHub !== 'boolean') {
            throw invalid('Agent mcp.projectHub must be a boolean.');
        }
    }
    const mcp = { projectHub: raw.mcp?.projectHub ?? false };
    const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : raw.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
        throw invalid(`Agent timeoutMs must be an integer between 1000 and ${MAX_TIMEOUT_MS}.`);
    }
    if (!Array.isArray(raw.targets)) throw invalid('Agent targets must be an array.');
    if (raw.defaultTarget !== undefined && (typeof raw.defaultTarget !== 'string' || !raw.defaultTarget.trim())) {
        throw invalid('defaultTarget must be a nonempty target name.');
    }
    const stateDir = path.join(agentStorageRoot(config, env), 'config-check', 'state');
    const names = new Set();
    const targets = raw.targets.map((entry) => {
        object(entry, 'Agent target');
        fields(entry, ['name', 'enabled', 'harness', 'backend'], 'agent target');
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
            throw invalid('Agent target enabled must be a boolean.');
        }
        let target;
        try {
            target = validateTarget({ name: entry.name, harness: entry.harness, backend: entry.backend });
            // validateTarget checks shape; planning also validates adapter/auth/protocol.
            // Runtime planning is side-effect free and never reads credentials.
            plan({ runId: 'config-check', workspace, prompt: 'Validate configuration only.', target, timeoutMs, stateDir });
        } catch (error) {
            throw invalid(`Invalid agent target: ${error.message}`);
        }
        if (names.has(target.name)) throw invalid(`Duplicate agent target name: ${target.name}`);
        names.add(target.name);
        return { ...target, enabled: entry.enabled ?? false };
    });
    if (raw.defaultTarget !== undefined && !names.has(raw.defaultTarget)) {
        throw invalid(`defaultTarget does not exist: ${raw.defaultTarget}`);
    }
    return { configPath: selectedPath, defaultTarget: raw.defaultTarget, timeoutMs, mcp, targets };
}

export function selectAgentTarget(settings, name, { requireEnabled = false } = {}) {
    const selectedName = name ?? settings.defaultTarget ?? (settings.targets.length === 1 ? settings.targets[0].name : undefined);
    if (!selectedName) throw invalid('Choose an agent with --target or set defaultTarget in the agent configuration.');
    const selected = settings.targets.find((entry) => entry.name === selectedName);
    if (!selected) throw invalid(`Agent target does not exist: ${selectedName}`);
    const { enabled, ...target } = selected;
    if (requireEnabled && !enabled) {
        throw invalid(`Agent target ${selectedName} is disabled. Set enabled to true in the agent configuration before running it.`);
    }
    return { target: structuredClone(target), enabled };
}

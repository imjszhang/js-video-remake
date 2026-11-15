import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError } from './errors.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const harnessPackages = {
    'claude-code': { package: '@anthropic-ai/claude-code', bin: 'claude' },
    codex: { package: '@openai/codex', bin: 'codex' },
    'deepseek-harness': { package: '@deepseek-ai/dsh', bin: 'dsh' },
};

export function managedHarness(adapter, root = projectRoot) {
    const entry = harnessPackages[adapter];
    if (!entry) throw appError('CONFIG_INVALID', `执行器 ${adapter} 不支持项目托管。`);
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const expected = manifest.dependencies[entry.package];
        const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', entry.package, 'package.json'), 'utf8'));
        if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(expected) || installed.version !== expected) {
            throw new Error(`期望 ${expected}，已安装 ${installed.version}`);
        }
        const executable = path.join(root, 'node_modules', '.bin', entry.bin);
        fs.accessSync(executable, fs.constants.X_OK);
        return { adapter, package: entry.package, version: expected, executable };
    } catch (error) {
        throw appError('CONFIG_INVALID', `项目执行器 ${entry.package} 未就绪：${error.message}。请运行 npm ci。`);
    }
}

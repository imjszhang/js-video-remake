import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { templateAgentLabel } from './template-agent-label.js';

/** Local filesystem checks only: never starts a CLI or contacts a model provider. */
export async function checkTemplateAgentExecutable(config, target) {
    const executable = target.harness.executable;
    const { harness } = templateAgentLabel(target);
    const env = { ...process.env, ...config.env };
    const candidates = path.isAbsolute(executable) || executable.includes(path.sep)
        ? [path.resolve(config.workspace, executable)]
        : (env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(config.workspace, directory, executable));
    let exists = false;
    for (const candidate of candidates) {
        try {
            const stat = await fs.stat(candidate);
            exists = true;
            if (!stat.isFile()) continue;
            await fs.access(candidate, constants.X_OK);
            return { available: true, unavailableReason: null };
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
            if (['EACCES', 'EPERM'].includes(error.code)) exists = true;
        }
    }
    return { available: false, unavailableReason: exists
        ? `${harness} 启动程序不可执行，请检查安装和执行权限。`
        : `${harness} 启动程序不存在，请安装或更新执行路径。` };
}

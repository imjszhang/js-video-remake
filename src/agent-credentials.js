import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { readTemplateProviders } from './template-providers.js';
import { appError } from './errors.js';

// Only run/doctor call this. Planning and config inspection never read secrets.
// Import just the selected credential, not PATH, proxies, NODE_OPTIONS or other targets' keys.
export async function agentCredentialEnvironment(config, target) {
    const env = config.env || process.env;
    if (target.backend.auth !== 'api-key') return env;
    const ref = target.backend.apiKeyEnv;
    const managed = (await readTemplateProviders(config)).find(item => item.keyRef === ref);
    if (managed) return { ...env, [ref]: managed.apiKey };
    if (env[ref] !== undefined) return env;
    const file = path.join(config.workspace, '.env.agent.local');
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
        if (error.code === 'ENOENT') return env;
        throw appError('CONFIG_INVALID', '无法读取本项目的 .env.agent.local。');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
        throw appError('CONFIG_INVALID', '.env.agent.local 必须是本项目内不超过 64 KiB 的普通文件，不能是符号链接。');
    }
    let values;
    try { values = parseEnv(await fs.readFile(file, 'utf8')); }
    catch { throw appError('CONFIG_INVALID', '无法解析本项目的 .env.agent.local。'); }
    return Object.hasOwn(values, ref) ? { ...env, [ref]: values[ref] } : env;
}

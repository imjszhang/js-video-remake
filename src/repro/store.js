import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { agentStorageRoot } from '../agent-config.js';
import { appError } from '../errors.js';
import { safeProjectPath } from './schema.js';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function fileHash(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
export const jsonHash = value => digest(JSON.stringify(value));
export const storage = config => path.join(agentStorageRoot(config), 'repro');
export function name(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(value)) throw appError('REPRO_INVALID', '名称仅支持字母、数字、下划线和连字符（最多 81 字符）。');
    return value;
}
export function relative(value) {
    safeProjectPath(value);
    if (value.split('/').some(p => /^(auth\.json|credentials\.json|agent-runtime\.json|video-remake\.json)$/i.test(p))) throw appError('REPRO_INVALID', '不接受凭据或宿主配置文件。');
    return value;
}
export async function safeFile(root, rel, { missing = false } = {}) {
    relative(rel);
    const info = await fs.lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw appError('REPRO_INVALID', '根目录必须是真实目录。');
    let current = root;
    for (const part of rel.split('/')) {
        current = path.join(current, part);
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) throw appError('REPRO_INVALID', `不接受符号链接: ${rel}`);
        } catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
    }
    return current;
}
export async function readJson(root, rel) {
    const file = await safeFile(root, rel);
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw appError('REPRO_INVALID', `JSON 文件过大或不是普通文件: ${rel}`);
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw appError('REPRO_INVALID', `无法解析 JSON: ${rel}`); }
}
export async function writeJson(root, rel, data, { exclusive = false } = {}) {
    const file = await safeFile(root, rel, { missing: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = `${JSON.stringify(data, null, 2)}\n`;
    if (exclusive) return fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force: true }); }
}
export async function copyFile(root, rel, destination, to = rel) {
    const source = await safeFile(root, rel);
    const info = await fs.stat(source);
    if (!info.isFile() || info.size > 1024 * 1024 * 1024) throw appError('REPRO_INVALID', `文件类型或大小不支持: ${rel}`);
    const target = await safeFile(destination, to, { missing: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    return fileHash(target);
}
export async function withLock(config, key, operation) {
    const root = storage(config);
    await fs.mkdir(root, { recursive: true });
    const file = await safeFile(root, `locks/${name(key)}.json`, { missing: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const token = randomUUID();
    const create = () => fs.writeFile(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), token, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    try { await create(); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Serialize stale-owner recovery. Rechecking a token without this guard
        // still allows another recoverer to rename a newly created live lock.
        const recovery = `${file}.recovery`;
        try { await fs.mkdir(recovery, { mode: 0o700 }); }
        catch (cause) { if (cause.code === 'EEXIST') throw appError('REPRO_BUSY', '运行锁正在恢复，请稍后重试。'); throw cause; }
        try {
            let old;
            try { old = JSON.parse(await fs.readFile(await safeFile(root, `locks/${name(key)}.json`), 'utf8')); }
            catch (cause) {
                if (cause.code !== 'ENOENT') throw appError('REPRO_BUSY', '无法确认运行锁归属，请检查后重试。');
            }
            if (old) {
                let dead = false;
                if ((!old.hostname || old.hostname === os.hostname()) && Number.isSafeInteger(old.pid) && old.pid > 0) {
                    try { process.kill(old.pid, 0); } catch (cause) { dead = cause.code === 'ESRCH'; }
                }
                if (!dead) throw appError('REPRO_BUSY', `此运行正在执行: ${key}`);
                await fs.unlink(file);
            }
            try { await create(); }
            catch (cause) { if (cause.code === 'EEXIST') throw appError('REPRO_BUSY', '另一进程已恢复此运行。'); throw cause; }
        } finally { await fs.rmdir(recovery); }
    }
    try { return await operation(); }
    finally {
        try { if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
}

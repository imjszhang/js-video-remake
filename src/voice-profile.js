import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { appError } from './errors.js';
import { pcmWavInfo } from './media/providers/qwen-tts.js';

const LEDGER = 'voices.json';
const DIRECTORY = 'voices';
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TEXT = 2000;
const invalid = (message) => appError('INVALID_INPUT', message);

function ledgerPath(config) {
    return path.join(config.workspace, LEDGER);
}

function storedFile(id) {
    return `${DIRECTORY}/${id}.wav`;
}

async function rejectSymlink(file) {
    const stat = await fs.lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat?.isSymbolicLink()) throw invalid('音色记录和 voices 目录不能是符号链接。');
    return stat;
}

async function readLedger(config) {
    const file = ledgerPath(config);
    const stat = await rejectSymlink(file);
    if (!stat) return null;
    if (!stat.isFile()) throw invalid('voices.json 必须是普通文件。');
    let raw;
    try { raw = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw invalid('voices.json 无法读取。'); }
    if (!raw || raw.version !== 1 || !raw.voices || typeof raw.voices !== 'object' || Array.isArray(raw.voices)) {
        throw invalid('voices.json 不是可识别的音色记录。');
    }
    return raw;
}

async function writeLedger(config, ledger) {
    const file = ledgerPath(config);
    await rejectSymlink(file);
    const temporary = path.join(config.workspace, `.voices-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
}

function describe(id, entry, defaultId) {
    return {
        id, text: entry.text, file: entry.file, duration: entry.duration, createdAt: entry.createdAt,
        default: id === defaultId,
    };
}

/** Read-only. A missing ledger stays missing. */
export async function listVoiceProfiles(config) {
    const ledger = await readLedger(config);
    const voices = ledger ? Object.keys(ledger.voices).sort().map(id => describe(id, ledger.voices[id], ledger.defaultId)) : [];
    return { command: 'voice:list', defaultId: ledger?.defaultId ?? null, voices };
}

export async function loadVoiceProfile(config, id) {
    const ledger = await readLedger(config);
    if (!ledger || !Object.keys(ledger.voices).length) {
        throw invalid('还没有保存的音色。先运行 remake voice:save --from 参考.wav --text "录音里的原话"。');
    }
    const selected = id || ledger.defaultId;
    const entry = ledger.voices[selected];
    if (!entry || entry.file !== storedFile(selected) || typeof entry.text !== 'string') {
        throw invalid(id ? `没有音色 ${id}。用 voice:list 查看已保存的音色。` : '默认音色无效。请重新 voice:save。');
    }
    const file = path.resolve(config.workspace, entry.file);
    if (file !== path.join(path.resolve(config.workspace, DIRECTORY), `${selected}.wav`)) throw invalid('音色文件路径无效。');
    const stat = await rejectSymlink(file);
    if (!stat?.isFile()) throw invalid(`音色文件不存在：${entry.file}。请重新 voice:save。`);
    return { id: selected, text: entry.text, file, relative: entry.file, duration: entry.duration };
}

export async function saveVoiceProfile(config, { from, text, id = 'default', force = false } = {}) {
    if (!ID_RE.test(id)) throw invalid('音色 id 需以小写字母开头，只含小写字母、数字和连字符，最长 32 个字符。');
    if (typeof text !== 'string' || !text.trim() || [...text].length > MAX_TEXT) throw invalid(`参考原话必须是 1 到 ${MAX_TEXT} 个字符，且要和录音里说的一致。`);
    if (typeof from !== 'string' || !from.trim()) throw invalid('voice:save 需要 --from 参考 WAV。');
    const source = path.resolve(config.workspace, from);
    const sourceStat = await fs.stat(source).catch(() => null);
    if (!sourceStat?.isFile() || !sourceStat.size) throw invalid('参考音频不存在或为空。');
    const info = pcmWavInfo(await fs.readFile(source));
    const directory = path.join(config.workspace, DIRECTORY);
    await rejectSymlink(directory);
    if (!(await fs.lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)))) await fs.mkdir(directory, { mode: 0o700 });
    const relative = storedFile(id);
    const target = path.join(config.workspace, relative);
    await rejectSymlink(target);
    const existing = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing && !force) throw appError('ALREADY_EXISTS', `音色 ${id} 已存在。确认替换请加 --force。`);
    if (path.resolve(source) === path.resolve(target)) throw invalid('参考音频不能就是 voices 目录里的音色文件。请从别处复制一份再保存。');
    const ledger = await readLedger(config) ?? { version: 1, defaultId: id, voices: {} };
    ledger.version = 1;
    ledger.defaultId = id;
    ledger.voices[id] = { text, file: relative, duration: Number(info.duration.toFixed(3)), createdAt: new Date().toISOString() };
    const staging = path.join(directory, `.${id}-${randomUUID()}.wav`);
    await fs.copyFile(source, staging, fs.constants.COPYFILE_EXCL);
    await fs.chmod(staging, 0o600);
    try { await fs.rename(staging, target); }
    catch (error) {
        await fs.rm(staging, { force: true });
        throw error;
    }
    try { await writeLedger(config, ledger); }
    catch (error) {
        if (!existing) await fs.rm(target, { force: true });
        throw error;
    }
    return { command: 'voice:save', id, defaultId: id, file: relative, duration: ledger.voices[id].duration, text };
}

/** qwen-tts uses the saved sample when this call does not pass its own reference. */
export async function resolveSpeechReference(config, { providerId, reference, referenceText, voiceId } = {}) {
    if (voiceId && (reference || referenceText)) throw invalid('已指定 --voice-id 时不要再传 --reference 或 --reference-text。');
    if (providerId !== 'qwen-tts') {
        if (voiceId) throw invalid('已保存的音色只用于 qwen-tts。当前语音合成使用系统音色，不会读取这段录音。');
        return { reference, referenceText, voiceId: null };
    }
    if (reference || referenceText) return { reference, referenceText, voiceId: null };
    const profile = await loadVoiceProfile(config, voiceId);
    return { reference: profile.file, referenceText: profile.text, voiceId: profile.id };
}

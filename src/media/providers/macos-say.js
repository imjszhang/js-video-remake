import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError } from '../../errors.js';
import { runFixedCommand } from '../../repro/render.js';

const invalid = (message) => appError('INVALID_INPUT', message);
const failed = (message) => appError('MEDIA_FAILED', message);

export function validateSpeechRequest(request) {
    if (typeof request.text !== 'string' || !request.text.trim() || [...request.text].length > 2000) throw invalid('text 必须是 1 到 2000 个字符。');
    if (request.reference || request.referenceText) throw invalid('macos-say 使用系统音色，不接受参考音频。');
    if (request.voice !== undefined && (typeof request.voice !== 'string' || !request.voice.trim() || request.voice.length > 80)) {
        throw invalid('voice 必须是系统音色名称。');
    }
    if (Object.keys(request.options ?? {}).length) throw invalid('macos-say 不支持专属 options。');
}

async function saveTarget(outPath) {
    const target = outPath || path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'remake-say-')), 'speech.wav');
    if (path.extname(target).toLowerCase() !== '.wav') throw invalid('语音输出文件必须使用 .wav 后缀。');
    if (await fs.lstat(target).catch(() => null)) throw appError('ALREADY_EXISTS', '语音输出文件已存在，请更换 --out。');
    await fs.mkdir(path.dirname(target), { recursive: true });
    return target;
}

export default {
    id: 'macos-say',
    task: 'speech',
    label: 'macOS 系统语音',
    guide: 'providers/macos-say.md',
    ledgerProviders: ['macos-say.speak'],
    testedVersion: 'say',
    execution: 'program',
    capabilities: ['text-to-speech'],
    publicSettings: ['voice'],
    fields: {
        voice: { env: 'MACOS_SAY_VOICE', type: 'string' },
    },
    validateRequest: validateSpeechRequest,
    async doctor(_settings, deps = {}) {
        if ((deps.platform || process.platform) !== 'darwin') return { ready: false, version: '', hint: 'macos-say 需要 macOS 系统语音。' };
        try {
            await fs.access('/usr/bin/say', fs.constants.X_OK);
            return { ready: true, version: 'say', hint: '' };
        } catch {
            return { ready: false, version: '', hint: '找不到可执行的 /usr/bin/say。' };
        }
    },
    async synthesize(settings, request, deps = {}) {
        validateSpeechRequest(request);
        const voice = request.voice || settings.voice;
        const target = await saveTarget(request.outPath);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-say-text-'));
        try {
            const textFile = path.join(directory, 'line.txt');
            await fs.writeFile(textFile, request.text, { mode: 0o600 });
            const args = [...(voice ? ['-v', voice] : []), '-f', textFile, '-o', target, '--data-format=LEI16@24000'];
            const result = await (deps.runSay || runFixedCommand)('/usr/bin/say', args, {
                cwd: deps.workspace || process.cwd(), timeoutMs: deps.timeoutMs ?? 120000, signal: deps.signal,
            });
            if (result.exitCode !== 0) throw failed('系统语音合成失败。');
            const stat = await fs.stat(target).catch(() => null);
            if (!stat?.isFile() || !stat.size) throw failed('系统语音没有留下 WAV 文件。');
            return { path: target, provider: 'macos-say.speak' };
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    },
};

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError } from './errors.js';
import { rendererEnvironment, runFixedCommand } from './repro/render.js';

const RATE = 48000;
const SAMPLE_BYTES = 2;
const MAX_ACCELERATION = 3;
const provider = 'macos-say';
const label = 'macOS 系统语音（本机）';
const fail = message => appError('VIDEO_SPEECH_INVALID', message);
function cancelled(signal) {
    if (signal?.aborted) throw appError('VIDEO_CANCELLED', '口播生成已取消。');
}
async function command(config, executable, args, deps, timeoutMs = 120000) {
    cancelled(deps.signal);
    let result;
    try {
        result = await (deps.runSpeechCommand || runFixedCommand)(executable, args, {
            cwd: config.workspace, env: rendererEnvironment(config.workspace, config.env || process.env), signal: deps.signal,
            timeoutMs, maxOutputBytes: 512 * 1024,
        });
    } catch { cancelled(deps.signal); throw fail(`无法运行 ${path.basename(executable)}，请检查本机语音与 FFmpeg 安装。`); }
    cancelled(deps.signal);
    if (result.termination === 'cancelled') throw appError('VIDEO_CANCELLED', '口播生成已取消。');
    if (result.termination === 'timeout') throw fail(`${path.basename(executable)} 执行超时，请缩短字幕后重试。`);
    if (result.exitCode !== 0) throw fail(`${path.basename(executable)} 执行失败，请检查音色或本机工具安装。`);
    return result;
}

export async function speechOptions(config, deps = {}) {
    if ((deps.platform || process.platform) !== 'darwin') return { provider, label, available: false, voices: [], defaultVoice: null, reason: '本机自动口播目前需要 macOS 系统语音。' };
    try {
        const [listed] = await Promise.all([
            command(config, '/usr/bin/say', ['-v', '?'], deps, 15000),
            command(config, 'ffmpeg', ['-version'], deps, 15000),
            command(config, 'ffprobe', ['-version'], deps, 15000),
        ]);
        const voices = [];
        for (const line of listed.stdout.split('\n')) {
            const match = /^(.+?)\s+((?:zh|en)_[A-Za-z]+)\s+#/.exec(line);
            if (!match) continue;
            const id = match[1].trim(), locale = match[2], language = locale.slice(0, 2);
            if (!voices.some(voice => voice.id === id)) voices.push({ id, label: `${id} · ${locale.replace('_', '-')}`, language, locale, default: false });
        }
        for (const language of ['zh', 'en']) {
            const selected = voices.find(voice => voice.id === (language === 'zh' ? 'Tingting' : 'Samantha')) || voices.find(voice => voice.language === language);
            if (selected) selected.default = true;
        }
        return { provider, label, available: voices.length > 0, voices, defaultVoice: voices.find(voice => voice.default && voice.language === 'zh')?.id || voices.find(voice => voice.default)?.id || null, ...(voices.length ? {} : { reason: '没有找到已安装的中文或英文系统音色。' }) };
    } catch (error) {
        if (error.code === 'VIDEO_CANCELLED') throw error;
        return { provider, label, available: false, voices: [], defaultVoice: null, reason: error.message };
    }
}

function spokenText(value, identity, index) {
    const substituted = value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!Object.hasOwn(identity, key) || typeof identity[key] !== 'string') throw fail(`第 ${index + 1} 句含未填写的身份变量 ${match}，请先填写个人信息。`);
        return identity[key];
    });
    // Apple speech commands use [[...]]. Remove both delimiters, including in identity values.
    return substituted.replace(/\[\[|\]\]/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}
async function silence(handle, samples, signal) {
    let bytes = samples * SAMPLE_BYTES;
    const zero = Buffer.alloc(Math.min(bytes, 65536));
    while (bytes > 0) { cancelled(signal); const length = Math.min(bytes, zero.length); await handle.writeFile(zero.subarray(0, length)); bytes -= length; }
}
async function appendPcm(handle, file, maxSamples, index, signal) {
    const source = await fs.open(file, 'r');
    try {
        const info = await source.stat();
        if (info.size > maxSamples * SAMPLE_BYTES + RATE * SAMPLE_BYTES * 0.05) throw fail(`第 ${index + 1} 句生成语音仍超出字幕时间窗，请缩短这句后重试。`);
        let position = 0, remaining = Math.min(info.size, maxSamples * SAMPLE_BYTES);
        const buffer = Buffer.alloc(65536);
        while (remaining > 0) {
            cancelled(signal);
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, remaining), position);
            if (!bytesRead) break;
            await handle.writeFile(buffer.subarray(0, bytesRead)); position += bytesRead; remaining -= bytesRead;
        }
        await silence(handle, maxSamples - Math.floor(position / SAMPLE_BYTES), signal);
    } finally { await source.close(); }
}

/** Host-owned output, never edits subtitle rows or the template source. */
export async function synthesizeCaptionSpeech(config, { rows, identity = {}, voice, language = 'zh', duration, outputFile } = {}, deps = {}) {
    if (!['zh', 'en'].includes(language)) throw fail('口播语言只能是中文或英文。');
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw fail('口播总时长必须在 0–3600 秒内。');
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw fail('没有有效字幕可生成口播。');
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw fail('个人信息格式无效。');
    if (typeof outputFile !== 'string' || !path.isAbsolute(outputFile) || path.extname(outputFile).toLowerCase() !== '.wav') throw fail('口播输出必须是本机绝对路径 WAV 文件。');
    try { await fs.lstat(outputFile); throw fail('口播输出文件已存在，不能覆盖。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let previousEnd = 0;
    const speechRows = rows.map((row, index) => {
        if (!row || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < previousEnd || row.end <= row.start || row.end > duration) throw fail(`第 ${index + 1} 句时间窗无效或与上一句重叠。`);
        previousEnd = row.end;
        const value = row[language] ?? '';
        if (typeof value !== 'string' || value.length > 2000) throw fail(`第 ${index + 1} 句文字无效或过长。`);
        return { ...row, index, text: spokenText(value, identity, index) };
    }).filter(row => row.text);
    if (!speechRows.length) throw fail(`没有可朗读的${language === 'zh' ? '中文' : '英文'}字幕，请先填写字幕。`);
    const options = await speechOptions(config, deps);
    if (!options.available) throw fail(options.reason);
    const selected = voice ? options.voices.find(item => item.id === voice && item.language === language) : options.voices.find(item => item.default && item.language === language);
    if (!selected) throw fail('所选音色不存在或与口播语言不一致，请重新选择。');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'remake-caption-speech-'));
    const timeline = path.join(temporary, 'timeline.pcm');
    let writtenOutput = false, adjustedCount = 0;
    try {
        const handle = await fs.open(timeline, 'wx', 0o600);
        let position = 0;
        try {
            for (let i = 0; i < speechRows.length; i++) {
                cancelled(deps.signal);
                const row = speechRows[i];
                await deps.onProgress?.({ stage: 'speech', message: `正在生成第 ${row.index + 1}/${rows.length} 句口播`, current: i + 1, total: speechRows.length, captionIndex: row.index });
                const textFile = path.join(temporary, `sentence-${i}.txt`), audio = path.join(temporary, `sentence-${i}.aiff`), pcm = path.join(temporary, `sentence-${i}.pcm`);
                await fs.writeFile(textFile, row.text, { mode: 0o600 });
                await command(config, '/usr/bin/say', ['-v', selected.id, '-r', '180', '-f', textFile, '-o', audio], deps);
                const probe = await command(config, 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', audio], deps, 15000);
                let seconds;
                try { seconds = Number(JSON.parse(probe.stdout).format.duration); } catch { throw fail(`无法测量第 ${row.index + 1} 句的语音时长。`); }
                if (!Number.isFinite(seconds) || seconds <= 0) throw fail(`第 ${row.index + 1} 句没有生成有效语音。`);
                const startSample = Math.round(row.start * RATE), endSample = Math.round(row.end * RATE), samples = endSample - startSample;
                const window = samples / RATE;
                const speed = seconds > window ? seconds / Math.max(window - 0.02, window * 0.98) : 1;
                if (speed > MAX_ACCELERATION) throw fail(`第 ${row.index + 1} 句口播约 ${seconds.toFixed(2)} 秒，超过 ${window.toFixed(2)} 秒时间窗的 ${MAX_ACCELERATION} 倍加速上限，请缩短这句字幕。`);
                if (speed > 1) adjustedCount++;
                const filters = speed > 2 ? `atempo=2,atempo=${(speed / 2).toFixed(6)}` : `atempo=${speed.toFixed(6)}`;
                await command(config, 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', audio, '-af', filters, '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', pcm], deps);
                await silence(handle, startSample - position, deps.signal);
                await appendPcm(handle, pcm, samples, row.index, deps.signal);
                position = endSample;
            }
            await silence(handle, Math.round(duration * RATE) - position, deps.signal);
        } finally { await handle.close(); }
        cancelled(deps.signal);
        await deps.onProgress?.({ stage: 'speech', message: '正在对齐并保存完整口播', current: speechRows.length, total: speechRows.length });
        const final = path.join(temporary, 'voice.wav');
        await command(config, 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', timeline, '-c:a', 'pcm_s16le', final], deps);
        cancelled(deps.signal);
        await fs.chmod(final, 0o600);
        await fs.copyFile(final, outputFile, fs.constants.COPYFILE_EXCL); writtenOutput = true;
        cancelled(deps.signal);
        return { provider, label, voice: selected.id, language, duration: Math.round(duration * RATE) / RATE, count: speechRows.length, totalCount: rows.length, skippedCount: rows.length - speechRows.length, adjustedCount, firstAt: speechRows[0].start, maxAcceleration: MAX_ACCELERATION };
    } catch (error) {
        if (writtenOutput) await fs.rm(outputFile, { force: true });
        throw error;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

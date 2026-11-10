import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appError } from '../../errors.js';
import { validateTranscriptResult } from '../contracts.js';

const runFile = promisify(execFile);
const RUNNER = fileURLToPath(new URL('./faster-whisper-runner.py', import.meta.url));
const TIMEOUT_MS = 1800000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEVICES = new Set(['cpu', 'cuda', 'auto']);
const COMPUTE_TYPES = new Set(['default', 'auto', 'int8', 'int8_float32', 'int8_float16', 'int8_bfloat16', 'int16', 'float16', 'float32', 'bfloat16']);

function options(settings) {
    const device = settings.device || 'cpu';
    const computeType = settings.computeType || 'int8';
    if (!DEVICES.has(device)) throw appError('CONFIG_INVALID', 'faster-whisper device 只接受 cpu、cuda 或 auto。');
    if (!COMPUTE_TYPES.has(computeType)) throw appError('CONFIG_INVALID', 'faster-whisper computeType 不是受支持的计算类型。');
    const localFilesOnly = settings.localFilesOnly ?? 'true';
    if (!['true', 'false'].includes(localFilesOnly)) throw appError('CONFIG_INVALID', 'faster-whisper localFilesOnly 只接受字符串 "true" 或 "false"。');
    return {
        model: settings.model || 'large-v3', device, computeType,
        localFilesOnly: localFilesOnly === 'true',
        ...(settings.cacheDir ? { cacheDir: settings.cacheDir } : {}),
    };
}

async function invoke(settings, args, { env = process.env, runTranscribe = runFile, timeoutMs = TIMEOUT_MS } = {}) {
    // 上游在本地模型缺少 tokenizer.json 时可能另取 tokenizer；离线标志也约束这条路径。
    const childEnv = settings.localFilesOnly === 'false' ? { ...env } : { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
    const result = await runTranscribe(settings.python || 'python3', ['-I', RUNNER, ...args], {
        env: childEnv, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true, killSignal: 'SIGKILL',
    });
    const stdout = typeof result === 'string' ? result : result?.stdout;
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        throw appError('MEDIA_FAILED', 'faster-whisper 输出缺失或超过 32 MiB。');
    }
    let json;
    try { json = JSON.parse(stdout); } catch { throw appError('MEDIA_FAILED', 'faster-whisper 没有返回有效的 JSON。'); }
    return json;
}

function failure(error) {
    if (error.code === 'ENOENT') return '找不到 Python；请配置 FASTER_WHISPER_PYTHON 为独立环境的 Python 可执行文件。';
    if (error.killed || error.code === 'ETIMEDOUT') return '运行超时，Python 进程已终止。';
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return '输出超过 32 MiB，请分段转写。';
    return String(error.stderr || error.message || 'Python 进程失败').replace(/[\u0000-\u0008\u001b]/g, '').trim().slice(-500);
}

export async function transcribe(settings, request, deps = {}) {
    const config = options(settings);
    const stat = await fs.stat(request.file).catch(() => null);
    if (!stat?.isFile()) throw appError('NOT_FOUND', `音频不存在: ${request.file}`);
    if (stat.size === 0) throw appError('INVALID_INPUT', '转写音频不能为空。');
    const payload = { ...config, file: request.file, language: request.language || settings.language || null };
    let json;
    try {
        json = await invoke(settings, ['--transcribe', JSON.stringify(payload)], deps);
    } catch (error) {
        throw appError(error.code === 'ENOENT' ? 'MEDIA_UNAVAILABLE' : 'MEDIA_FAILED', `faster-whisper 转写失败: ${failure(error)}`);
    }
    return validateTranscriptResult(json, { ...request, require: request.require ?? [] });
}

export default {
    id: 'faster-whisper',
    task: 'transcribe',
    label: 'faster-whisper 本地转写',
    guide: 'providers/faster-whisper.md',
    ledgerProviders: ['faster-whisper.transcribe'],
    testedVersion: 'WhisperModel 接口；仅模拟测试，未做真实转写',
    execution: 'program',
    capabilities: ['timed-transcription', 'word-timestamps'],
    publicSettings: ['model', 'device', 'computeType', 'language', 'localFilesOnly'],
    fields: {
        python: { env: 'FASTER_WHISPER_PYTHON', type: 'executable', default: 'python3' },
        model: { env: 'FASTER_WHISPER_MODEL', type: 'string', default: 'large-v3' },
        device: { env: 'FASTER_WHISPER_DEVICE', type: 'string', default: 'cpu' },
        computeType: { env: 'FASTER_WHISPER_COMPUTE_TYPE', type: 'string', default: 'int8' },
        language: { env: 'FASTER_WHISPER_LANGUAGE', type: 'string' },
        cacheDir: { env: 'FASTER_WHISPER_CACHE_DIR', type: 'path' },
        localFilesOnly: { env: 'FASTER_WHISPER_LOCAL_FILES_ONLY', type: 'string', default: 'true' },
    },
    async doctor(settings, deps = {}) {
        try {
            options(settings);
            const result = await invoke(settings, ['--doctor'], { ...deps, timeoutMs: deps.timeoutMs ?? 15000 });
            if (result?.status !== 'ok' || typeof result.version !== 'string' || !result.version) {
                throw new Error('Python 未返回有效的包版本。');
            }
            return { ready: true, version: result.version, hint: '仅验证 Python 与 faster-whisper 包；未加载模型、检查模型缓存或验证设备计算能力。' };
        } catch (error) {
            return { ready: false, version: '', hint: `faster-whisper 未就绪: ${failure(error)}` };
        }
    },
    transcribe,
};

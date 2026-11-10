import { appError } from '../../errors.js';

// 内置工具属于当前 Agent 会话，Node CLI 不读取登录凭据或代调图片 API。
export default {
    id: 'codex-image',
    task: 'image',
    label: 'Codex 内置生图（ChatGPT 登录）',
    guide: 'providers/codex-image.md',
    ledgerProviders: ['codex-image.generate', 'codex-image.edit'],
    testedVersion: '2026-11-09 文生图与文件落地验证',
    execution: 'agent',
    agentOnly: true,
    capabilities: ['text-to-image', 'image-edit'],
    publicSettings: [],
    fields: {},
    validateRequest({ options }) {
        const unknown = Object.keys(options).find((key) => key !== 'transparentBackground');
        if (unknown) throw appError('INVALID_INPUT', `codex-image 不支持选项 ${unknown}；质量和画面要求请写入 intent。`);
        if (options.transparentBackground !== undefined && typeof options.transparentBackground !== 'boolean') {
            throw appError('INVALID_INPUT', 'codex-image 的 transparentBackground 必须是布尔值。');
        }
    },
    async doctor() {
        return {
            ready: false,
            version: '',
            hint: 'CLI 无法验证当前 Agent 的内置生图工具、ChatGPT 登录或额度；请由 Agent 按指南确认。此状态不表示工具已确认不可用，不需要配置 API Key。',
        };
    },
};

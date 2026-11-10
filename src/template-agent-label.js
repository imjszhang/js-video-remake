const HARNESS_NAMES = {
    codex: 'Codex CLI',
    'claude-code': 'Claude Code',
    'deepseek-harness': 'DeepSeek Harness',
    'cursor-agent': 'Cursor Agent',
    opencode: 'OpenCode',
};

/** 展示真实 Harness 与模型，配置键仅用于提交请求。 */
export function templateAgentLabel(target) {
    const adapter = target?.harness?.adapter;
    const harness = HARNESS_NAMES[adapter] || adapter || '未知 Harness';
    const configuredModel = target?.backend?.model;
    const model = !configuredModel || configuredModel === 'configured' ? '跟随 Harness 本机设置' : configuredModel;
    return { harness, model, label: `${harness} · ${model}` };
}

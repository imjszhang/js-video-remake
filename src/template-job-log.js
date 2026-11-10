// Only publish displayable events, never raw protocol packets or reasoning blocks.
export function logText(value) {
    return String(value ?? '')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/(bearer\s+)\S+/gi, '$1[已隐藏]')
        .replace(/((?:[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[已隐藏]')
        .replace(/https?:\/\/[^\s"'<>]+/g, value => {
            try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return '[地址]'; }
        }).slice(0, 2000);
}

export function eventLog(event) {
    const data = event.data || {};
    if (event.type === 'message' && typeof data.text === 'string' && !data.delta) return { kind: 'message', text: logText(data.text) };
    if (event.type === 'tool') {
        const item = data.item || data;
        if (item.type === 'reasoning' || item.type === 'thinking') return null;
        const input = item.input || {};
        const detail = item.command || input.command || input.file_path || input.path || input.pattern || '';
        return { kind: 'tool', text: logText(`${item.name || item.type || '工具'}${data.phase ? ` · ${data.phase}` : ''}${detail ? `\n${detail}` : ''}${item.exit_code != null ? `\n退出码：${item.exit_code}` : ''}`) };
    }
    if (event.type === 'raw' && data.type === 'system' && data.subtype === 'api_retry') {
        return { kind: 'retry', text: logText(`服务请求重试 ${data.attempt ?? ''} · HTTP ${data.error_status ?? '未知'} · ${Math.round((Number(data.retry_delay_ms) || 0) / 1000)} 秒后重试`) };
    }
    if (event.type === 'started') return { kind: 'status', text: 'Agent 已启动' };
    if (event.type === 'status') return { kind: 'status', text: logText(`Agent 状态：${data.status || '未知'}${data.error ? ` · ${typeof data.error === 'string' ? data.error : data.error.message || ''}` : ''}`) };
    return null;
}

export function appendJobLog(job, entry) {
    if (!entry?.text) return;
    job.logs ||= [];
    const text = logText(entry.text);
    const previous = job.logs.at(-1);
    if (previous?.kind === entry.kind && previous.text === text) return;
    job.logSequence = (job.logSequence || 0) + 1;
    job.logs.push({ sequence: job.logSequence, time: Number.isFinite(Date.parse(entry.time)) ? new Date(entry.time).toISOString() : new Date().toISOString(), kind: entry.kind, text });
    let size = job.logs.reduce((sum, line) => sum + line.text.length, 0);
    while (job.logs.length > 200 || size > 64000) {
        size -= job.logs.shift().text.length;
        job.logsTruncated = true;
    }
}

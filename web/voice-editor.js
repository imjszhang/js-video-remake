const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

export function mountVoiceEditor(parent, context, { request, onGenerate, fallback }) {
    const panel = el('section', 'voice-editor');
    panel.append(el('h4', '', '根据字幕生成口播'), el('p', 'editor-hint', '先修改上方字幕，再生成声音。每句话会按字幕时间对齐，生成成功后自动用作当前视频的口播。'));
    const provider = el('p', 'editor-hint', '正在检查可用音色…');
    const controls = el('fieldset', 'voice-controls');
    const language = el('select'); language.setAttribute('aria-label', '口播语言');
    for (const [value, label] of [['zh', '中文'], ['en', '英文']]) {
        const option = el('option', '', label); option.value = value; language.append(option);
    }
    const voice = el('select'); voice.setAttribute('aria-label', '口播音色');
    const label = (text, input) => { const node = el('label'); node.append(el('span', '', text), input); return node; };
    const generate = el('button', 'download-link', '保存字幕并生成口播'); generate.type = 'button';
    generate.addEventListener('click', onGenerate);
    controls.append(el('legend', 'sr-only', '语音生成设置'), label('语言', language), label('音色', voice), generate);
    const state = el('p', 'voice-status'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    const output = el('div', 'voice-output');
    const uploadControls = el('fieldset', 'editor-fields'); uploadControls.append(fallback);
    const upload = el('details', 'voice-upload'); upload.append(el('summary', '', '使用自己的录音（可选）'), uploadControls);
    panel.append(provider, controls, state, output, upload); parent.append(panel);
    let data = null, loading = true;
    const alive = () => panel.isConnected;
    function remember() { context.speechSelection = { voice: voice.value, language: language.value }; }
    function fillVoices() {
        const preferred = context.speechSelection?.voice || data?.audio?.voice || data?.defaultVoice;
        voice.replaceChildren();
        const matches = (data?.voices || []).filter(item => String(item.language || '').startsWith(language.value));
        for (const item of matches) { const option = el('option', '', item.label || item.id); option.value = item.id; voice.append(option); }
        if (matches.some(item => item.id === preferred)) voice.value = preferred;
        else if (matches.some(item => item.default)) voice.value = matches.find(item => item.default).id;
        remember(); update();
    }
    language.addEventListener('change', fillVoices);
    voice.addEventListener('change', remember);
    function update() {
        const busy = context.pending || context.job?.status === 'running';
        uploadControls.disabled = busy || context.data.frozen;
        controls.disabled = loading || busy || context.data.frozen || !data?.available || !data?.supported || !voice.value;
        const running = context.job?.action === 'voice' && context.job.status === 'running';
        if (running) state.textContent = context.job.message || '正在生成口播…';
        else if (context.job?.action === 'voice' && context.job.status === 'failed') state.textContent = context.job.error || '生成失败，请重试。';
        else if (context.data.frozen) state.textContent = '这个版本已合成。复制为新版本后可修改字幕、重新生成口播。';
        else if (context.dirty) state.textContent = '有尚未保存的内容；点击生成会先保存当前字幕与素材设置。';
        else if (data?.audio?.stale) state.textContent = '字幕或个人信息已修改，当前口播仍是旧内容，请重新生成。';
        else if (data?.audio?.generated) state.textContent = `口播已生成并用于当前视频${data.audio.adjustedCount ? `，${data.audio.adjustedCount} 句已加快以匹配时间窗` : ''}。可以试听，再去预览或合成视频。`;
        else state.textContent = data?.audio ? '当前使用已上传的口播。生成新口播成功后会替换它。' : '';
    }
    async function reload() {
        loading = true; update();
        try {
            const result = await request(`${context.base}/voice`);
            if (!alive()) return;
            data = result;
            provider.textContent = data.available && data.supported
                ? `${data.label} · 本机生成，无需 API Key。英文为空的句子保留静音。`
                : data.reason || '当前暂时无法生成语音。';
            language.value = context.speechSelection?.language || data.audio?.language || 'zh';
            fillVoices(); output.replaceChildren();
            if (data.audio) {
                if (data.audio.generated) output.append(el('p', 'editor-hint', `已保存口播：${data.audio.language === 'en' ? '英文' : '中文'} · ${data.audio.voice}${data.audio.count ? ` · ${data.audio.count} 句` : ''}`));
                const audio = el('audio'); audio.controls = true; audio.preload = 'metadata'; audio.setAttribute('aria-label', '试听当前口播');
                const params = new URLSearchParams({ version: data.audio.path });
                audio.src = `${context.base}/voice/audio?${params}`;
                // The exported track includes the opening silence; start listening at the first spoken line.
                audio.addEventListener('loadedmetadata', () => { if (Number.isFinite(data.audio.firstAt)) audio.currentTime = data.audio.firstAt; }, { once: true });
                const download = el('a', 'editor-secondary', '下载口播音频'); download.href = `${context.base}/voice/audio?download=1`; download.download = '';
                output.append(audio, download);
                if (data.audio.firstAt > 0) output.append(el('p', 'editor-hint', `音频包含完整时间轴。试听从第 ${data.audio.firstAt.toFixed(2)} 秒的第一句开始。`));
            }
        } catch (error) { if (alive()) provider.textContent = error.message; }
        finally { loading = false; if (alive()) update(); }
    }
    reload();
    return { update, reload };
}

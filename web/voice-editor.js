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
    const referenceFile = el('input'); referenceFile.type = 'file'; referenceFile.accept = 'audio/*,.wav'; referenceFile.setAttribute('aria-label', '参考音频');
    const referenceText = el('textarea'); referenceText.rows = 2; referenceText.maxLength = 2000; referenceText.placeholder = '这段参考音频里实际说的话'; referenceText.setAttribute('aria-label', '参考音频原话');
    const label = (text, input) => { const node = el('label'); node.append(el('span', '', text), input); return node; };
    const languageLabel = label('语言', language);
    const voiceLabel = label('音色', voice);
    const referenceFileLabel = label('参考音频', referenceFile);
    const referenceTextLabel = label('参考原话', referenceText);
    referenceFileLabel.hidden = true; referenceTextLabel.hidden = true;
    const generate = el('button', 'download-link', '保存字幕并生成口播'); generate.type = 'button';
    let uploading = false;
    generate.addEventListener('click', async () => {
        if (uploading) return;
        if (data?.referenceRequired) {
            const file = referenceFile.files?.[0];
            const text = referenceText.value.trim();
            if (!file || !text) { state.textContent = '请选择 1–30 秒的参考音频，并填写其中的原话。'; return; }
            if (file.size > 12 * 1024 * 1024) { state.textContent = '参考音频不能超过 12 MiB。'; return; }
            uploading = true; update();
            let uploadError;
            try {
                const params = new URLSearchParams({ kind: 'voice', filename: file.name || 'reference.wav' });
                const uploaded = await request(`${context.base}/assets?${params}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Remake-Action': 'template' }, body: file,
                });
                context.speechSelection = { referenceRequired: true, reference: uploaded.path, referenceText: text, language: language.value };
            } catch (error) {
                uploadError = error;
            } finally { uploading = false; update(); }
            if (uploadError) { state.textContent = uploadError.message; return; }
        }
        onGenerate();
    });
    controls.append(el('legend', 'sr-only', '语音生成设置'), languageLabel, voiceLabel, referenceFileLabel, referenceTextLabel, generate);
    const state = el('p', 'voice-status'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    const output = el('div', 'voice-output');
    const uploadControls = el('fieldset', 'editor-fields'); uploadControls.append(fallback);
    const upload = el('details', 'voice-upload'); upload.append(el('summary', '', '使用自己的录音（可选）'), uploadControls);
    panel.append(provider, controls, state, output, upload); parent.append(panel);
    let data = null, loading = true;
    const alive = () => panel.isConnected;
    function remember() {
        context.speechSelection = data?.referenceRequired
            ? { referenceRequired: true, referenceText: referenceText.value, language: language.value, reference: context.speechSelection?.reference }
            : { voice: voice.value, language: language.value };
    }
    function fillVoices() {
        voiceLabel.hidden = Boolean(data?.referenceRequired);
        referenceFileLabel.hidden = !data?.referenceRequired;
        referenceTextLabel.hidden = !data?.referenceRequired;
        if (data?.referenceRequired) { remember(); update(); return; }
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
    referenceText.addEventListener('input', () => { remember(); update(); });
    referenceFile.addEventListener('change', update);
    function update() {
        const busy = context.pending || context.job?.status === 'running' || uploading;
        uploadControls.disabled = busy || context.data.frozen;
        const ready = data?.referenceRequired ? Boolean(referenceFile.files?.[0] && referenceText.value.trim()) : Boolean(voice.value);
        controls.disabled = loading || busy || context.data.frozen || !data?.available || !data?.supported;
        generate.disabled = controls.disabled || !ready;
        const running = context.job?.action === 'voice' && context.job.status === 'running';
        if (uploading) state.textContent = '正在上传参考音频…';
        else if (running) state.textContent = context.job.message || '正在生成口播…';
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
                ? (data.referenceRequired
                    ? `${data.label}。上传 1–30 秒参考音频和其中的原话，按这个音色逐句生成并对齐字幕时间。所选语言里空着的句子保持静音。`
                    : `${data.label} · 本机生成，无需 API Key。所选语言里空着的句子保持静音。`)
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

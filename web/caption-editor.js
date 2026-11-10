const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
};
const PAGE_SIZE = 10;

export function mountCaptionEditor(parent, context, { request, mutate, onChange, onSaved, onSave, onPreview, fallback }) {
    const panel = node('details', 'caption-editor');
    const summary = node('summary', '', `口播字幕 · ${context.data.schema.captions.count || ''} 句`);
    panel.append(summary, node('p', 'editor-hint', '逐句修改中英文，时间轴保持不变。修改字幕不会改变口播声音。'));
    const notice = node('p', 'editor-hint'); notice.setAttribute('role', 'status'); panel.append(notice);
    const toolbar = node('div', 'caption-toolbar');
    const download = node('a', 'editor-secondary', '下载字幕原稿');
    download.href = `${context.base}/captions/original`; download.download = 'captions-original.json';
    toolbar.append(download);
    const search = node('input'); search.type = 'search'; search.placeholder = '搜索中英文字幕'; search.setAttribute('aria-label', '搜索字幕'); toolbar.append(search);
    panel.append(toolbar);
    const rows = node('div', 'caption-rows'); panel.append(rows);
    const navigation = node('div', 'caption-pagination');
    const previous = node('button', 'editor-secondary', '上一页'); previous.type = 'button';
    const counter = node('span');
    const next = node('button', 'editor-secondary', '下一页'); next.type = 'button';
    navigation.append(previous, counter, next); panel.append(navigation);
    const actions = node('div', 'caption-toolbar');
    const save = node('button', 'editor-secondary', '保存字幕'); save.type = 'button';
    const preview = node('button', 'download-link', '保存并预览当前句'); preview.type = 'button';
    actions.append(save, preview); panel.append(actions);
    const fallbackBox = node('fieldset', 'caption-fallback'); fallbackBox.append(fallback); fallbackBox.hidden = true; panel.append(fallbackBox);
    parent.append(panel);
    let loading = false;
    const state = () => context.captionDraft;
    const alive = () => panel.isConnected;
    const busy = () => context.pending || context.job?.status === 'running' || loading;
    const writable = () => !busy() && !context.data.frozen && state()?.data?.supported;
    function sync() {
        const available = Boolean(state()?.data?.supported);
        rows.querySelectorAll('textarea').forEach(input => { input.disabled = !writable(); });
        rows.querySelectorAll('button').forEach(button => { button.disabled = !writable(); });
        save.disabled = !writable() || !state()?.dirty;
        preview.disabled = !writable();
        search.disabled = !available || loading;
        previous.disabled = loading || !available || !(state()?.page > 0);
        const count = filtered().length;
        next.disabled = loading || !available || ((state()?.page || 0) + 1) * PAGE_SIZE >= count;
        fallbackBox.disabled = busy() || context.data.frozen;
        toolbar.hidden = !available; navigation.hidden = !available; actions.hidden = !available;
        fallbackBox.hidden = !state()?.data || available;
    }
    function filtered() {
        const query = (state()?.query || '').toLocaleLowerCase();
        return (state()?.rows || []).map((row, index) => ({ row, index })).filter(({ row }) => `${row.zh}\n${row.en}`.toLocaleLowerCase().includes(query));
    }
    function draw() {
        const draft = state();
        rows.replaceChildren();
        if (!draft?.data?.supported) { notice.textContent = draft?.data?.reason || '展开后读取字幕。'; sync(); return; }
        search.value = draft.query || '';
        const matches = filtered();
        draft.page = Math.min(draft.page || 0, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
        counter.textContent = `${draft.page + 1} / ${Math.max(1, Math.ceil(matches.length / PAGE_SIZE))} 页 · ${matches.length} 句`;
        notice.textContent = context.data.frozen ? '此版本已合成，字幕只读。请先复制为新版本继续编辑。' : draft.dirty ? '有未保存的字幕修改' : '字幕已载入，可直接编辑。';
        if (!matches.length) rows.append(node('p', 'editor-hint', '没有匹配的字幕。'));
        for (const { row, index } of matches.slice(draft.page * PAGE_SIZE, (draft.page + 1) * PAGE_SIZE)) {
            const card = node('div', 'caption-row');
            const header = node('div', 'caption-row-heading');
            header.append(node('strong', '', `第 ${index + 1} 句`), node('span', '', row.at || `${row.start.toFixed(2)}–${row.end.toFixed(2)} 秒`));
            const rowPreview = node('button', 'editor-secondary', '保存并预览此句'); rowPreview.type = 'button';
            rowPreview.setAttribute('aria-label', `保存并预览第 ${index + 1} 句`);
            rowPreview.addEventListener('click', () => { draft.selected = index; onPreview(row); });
            header.append(rowPreview); card.append(header);
            const columns = node('div', 'caption-language-grid');
            for (const [key, label] of [['zh', '中文'], ['en', '英文']]) {
                const field = node('label', 'editor-field'); const input = node('textarea');
                input.rows = 2; input.maxLength = 2000; input.value = row[key] || '';
                input.setAttribute('aria-label', `第 ${index + 1} 句${label}字幕`);
                input.addEventListener('focus', () => { draft.selected = index; });
                input.addEventListener('input', () => {
                    row[key] = input.value; draft.dirty = true; draft.selected = index;
                    notice.textContent = '有未保存的字幕修改'; onChange(); sync();
                });
                field.append(node('span', '', label), input); columns.append(field);
            }
            card.append(columns); rows.append(card);
        }
        sync();
    }
    async function load() {
        if (loading) return;
        loading = true; notice.textContent = '正在读取字幕…'; sync();
        try {
            const data = await request(`${context.base}/captions`);
            if (!alive()) return;
            if (!state()?.dirty) context.captionDraft = { data, rows: structuredClone(data.rows || []), page: 0, query: '', selected: 0, dirty: false, open: true };
            draw();
        } catch (error) { if (alive()) notice.textContent = `无法读取字幕：${error.message} 收起后重新展开可重试。`; }
        finally { loading = false; if (alive()) sync(); }
    }
    panel.addEventListener('toggle', () => {
        if (state()) state().open = panel.open;
        if (panel.open) load();
    });
    search.addEventListener('input', () => { state().query = search.value; state().page = 0; draw(); });
    previous.addEventListener('click', () => { state().page--; draw(); });
    next.addEventListener('click', () => { state().page++; draw(); });
    save.addEventListener('click', onSave);
    preview.addEventListener('click', () => onPreview(state().rows[state().selected || 0]));
    panel.open = state()?.open || false;
    draw();
    return {
        update: sync,
        async save() {
            const draft = state();
            if (!draft?.dirty) return;
            let result;
            try {
                result = await mutate(context, 'captions', { rows: draft.rows.map(({ zh, en }) => ({ zh, en })), revision: draft.data.revision, inputs: context.inputs }, 'PUT');
            } catch (error) {
                if (alive()) notice.textContent = `字幕未保存：${error.message}`;
                throw error;
            }
            context.captionDraft = { ...draft, data: result.captions, rows: structuredClone(result.captions.rows), dirty: false };
            onSaved(result.inputs);
            if (alive()) { draw(); notice.textContent = '字幕已保存。'; }
        },
    };
}

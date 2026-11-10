const $ = selector => document.querySelector(selector);
const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
};
const state = { references: [], loaded: false, query: '', availableOnly: false, scan: null, scanBusy: false,
    selected: new Set(), jobs: [], downloadSubmitting: false, production: null, productionBusy: false, importBusy: false };
let pollTimer;
let listRequest = 0;
let jobsRequest = 0;
let stopped = false;
let addReturnToLibrary = false;
const providerLabels = { local: '本地文件', manifest: '清单导入', 'yt-dlp': '链接下载', 'gateway-video': '素材网关' };
const formatBytes = value => Number.isFinite(value) ? `${(value / 1048576).toFixed(1)} MB` : '大小未登记';
const formatDuration = value => Number.isFinite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '时长未登记';
const projectUrl = slug => `./#${new URLSearchParams({ project: slug })}`;
function sourceUrl(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
}
function setStatus(selector, message, error = false) {
    const item = $(selector);
    item.textContent = message;
    item.classList.toggle('is-error', error);
}
function notify(message, error = false, link) {
    const box = $('#page-status');
    box.replaceChildren(document.createTextNode(message));
    box.hidden = !message;
    box.classList.toggle('is-error', error);
    if (link) { const anchor = node('a', '', link.text); anchor.href = link.href; box.append(anchor); }
}
async function api(route, body) {
    const response = await fetch(`api/references${route}`, body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remake-Action': 'references' }, body: JSON.stringify(body),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('工作台返回了无法读取的结果，请刷新后重试。'); }
    if (!response.ok) throw Object.assign(new Error(result.error || '操作未完成，请稍后重试。'), { code: result.code, data: result.data });
    return result;
}
const methodTitles = { file: '添加本地视频', folder: '从文件夹选择视频', download: '下载视频链接', manifest: '导入文件清单' };
const methodInputs = { file: '#file-path', folder: '#scan-path', download: '#download-url', manifest: '#manifest-path' };
const revealedFailures = new Set();
function addBusy() { return state.importBusy || state.scanBusy || state.downloadSubmitting; }
function syncAddControls() {
    $('#close-add').disabled = addBusy();
    $('#back-methods').disabled = addBusy();
}
function activatePanel(name) {
    $('#add-methods').hidden = !!name;
    $('#back-methods').hidden = !name;
    $('#add-heading').textContent = methodTitles[name] || '添加参考视频';
    for (const method of Object.keys(methodTitles)) $(`#panel-${method}`).hidden = method !== name;
    $('#add-dialog').scrollTop = 0;
    if (name) $(methodInputs[name]).focus();
    else $('#tab-file').focus();
}
function openAdd() {
    addReturnToLibrary = false;
    $('#add-dialog').showModal();
    activatePanel(null);
}
function closeAdd(force = false, focusLibrary = false) {
    if (!force && addBusy()) return;
    addReturnToLibrary = focusLibrary;
    $('#add-dialog').close();
}
function showLibrary() {
    closeAdd(true, true);
    $('#library-heading').focus({ preventScroll: true });
    $('#reference-library').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
$('#add-reference').addEventListener('click', openAdd);
$('#close-add').addEventListener('click', () => closeAdd());
$('#back-methods').addEventListener('click', () => activatePanel(null));
$('#add-dialog').addEventListener('cancel', event => { if (addBusy()) event.preventDefault(); });
$('#add-dialog').addEventListener('close', () => {
    $(addReturnToLibrary ? '#library-heading' : '#add-reference').focus({ preventScroll: true });
});
$('#add-dialog').addEventListener('invalid', event => {
    let parent = event.target.parentElement;
    while (parent && parent !== $('#add-dialog')) {
        if (parent.tagName === 'DETAILS') parent.open = true;
        parent = parent.parentElement;
    }
}, true);
for (const method of document.querySelectorAll('[data-panel]')) method.addEventListener('click', () => activatePanel(method.dataset.panel));
$('#view-download').addEventListener('click', () => {
    $('#jobs-section').open = true;
    $('#jobs-section').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
let previewTrigger;
function openPreview(item) {
    previewTrigger = document.activeElement;
    $('#preview-title').textContent = item.title || item.id;
    $('#preview-error').hidden = true;
    const player = $('#reference-player');
    player.src = `./${item.videoUrl}`;
    if (item.posterUrl) player.poster = `./${item.posterUrl}`;
    else player.removeAttribute('poster');
    $('#preview-dialog').showModal();
    player.play().catch(() => {});
}
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('close', () => {
    const player = $('#reference-player'); player.pause(); player.removeAttribute('src'); player.load();
    if (previewTrigger?.isConnected) previewTrigger.focus({ preventScroll: true });
});
$('#reference-player').addEventListener('error', () => { if ($('#preview-dialog').open) $('#preview-error').hidden = false; });

function renderReferences() {
    $('#total-count').textContent = String(state.references.length);
    $('#available-count').textContent = String(state.references.filter(item => item.available).length);
    $('#nav-reference-count').textContent = String(state.references.length);
    const query = state.query.trim().toLowerCase();
    const references = state.references.filter(item => (!state.availableOnly || item.available)
        && [item.title, item.id, ...(item.productions || [])].join(' ').toLowerCase().includes(query));
    $('#visible-count').textContent = query || state.availableOnly ? `筛选结果 ${references.length} 条` : '';
    const list = $('#reference-list');
    list.replaceChildren();
    if (!references.length && state.loaded) {
        const empty = node('div', 'refs-empty');
        empty.append(node('strong', '', state.references.length ? '没有匹配的参考' : '还没有参考视频'),
            node('p', '', state.references.length ? '试试其他关键词，或取消「仅原片可用」。' : '先添加一个原片，再选择它开始自己的制作。'));
        if (!state.references.length) {
            const steps = node('p', 'refs-empty-steps', '添加原片  →  选择参考  →  创建制作'); empty.append(steps);
            const button = node('button', 'refs-button refs-secondary', '添加第一条参考'); button.type = 'button';
            button.addEventListener('click', openAdd); empty.append(button);
        }
        list.append(empty);
    }
    for (const item of references) {
        const card = node('article', 'refs-card');
        const icon = node('button', 'refs-cover'); icon.type = 'button';
        icon.disabled = !item.videoUrl;
        icon.setAttribute('aria-label', `播放原片：${item.title || item.id}`);
        const fallback = node('span', 'refs-cover-placeholder', '暂无封面'); icon.append(fallback);
        if (item.posterUrl) {
            const poster = node('img'); poster.src = `./${item.posterUrl}`; poster.alt = ''; poster.loading = 'lazy';
            poster.addEventListener('error', () => poster.remove(), { once: true }); icon.append(poster);
        }
        icon.append(node('span', 'refs-cover-play', item.videoUrl ? '▶ 播放原片' : '原片不可播放'));
        if (Number.isFinite(item.durationSec)) icon.append(node('span', 'refs-cover-duration', formatDuration(item.durationSec)));
        icon.addEventListener('click', () => openPreview(item));
        const content = node('div', 'refs-card-content');
        const heading = node('div', 'refs-card-title');
        heading.append(node('h3', '', item.title || item.id), node('span', `refs-badge${item.available ? '' : ' is-unavailable'}`, item.available ? '原片可用' : '原片不可用'));
        const meta = node('div', 'refs-card-meta');
        meta.append(node('span', '', providerLabels[item.provider] || item.provider || '本地参考'));
        if (Number.isFinite(item.durationSec)) meta.append(node('span', '', formatDuration(item.durationSec)));
        if (item.status === 'understanding') meta.append(node('span', '', '理解中'));
        content.append(heading, meta);
        const productions = node('div', 'refs-card-links'); productions.append(node('span', '', '关联制作'));
        if (!item.productions?.length) productions.append(node('span', '', '尚未创建制作'));
        for (const slug of item.productions || []) { const link = node('a', '', slug); link.href = projectUrl(slug); productions.append(link); }
        content.append(productions);
        if (item.availabilityError) content.append(node('p', 'refs-card-error', item.availabilityError));
        const details = node('details'); details.append(node('summary', '', '查看来源与路径'));
        const identifier = node('p'); identifier.append(document.createTextNode('参考标识：'), node('code', '', item.id)); details.append(identifier);
        if (item.videoPath) { const file = node('p'); file.append(document.createTextNode('原片：'), node('code', '', item.videoPath)); details.append(file); }
        const url = sourceUrl(item.canonicalUrl);
        if (url) { const source = node('p'); const link = node('a', '', '打开原始来源 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; source.append(link); details.append(source); }
        content.append(details);
        const create = node('button', 'refs-button refs-secondary', '创建制作'); create.type = 'button'; create.disabled = !item.available;
        if (!item.available) create.title = '原片恢复可读后才能创建制作';
        create.addEventListener('click', () => openProduction(item));
        card.append(icon, content, create); list.append(card);
    }
}
async function loadReferences() {
    const request = ++listRequest;
    $('#refresh-references').disabled = true;
    if (!state.loaded) $('#library-loading').hidden = false;
    try {
        const result = await api('');
        if (request !== listRequest || stopped) return;
        state.references = result.references || [];
        state.loaded = true;
        $('#library-loading').hidden = true;
        renderReferences();
    } catch (error) {
        if (request !== listRequest || stopped) return;
        $('#library-loading').hidden = state.loaded;
        if (!state.loaded) $('#library-loading').textContent = '清单读取失败。请点击「刷新清单」重试。';
        notify(error.message, true);
    } finally { if (request === listRequest) $('#refresh-references').disabled = false; }
}
async function importForm(form, status, payload) {
    const fieldset = form.querySelector('fieldset');
    if (fieldset.disabled) return;
    fieldset.disabled = true; state.importBusy = true; syncAddControls(); setStatus(status, '正在检查原片并登记…');
    try {
        const result = await api('/import', payload);
        const count = result.count ?? result.references?.length ?? 0;
        setStatus(status, `已登记 ${count} 条参考，原片保留在原位置。`);
        notify(`已添加 ${count} 条参考。选择一条即可创建制作。`);
        await loadReferences();
        showLibrary();
    } catch (error) { setStatus(status, error.message, true); }
    finally { fieldset.disabled = false; state.importBusy = false; syncAddControls(); }
}
$('#file-form').addEventListener('submit', event => {
    event.preventDefault();
    const payload = { file: $('#file-path').value.trim() };
    if ($('#file-id').value.trim()) payload.id = $('#file-id').value.trim();
    if ($('#file-title').value.trim()) payload.title = $('#file-title').value.trim();
    void importForm(event.currentTarget, '#file-status', payload);
});
$('#manifest-form').addEventListener('submit', event => {
    event.preventDefault(); const payload = { manifest: $('#manifest-path').value.trim() };
    if ($('#manifest-root').value.trim()) payload.assetRoot = $('#manifest-root').value.trim();
    void importForm(event.currentTarget, '#manifest-status', payload);
});
function invalidateScan() {
    state.scan = null; state.selected.clear(); $('#scan-results').hidden = true;
    setStatus('#scan-status', '');
}
$('#scan-path').addEventListener('input', invalidateScan);
$('#scan-recursive').addEventListener('change', invalidateScan);
function selectionStatus() {
    $('#selection-count').textContent = `已选择 ${state.selected.size} 个`;
    $('#import-selected').disabled = state.scanBusy || !state.selected.size;
    for (const checkbox of document.querySelectorAll('#scan-candidates input')) checkbox.disabled = state.scanBusy || checkbox.dataset.registered === 'true';
    $('#select-new').disabled = state.scanBusy; $('#clear-selection').disabled = state.scanBusy;
}
function renderScan() {
    const scan = state.scan;
    $('#scan-results').hidden = !scan;
    if (!scan) return;
    const candidates = scan.candidates || [];
    $('#scan-count').textContent = `${candidates.length} 个视频 · ${candidates.filter(item => item.referenceIds?.length).length} 个已登记`;
    const container = $('#scan-candidates'); container.replaceChildren();
    for (const item of candidates) {
        const registered = !!item.referenceIds?.length;
        const label = node('label', `refs-candidate${registered ? ' is-registered' : ''}`);
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(item.relativePath);
        checkbox.dataset.registered = String(registered); checkbox.disabled = registered || state.scanBusy;
        checkbox.setAttribute('aria-label', `选择 ${item.relativePath}`);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) state.selected.add(item.relativePath); else state.selected.delete(item.relativePath);
            selectionStatus();
        });
        const text = node('span', '', item.relativePath); text.append(node('small', '', `${formatBytes(item.bytes)} · ${registered ? '已登记' : '未登记'}`));
        label.append(checkbox, text); container.append(label);
    }
    if (!candidates.length) container.append(node('p', 'refs-empty', '没有发现可导入的视频。试试其他文件夹，或勾选「包含子文件夹」。'));
    selectionStatus();
}
$('#scan-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.scanBusy) return;
    const fieldset = event.currentTarget.querySelector('fieldset');
    const payload = { directory: $('#scan-path').value.trim(), recursive: $('#scan-recursive').checked };
    state.scanBusy = true; syncAddControls(); fieldset.disabled = true; invalidateScan(); selectionStatus();
    setStatus('#scan-status', '正在扫描候选，不会写入参考清单…');
    try {
        const result = await api('/scan', payload);
        state.scan = { ...result, recursive: payload.recursive }; state.selected.clear();
        setStatus('#scan-status', `扫描完成，找到 ${result.candidates.length} 个视频${result.skipped?.length ? `，跳过 ${result.skipped.length} 项（隐藏、链接或不可读文件等）` : ''}。请选择需要导入的条目。`);
        renderScan();
    } catch (error) { setStatus('#scan-status', error.message, true); }
    finally { state.scanBusy = false; syncAddControls(); fieldset.disabled = false; selectionStatus(); }
});
$('#select-new').addEventListener('click', () => {
    state.selected = new Set((state.scan?.candidates || []).filter(item => !item.referenceIds?.length).map(item => item.relativePath)); renderScan();
});
$('#clear-selection').addEventListener('click', () => { state.selected.clear(); renderScan(); });
$('#import-selected').addEventListener('click', async () => {
    if (state.scanBusy || !state.scan || !state.selected.size) return;
    const snapshot = state.scan;
    state.scanBusy = true; syncAddControls(); $('#scan-form fieldset').disabled = true; selectionStatus();
    setStatus('#scan-status', '正在检查所选原片并登记…');
    try {
        const result = await api('/scan/import', { directory: snapshot.directory, recursive: snapshot.recursive, select: [...state.selected] });
        const count = result.imported?.length || 0;
        setStatus('#scan-status', count ? `已导入 ${count} 条参考。相同内容或已登记的原片会自动跳过。` : '所选原片已登记或内容重复，没有新增参考。');
        notify(count ? `已导入 ${count} 条参考。` : '已检查所选视频，没有新参考需要导入。');
        state.selected.clear();
        await loadReferences();
        invalidateScan();
        showLibrary();
    } catch (error) { setStatus('#scan-status', error.message, true); }
    finally { state.scanBusy = false; syncAddControls(); $('#scan-form fieldset').disabled = false; selectionStatus(); }
});
function openProduction(reference) {
    state.production = reference;
    $('#production-reference').textContent = `参考：${reference.title || reference.id}`;
    $('#production-slug').value = '';
    setStatus('#production-status', '');
    $('#production-dialog').showModal(); $('#production-slug').focus();
}
function closeProduction() { if (!state.productionBusy) $('#production-dialog').close(); }
$('#close-production').addEventListener('click', closeProduction);
$('#cancel-production').addEventListener('click', closeProduction);
$('#production-dialog').addEventListener('cancel', event => { if (state.productionBusy) event.preventDefault(); });
$('#production-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!state.production || state.productionBusy) return;
    state.productionBusy = true;
    const controls = [...event.currentTarget.querySelectorAll('button,input')]; controls.forEach(item => { item.disabled = true; });
    setStatus('#production-status', '正在创建制作…');
    try {
        const result = await api('/start', { referenceId: state.production.id, slug: $('#production-slug').value.trim() });
        $('#production-dialog').close();
        notify(`制作 ${result.production.slug} 已创建。`, false, { text: '进入制作 →', href: projectUrl(result.production.slug) });
        await loadReferences();
    } catch (error) { setStatus('#production-status', error.message, true); }
    finally { state.productionBusy = false; controls.forEach(item => { item.disabled = false; }); }
});
function downloadState() {
    const active = state.jobs.some(job => job.status === 'running');
    $('#download-submit').disabled = active || state.downloadSubmitting;
    $('#download-submit').textContent = state.downloadSubmitting ? '正在提交…' : active ? '已有下载进行中' : '开始下载';
}
function renderJobs() {
    const list = $('#job-list'); list.replaceChildren();
    $('#jobs-section').hidden = !state.jobs.length;
    $('#jobs-summary').textContent = `${state.jobs.length} 条`;
    $('#download-activity').hidden = !state.jobs.some(job => job.status === 'running');
    for (const job of state.jobs) {
        const card = node('article', 'refs-job');
        const heading = node('div', 'refs-job-heading');
        heading.append(node('span', `refs-badge${job.status === 'failed' ? ' is-unavailable' : ''}`, { running: '下载中', succeeded: '已登记', failed: '未完成' }[job.status] || job.status), node('span', '', `${job.quality || '1080'}p`));
        const date = new Date(job.createdAt);
        if (Number.isFinite(date.getTime())) { const time = node('time', '', date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })); time.dateTime = date.toISOString(); heading.append(time); }
        card.append(heading, node('p', 'refs-job-url', job.url));
        if (job.status === 'running') card.append(node('p', 'refs-job-result', '正在读取链接、下载或整理原片，完成后会自动更新。'));
        if (job.status === 'succeeded') {
            const count = job.result?.references?.length || 1;
            card.append(node('p', 'refs-job-result', `已加入 ${count} 条参考，可在清单中创建制作。`));
        }
        if (job.error) {
            if (!revealedFailures.has(job.id)) { $('#jobs-section').open = true; revealedFailures.add(job.id); }
            card.append(node('p', 'refs-job-error', job.error.message || '下载未完成，请检查链接和下载工具。'));
            const recovery = job.error.data?.file || job.error.data?.directory;
            if (recovery && !job.error.message?.includes(recovery)) card.append(node('p', 'refs-job-result', `已保留：${recovery}`));
        }
        list.append(card);
    }
    downloadState();
}
function scheduleJobs() {
    clearTimeout(pollTimer);
    if (!stopped && state.jobs.some(job => job.status === 'running')) pollTimer = setTimeout(() => { void loadJobs(); }, 1500);
}
async function loadJobs() {
    const request = ++jobsRequest;
    try {
        const previous = new Map(state.jobs.map(job => [job.id, job.status]));
        const result = await api('/jobs');
        if (stopped || request !== jobsRequest) return;
        state.jobs = result.jobs || [];
        setStatus('#jobs-status', ''); renderJobs();
        const completed = state.jobs.filter(job => previous.get(job.id) === 'running' && job.status === 'succeeded');
        if (completed.length) { notify('视频已下载并登记到参考清单。'); await loadReferences(); }
    } catch (error) {
        if (stopped || request !== jobsRequest) return;
        $('#jobs-section').hidden = false; $('#jobs-section').open = true;
        setStatus('#jobs-status', `任务状态暂时无法更新：${error.message}`, true);
    } finally { scheduleJobs(); }
}
$('#download-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.downloadSubmitting || state.jobs.some(job => job.status === 'running')) return;
    state.downloadSubmitting = true; syncAddControls(); downloadState(); setStatus('#download-status', '正在提交下载任务…');
    try {
        const result = await api('/download', { url: $('#download-url').value.trim(), quality: $('#download-quality').value });
        jobsRequest += 1;
        state.jobs = [result.job, ...state.jobs.filter(job => job.id !== result.job.id)]; renderJobs(); scheduleJobs();
        setStatus('#download-status', '下载任务已启动。');
        notify('下载已开始，完成后会自动加入参考清单。');
        closeAdd(true);
        if (result.job.status === 'succeeded') await loadReferences();
    } catch (error) {
        setStatus('#download-status', error.message, true);
        if (error.code === 'DOWNLOAD_BUSY') await loadJobs();
    } finally { state.downloadSubmitting = false; syncAddControls(); downloadState(); }
});
$('#download-doctor').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; setStatus('#doctor-status', '正在检查本机工具，不会访问视频网站…');
    try {
        const result = await api('/download/doctor');
        const checks = (result.checks || []).map(item => `${item.tool} ${item.ready ? '可用' : '未就绪'}`).join(' · ');
        setStatus('#doctor-status', result.ready ? `下载工具就绪。${checks}。实际链接是否可下载需以下载结果为准。` : result.hint || checks || '下载工具尚未就绪。', !result.ready);
    } catch (error) { setStatus('#doctor-status', error.message, true); }
    finally { button.disabled = false; }
});
$('#reference-search').addEventListener('input', event => { state.query = event.target.value; renderReferences(); });
$('#available-only').addEventListener('change', event => { state.availableOnly = event.target.checked; renderReferences(); });
$('#refresh-references').addEventListener('click', () => { notify(''); void loadReferences(); void loadJobs(); });
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void loadReferences(); void loadJobs(); } });
void loadReferences();
void loadJobs();

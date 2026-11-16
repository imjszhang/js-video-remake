/** 项目视图：项目头、两个工作区页签、归档菜单，以及把模板编辑器和放映区接到当前项目上。 */
import { api } from './api.js';
import { $, $$, node, statusLabel, notify, mediaUrl } from './ui.js';
import { state, activeProject, changed, updateHash } from './state.js';
import { projectTitle } from './library-model.js';
import { mountTemplateEditor, preferTemplateVersion } from './template-editor.js';
import { workspaceForProject, templatePlaybackVideo, groupTemplatePackages } from './workspace.js';
import { chooseDraftVersion, videoForVersion } from './versions.js';
import { renderTemplates } from './templates.js';
import { renderVersions, selectVideo, releasePlayers, pausePlayback, resumePlaybackIfNeeded } from './playback.js';

let actions = { reload: async () => {} };
const tabs = () => $$('[data-workspace]');

export function setWorkspace(preferred, { focus = false } = {}) {
    const project = activeProject();
    state.workspace = workspaceForProject(project, preferred);
    const editing = state.workspace === 'template';
    $('#template-workspace').hidden = !editing;
    $('#playback-workspace').hidden = editing;
    $('#template-tab').hidden = !project?.templatePackages?.length;
    for (const tab of tabs()) {
        const selected = tab.dataset.workspace === state.workspace;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
    }
    if (editing) pausePlayback(); else resumePlaybackIfNeeded();
    updateHash();
}

function playTemplateVersion(version) {
    const video = templatePlaybackVideo(activeProject(), version);
    if (!video) { notify('这个模板版本尚未合成视频。请在「预览与导出」中合成后播放。'); return; }
    state.version = version;
    renderVersions();
    selectVideo(video.id);
    setWorkspace('playback', { focus: true });
    $('#playback-workspace').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

const ACTIVITY_LABELS = {
    preparing: '正在准备', running: '正在制作', completed: '这一轮已结束',
    failed: '已停下', cancelled: '已取消', timed_out: '已到时限', interrupted: '已中断',
};
const ACTIVE_AGENT = new Set(['preparing', 'running']);
let consoleTargets = [];
let consoleCatalog = { harnesses: [], providers: [], targets: [] };
const discoveredModels = new Map();

function renderConsole(project, view = {}) {
    const panel = $('#agent-console');
    if (!panel) return;
    panel.hidden = false;
    const activity = project?.activity;
    const running = Boolean(activity && ACTIVE_AGENT.has(activity.status));
    const dot = $('#agent-console-dot');
    dot.hidden = !running;
    const packages = activity?.packages?.length ? activity.packages.join('、') : '';
    if (Array.isArray(view.targets)) consoleTargets = view.targets.filter(item => item && typeof item.name === 'string');
    const currentTarget = consoleTargets.find(item => item.name === activity?.target);
    const meta = activity
        ? [ACTIVITY_LABELS[activity.status] || activity.status, currentTarget?.label || activity.target, activity.runId, packages].filter(Boolean).join(' · ')
        : '还没有运行';
    $('#agent-console-meta').textContent = meta;
    const log = $('#agent-console-log');
    const lines = Array.isArray(view.lines) ? view.lines : [];
    const header = activity?.summary ? [`# ${activity.summary}`] : [];
    const text = [...header, ...lines].join('\n') || (running ? '等待输出…' : '填写提示词后，可以在这个项目里开始或继续调整。');
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 36;
    if (log.textContent !== text) {
        log.textContent = text;
        if (pinned) log.scrollTop = log.scrollHeight;
    }
    renderExecution(view);
    syncEngine(project);
    updateTargetDetail();
    $('#agent-prompt').disabled = running;
    $('#agent-continue').disabled = running || !activity?.runId;
    $('#agent-cancel').disabled = !running;
}

let watchToken = 0;
let watchTimer = 0;
function watchConsole(slug) {
    const token = ++watchToken;
    clearTimeout(watchTimer);
    const tick = async () => {
        if (token !== watchToken || state.selected !== slug) return;
        try {
            const data = await api.agentConsole(slug);
            if (token !== watchToken) return;
            const current = activeProject();
            if (!current || current.slug !== slug) return;
            const previous = current.activity;
            current.activity = data.activity;
            renderConsole(current, data);
            const running = data.activity && ACTIVE_AGENT.has(data.activity.status);
            const packagesChanged = JSON.stringify(data.activity?.packages || []) !== JSON.stringify(previous?.packages || []);
            const finished = previous && ACTIVE_AGENT.has(previous.status) && data.activity && !running;
            if (packagesChanged || finished) {
                watchToken += 1;
                await actions.reload();
                return;
            }
        } catch { /* 保留上一屏输出。 */ }
        if (token === watchToken) watchTimer = setTimeout(tick, 2000);
    };
    watchTimer = setTimeout(tick, 300);
}

function renderHeader(project) {
    const hasTemplate = Boolean(project.templatePackages?.length);
    $('#project-title').textContent = projectTitle(project);
    $('#project-kicker').textContent = `${project.videos.length > 1 ? 'SERIES' : 'PROJECT'} / ${project.referenceCount || 0} 条参考${project.archived ? ' / 已归档' : ''}`;
    $('#project-status').textContent = statusLabel(project);
    $('#project-status').dataset.status = project.status;
    $('#archive-project').textContent = project.archived ? '恢复项目' : '归档项目';
    $('#template-tab-count').textContent = groupTemplatePackages(project.templatePackages).length;
    $('#playback-tab-count').textContent = project.videos.length;
    $('#screening').hidden = !project.videos.length;
    const original = project.originals?.[0];
    const preview = $('#remake-original');
    $('#empty-project').hidden = Boolean(project.videos.length);
    $('#empty-project h3').textContent = hasTemplate ? '还没有可播放的视频' : original ? '复刻还没有成片' : '这个项目还在制作中';
    $('#empty-project p').textContent = hasTemplate
        ? '模板和静态截图已在工作台就绪。进入「预览与导出」，合成后的视频会出现在这里。'
        : original
            ? `对标原片「${original.title}」可以先看。复刻工程还在制作，成片登记后会出现在这里，并和原片并排对比。`
            : project.codePackages?.length
                ? '登记成片后可以在这里播放。也可以把上面的复刻工程收成模板，再填写口播和音乐。'
                : '登记成片或审阅草稿后，会自动出现在这里。';
    if (preview) {
        if (!project.videos.length && original && mediaUrl(original.url)) {
            const url = mediaUrl(original.url);
            if (preview.dataset.src !== url) { preview.dataset.src = url; preview.src = url; }
            preview.hidden = false;
        } else {
            preview.hidden = true;
            preview.removeAttribute('src');
            delete preview.dataset.src;
        }
    }
    renderAdopt(project);
    renderConsole(project);
}

function renderAdopt(project) {
    const packages = project.codePackages || [];
    const panel = $('#adopt-panel');
    panel.hidden = !packages.length;
    if (!packages.length) return;
    const select = $('#adopt-package');
    const title = $('#adopt-title');
    const previous = select.value;
    select.replaceChildren(...packages.map(pkg => {
        const name = pkg.title && pkg.title !== pkg.name ? `${pkg.title} · ${pkg.name}` : pkg.name;
        const option = node('option', '', pkg.engine === 'film' ? `${name}（film）` : name);
        option.value = pkg.name;
        return option;
    }));
    if (packages.some(pkg => pkg.name === previous)) select.value = previous;
    const signature = packages.map(pkg => pkg.name).join('\n');
    if (panel.dataset.signature !== signature) {
        panel.dataset.signature = signature;
        delete title.dataset.edited;
    }
    if (!title.dataset.edited) title.value = packages.find(pkg => pkg.name === select.value)?.title || select.value;
    refreshAdoptAction();
}

function refreshAdoptAction() {
    const button = $('#adopt-submit');
    const status = $('#adopt-status');
    if (!button || !status || status.dataset.busy === '1') return;
    button.disabled = false;
    if (status.dataset.reason === 'film') {
        status.textContent = '';
        delete status.dataset.reason;
    }
}

/** 打开（或在重新载入后刷新）一个项目。同一项目保持当前页签，换项目时按地址栏或默认规则决定。 */
export function openProject(slug, { videoId, version } = {}) {
    const project = state.projects.find(item => item.slug === slug);
    if (!project) return false;
    const hash = new URLSearchParams(location.hash.slice(1));
    const preferred = state.selected === slug ? state.workspace : hash.get('project') === slug ? hash.get('workspace') : null;
    Object.assign(state, {
        home: false, selected: slug, video: null,
        workspace: workspaceForProject(project, preferred),
        version: chooseDraftVersion(project, { version, videoId }),
    });
    $('#project-view').hidden = false;
    renderHeader(project);
    renderTemplates(project, { onPacked: actions.reload });
    mountTemplateEditor(project, { onLibraryChanged: actions.reload, onPlayVersion: playTemplateVersion });
    releasePlayers();
    renderVersions();
    if (project.videos.length) selectVideo(videoForVersion(project, state.version, project.videos.find(video => video.id === videoId)).id);
    setWorkspace(state.workspace);
    watchConsole(slug);
    changed();
    return true;
}

/** 离开项目视图：停掉播放、卸载编辑器。显示什么由调用方决定。 */
export function closeProject() {
    watchToken += 1;
    clearTimeout(watchTimer);
    const panel = $('#agent-console');
    if (panel) panel.hidden = true;
    Object.assign(state, { selected: null, video: null, version: null, workspace: null });
    releasePlayers();
    mountTemplateEditor(null);
    $('#project-view').hidden = true;
}

async function adoptTemplate(event) {
    event.preventDefault();
    const project = activeProject();
    if (!project) return;
    const name = $('#adopt-package').value;
    const title = $('#adopt-title').value.trim();
    const status = $('#adopt-status');
    const button = $('#adopt-submit');
    button.disabled = true;
    status.dataset.busy = '1';
    status.textContent = '正在收成模板，原来的复刻工程会保留。';
    try {
        const result = await api.adoptTemplate(project.slug, name, title);
        preferTemplateVersion(project.slug, result.video);
        state.workspace = 'template';
        await actions.reload();
        notify(`已把「${name}」收成模板。可以替换口播和音乐，也可以继续改造画面。`);
        status.textContent = '';
    } catch (error) { status.textContent = error.message; }
    finally {
        delete status.dataset.busy;
        refreshAdoptAction();
    }
}

async function toggleArchive() {
    const project = activeProject();
    if (!project) return;
    const control = $('#archive-project'); control.disabled = true;
    try {
        const { archived } = await api.archiveProject(project.slug, project.archived);
        // 归档后留在「进行中」并换到下一个项目；恢复后跟着项目回到「进行中」。
        state.scope = 'active';
        await actions.reload({ leaveProject: archived });
        notify(archived ? `「${projectTitle(project)}」已归档，可在左侧「已归档」中恢复。素材和成片均保留。` : `「${projectTitle(project)}」已恢复到进行中。`);
    } catch (error) { notify(error.message); }
    finally { control.disabled = false; closeMenu(); }
}

function agentInstruction() {
    return $('#agent-instruction').value;
}

function fillSelect(select, options, previous) {
    select.replaceChildren();
    for (const item of options) {
        const option = node('option', '', item.label);
        option.value = item.value;
        select.append(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    else if (select.options.length) select.selectedIndex = 0;
}

function rememberModels(providerId, models) {
    const ids = [];
    const labels = {};
    for (const item of models || []) {
        if (!item?.id || ids.includes(item.id)) continue;
        ids.push(item.id);
        labels[item.id] = item.label || item.id;
    }
    if (ids.length) discoveredModels.set(providerId, { ids, labels });
}

function applyDiscovered(catalog) {
    for (const provider of catalog?.providers || []) {
        const found = discoveredModels.get(provider.id);
        if (!found) continue;
        provider.models = [...new Set([...found.ids, ...(provider.models || [])])];
        provider.modelLabels = { ...(provider.modelLabels || {}), ...found.labels };
    }
}

function renderExecution(view = {}) {
    if (view.execution) {
        consoleCatalog = view.execution;
        applyDiscovered(consoleCatalog);
    }
    if (view.execution?.targets) consoleTargets = view.execution.targets;
    else if (Array.isArray(view.targets)) consoleTargets = view.targets.filter(item => item && typeof item.name === 'string');
    const harness = $('#agent-harness');
    const provider = $('#agent-provider');
    const model = $('#agent-model');
    const custom = $('#agent-model-custom');
    if (!harness || !provider || !model || !custom) return;
    const harnesses = consoleCatalog.harnesses?.length
        ? consoleCatalog.harnesses
        : (consoleCatalog.targets || consoleTargets).map(item => ({ name: item.name, label: item.harness || item.label }));
    const harnessSignature = harnesses.map(item => `${item.name}\t${item.label}`).join('\n');
    if (harness.dataset.signature !== harnessSignature) {
        const previous = harness.value;
        const defaultLabel = (consoleCatalog.targets || []).find(item => item.name === consoleCatalog.defaultTarget)?.harness;
        const preferred = harnesses.find(item => item.names?.includes(consoleCatalog.defaultTarget)) || harnesses.find(item => item.name === consoleCatalog.defaultTarget) || harnesses.find(item => item.label === defaultLabel);
        fillSelect(harness, harnesses.map(item => ({ value: item.name, label: item.label })), previous || preferred?.name || '');
        harness.dataset.signature = harnessSignature;
    }
    const providers = (consoleCatalog.providers || []).filter(item => !item.harnesses?.length || item.harnesses.includes(harness.value));
    const providerSignature = `${harness.value}\n${providers.map(item => `${item.id}\t${item.label}`).join('\n')}`;
    if (provider.dataset.signature !== providerSignature) {
        const previous = provider.value;
        fillSelect(provider, providers.map(item => ({ value: item.id, label: item.label })), previous);
        provider.dataset.signature = providerSignature;
    }
    const selected = providers.find(item => item.id === provider.value) || providers[0];
    const models = [...new Set((selected?.models || []).filter(Boolean))];
    const modelSignature = `${provider.value}\n${models.join('\n')}`;
    if (model.dataset.signature !== modelSignature) {
        const previous = model.value;
        const configured = (consoleCatalog.targets || []).find(item => item.name === consoleCatalog.defaultTarget)?.model;
        const preferred = models.includes(previous) ? previous : (models.includes(configured) ? configured : models[0] || '__custom__');
        fillSelect(model, [
            ...models.map(value => ({ value, label: selected?.modelLabels?.[value] && selected.modelLabels[value] !== value ? `${selected.modelLabels[value]}（${value}）` : (value === 'configured' ? '客户端当前模型' : value) })),
            { value: '__custom__', label: '自定义模型 ID…' },
        ], preferred);
        model.dataset.signature = modelSignature;
    }
    custom.hidden = model.value !== '__custom__';
    updateTargetDetail();
    refreshModels();
}

let modelRequest = '';
function refreshModels() {
    const providerId = $('#agent-provider')?.value;
    const harnessId = $('#agent-harness')?.value;
    const slug = state.selected;
    if (!providerId || !slug) return;
    const key = `${slug}\n${harnessId || ''}\n${providerId}`;
    if (modelRequest === key) return;
    modelRequest = key;
    const note = $('#agent-console-note');
    if (note && !note.textContent) note.textContent = '正在读取可选模型…';
    api.agentModels(slug, providerId, harnessId).then(data => {
        if (`${state.selected}\n${$('#agent-harness')?.value || ''}\n${$('#agent-provider')?.value || ''}` !== key) return;
        const ids = Array.isArray(data?.models) ? data.models.map(item => item?.id).filter(Boolean) : [];
        if (ids.length && !data?.error) rememberModels(providerId, data.models);
        else if (ids.length && !discoveredModels.has(providerId)) rememberModels(providerId, data.models);
        applyDiscovered(consoleCatalog);
        if (ids.length) {
            $('#agent-model').dataset.signature = '';
            renderExecution();
        }
        if (note && (note.textContent === '正在读取可选模型…' || data?.error)) note.textContent = data?.error || '';
    }).catch(error => {
        if (`${state.selected}\n${$('#agent-harness')?.value || ''}\n${$('#agent-provider')?.value || ''}` !== key) return;
        if (note) note.textContent = error.message;
    });
}

function storedEngine(slug) {
    try {
        const value = sessionStorage.getItem(`remake-engine:${slug}`);
        return value === 'film' || value === 'hyperframes' ? value : '';
    } catch { return ''; }
}

function syncEngine(project) {
    const select = $('#agent-engine');
    if (!select || !project || select.dataset.slug === project.slug) return;
    const saved = storedEngine(project.slug);
    const engines = [...new Set((project.codePackages || []).map(pkg => pkg.engine === 'film' ? 'film' : 'hyperframes'))];
    select.value = saved || (engines.length === 1 ? engines[0] : 'hyperframes');
    select.dataset.slug = project.slug;
}

function chosenEngine() {
    return $('#agent-engine')?.value === 'film' ? 'film' : 'hyperframes';
}

function chosenModel() {
    const model = $('#agent-model')?.value || '';
    if (model === '__custom__') return $('#agent-model-custom').value.trim();
    return model;
}

function updateTargetDetail() {
    const harness = (consoleCatalog.harnesses || []).find(item => item.name === $('#agent-harness')?.value);
    const provider = (consoleCatalog.providers || []).find(item => item.id === $('#agent-provider')?.value);
    const model = chosenModel();
    const modelText = model === 'configured' ? '客户端当前模型' : model || '尚未选择';
    const engineText = chosenEngine() === 'film' ? 'film' : 'HyperFrames';
    $('#agent-target-detail').textContent = harness || provider
        ? `执行器 ${harness?.label || '默认'}，Provider ${provider?.label || '当前连接'}，模型 ${modelText}，引擎 ${engineText}。`
        : `还没有启用的执行目标。引擎 ${engineText}。`;
}

function agentSelection() {
    return {
        target: $('#agent-harness')?.value || undefined,
        providerTarget: $('#agent-provider')?.value || undefined,
        model: chosenModel() || undefined,
        engine: chosenEngine(),
    };
}

async function runAgentAction(mode) {
    const project = activeProject();
    if (!project) return;
    const note = $('#agent-console-note');
    const buttons = ['#agent-prompt', '#agent-continue', '#agent-cancel'].map(selector => $(selector));
    for (const button of buttons) button.disabled = true;
    note.textContent = mode === 'cancel' ? '正在停止…' : '正在启动…';
    try {
        await api.agentAction(project.slug, { mode, instruction: agentInstruction(), ...agentSelection() });
        note.textContent = mode === 'cancel' ? '已请求停止。' : '已启动，输出会显示在上面。';
        if (mode !== 'cancel') $('#agent-instruction').value = '';
        watchConsole(project.slug);
    } catch (error) {
        note.textContent = error.message;
        renderConsole(activeProject() || project);
    }
}

const closeMenu = () => { for (const menu of $$('.project-menu[open]')) menu.removeAttribute('open'); };

export function initProjects(injected) {
    actions = { ...actions, ...injected };
    for (const tab of tabs()) {
        tab.addEventListener('click', () => setWorkspace(tab.dataset.workspace));
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const visible = tabs().filter(item => !item.hidden);
            const step = event.key === 'ArrowLeft' ? -1 : 1;
            const next = event.key === 'Home' ? visible[0] : event.key === 'End' ? visible.at(-1) : visible[(visible.indexOf(tab) + step + visible.length) % visible.length];
            setWorkspace(next.dataset.workspace, { focus: true });
        });
    }
    $('#archive-project').addEventListener('click', toggleArchive);
    $('#adopt-package').addEventListener('change', () => {
        refreshAdoptAction();
        const title = $('#adopt-title');
        if (title.dataset.edited) return;
        const pkg = activeProject()?.codePackages?.find(item => item.name === $('#adopt-package').value);
        title.value = pkg?.title || $('#adopt-package').value;
    });
    $('#adopt-title').addEventListener('input', event => { event.target.dataset.edited = '1'; });
    $('#adopt-form').addEventListener('submit', adoptTemplate);
    $('#agent-harness').addEventListener('change', () => { $('#agent-provider').dataset.signature = ''; $('#agent-model').dataset.signature = ''; renderExecution(); });
    $('#agent-provider').addEventListener('change', () => { $('#agent-model').dataset.signature = ''; renderExecution(); });
    $('#agent-model').addEventListener('change', () => { $('#agent-model-custom').hidden = $('#agent-model').value !== '__custom__'; updateTargetDetail(); });
    $('#agent-engine').addEventListener('change', () => {
        const slug = activeProject()?.slug;
        const engine = chosenEngine();
        if (slug) {
            try { sessionStorage.setItem(`remake-engine:${slug}`, engine); } catch { /* 隐私模式仍使用当前选择。 */ }
        }
        updateTargetDetail();
    });
    $('#agent-model-custom').addEventListener('input', updateTargetDetail);
    $('#agent-console-form').addEventListener('submit', event => { event.preventDefault(); void runAgentAction('prompt'); });
    $('#agent-continue').addEventListener('click', () => { void runAgentAction('continue'); });
    $('#agent-cancel').addEventListener('click', () => { void runAgentAction('cancel'); });
    document.addEventListener('click', event => { if (!event.target.closest('.project-menu')) closeMenu(); });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !$('.project-menu[open]')) return;
        closeMenu(); $('.project-menu > summary').focus();
    });
}

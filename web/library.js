import { $, node, projectTitle, statusLabels, notify } from './ui.js';
import { state, scopedProjects } from './state.js';

let deps = { selectProject() {}, load() {} };

export function renderProjects() {
    const nav = $('#projects'); nav.replaceChildren();
    const query = state.query.trim().toLowerCase();
    const projects = scopedProjects().filter((project) => (!state.playableOnly || project.videos.length) && [project.slug, projectTitle(project), ...project.videos.map((video) => video.title)].join(' ').toLowerCase().includes(query));
    for (const project of projects) {
        const selected = project.slug === state.selected;
        const button = node('button', `project-item${selected ? ' active' : ''}`); button.type = 'button'; button.setAttribute('aria-current', selected ? 'true' : 'false');
        button.append(node('span', 'project-icon', project.videos.length ? '▣' : '▧'));
        const info = node('span'); info.append(node('strong', '', projectTitle(project)), node('small', '', `${String(project.videos.length).padStart(2, '0')} 条视频 · ${statusLabels[project.status] || project.status || '制作中'}`)); button.append(info);
        button.addEventListener('click', () => deps.selectProject(project.slug)); nav.append(button);
    }
    if (!projects.length) nav.append(node('p', 'sidebar-message', state.projects.length ? (state.scope === 'archived' ? '没有已归档的项目' : '没有匹配的项目') : '暂无项目'));
}

export function renderStats() {
    $('#project-count').textContent = String(scopedProjects().length).padStart(2, '0');
    const videos = state.projects.filter(project => !project.archived).flatMap((project) => project.videos);
    const stats = $('#stats'); stats.replaceChildren();
    const entries = [[state.projects.filter(project => !project.archived).length, '制作项目'], [videos.length, '可播放视频'], [videos.filter((v) => v.kind === 'draft').length, '审阅草稿']];
    for (const [value, label] of entries) { const stat = node('div', 'stat'); stat.append(node('strong', '', String(value).padStart(2, '0')), node('span', '', label)); stats.append(stat); }
}

export function showLibrary() {
    $('#library-view').hidden = false;
    $('#library-empty').hidden = Boolean(state.projects.filter(project => !project.archived).length);
}

export function reflectScope() {
    setScopeButtons();
    renderStats();
    renderProjects();
}

function setScopeButtons() {
    document.querySelectorAll('[data-scope]').forEach((button) => {
        const active = button.dataset.scope === state.scope;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
}

function setBusy(controls, busy) { controls.forEach(control => { control.disabled = busy; }); $('#import-toggle').disabled = busy; }

export function initLibrary(options) {
    deps = { ...deps, ...options };
    $('#search').addEventListener('input', (event) => { state.query = event.target.value; renderProjects(); });
    document.querySelectorAll('[data-scope]').forEach((button) => button.addEventListener('click', () => {
        state.scope = button.dataset.scope; setScopeButtons(); renderStats(); renderProjects();
        deps.scopeChanged?.();
    }));
    $('#playable-only').addEventListener('change', (event) => { state.playableOnly = event.target.checked; renderProjects(); });
    $('#refresh').addEventListener('click', () => deps.load());
    $('#new-project').addEventListener('click', () => {
        state.scope = 'active'; state.playableOnly = false;
        $('#playable-only').checked = false; setScopeButtons(); renderStats(); renderProjects();
        deps.openLibrary();
        $('#import-form').hidden = false;
        $('#import-toggle').setAttribute('aria-expanded', 'true');
        $('#import-file').focus();
    });
    $('#import-toggle').addEventListener('click', () => {
        const form = $('#import-form');
        form.hidden = !form.hidden;
        $('#import-toggle').setAttribute('aria-expanded', String(!form.hidden));
        if (!form.hidden) $('#import-file').focus();
    });
    $('#import-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = $('#import-file').files[0];
        const status = $('#import-status');
        if (!file || !file.name.toLowerCase().endsWith('.video')) {
            status.textContent = '请选择 .video 模板文件。';
            return;
        }
        if (file.size > 100 * 1024 * 1024) {
            status.textContent = '模板文件不能超过 100 MiB。';
            return;
        }
        const controls = [...$('#import-form').querySelectorAll('input, button')];
        setBusy(controls, true);
        $('#import-form').setAttribute('aria-busy', 'true');
        status.textContent = '正在上传并导入模板…';
        try {
            const params = new URLSearchParams();
            const slug = $('#import-slug').value.trim();
            if (slug) params.set('slug', slug);
            const response = await fetch(`./api/templates/import?${params}`, {
                method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Remake-Action': 'import' }, body: file,
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '导入失败，请重试。');
            state.selected = result.slug; state.video = null; state.version = null; state.workspace = 'template';
            state.query = ''; state.scope = 'active'; state.playableOnly = false;
            $('#search').value = ''; $('#playable-only').checked = false; setScopeButtons();
            await deps.load();
            deps.selectProject(result.slug);
            $('#import-form').reset();
            status.textContent = '导入完成';
            notify(`已导入「${result.title || result.slug}」。接下来准备人物录像、口播和个人信息，合成后即可在这里播放。`);
        } catch (error) {
            status.textContent = error.message || '导入失败，请重试。';
        } finally {
            setBusy(controls, false);
            $('#import-form').removeAttribute('aria-busy');
        }
    });
}

import { $, projectTitle, statusLabels, notify } from './ui.js';
import { state, activeProject, updateHash } from './state.js';
import { mountTemplateEditor } from './template-editor.js';
import { workspaceForProject, templatePlaybackVideo, groupTemplatePackages } from './workspace.js';
import { chooseDraftVersion, videoForVersion } from './versions.js';
import { renderTemplates as templateList } from './templates.js';
import { renderVersions, selectVideo, releasePlayers, pausePlayback, setMode } from './playback.js';
import { renderProjects, renderStats, showLibrary, reflectScope } from './library.js';

export function setWorkspace(preferred, { focus = false } = {}) {
    const project = activeProject();
    state.workspace = workspaceForProject(project, preferred);
    const editing = state.workspace === 'template';
    $('#template-workspace').hidden = !editing;
    $('#playback-workspace').hidden = editing;
    $('#template-tab').hidden = !project?.templatePackages?.length;
    document.querySelectorAll('[data-workspace]').forEach(button => {
        const selected = button.dataset.workspace === state.workspace;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected && focus) button.focus();
    });
    if (editing) pausePlayback();
    else if (state.mode === 'compare' && state.video) setMode('compare', { keepTime: true, remember: false });
    updateHash();
}

export function selectProject(slug, videoId, version) {
    const project = state.projects.find((item) => item.slug === slug); if (!project) return;
    if (project.archived && state.scope !== 'archived') { state.scope = 'archived'; reflectScope(); }
    const preferredWorkspace = state.selected === slug ? state.workspace : null;
    const hashWorkspace = new URLSearchParams(location.hash.slice(1));
    state.workspace = workspaceForProject(project, preferredWorkspace || (hashWorkspace.get('project') === slug ? hashWorkspace.get('workspace') : null));
    state.selected = slug; state.video = null; state.version = chooseDraftVersion(project, { version, videoId });
    showProject(project);
    releasePlayers(); renderProjects(); renderStats(); renderVersions();
    if (project.videos.length) selectVideo(videoForVersion(project, state.version, project.videos.find((video) => video.id === videoId)).id);
    else updateHash();
    setWorkspace(state.workspace);
}

export function showProject(project) {
    $('#library-view').hidden = true;
    $('#project-view').hidden = false;
    $('#breadcrumb').textContent = `制作工作台 / ${projectTitle(project)}`;
    $('#archive-project').textContent = project.archived ? '恢复项目' : '归档项目';
    $('#project-title').textContent = projectTitle(project);
    $('#project-kicker').textContent = `${project.videos.length > 1 ? 'SERIES' : 'PROJECT'} / ${project.referenceCount || 0} 条参考`;
    $('#project-status').textContent = statusLabels[project.status] || project.status || '制作中'; $('#project-status').dataset.status = project.status;
    if (!project.videos.length) $('#playback-context').textContent = '这里播放已合成的视频，模板截图在工作台查看。';
    $('#screening').hidden = !project.videos.length; $('#empty-project').hidden = !!project.videos.length;
    const hasTemplate = Boolean(project.templatePackages?.length);
    $('#template-tab-count').textContent = groupTemplatePackages(project.templatePackages).length;
    $('#playback-tab-count').textContent = project.videos.length;
    renderTemplates(project);
    mountTemplateEditor(project, { onLibraryChanged: loadProjectData, onPlayVersion: playTemplateVersion });
    $('#empty-project h3').textContent = hasTemplate ? '还没有可播放的视频' : '这个项目还在制作中';
    $('#empty-project p').textContent = hasTemplate ? '模板和静态截图已在工作台就绪。进入「预览与导出」，合成后的视频会出现在这里。' : '登记成片或审阅草稿后，会自动出现在这里。';
}

export function showLibraryView() {
    state.selected = null; state.video = null;
    pausePlayback(); releasePlayers();
    mountTemplateEditor(null);
    $('#project-view').hidden = true;
    $('#breadcrumb').textContent = '制作工作台';
    $('#screening').hidden = false;
    $('#templates').hidden = true;
    renderStats(); renderProjects(); showLibrary();
    updateHash();
}

function loadProjectData() { reload?.(); }
let reload = null;
export function setReloadHandler(handler) { reload = handler; }

export function playTemplateVersion(version) {
    const video = templatePlaybackVideo(activeProject(), version);
    if (!video) {
        notify('这个模板版本尚未合成视频。请在「预览与导出」中合成后播放。');
        return;
    }
    state.version = version;
    renderVersions();
    selectVideo(video.id);
    setWorkspace('playback', { focus: true });
    $('#playback-workspace').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function renderTemplates(project) {
    templateList(project, {
        pack: async (pkg, button) => {
            button.disabled = true; button.textContent = '正在打包…';
            try {
                const response = await fetch(`api/projects/${encodeURIComponent(project.slug)}/templates/${encodeURIComponent(pkg.name)}`, {
                    method: 'POST', headers: { 'X-Remake-Action': 'pack' },
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || '打包失败');
                reload?.();
                notify('模板已打包，点击「下载 .video」保存。');
            } catch (error) { notify(error.message); }
            finally { button.disabled = false; button.textContent = '打包 .video'; }
        },
    });
}

export async function archiveActiveProject() {
    const project = activeProject();
    if (!project) return;
    const button = $('#archive-project'); button.disabled = true;
    try {
        const response = await fetch(`api/projects/${encodeURIComponent(project.slug)}/${project.archived ? 'restore' : 'archive'}`, {
            method: 'POST', headers: { 'X-Remake-Action': 'archive' },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '归档操作失败');
        await reload?.();
        notify(result.archived ? '项目已归档，可在「已归档」中恢复。素材和成片均保留。' : '项目已恢复到当前项目列表。');
    } catch (error) { notify(error.message); }
    finally { button.disabled = false; button.closest('details')?.removeAttribute('open'); }
}

export function initProjectControls() {
    document.querySelectorAll('[data-workspace]').forEach(button => {
        button.addEventListener('click', () => setWorkspace(button.dataset.workspace));
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...document.querySelectorAll('[data-workspace]')].filter(tab => !tab.hidden);
            const index = tabs.indexOf(button);
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
            setWorkspace(next.dataset.workspace, { focus: true });
        });
    });
    $('#archive-project').addEventListener('click', archiveActiveProject);
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.project-menu')) document.querySelectorAll('.project-menu[open]').forEach(menu => menu.removeAttribute('open'));
    });
}

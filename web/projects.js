/** 项目视图：项目头、两个工作区页签、归档菜单，以及把模板编辑器和放映区接到当前项目上。 */
import { api } from './api.js';
import { $, $$, statusLabel, notify } from './ui.js';
import { state, activeProject, changed, updateHash } from './state.js';
import { projectTitle } from './library-model.js';
import { mountTemplateEditor } from './template-editor.js';
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
    $('#empty-project').hidden = Boolean(project.videos.length);
    $('#empty-project h3').textContent = hasTemplate ? '还没有可播放的视频' : '这个项目还在制作中';
    $('#empty-project p').textContent = hasTemplate ? '模板和静态截图已在工作台就绪。进入「预览与导出」，合成后的视频会出现在这里。' : '登记成片或审阅草稿后，会自动出现在这里。';
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
    changed();
    return true;
}

/** 离开项目视图：停掉播放、卸载编辑器。显示什么由调用方决定。 */
export function closeProject() {
    Object.assign(state, { selected: null, video: null, version: null, workspace: null });
    releasePlayers();
    mountTemplateEditor(null);
    $('#project-view').hidden = true;
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
    document.addEventListener('click', event => { if (!event.target.closest('.project-menu')) closeMenu(); });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !$('.project-menu[open]')) return;
        closeMenu(); $('.project-menu > summary').focus();
    });
}

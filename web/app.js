import { $, notify, setRetryHandler } from './ui.js';
import { state, scopedProjects } from './state.js';
import { initLibrary, renderProjects, renderStats } from './library.js';
import { initPlayback, resumePlaybackIfNeeded, pausePlayback } from './playback.js';
import { selectProject, showLibraryView, initProjectControls, setReloadHandler } from './projects.js';

async function load() {
    $('#refresh').disabled = true;
    try {
        const response = await fetch('./api/projects', { cache: 'no-store' }); if (!response.ok) throw new Error('load failed');
        const data = await response.json(); if (!Array.isArray(data.projects)) throw new Error('invalid data');
        state.projects = data.projects; renderStats(); renderProjects();
        const hash = new URLSearchParams(location.hash.slice(1));
        const slug = state.selected || hash.get('project');
        const scoped = scopedProjects();
        const selected = scoped.find((project) => project.slug === slug)
            || state.projects.find((project) => project.slug === slug)
            || scoped.find((project) => project.videos.length)
            || scoped[0];
        if (selected) selectProject(selected.slug, state.video || hash.get('video'), state.version || hash.get('version'));
        else { showLibraryView(); notify(''); }
        if (selected) notify(data.warnings?.length ? `有 ${data.warnings.length} 项素材暂不可用，其他视频仍可正常播放。` : '');
    } catch { notify('无法读取项目库，请检查本地视频服务后重试。', true); }
    finally { $('#loading').hidden = true; $('#refresh').disabled = false; }
}

setRetryHandler(load);
setReloadHandler(load);

initLibrary({
    load,
    selectProject: (slug) => selectProject(slug),
    scopeChanged() { load(); },
    showLibrary() { showLibraryView(); showLibrary(); },
});
initPlayback();
initProjectControls();

window.addEventListener('hashchange', () => {
    const params = new URLSearchParams(location.hash.slice(1));
    state.workspace = params.get('workspace');
    if (['remake', 'original', 'compare'].includes(params.get('view'))) state.preferredMode = params.get('view');
    if (params.get('project')) selectProject(params.get('project'), params.get('video'), params.get('version'));
});
window.addEventListener('pageshow', (event) => { if (event.persisted) resumePlaybackIfNeeded(); });
window.addEventListener('pagehide', pausePlayback);

load();

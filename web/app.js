/** 入口：载入台账，决定显示制作库还是某个项目，并把各模块接起来。 */
import { api } from './api.js';
import { $, notify } from './ui.js';
import { state, changed, updateHash, readHash, playerModeFrom } from './state.js';
import { projectTitle, resolveSelection } from './library-model.js';
import { initLibrary, showHome } from './library.js';
import { initPlayback } from './playback.js';
import { initProjects, openProject, closeProject } from './projects.js';

function setCrumb(project) {
    $('#crumb-project').textContent = project ? projectTitle(project) : '';
    $('#crumb-project').hidden = !project;
    $('#crumb-separator').hidden = !project;
    if (project) $('#crumb-home').removeAttribute('aria-current'); else $('#crumb-home').setAttribute('aria-current', 'page');
    document.title = `${project ? `${projectTitle(project)} · ` : ''}制作工作台 · Video Remake`;
}

/** 回到制作库首页。 */
function goHome() {
    closeProject();
    state.home = true;
    showHome(true); setCrumb(null);
    changed(); updateHash();
}

/** 用户主动打开一个项目：侧栏范围跟着项目走，保证它在列表里可见。 */
function open(slug, target) {
    const project = state.projects.find(item => item.slug === slug);
    if (!project) return;
    state.scope = project.archived ? 'archived' : 'active';
    show(project, target);
}

function show(project, target) {
    showHome(false); setCrumb(project);
    openProject(project.slug, target);
}

async function load({ leaveProject = false } = {}) {
    $('#refresh').disabled = true;
    try {
        const data = await api.projects();
        if (!Array.isArray(data?.projects)) throw new Error('invalid data');
        state.projects = data.projects;
        const hash = readHash();
        const firstLoad = !state.selected && !state.home;
        const slug = leaveProject ? null : state.selected || (firstLoad ? hash.get('project') : null);
        const stayHome = !leaveProject && (state.home || (firstLoad && hash.has('home') && !hash.get('project')));
        const { project, scope } = resolveSelection(state.projects, { scope: state.scope, slug, deepLink: firstLoad });
        state.scope = scope;
        if (stayHome || !project) goHome();
        else show(project, { videoId: state.video || hash.get('video'), version: state.version || hash.get('version') });
        notify(data.warnings?.length ? `有 ${data.warnings.length} 项素材暂不可用，其他视频仍可正常播放。` : '');
    } catch (error) {
        notify(error.name === 'ApiError' ? `无法读取项目库：${error.message}` : '无法读取项目库，请检查本地视频服务后重试。', () => load());
    } finally {
        $('#loading').hidden = true;
        $('#refresh').disabled = false;
    }
}

initLibrary({ openProject: open, openHome: goHome, reload: load });
initProjects({ reload: load });
initPlayback();

$('#crumb-home').addEventListener('click', goHome);
window.addEventListener('hashchange', () => {
    const hash = readHash();
    if (playerModeFrom(hash)) state.preferredMode = playerModeFrom(hash);
    if (hash.get('project')) {
        if (hash.get('project') === state.selected) state.workspace = hash.get('workspace');
        open(hash.get('project'), { videoId: hash.get('video'), version: hash.get('version') });
    } else if (hash.has('home')) goHome();
});

load();

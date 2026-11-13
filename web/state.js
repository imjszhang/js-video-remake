import { templateVersionLabel } from './workspace.js';
import { videosForVersion } from './versions.js';

const playerModes = ['remake', 'original', 'compare'];
export const readHash = () => new URLSearchParams(location.hash.slice(1));
export const playerModeFrom = params => playerModes.includes(params.get('view')) ? params.get('view') : null;

/** 唯一的页面状态。模块只读它；改动走各自的入口函数，再调用 changed() 通知重绘。 */
export const state = {
    projects: [], selected: null, video: null, version: null,
    home: false, scope: 'active', playableOnly: false, query: '',
    workspace: null, mode: 'remake', audioPreference: null,
    preferredMode: playerModeFrom(readHash()) || 'compare',
};

export const activeProject = () => state.projects.find(project => project.slug === state.selected);
export const activeVideos = () => videosForVersion(activeProject(), state.version);
export const currentVideo = () => activeProject()?.videos.find(video => video.id === state.video);
export const playbackVersionLabel = version => {
    const pkg = activeProject()?.templatePackages?.find(item => item.name === version);
    return pkg ? templateVersionLabel(pkg) : version || '—';
};

const listeners = new Set();
/** 订阅「制作库相关状态变了」：项目列表、范围、筛选或当前选中项。 */
export function onChange(listener) { listeners.add(listener); }
export function changed() { for (const listener of listeners) listener(); }

/** 地址栏只记录能恢复现场的最少信息；制作库首页记为 #home。 */
export function updateHash() {
    const params = new URLSearchParams();
    if (state.selected) {
        params.set('project', state.selected);
        if (state.video) params.set('video', state.video);
        if (state.version) params.set('version', state.version);
        params.set('view', state.mode);
        if (state.workspace) params.set('workspace', state.workspace);
    } else if (state.home) params.set('home', '1');
    const fragment = params.toString();
    history.replaceState(null, '', fragment ? `#${fragment}` : `${location.pathname}${location.search}`);
}

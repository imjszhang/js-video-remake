import { templateVersionLabel } from './workspace.js';
import { videosForVersion } from './versions.js';

const initialView = new URLSearchParams(location.hash.slice(1)).get('view');

export const state = {
    projects: [], selected: null, video: null, version: null,
    scope: 'active', playableOnly: false, query: '',
    workspace: null, mode: 'remake', audioPreference: null,
    preferredMode: ['remake', 'original', 'compare'].includes(initialView) ? initialView : 'compare',
};

export const activeProject = () => state.projects.find((project) => project.slug === state.selected);
export const activeVideos = () => videosForVersion(activeProject(), state.version);
export const currentVideo = () => activeProject()?.videos.find((video) => video.id === state.video);
export const playbackVersionLabel = version => {
    const pkg = activeProject()?.templatePackages?.find(item => item.name === version);
    return pkg ? templateVersionLabel(pkg) : version || '—';
};
export const scopedProjects = () => state.projects.filter(project => Boolean(project.archived) === (state.scope === 'archived'));

export function updateHash() {
    const params = new URLSearchParams();
    if (state.selected) params.set('project', state.selected);
    if (state.video) params.set('video', state.video);
    if (state.version) params.set('version', state.version);
    params.set('view', state.mode);
    if (state.workspace) params.set('workspace', state.workspace);
    history.replaceState(null, '', `#${params}`);
}

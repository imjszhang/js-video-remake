/** 制作库的纯规则：范围、筛选、默认打开哪个项目。不接触 DOM，可直接测试。 */

export const projectTitle = project => project.title && project.title !== project.slug ? project.title : project.slug;

/** 「进行中」与「已归档」互斥；未标注 archived 的旧台账条目算进行中。 */
export function projectsInScope(projects, scope) {
    return projects.filter(project => Boolean(project.archived) === (scope === 'archived'));
}

/** 范围之内再按「仅可播放」和搜索词收窄；搜索同时匹配标识、标题和视频标题。 */
export function filterProjects(projects, { scope = 'active', playableOnly = false, query = '' } = {}) {
    const needle = query.trim().toLowerCase();
    return projectsInScope(projects, scope).filter(project => (!playableOnly || project.videos.length)
        && [project.slug, projectTitle(project), ...project.videos.map(video => video.title)].join(' ').toLowerCase().includes(needle));
}

const scopeOf = project => project.archived ? 'archived' : 'active';

/**
 * 载入后打开哪个项目，以及侧栏应停在哪个范围。
 * - 已选项目还在台账里：保持打开。侧栏范围只是浏览用的筛选，刷新不会把人带走；
 *   只有从链接进入（deepLink）时才让范围跟随项目，保证它在列表里可见。
 * - 没有已选项目（首次进入、刚归档、项目被删除）：打开当前范围里第一个有视频的项目。
 * - 当前范围为空：project 为 null，由调用方显示制作库。
 */
export function resolveSelection(projects, { scope = 'active', slug = null, deepLink = false } = {}) {
    const kept = slug ? projects.find(project => project.slug === slug) : null;
    if (kept) return { project: kept, scope: deepLink ? scopeOf(kept) : scope };
    const scoped = projectsInScope(projects, scope);
    return { project: scoped.find(project => project.videos.length) || scoped[0] || null, scope };
}

/** 制作库首页的卡片顺序：最近改动的在前，没有时间的排在最后并保持原有顺序。 */
export function recentProjects(projects, limit = 12) {
    const time = project => { const value = Date.parse(project.updatedAt); return Number.isFinite(value) ? value : -Infinity; };
    return projects.map((project, index) => ({ project, index }))
        .sort((a, b) => time(b.project) - time(a.project) || a.index - b.index)
        .slice(0, limit).map(entry => entry.project);
}

export function libraryCounts(projects) {
    const active = projectsInScope(projects, 'active');
    const videos = active.flatMap(project => project.videos);
    return { projects: active.length, videos: videos.length, drafts: videos.filter(video => video.kind === 'draft').length };
}

/** 模板编辑与已合成的视频使用独立工作区，避免隐式切换播放版本。 */
export function workspaceForProject(project, preferred) {
    if (!project?.templatePackages?.length) return 'playback';
    return preferred === 'playback' ? 'playback' : 'template';
}

/** 未合成的模板没有播放目标，绝不回退到其他版本的视频。 */
export function templatePlaybackVideo(project, version) {
    if (!version) return null;
    return (project?.videos || []).find(video => video.kind === 'draft' && video.version === version) || null;
}

/** 模板身份独立分组；目录名只用于定位文件，不作为展示版本号。 */
export function groupTemplatePackages(packages = []) {
    const groups = new Map();
    for (const pkg of packages) {
        const lineage = pkg.lineage || { id: pkg.name, title: pkg.title, kind: 'source', version: 1 };
        if (!groups.has(lineage.id)) groups.set(lineage.id, { id: lineage.id, title: lineage.title || pkg.title, kind: lineage.kind, versions: [] });
        groups.get(lineage.id).versions.push(pkg);
    }
    for (const group of groups.values()) group.versions.sort((a, b) => (a.lineage?.version || 1) - (b.lineage?.version || 1));
    return [...groups.values()];
}

export function templateVersionLabel(pkg) {
    return pkg?.lineage ? `${pkg.lineage.title || pkg.title} · ${pkg.lineage.kind === 'source' ? '原版 ' : ''}v${pkg.lineage.version}` : pkg?.name || '';
}

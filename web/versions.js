/** Version selection is independent of the playback/synchronization controller. */
export function playableDraftVersions(project) {
  return (project?.draftVersions || []).filter((group) => project.videos.some((video) => video.kind === 'draft' && video.version === group.version));
}

export function videosForVersion(project, version) {
  return (project?.videos || []).filter((video) => video.kind !== 'draft' || version === null || video.version === version);
}

export function chooseDraftVersion(project, { version, videoId } = {}) {
  const groups = playableDraftVersions(project);
  const selected = project.videos.find((video) => video.id === videoId && video.kind === 'draft');
  return [version, selected?.version, project.defaultDraftVersion, groups[0]?.version]
    .find((candidate) => groups.some((group) => group.version === candidate)) ?? null;
}

export function videoForVersion(project, version, previousVideo) {
  const videos = videosForVersion(project, version);
  return videos.find((video) => video.id === previousVideo?.id)
    || videos.find((video) => video.kind === 'draft' && previousVideo?.reference?.id && video.reference?.id === previousVideo.reference.id)
    || videos.find((video) => video.kind === 'draft' && previousVideo?.episode && video.episode === previousVideo.episode)
    || videos[0];
}

/** Comparisons made for one draft version show only with it; older catalog comparisons show with every version. */
export function videosForVersionWithComparisons(project, version) {
  return videosForVersion(project, version).filter((video) => video.kind !== 'comparison' || !video.forVersion || version === null || video.forVersion === version);
}

/** The version to put beside `version`: the one it was forked from when that is playable, else the one before it. */
export function defaultCompareVersion(project, version) {
  const groups = playableDraftVersions(project);
  const index = groups.findIndex((group) => group.version === version);
  if (index < 0 || groups.length < 2) return null;
  const parent = groups[index].forkedFrom;
  if (parent && parent !== version && groups.some((group) => group.version === parent)) return parent;
  return (groups[index - 1] || groups[index + 1]).version;
}

/** The draft in `otherVersion` that shows the same thing as `video` (same id, original or episode, else its first). */
export function counterpartVideo(project, otherVersion, video) {
  const drafts = (project?.videos || []).filter((item) => item.kind === 'draft' && item.version === otherVersion);
  return drafts.find((item) => video?.reference?.id && item.reference?.id === video.reference.id)
    || drafts.find((item) => video?.episode && item.episode === video.episode)
    || drafts[0] || null;
}

/** Short label for a version in a menu: the first clause of its note, else its label. */
export function versionLabel(group, max = 26) {
  const text = (group?.note?.summary || group?.label || '').replace(/（[^）]*）/g, '').replace(/[。.]+$/, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

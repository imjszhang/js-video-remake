import { createComparisonController } from './comparison.js';
import { mountTemplateEditor } from './template-editor.js';
import { workspaceForProject, templatePlaybackVideo, groupTemplatePackages, templateVersionLabel } from './workspace.js';
import { playableDraftVersions, videosForVersion, chooseDraftVersion, videoForVersion } from './versions.js';

const $ = (selector) => document.querySelector(selector);
const initialView = new URLSearchParams(location.hash.slice(1)).get('view');
const state = { projects: [], selected: null, video: null, version: null, filter: 'all', query: '', workspace: null, mode: 'remake', audioPreference: null, preferredMode: ['remake', 'original', 'compare'].includes(initialView) ? initialView : 'compare' };
let comparisonState = { playing: false, time: 0, duration: 0, ready: false };

const statusLabels = { 'picture-review': '画面审阅', delivered: '已交付', commissioned: '制作中', drafting: '制作中' };
const kindLabels = { draft: '审阅草稿', delivery: '正式成片', comparison: '版本对比' };
const title = (project) => project.title && project.title !== project.slug ? project.title : project.slug;
const duration = (seconds) => Number.isFinite(seconds) ? `${Math.floor(Math.round(seconds) / 60)}:${String(Math.round(seconds) % 60).padStart(2, '0')}` : '—';
const bytes = (value) => Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(1)} MB` : '—';
const audio = (value) => ({ none: '无音轨', present: '有音轨', unknown: '未标注' }[value] || '未标注');
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const activeProject = () => state.projects.find((project) => project.slug === state.selected);
const activeVideos = () => videosForVersion(activeProject(), state.version);
const currentVideo = () => activeProject()?.videos.find((video) => video.id === state.video);
const playbackVersionLabel = version => { const pkg = activeProject()?.templatePackages?.find(item => item.name === version); return pkg ? templateVersionLabel(pkg) : version || '—'; };
const comparison = createComparisonController({
  remake: $('#player'), original: $('#original-player'),
  onUpdate(snapshot) {
    comparisonState = snapshot;
    $('#compare-play').textContent = snapshot.buffering ? 'Ⅱ 暂停等待' : snapshot.playing ? 'Ⅱ 一起暂停' : '▶ 一起播放';
    $('#compare-play').disabled = !snapshot.ready && !snapshot.buffering;
    $('#compare-restart').disabled = !snapshot.ready;
    $('#compare-seek').disabled = !snapshot.ready;
    $('#compare-seek').max = String(snapshot.duration || 0);
    $('#compare-seek').value = String(snapshot.time || 0);
    $('#compare-seek').setAttribute('aria-valuetext', `${duration(snapshot.time)} / ${duration(snapshot.duration)}`);
    $('#compare-time').textContent = `${duration(snapshot.time)} / ${duration(snapshot.duration)}`;
    $('#sync-status').textContent = snapshot.buffering ? '缓冲中 · 两侧同步等待' : snapshot.ready ? (snapshot.playing ? '● 同步播放中' : '同一时间轴 · 已暂停') : '正在读取两段视频…';
  },
  onError() { $('#compare-error').hidden = false; $('#compare-error').textContent = '对比播放暂时中断，请刷新项目库后重试。'; },
  onEnded() { if (state.mode === 'compare' && $('#auto-next').checked) stepVideo(1, true); },
});

function mediaUrl(path) {
  if (!path) return null;
  const url = new URL(path, location.href.split('#')[0]);
  return url.origin === location.origin && /\/media\//.test(url.pathname) ? url.href : null;
}
function sourceUrl(path) { try { const url = new URL(path); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
function updateHash() { const params = new URLSearchParams({ project: state.selected }); if (state.video) params.set('video', state.video); if (state.version) params.set('version', state.version); params.set('view', state.mode); if (state.workspace) params.set('workspace', state.workspace); history.replaceState(null, '', `#${params}`); }
function notify(message, retry = false) {
  const notice = $('#notice'); notice.replaceChildren(); notice.hidden = !message;
  if (message) notice.append(document.createTextNode(message));
  if (retry) { const button = node('button', '', '重试'); button.type = 'button'; button.addEventListener('click', load); notice.append(button); }
}
function renderProjects() {
  const nav = $('#projects'); nav.replaceChildren();
  const query = state.query.trim().toLowerCase();
  const projects = state.projects.filter((project) => (state.filter !== 'playable' || project.videos.length) && [project.slug, title(project), ...project.videos.map((video) => video.title)].join(' ').toLowerCase().includes(query));
  for (const project of projects) {
    const selected = project.slug === state.selected;
    const button = node('button', `project-item${selected ? ' active' : ''}`); button.type = 'button'; button.setAttribute('aria-current', selected ? 'true' : 'false');
    button.append(node('span', 'project-icon', project.videos.length ? '▣' : '▧'));
    const info = node('span'); info.append(node('strong', '', title(project)), node('small', '', `${String(project.videos.length).padStart(2, '0')} 条视频 · ${statusLabels[project.status] || project.status || '制作中'}`)); button.append(info);
    button.addEventListener('click', () => selectProject(project.slug)); nav.append(button);
  }
  if (!projects.length) nav.append(node('p', 'sidebar-message', state.projects.length ? '没有匹配的项目' : '暂无项目'));
}
function renderStats() {
  $('#project-count').textContent = String(state.projects.length).padStart(2, '0');
  const videos = state.projects.flatMap((project) => project.videos);
  const stats = $('#stats'); stats.replaceChildren();
  const entries = [[state.projects.length, '制作项目'], [videos.length, '可播放视频'], [videos.filter((v) => v.kind === 'draft').length, '审阅草稿']];
  for (const [value, label] of entries) { const stat = node('div', 'stat'); stat.append(node('strong', '', String(value).padStart(2, '0')), node('span', '', label)); stats.append(stat); }
}
function renderPlaylist() {
  const videos = activeVideos(); const list = $('#playlist'); list.replaceChildren();
  $('#playlist-count').textContent = `${String(videos.length).padStart(2, '0')} VIDEOS`;
  for (const [index, video] of videos.entries()) {
    const button = node('button', `episode${video.id === state.video ? ' active' : ''}`); button.type = 'button'; button.setAttribute('aria-current', video.id === state.video ? 'true' : 'false');
    button.setAttribute('aria-label', `播放第 ${video.episode || index + 1} 条：${video.title}`);
    const thumbnail = node('span', 'episode-thumbnail'); const poster = mediaUrl(video.poster);
    if (poster) { const image = node('img'); image.src = poster; image.alt = ''; image.loading = 'lazy'; thumbnail.append(image); } else thumbnail.append(node('span', '', '▷'));
    thumbnail.append(node('span', 'episode-number', String(video.episode || index + 1).padStart(2, '0')));
    const info = node('span', 'episode-info'); info.append(node('span', 'episode-title', video.title), node('span', 'episode-meta', `${duration(video.duration)} · ${playbackVersionLabel(video.version)} · ${kindLabels[video.kind] || '视频'}`));
    button.append(thumbnail, info); button.addEventListener('click', () => selectVideo(video.id)); list.append(button);
  }
}
function renderVersions() {
  const project = activeProject(); const groups = playableDraftVersions(project);
  const select = $('#draft-version'); select.replaceChildren();
  $('#version-controls').hidden = groups.length < 2;
  for (const group of groups) {
    const option = node('option', '', `${playbackVersionLabel(group.version)}${group.label && !project.templatePackages?.some(pkg => pkg.name === group.version) ? ` · ${group.label}` : ''} · ${group.videoCount} 条`);
    option.value = group.version; select.append(option);
  }
  select.value = state.version || '';
  const selected = groups.find((group) => group.version === state.version);
  $('#version-note').textContent = selected ? `${playbackVersionLabel(selected.version)} · ${selected.videoCount} 条${project.referenceCount > selected.videoCount ? ` / ${project.referenceCount} 条参考` : ''}。切换版本查看对应视频，原版随分集匹配。` : '';
}
function selectVersion(version) {
  const project = activeProject(); if (!project) return;
  const previous = currentVideo(); state.version = chooseDraftVersion(project, { version });
  const next = videoForVersion(project, state.version, previous);
  renderVersions();
  if (next) selectVideo(next.id);
}
function setLink(selector, url) { const link = $(selector); link.hidden = !url; if (url) link.href = url; else link.removeAttribute('href'); }
function downloadUrl(path) { const href = mediaUrl(path); if (!href) return null; const url = new URL(href); url.searchParams.set('download', '1'); return url.href; }
function releasePlayers() {
  comparison.deactivate();
  for (const player of [$('#player'), $('#original-player')]) { player.pause(); player.removeAttribute('src'); player.removeAttribute('poster'); player.load(); }
}
function renderVideoMetadata() {
  const video = currentVideo(); if (!video) return;
  const pkg = activeProject()?.templatePackages?.find(item => item.name === video.version);
  const displayVersion = pkg ? templateVersionLabel(pkg) : video.version;
  $('#playback-context').textContent = `当前播放：${displayVersion || kindLabels[video.kind] || '已合成视频'}。此处只显示已合成的视频，模板版本在工作台单独选择。`;
  const original = state.mode === 'original';
  const asset = original ? video.reference : video;
  const player = original ? $('#original-player') : $('#player');
  const actualDuration = Number.isFinite(player.duration) ? player.duration : asset.duration;
  $('#video-kicker').textContent = original ? '原版参考 / ORIGINAL' : `${state.mode === 'compare' ? '原版 × 复刻 / ' : ''}${kindLabels[video.kind] || '视频'} / ${playbackVersionLabel(video.version)}${video.language ? ` / ${video.language.toUpperCase()}` : ''}`;
  $('#video-title').textContent = original ? asset.title : video.title;
  const width = player.videoWidth || asset.width; const height = player.videoHeight || asset.height;
  const metadata = $('#metadata'); metadata.replaceChildren();
  const labels = state.mode === 'compare' ? ['复刻时长', '复刻尺寸', '复刻音轨', '复刻大小'] : ['时长', '画面尺寸', '声音', '文件大小'];
  const values = [duration(actualDuration), width && height ? `${width} × ${height}` : '未标注', audio(asset.audio), bytes(asset.bytes)];
  labels.forEach((label, index) => { const item = node('div'); item.append(node('dt', '', label), node('dd', '', values[index])); metadata.append(item); });
  $('#draft-note').hidden = asset.audio !== 'none';
  const note = original ? '这条原片没有音轨。' : `${video.kind === 'draft' ? '画面审阅版 · ' : ''}复刻视频没有音轨。${state.mode === 'compare' ? '可在对比控制栏选择原版声音。' : ''}`;
  $('#draft-note').replaceChildren(node('span', '', '◌'), document.createTextNode(note));
  const originalDuration = Number.isFinite($('#original-player').duration) ? $('#original-player').duration : video.reference?.duration;
  const remakeDuration = Number.isFinite($('#player').duration) ? $('#player').duration : video.duration;
  $('#original-frame-meta').textContent = duration(originalDuration);
  $('#remake-frame-meta').textContent = `${playbackVersionLabel(video.version)} · ${duration(remakeDuration)}`;
}
function setMode(mode, { keepTime = true, remember = true } = {}) {
  const video = currentVideo(); if (!video) return;
  const time = keepTime ? state.mode === 'compare' ? comparisonState.time : state.mode === 'original' ? $('#original-player').currentTime : $('#player').currentTime : 0;
  if (remember) state.preferredMode = mode;
  state.mode = video.reference?.url ? mode : 'remake';
  comparison.deactivate(); $('#player').pause(); $('#original-player').pause();
  const comparing = state.mode === 'compare';
  $('#screening').classList.toggle('comparing', comparing); $('#viewer').classList.toggle('comparing', comparing);
  $('#original-frame').hidden = state.mode === 'remake'; $('#remake-frame').hidden = state.mode === 'original'; $('#compare-controls').hidden = !comparing;
  $('#player').controls = !comparing; $('#original-player').controls = !comparing;
  $('#reference-unavailable').hidden = !!video.reference?.url;
  document.querySelectorAll('[data-view]').forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.view === state.mode)); button.disabled = button.dataset.view !== 'remake' && !video.reference?.url; });
  $('#compare-error').hidden = true;
  if (comparing) {
    comparison.activate(); comparison.setAudio($('#compare-audio').value); comparison.setRate(Number($('#compare-rate').value)); comparison.seek(time);
  } else {
    const player = state.mode === 'original' ? $('#original-player') : $('#player');
    if (Number.isFinite(player.duration)) player.currentTime = Math.min(time, player.duration);
  }
  renderVideoMetadata(); updateHash();
}
function startCurrentVideo() {
  if (state.mode === 'compare') comparison.play();
  else (state.mode === 'original' ? $('#original-player') : $('#player')).play().catch(() => {});
}
function selectVideo(id, play = false) {
  const project = activeProject(); const video = project?.videos.find((item) => item.id === id); if (!video) return;
  releasePlayers(); state.video = video.id; const player = $('#player');
  $('#playback-error').hidden = true; player.src = mediaUrl(video.url); player.setAttribute('aria-label', video.title);
  const poster = mediaUrl(video.poster); if (poster) player.poster = poster; else player.removeAttribute('poster');
  const original = $('#original-player'); const reference = video.reference;
  $('#original-error').hidden = true;
  if (reference?.url) { original.src = mediaUrl(reference.url); const originalPoster = mediaUrl(reference.poster); if (originalPoster) original.poster = originalPoster; original.load(); }
  $('#original-title').textContent = reference?.title || ''; $('#original-title').title = reference?.title || '';
  $('#remake-title').textContent = video.title;
  player.load(); const videos = activeVideos(); const index = videos.indexOf(video);
  $('#position').textContent = `${index + 1} / ${videos.length}`;
  $('#previous').disabled = index === 0; $('#next').disabled = index === videos.length - 1;
  setLink('#download', downloadUrl(video.url)); setLink('#original-download', downloadUrl(reference?.url));
  setLink('#contact-sheet', mediaUrl(video.contactSheet)); setLink('#reference', sourceUrl(video.referenceUrl));
  $('#compare-audio option[value="original"]').textContent = reference?.audio === 'none' ? '原版（无音轨）' : '原版';
  $('#compare-audio option[value="remake"]').textContent = video.audio === 'none' ? '复刻版（无音轨）' : '复刻版';
  $('#compare-audio').value = state.audioPreference || (video.audio === 'none' ? reference?.audio === 'none' ? 'none' : 'original' : 'remake');
  renderPlaylist(); setMode(state.preferredMode, { keepTime: false, remember: false });
  if (play) startCurrentVideo();
}
function renderTemplates(project) {
    const list = $('#template-list');
    list.replaceChildren();
    $('#templates').hidden = false;
    const templates = project.templates || [];
    $('#templates-count').textContent = `${templates.length} 个可下载`;
    for (const template of templates) {
        const row = node('div', 'template-row');
        const pkg = project.templatePackages?.find(item => item.name === template.video);
        row.append(node('strong', '', pkg ? templateVersionLabel(pkg) : template.title || template.name), node('span', '', bytes(template.bytes)));
        const link = node('a', 'download-link', '↓ 下载 .video');
        link.href = downloadUrl(template.url); link.download = template.name;
        row.append(link); list.append(row);
    }
    for (const pkg of project.templatePackages || []) {
        if (templates.some(template => template.video === pkg.name)) continue;
        const row = node('div', 'template-row');
        const button = node('button', 'download-link', '打包 .video');
        button.type = 'button';
        button.addEventListener('click', async () => {
            button.disabled = true; button.textContent = '正在打包…';
            try {
                const response = await fetch(`api/projects/${encodeURIComponent(project.slug)}/templates/${encodeURIComponent(pkg.name)}`, {
                    method: 'POST', headers: { 'X-Remake-Action': 'pack' },
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || '打包失败');
                await load(); notify('模板已打包，点击「下载 .video」保存。');
            } catch (error) { notify(error.message); }
            finally { button.disabled = false; button.textContent = '打包 .video'; }
        });
        row.append(node('strong', '', templateVersionLabel(pkg)), button); list.append(row);
    }
    if (!list.children.length) list.append(node('p', '', '暂无可打包模板。代码视频包声明为模板后，会在这里出现。'));
}

function setWorkspace(preferred, { focus = false } = {}) {
    const project = activeProject();
    state.workspace = workspaceForProject(project, preferred);
    const editing = state.workspace === 'template';
    $('#template-workspace').hidden = !editing;
    $('#playback-workspace').hidden = editing;
    $('#template-tab').hidden = !project?.templatePackages?.length;
    $('#back-to-template').hidden = !project?.templatePackages?.length;
    document.querySelectorAll('[data-workspace]').forEach(button => {
        const selected = button.dataset.workspace === state.workspace;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected && focus) button.focus();
    });
    if (editing) {
        comparison.deactivate();
        $('#player').pause(); $('#original-player').pause();
    } else if (state.mode === 'compare' && currentVideo()) {
        setMode('compare', { keepTime: true, remember: false });
    }
    updateHash();
}
function playTemplateVersion(version) {
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

function selectProject(slug, videoId, version) {
  const project = state.projects.find((item) => item.slug === slug); if (!project) return;
  const preferredWorkspace = state.selected === slug ? state.workspace : null;
  const hashWorkspace = new URLSearchParams(location.hash.slice(1));
  state.workspace = workspaceForProject(project, preferredWorkspace || (hashWorkspace.get('project') === slug ? hashWorkspace.get('workspace') : null));
  state.selected = slug; state.video = null; state.version = chooseDraftVersion(project, { version, videoId }); $('#project-view').hidden = false;
  $('#project-title').textContent = title(project); $('#project-kicker').textContent = `${project.videos.length > 1 ? 'SERIES' : 'PROJECT'} / ${project.referenceCount || 0} 条参考`;
  $('#project-status').textContent = statusLabels[project.status] || project.status || '制作中'; $('#project-status').dataset.status = project.status;
  if (!project.videos.length) $('#playback-context').textContent = '这里播放已合成的视频，模板截图在工作台查看。';
  $('#screening').hidden = !project.videos.length; $('#empty-project').hidden = !!project.videos.length;
    const hasTemplate = Boolean(project.templatePackages?.length);
    $('#template-tab-count').textContent = groupTemplatePackages(project.templatePackages).length;
    $('#playback-tab-count').textContent = project.videos.length;
    $('#template-archive').append($('#templates'));
    mountTemplateEditor(project, { onLibraryChanged: load, onPlayVersion: playTemplateVersion });
    $('#empty-project h3').textContent = hasTemplate ? '还没有可播放的视频' : '这个项目还在制作中';
    $('#empty-project p').textContent = hasTemplate ? '模板和静态截图已在工作台就绪。进入「预览与导出」，合成后的视频会出现在这里。' : '登记成片或审阅草稿后，会自动出现在这里。';
  releasePlayers(); renderProjects(); renderVersions(); renderTemplates(project);
  if (project.videos.length) selectVideo(videoForVersion(project, state.version, project.videos.find((video) => video.id === videoId)).id);
  else updateHash();
  setWorkspace(state.workspace);
}
function stepVideo(delta, play = false) { const videos = activeVideos(); const index = videos.findIndex((video) => video.id === state.video); const next = videos[index + delta]; if (next) selectVideo(next.id, play); }
async function load() {
  $('#refresh').disabled = true;
  try {
    const response = await fetch('./api/projects', { cache: 'no-store' }); if (!response.ok) throw new Error('load failed');
    const data = await response.json(); if (!Array.isArray(data.projects)) throw new Error('invalid data');
    state.projects = data.projects; renderStats(); renderProjects();
    const hash = new URLSearchParams(location.hash.slice(1));
    const slug = state.selected || hash.get('project'); const selected = state.projects.find((project) => project.slug === slug) || state.projects.find((project) => project.videos.length) || state.projects[0];
    if (selected) selectProject(selected.slug, state.video || hash.get('video'), state.version || hash.get('version'));
    else { releasePlayers(); state.selected = null; state.video = null; mountTemplateEditor(null); $('#project-view').hidden = true; notify('还没有制作。可以选择参考视频，或导入模板开始。'); }
    if (selected) notify(data.warnings?.length ? `有 ${data.warnings.length} 项素材暂不可用，其他视频仍可正常播放。` : '');
  } catch { notify('无法读取项目库，请检查本地视频服务后重试。', true); }
  finally { $('#loading').hidden = true; $('#refresh').disabled = false; }
}
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
    controls.forEach(control => { control.disabled = true; });
    $('#import-toggle').disabled = true;
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
        state.query = ''; state.filter = 'all'; $('#search').value = '';
        document.querySelectorAll('[data-filter]').forEach(button => {
            const active = button.dataset.filter === 'all';
            button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
        });
        await load();
        selectProject(result.slug);
        $('#import-form').reset();
        status.textContent = '导入完成';
        notify(`已导入「${result.title || result.slug}」。接下来准备人物录像、口播和个人信息，合成后即可在这里播放。`);
    } catch (error) {
        status.textContent = error.message || '导入失败，请重试。';
    } finally {
        controls.forEach(control => { control.disabled = false; });
        $('#import-toggle').disabled = false;
        $('#import-form').removeAttribute('aria-busy');
    }
});
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
$('#back-to-template').addEventListener('click', () => setWorkspace('template', { focus: true }));
$('#search').addEventListener('input', (event) => { state.query = event.target.value; renderProjects(); });
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); renderProjects(); }));
$('#refresh').addEventListener('click', load); $('#previous').addEventListener('click', () => stepVideo(-1)); $('#next').addEventListener('click', () => stepVideo(1));
$('#draft-version').addEventListener('change', (event) => selectVersion(event.target.value));
$('#player').addEventListener('ended', () => { if (state.mode === 'remake' && $('#auto-next').checked) stepVideo(1, true); });
$('#original-player').addEventListener('ended', () => { if (state.mode === 'original' && $('#auto-next').checked) stepVideo(1, true); });
$('#player').addEventListener('error', () => { if ($('#player').hasAttribute('src')) $('#playback-error').hidden = false; });
$('#original-player').addEventListener('error', () => { if ($('#original-player').hasAttribute('src')) $('#original-error').hidden = false; });
for (const player of [$('#player'), $('#original-player')]) player.addEventListener('loadedmetadata', renderVideoMetadata);
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.view)));
$('#compare-play').addEventListener('click', () => {
  if (comparisonState.playing || comparisonState.buffering) comparison.pause();
  else if (!$('#compare-error').hidden) selectVideo(state.video, true);
  else comparison.play();
});
$('#compare-restart').addEventListener('click', () => comparison.seek(0));
$('#compare-seek').addEventListener('input', (event) => comparison.seek(Number(event.target.value)));
$('#compare-audio').addEventListener('change', (event) => { state.audioPreference = event.target.value; comparison.setAudio(event.target.value); });
$('#compare-rate').addEventListener('change', (event) => comparison.setRate(Number(event.target.value)));
$('#compare-fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#viewer').requestFullscreen(); }
  catch { $('#compare-error').hidden = false; $('#compare-error').textContent = '当前浏览器不支持全屏，请使用浏览器窗口放大查看。'; }
});
window.addEventListener('hashchange', () => { const params = new URLSearchParams(location.hash.slice(1)); state.workspace = params.get('workspace'); if (['remake', 'original', 'compare'].includes(params.get('view'))) state.preferredMode = params.get('view'); if (params.get('project')) selectProject(params.get('project'), params.get('video'), params.get('version')); });
window.addEventListener('pagehide', () => { comparison.deactivate(); $('#player').pause(); $('#original-player').pause(); });
window.addEventListener('pageshow', (event) => { if (event.persisted && state.mode === 'compare' && currentVideo()) setMode('compare', { keepTime: true, remember: false }); });
load();

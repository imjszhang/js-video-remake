import { createComparisonController } from './comparison.js';
import { $, node, duration, bytes, audio, kindLabels, mediaUrl, sourceUrl, downloadUrl, setLink } from './ui.js';
import { state, activeProject, activeVideos, currentVideo, playbackVersionLabel, updateHash } from './state.js';
import { playableDraftVersions, chooseDraftVersion, videoForVersion } from './versions.js';

let comparisonState = { playing: false, time: 0, duration: 0, ready: false };

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

export function renderPlaylist() {
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

export function renderVersions() {
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

export function selectVersion(version) {
    const project = activeProject(); if (!project) return;
    const previous = currentVideo(); state.version = chooseDraftVersion(project, { version });
    const next = videoForVersion(project, state.version, previous);
    renderVersions();
    if (next) selectVideo(next.id);
}

export function releasePlayers() {
    comparison.deactivate();
    for (const player of [$('#player'), $('#original-player')]) { player.pause(); player.removeAttribute('src'); player.removeAttribute('poster'); player.load(); }
}

export function renderVideoMetadata() {
    const video = currentVideo(); if (!video) return;
    const pkg = activeProject()?.templatePackages?.find(item => item.name === video.version);
    const displayVersion = pkg ? playbackVersionLabel(video.version) : video.version;
    $('#playback-context').textContent = `当前播放：${displayVersion || kindLabels[video.kind] || '已合成视频'}。已合成视频在这里播放，模板版本在模板工作台编辑。`;
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

export function setMode(mode, { keepTime = true, remember = true } = {}) {
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

export function selectVideo(id, play = false) {
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

export function stepVideo(delta, play = false) { const videos = activeVideos(); const index = videos.findIndex((video) => video.id === state.video); const next = videos[index + delta]; if (next) selectVideo(next.id, play); }

export function pausePlayback() {
    comparison.deactivate();
    $('#player').pause(); $('#original-player').pause();
}

export function resumePlaybackIfNeeded() {
    if (state.mode === 'compare' && currentVideo() && !$('#playback-workspace').hidden) setMode('compare', { keepTime: true, remember: false });
}

export function initPlayback() {
    $('#previous').addEventListener('click', () => stepVideo(-1));
    $('#next').addEventListener('click', () => stepVideo(1));
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
    window.addEventListener('pagehide', pausePlayback);
    window.addEventListener('pageshow', (event) => { if (event.persisted) resumePlaybackIfNeeded(); });
}

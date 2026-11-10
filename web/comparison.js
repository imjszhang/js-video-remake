/** Two videos share elapsed seconds; the shorter video holds its last frame. */
export function createComparisonController({ remake, original, onUpdate = () => {}, onError = () => {}, onEnded = () => {} }) {
  const videos = [remake, original];
  const blocked = new Set();
  const listeners = [];
  let active = false, destroyed = false, wanted = false, playing = false, starting = false;
  let time = 0, rate = 1, audio = 'original', generation = 0, timer = null, fault = null, ended = false;
  let startPromise = Promise.resolve(false);
  const length = (video) => Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const duration = () => Math.max(...videos.map(length));
  const ready = () => videos.every((video) => length(video) > 0);
  const master = () => length(remake) >= length(original) ? remake : original;
  const finished = (video) => length(video) > 0 && time >= length(video) - 0.015;
  const unfinished = () => videos.filter((video) => !finished(video));
  const canRun = () => ready() && unfinished().every((video) => !blocked.has(video) && !video.seeking && video.readyState >= 3);
  const pauseVideos = () => videos.forEach((video) => video.pause());
  const emit = () => onUpdate({ playing, time, duration: duration(), ready: ready(), buffering: active && wanted && !fault && !playing, audio, rate });
  const applyAudio = () => videos.forEach((video, index) => { video.muted = audio !== (index ? 'original' : 'remake'); });
  function align() {
    for (const video of videos) {
      if (!length(video)) continue;
      const target = Math.min(time, length(video));
      if (Math.abs(video.currentTime - target) > 0.025) video.currentTime = target;
      if (finished(video)) video.pause();
    }
  }
  function halt() {
    generation += 1;
    starting = false;
    playing = false;
    pauseVideos();
  }
  function captureTime() {
    if (ready()) time = Math.max(0, Math.min(master().currentTime || 0, duration()));
  }
  function fail(error) {
    if (!active) return;
    fault = error instanceof Error ? error : new Error('视频加载或播放失败');
    wanted = false;
    captureTime();
    halt();
    emit();
    onError(fault);
  }
  function finish() {
    if (ended) return;
    time = duration();
    wanted = false;
    ended = true;
    halt();
    align();
    emit();
    onEnded();
  }
  function resume() {
    if (!active || !wanted || fault || playing || starting) return startPromise;
    if (!canRun()) { emit(); return Promise.resolve(false); }
    align();
    // Assigning currentTime may itself start a seek. Wait for both seeked events.
    if (!canRun()) { emit(); return Promise.resolve(false); }
    const token = ++generation;
    starting = true;
    const pending = unfinished().map((video) => {
      try { return Promise.resolve(video.play()); }
      catch (error) { return Promise.reject(error); }
    });
    startPromise = Promise.allSettled(pending).then((results) => {
      if (token !== generation || !active || !wanted) {
        // A late play() completion must not restart a paused or replaced clip.
        // A newer, valid comparison play attempt may already own these elements.
        if (!active || !wanted || fault || !canRun()) pauseVideos();
        return false;
      }
      starting = false;
      const rejection = results.find((result) => result.status === 'rejected');
      if (rejection) { fail(rejection.reason); return false; }
      if (!canRun()) { halt(); emit(); return false; }
      playing = true;
      emit();
      return true;
    });
    emit();
    return startPromise;
  }
  function suspend(video) {
    if (!active || !wanted || finished(video)) return;
    if (playing || starting) captureTime();
    blocked.add(video);
    halt();
    align();
    emit();
  }
  function tick() {
    if (!active || !playing) return;
    captureTime();
    if (time >= duration() - 0.015) { finish(); return; }
    for (const video of videos) {
      if (finished(video)) {
        video.pause();
        if (Math.abs(video.currentTime - length(video)) > 0.025) video.currentTime = length(video);
      } else if (video.readyState < 3 || video.seeking || blocked.has(video)) {
        suspend(video);
        return;
      } else if (video !== master() && Math.abs(video.currentTime - time) > 0.12) {
        // Correct only the follower, and never seek repeatedly during buffering.
        video.currentTime = time;
      }
    }
    emit();
  }
  function listen(video, name, handler) {
    video.addEventListener(name, handler);
    listeners.push(() => video.removeEventListener(name, handler));
  }
  for (const video of videos) {
    for (const name of ['loadedmetadata', 'durationchange']) listen(video, name, () => {
      if (!active) return;
      if (ready()) time = Math.min(time, duration());
      align();
      emit();
      resume();
    });
    for (const name of ['canplay', 'canplaythrough', 'loadeddata', 'seeked']) listen(video, name, () => {
      if (!active) return;
      if (!video.seeking && video.readyState >= 3) blocked.delete(video);
      emit();
      resume();
    });
    listen(video, 'waiting', () => suspend(video));
    listen(video, 'stalled', () => { if (video.readyState < 3) suspend(video); });
    listen(video, 'seeking', () => suspend(video));
    listen(video, 'timeupdate', tick);
    listen(video, 'ended', () => {
      if (!active || !wanted) return;
      captureTime();
      if (time >= duration() - 0.015) finish();
      else { video.pause(); emit(); }
    });
    listen(video, 'error', () => fail(new Error(video.error?.message || '视频加载失败，请检查原版和复刻素材。')));
  }
  return {
    activate() {
      if (destroyed) return;
      active = true;
      wanted = false;
      fault = null;
      ended = false;
      time = 0;
      blocked.clear();
      halt();
      align();
      videos.forEach((video) => { video.playbackRate = rate; });
      applyAudio();
      if (!timer) { timer = setInterval(tick, 80); timer.unref?.(); }
      emit();
    },
    deactivate() {
      active = false;
      wanted = false;
      halt();
      blocked.clear();
      if (timer) clearInterval(timer);
      timer = null;
      videos.forEach((video) => { video.playbackRate = 1; video.muted = false; });
      emit();
    },
    play() {
      if (!active || destroyed || fault) return Promise.resolve(false);
      if (ready() && time >= duration() - 0.015) {
        time = 0;
        ended = false;
        blocked.clear();
        halt();
        align();
      }
      wanted = true;
      return resume();
    },
    pause() {
      if (playing || starting) captureTime();
      wanted = false;
      halt();
      if (active) align();
      emit();
    },
    seek(seconds) {
      if (!active || !Number.isFinite(seconds)) return;
      halt();
      time = Math.max(0, Math.min(seconds, duration()));
      ended = false;
      blocked.clear();
      align();
      emit();
      if (wanted && time >= duration() - 0.015 && ready()) finish();
      else resume();
    },
    setRate(value) {
      if (!Number.isFinite(value) || value <= 0 || value > 4) return;
      rate = value;
      if (active) videos.forEach((video) => { video.playbackRate = rate; });
      emit();
    },
    setAudio(value) {
      if (!['remake', 'original', 'none'].includes(value)) return;
      audio = value;
      if (active) applyAudio();
      emit();
    },
    destroy() {
      this.deactivate();
      destroyed = true;
      listeners.forEach((remove) => remove());
    },
  };
}

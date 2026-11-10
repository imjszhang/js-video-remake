import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComparisonController } from '../web/comparison.js';

class Video extends EventTarget {
  constructor(duration) {
    super();
    Object.assign(this, { duration, currentTime: 0, paused: true, muted: false, volume: 0.6, playbackRate: 1, readyState: 4, seeking: false, playCount: 0 });
  }
  play() { this.paused = false; this.playCount += 1; return Promise.resolve(); }
  pause() { this.paused = true; }
  event(name) { this.dispatchEvent(new Event(name)); }
  advance(time) { this.currentTime = time; this.event(time >= this.duration ? 'ended' : 'timeupdate'); }
}
function setup(t, a = 5, b = 10) {
  const remake = new Video(a), original = new Video(b), updates = [], errors = [];
  let ends = 0;
  const controller = createComparisonController({ remake, original, onUpdate: (value) => updates.push(value), onError: (error) => errors.push(error), onEnded: () => { ends += 1; } });
  t.after(() => controller.destroy());
  controller.activate();
  return { remake, original, controller, updates, errors, ends: () => ends, state: () => updates.at(-1) };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('starts paused, uses real metadata, and selects only one audio source without changing volume', (t) => {
  const f = setup(t);
  assert.deepEqual(f.state(), { playing: false, time: 0, duration: 10, ready: true, buffering: false, audio: 'original', rate: 1 });
  assert.equal(f.remake.paused, true);
  assert.equal(f.remake.muted, true);
  assert.equal(f.original.muted, false);
  f.controller.setAudio('remake');
  assert.equal(f.remake.muted, false);
  assert.equal(f.original.muted, true);
  f.controller.setAudio('none');
  assert.equal(f.remake.muted && f.original.muted, true);
  assert.equal(f.original.volume, 0.6);
  f.controller.setRate(1.5);
  assert.equal(f.remake.playbackRate, 1.5);
  assert.equal(f.original.playbackRate, 1.5);
  f.controller.deactivate();
  assert.equal(f.remake.playbackRate, 1);
  assert.equal(f.remake.muted, false);
  assert.equal(f.original.muted, false);
});

test('seeks by elapsed seconds, holds the short final frame, and ends only when the long video finishes', async (t) => {
  const f = setup(t);
  f.controller.seek(7);
  assert.equal(f.remake.currentTime, 5);
  assert.equal(f.original.currentTime, 7);
  await f.controller.play();
  assert.equal(f.remake.paused, true);
  assert.equal(f.original.paused, false);
  f.original.advance(9);
  assert.equal(f.state().time, 9);
  assert.equal(f.ends(), 0);
  f.original.advance(10);
  f.original.event('ended');
  assert.equal(f.ends(), 1);
  assert.equal(f.state().playing, false);
  await f.controller.play();
  assert.equal(f.remake.currentTime, 0);
  assert.equal(f.original.currentTime, 0);
  assert.equal(f.remake.paused || f.original.paused, false);
  f.controller.seek(-2);
  assert.equal(f.state().time, 0);
  f.controller.pause();
  f.controller.seek(999);
  assert.equal(f.state().time, 10);
  assert.equal(f.ends(), 1, 'paused seeking to the end is not an automatic next-video action');
});

test('corrects follower drift while playing and does not chase times while paused', async (t) => {
  const f = setup(t, 10, 8);
  await f.controller.play();
  f.original.currentTime = 1;
  f.remake.advance(1.3);
  assert.equal(f.original.currentTime, 1.3);
  f.controller.pause();
  f.original.currentTime = 2;
  f.remake.advance(3);
  assert.equal(f.original.currentTime, 2);
  assert.equal(f.state().time, 1.3);
});

test('buffers both videos together and resumes only when the waiting video is ready', async (t) => {
  const f = setup(t);
  await f.controller.play();
  f.original.currentTime = 2;
  f.remake.readyState = 2;
  f.remake.event('waiting');
  assert.equal(f.remake.paused && f.original.paused, true);
  assert.equal(f.state().buffering, true);
  assert.equal(f.state().time, 2);
  f.original.event('canplay');
  await flush();
  assert.equal(f.original.paused, true);
  f.remake.readyState = 4;
  f.remake.event('canplay');
  await flush();
  assert.equal(f.state().playing, true);
  assert.equal(f.remake.currentTime, 2);
  assert.equal(f.original.currentTime, 2);
});

test('a pending play completion cannot restart videos after leaving comparison', async (t) => {
  const f = setup(t);
  let complete;
  f.original.play = () => new Promise((resolve) => { complete = () => { f.original.paused = false; resolve(); }; });
  const pending = f.controller.play();
  f.controller.deactivate();
  complete();
  assert.equal(await pending, false);
  assert.equal(f.remake.paused && f.original.paused, true);
  assert.equal(f.state().playing, false);
});

test('seeking and drift correction wait for seeked rather than creating a pause/seek loop', async (t) => {
  const f = setup(t);
  for (const video of [f.remake, f.original]) {
    let value = 0;
    Object.defineProperty(video, 'currentTime', {
      get: () => value,
      set: (next) => {
        value = next;
        video.seeking = true;
        video.event('seeking');
        queueMicrotask(() => { video.seeking = false; video.event('seeked'); });
      },
    });
    video.advance = (next) => { value = next; video.event('timeupdate'); };
  }
  await f.controller.play();
  f.controller.seek(3);
  assert.equal(f.state().buffering, true);
  await flush();
  assert.equal(f.state().playing, true);
  assert.equal(f.remake.currentTime, 3);
  assert.equal(f.original.currentTime, 3);
  assert.equal(f.remake.playCount, 2);
  assert.equal(f.original.playCount, 2);
  f.original.advance(3.4);
  assert.equal(f.state().buffering, true);
  await flush();
  assert.equal(f.state().playing, true);
  assert.equal(f.remake.currentTime, 3.4);
  assert.equal(f.remake.playCount, 3);
  assert.equal(f.original.playCount, 3);
  f.controller.pause();
  f.controller.seek(4);
  await flush();
  assert.equal(f.state().playing, false);
  assert.equal(f.remake.playCount, 3);
});

test('play rejection and media errors pause both sides and report a recoverable error', async (t) => {
  const f = setup(t);
  f.original.play = () => Promise.reject(new Error('codec unsupported'));
  assert.equal(await f.controller.play(), false);
  assert.equal(f.errors[0].message, 'codec unsupported');
  assert.equal(f.remake.paused && f.original.paused, true);
  f.original.play = Video.prototype.play;
  f.controller.activate();
  await f.controller.play();
  f.remake.error = { message: 'network failure' };
  f.remake.event('error');
  assert.equal(f.errors[1].message, 'network failure');
  assert.equal(f.state().playing, false);
  assert.equal(f.original.paused, true);
});

test('play intent waits for metadata and canplay without starting one side early', async (t) => {
  const f = setup(t, NaN, NaN);
  f.remake.readyState = 0;
  f.original.readyState = 0;
  await f.controller.play();
  assert.equal(f.state().buffering, true);
  f.remake.duration = 4;
  f.remake.readyState = 4;
  f.remake.event('loadedmetadata');
  assert.equal(f.remake.playCount, 0);
  f.original.duration = 6;
  f.original.readyState = 2;
  f.original.event('loadedmetadata');
  assert.equal(f.state().duration, 6);
  assert.equal(f.original.playCount, 0);
  f.original.readyState = 4;
  f.original.event('canplay');
  await flush();
  assert.equal(f.state().playing, true);
});

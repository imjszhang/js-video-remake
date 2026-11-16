# film 运行时

把一个页面逐帧渲染成视频。页面自己实现 `window.__film`，本目录只负责驱动它。实验性，版本见 `src/film/engine.js` 的 `FILM_RUNTIME_VERSION`。

## 页面约定

```js
window.__film = {
  duration: 90,      // 秒
  fps: 60,
  width: 1920,
  height: 1080,
  ready: promise,    // 解析后才开始抓帧，用来等模型或着色器
  frame(t) {},       // 画出 t 秒处的画面，只依赖 t
  exportWav() {},    // 可选，返回整条音轨的 base64 WAV
}
```

`frame(t)` 必须是纯函数：同一个 `t` 每次画出同一帧。因此页面里不能用 `Date.now`、`performance.now`、`requestAnimationFrame` 当时钟，也不能用 `Math.random`。随机数用 `runtime/film.js` 的 `mulberry32(seed)`。

`film.json` 记录片长、帧率、画幅和节拍。页面用 `loadFilm()` 读取，不要在页面里另写一套时长。

## 渲染

```bash
node tools/render.mjs --entry index.html --out renders/film.mp4
node tools/render.mjs --frames 0,30,60 --png-dir renders/stills
node tools/render.mjs --check
```

Chrome 从 `FILM_CHROME` 或系统默认位置找。渲染只访问 `127.0.0.1` 上的本包文件，页面发起的其他网络请求会被记录并导致失败。

## 声音

`exportWav()` 用 `OfflineAudioContext` 一次合成整条音轨，再用 `runtime/wav.js` 的 `audioBufferToWav` 编码。渲染器把它和画面合成进同一个 mp4。不要在 `frame` 里播放声音。

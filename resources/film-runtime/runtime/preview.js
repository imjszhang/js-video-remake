// Preview scrubber. Included by a film page; does nothing while the renderer drives the
// page (?capture), and otherwise lets a person drag through the film or play it.
(async () => {
    if (new URLSearchParams(location.search).has('capture')) return;
    const deadline = Date.now() + 30000;
    while (!window.__film && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const film = window.__film;
    if (!film) return;
    await film.ready;

    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;display:flex;gap:12px;align-items:center;padding:10px 16px;background:rgba(0,0,0,.72);color:#fff;font:14px/1.4 sans-serif;z-index:10';
    const button = document.createElement('button');
    button.textContent = '播放';
    button.style.cssText = 'background:#e23d3d;color:#fff;border:0;border-radius:4px;padding:6px 14px;cursor:pointer';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(film.duration);
    slider.step = String(1 / film.fps);
    slider.value = '0';
    slider.style.flex = '1';
    const label = document.createElement('span');
    label.textContent = '0.00s';
    bar.append(button, slider, label);
    document.body.append(bar);

    // The single-file build opens straight from disk and should just play, like a video.
    let playing = Boolean(globalThis.__FILM_STANDALONE__);
    let origin = 0;
    let from = 0;
    addEventListener('keydown', event => { if (event.code === 'Space') { event.preventDefault(); button.click(); } });
    const show = time => { slider.value = String(time); label.textContent = `${time.toFixed(2)}s`; };
    const draw = async time => { await film.frame(time); show(time); };
    const tick = now => {
        if (!playing) return;
        const time = (from + (now - origin) / 1000) % film.duration;
        // frame() may be synchronous; wrap it so .then works either way.
        Promise.resolve(film.frame(time)).then(() => show(time));
        requestAnimationFrame(tick);
    };
    button.addEventListener('click', () => {
        playing = !playing;
        button.textContent = playing ? '暂停' : '播放';
        if (playing) { origin = performance.now(); from = Number(slider.value); requestAnimationFrame(tick); }
    });
    slider.addEventListener('input', () => { playing = false; button.textContent = '播放'; draw(Number(slider.value)); });
    await draw(0);
    if (playing) { button.textContent = '暂停'; origin = performance.now(); requestAnimationFrame(tick); }
})();

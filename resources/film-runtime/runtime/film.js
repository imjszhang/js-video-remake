// Helpers for a film page. A frame is a pure function of film time: read the frozen
// film.json, seed every random choice, and install the contract the renderer drives.
//
// Paths resolve against this module, not the page: runtime/ sits at the package root,
// so the defaults find film.json and inputs/ whether the entry is index.html or src/index.html.
const ROOT = new URL('../', import.meta.url);

// The single-file build (tools/build.mjs) embeds the package's JSON here, because a
// page opened from disk (file://) may not fetch files. Served pages fetch as usual.
const EMBEDDED = globalThis.__FILM_EMBED__ || null;

function embedded(url) {
    if (!EMBEDDED) return undefined;
    const href = new URL(url, ROOT).href;
    if (!href.startsWith(ROOT.href)) return undefined;
    const relative = decodeURIComponent(href.slice(ROOT.href.length));
    return Object.hasOwn(EMBEDDED, relative) ? EMBEDDED[relative] : undefined;
}

export async function loadFilm(url = new URL('film.json', ROOT)) {
    const inline = embedded(url);
    if (inline !== undefined) return structuredClone(inline);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`无法读取 ${url}`);
    return response.json();
}

// Reproduction inputs (inputs/values.json). A package without inputs gets {}.
export async function loadInputs(url = new URL('inputs/values.json', ROOT)) {
    const inline = embedded(url);
    if (inline !== undefined) return structuredClone(inline);
    if (EMBEDDED) return {};
    const response = await fetch(url);
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`无法读取 ${url}`);
    return response.json();
}

// Deterministic generator. Same seed, same sequence, on every machine.
export function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

// The beat named `name`, or the first one at or before time t.
export function beatAt(film, nameOrTime) {
    const beats = film.beats || [];
    if (typeof nameOrTime === 'string') return beats.find(beat => beat.name === nameOrTime) || null;
    let found = null;
    for (const beat of beats) if (beat.at <= nameOrTime) found = beat;
    return found;
}

// Publish the contract. `ready` may be a promise for mesh building or shader compile.
export function installFilm({ film, frame, exportWav = null, ready = Promise.resolve() }) {
    const contract = {
        duration: film.duration,
        fps: film.fps,
        width: film.width,
        height: film.height,
        ready: Promise.resolve(ready).then(() => true),
        frame,
    };
    if (exportWav) contract.exportWav = exportWav;
    window.__film = contract;
    return contract;
}

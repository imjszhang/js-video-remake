// The film counterpart of the trusted HyperFrames CLI. Managed renders and stage
// previews run the host's own runtime from resources/film-runtime/, never the copy a
// project carries, so a project cannot change how it is checked or rendered.
// Imports only the standard library, so reproduction modules can use it freely.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FILM_RUNTIME_DIR, FILM_RUNTIME_VERSION } from './constants.js';

export const FILM_RENDERER = path.join(FILM_RUNTIME_DIR, 'tools/render.mjs');
export const FILM_CHECKER = path.join(FILM_RUNTIME_DIR, 'tools/check.mjs');
// Runtime files a page imports at load time. The renderer serves the project
// directory, so these must be byte-identical to the host copies.
const PAGE_RUNTIME = ['runtime/film.js', 'runtime/wav.js', 'runtime/preview.js'];

const sha256 = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

/**
 * Refuse a project whose page-side runtime differs from the host's. Returns the
 * hashes the render record keeps, so a later audit can tell which runtime ran.
 */
export async function assertTrustedFilmRuntime(workspace, fail) {
    const hashes = {};
    for (const relative of PAGE_RUNTIME) {
        const host = await sha256(path.join(FILM_RUNTIME_DIR, relative));
        let project;
        try {
            const file = path.join(workspace, relative);
            const info = await fs.lstat(file);
            if (!info.isFile()) throw new Error('not a file');
            project = await sha256(file);
        } catch {
            throw fail(`film 工程缺少运行时文件 ${relative}。`);
        }
        if (project !== host) throw fail(`film 工程的 ${relative} 与本机运行时不一致，拒绝渲染。`);
        hashes[relative] = host;
    }
    return { version: FILM_RUNTIME_VERSION, renderer: await sha256(FILM_RENDERER), checker: await sha256(FILM_CHECKER), files: hashes };
}

/** Arguments for the host checker: static determinism rules over the project source. */
export function filmCheckArgs(workspace) {
    return [FILM_CHECKER, '--root', workspace];
}

/** Arguments for the host renderer, serving the project directory as the site root. */
export function filmRenderArgs(workspace, { entry, out }) {
    return [FILM_RENDERER, '--root', workspace, '--entry', entry, '--out', out];
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceServer } from './fixtures/source-server.js';
import { parseArgv } from '../src/args.js';
import { execute, main } from '../cli/remake.js';
import { writeCatalog } from '../src/catalog.js';
import { emptyCatalog } from '../src/schema.js';

export async function tempWorkspace(t, { videos } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'video-remake-'));
    t.after(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });
    const libraryDir = path.join(directory, 'library');
    await fs.mkdir(libraryDir, { recursive: true });
    for (const name of ['references', 'productions', 'deliverables', 'assets', 'packages']) {
        await fs.mkdir(path.join(directory, name), { recursive: true });
    }
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
        name: 'video-remake',
        private: true,
        type: 'module',
    }, null, 2));
    await writeCatalog(path.join(directory, 'catalog.json'), emptyCatalog());
    const statePath = path.join(directory, 'archive-state.json');
    await fs.writeFile(statePath, JSON.stringify({ libraryDir, videos: videos || {}, calls: [] }, null, 2));
    const server = await sourceServer(statePath);
    t.after(() => server.close());
    await fs.writeFile(path.join(directory, 'video-remake.json'), JSON.stringify({
        source: { provider: 'gateway-video', baseUrl: server.baseUrl, pollIntervalMs: 1, waitTimeoutMs: 1000 },
        assetRoot: libraryDir,
        quality: '1080',
    }, null, 2));
    return {
        directory,
        libraryDir,
        statePath,
        env: {
            VIDEO_REMAKE_SOURCE_TOKEN: 'fixture-token',
            VIDEO_REMAKE_WORKSPACE: directory,
            VIDEO_REMAKE_ASSET_ROOT: libraryDir,
        },
    };
}

export function downloadedVideo(overrides = {}) {
    return {
        videoId: 'abcdefghijk',
        platform: 'youtube',
        kind: 'long',
        status: 'downloaded',
        title: 'Fixture video',
        channel: 'Fixture Channel',
        durationSec: 90,
        quality: '1080',
        canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        inputUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoPath: 'video.mp4',
        thumbPath: 'thumb.jpg',
        subs: { en: 'subs/en.vtt' },
        sha256: 'abc123',
        bytes: 5,
        error: null,
        ...overrides,
    };
}

export async function readState(statePath) {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
}

export async function run(argv, env) {
    return execute(parseArgv(argv), env);
}

export async function runMain(argv, env) {
    const lines = [];
    const err = [];
    const code = await main(argv, {
        stdout: (text) => lines.push(text),
        stderr: (text) => err.push(text),
    }, env);
    return { code, stdout: lines.join('\n'), stderr: err.join('\n') };
}

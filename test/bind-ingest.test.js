import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { downloadedVideo, readState, run, tempWorkspace } from './helpers.js';

test('bind writes SOURCE.json and catalog from a downloaded archive entry', async (t) => {
    const workspace = await tempWorkspace(t, {
        videos: { abcdefghijk: downloadedVideo() },
    });
    const result = await run(['bind', 'abcdefghijk', '--json'], workspace.env);
    assert.equal(result.ok, true);
    assert.equal(result.data.reference.id, 'youtube-abcdefghijk');
    const source = JSON.parse(await fs.readFile(path.join(workspace.directory, 'references/youtube-abcdefghijk/SOURCE.json'), 'utf8'));
    assert.equal(source.schema, 'video-remake.source@1');
    assert.equal(source.relVideo, 'videos/abcdefghijk/video.mp4');
    assert.equal(source.videoPath, path.join(workspace.libraryDir, 'videos/abcdefghijk/video.mp4'));
    const catalog = JSON.parse(await fs.readFile(path.join(workspace.directory, 'catalog.json'), 'utf8'));
    assert.equal(catalog.references[0].id, 'youtube-abcdefghijk');
});

test('bind rejects entries that are not downloaded', async (t) => {
    const workspace = await tempWorkspace(t, {
        videos: { abcdefghijk: downloadedVideo({ status: 'queued', videoPath: null }) },
    });
    await assert.rejects(run(['bind', 'abcdefghijk'], workspace.env), (error) => error.code === 'NOT_DOWNLOADED');
});

test('ingest skips worker when the archive already has the file', async (t) => {
    const workspace = await tempWorkspace(t, {
        videos: { abcdefghijk: downloadedVideo() },
    });
    const result = await run(
        ['ingest', 'https://www.youtube.com/watch?v=abcdefghijk'],
        workspace.env,
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.ingestion.added.skipped, true);
    const state = await readState(workspace.statePath);
    assert.equal(state.calls.some((call) => call[0] === 'worker'), false);
});

test('ingest polls gateway until the video is downloaded', async (t) => {
    const workspace = await tempWorkspace(t);
    const result = await run(
        ['ingest', 'https://www.youtube.com/watch?v=abcdefghijk'],
        workspace.env,
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.reference.id, 'youtube-abcdefghijk');
    const state = await readState(workspace.statePath);
    assert.equal(state.calls.filter((call) => call[0] === 'get').length >= 1, true);
    assert.equal(state.videos.abcdefghijk.status, 'downloaded');
});

test('ingest warns when binding an existing 720 file without --force', async (t) => {
    const workspace = await tempWorkspace(t, {
        videos: { abcdefghijk: downloadedVideo({ quality: '720' }) },
    });
    const result = await run(
        ['ingest', 'https://www.youtube.com/watch?v=abcdefghijk'],
        workspace.env,
    );
    assert.equal(result.ok, true);
    assert.match(result.data.warning, /720/);
});

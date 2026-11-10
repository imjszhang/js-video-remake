import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';
import { nodeInfo } from '../src/doctor.js';
import { HYPERFRAMES_VERSION } from '../src/repro/project.js';
import { downloadedVideo, run, tempWorkspace } from './helpers.js';

test('an old hypit config field is ignored', async (t) => {
    const workspace = await tempWorkspace(t);
    await fs.writeFile(path.join(workspace.directory, 'video-remake.json'), JSON.stringify({
        hypit: './node_modules/@hypit/hypit/bin/hypit.mjs',
        assetRoot: workspace.libraryDir,
    }));
    const config = resolveConfig({ workspace: workspace.directory }, {}, workspace.directory);
    assert.equal(config.hypitBin, undefined);
    assert.equal(config.assetRoot, workspace.libraryDir);
});

test('paths reports ffmpeg, ffprobe, and the locked HyperFrames package', async (t) => {
    const workspace = await tempWorkspace(t);
    const result = await run(['paths'], workspace.env);
    assert.equal(result.data.workspace, workspace.directory);
    assert.equal(result.data.assetRoot, workspace.libraryDir);
    assert.equal(result.data.tools.hyperframes.expected, HYPERFRAMES_VERSION);
    assert.equal(result.data.tools.hyperframes.available, true);
    assert.equal(typeof result.data.tools.ffmpeg.available, 'boolean');
    assert.equal(typeof result.data.tools.ffprobe.available, 'boolean');
    assert.equal(result.data.hypitSuggested, undefined);
});

test('doctor enforces the Node 22.15.0 minimum', () => {
    for (const version of ['v20.19.0', 'v22.0.0', 'v22.14.9', 'invalid']) {
        assert.equal(nodeInfo(version).ok, false, version);
    }
    for (const version of ['v22.15.0', 'v22.15.1', 'v22.16.0', 'v23.0.0', 'v24.22.1']) {
        assert.equal(nodeInfo(version).ok, true, version);
    }
});

test('doctor succeeds against the fake archive', async (t) => {
    const workspace = await tempWorkspace(t, {
        videos: { abcdefghijk: downloadedVideo() },
    });
    const result = await run(['doctor'], workspace.env);
    assert.equal(result.ok, true);
    assert.equal(result.data.source.available, true);
    assert.equal(result.data.assetRoot.readable, true);
    assert.equal(result.data.catalog.ok, true);
    assert.equal(result.data.tools.hyperframes.version, HYPERFRAMES_VERSION);
    assert.equal(result.data.hypit, undefined);
});

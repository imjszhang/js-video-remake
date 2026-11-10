import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playableDraftVersions, videosForVersion, chooseDraftVersion, videoForVersion } from '../web/versions.js';

function projectFixture() {
    const videos = Array.from({ length: 6 }, (_, index) => ({ id: `v1-${index + 1}`, version: 'v1', kind: 'draft', episode: index + 1, reference: { id: `source-${index + 1}` } }));
    videos.push({ id: 'v2-pilot', version: 'v2', kind: 'draft', episode: 1, reference: { id: 'source-1' } });
    return { videos, defaultDraftVersion: 'v2', draftVersions: [{ version: 'v1', videoCount: 6 }, { version: 'v2', videoCount: 1 }, { version: 'v3', videoCount: 0 }] };
}

test('version playlists keep incomplete pilots separate and hide empty versions', () => {
    const project = projectFixture();
    assert.deepEqual(playableDraftVersions(project).map((group) => group.version), ['v1', 'v2']);
    assert.equal(videosForVersion(project, 'v1').length, 6);
    assert.deepEqual(videosForVersion(project, 'v2').map((video) => video.id), ['v2-pilot']);
    assert.equal(videosForVersion(project, null).length, 7);
});

test('default version, explicit links and legacy video links resolve predictably', () => {
    const project = projectFixture();
    assert.equal(chooseDraftVersion(project), 'v2');
    assert.equal(chooseDraftVersion(project, { videoId: 'v1-4' }), 'v1', 'old saved video links still select their version');
    assert.equal(chooseDraftVersion(project, { version: 'v2', videoId: 'v1-4' }), 'v2', 'explicit version takes precedence over a stale video id');
    assert.equal(chooseDraftVersion(project, { version: 'v3' }), 'v2', 'empty versions fall back to a playable default');
});

test('changing version preserves the episode and original when available, otherwise selects the pilot', () => {
    const project = projectFixture();
    const first = project.videos[0];
    const last = project.videos[5];
    const pilot = project.videos[6];
    assert.equal(videoForVersion(project, 'v2', first), pilot);
    assert.equal(videoForVersion(project, 'v2', last), pilot, 'an unfinished episode must not borrow the v1 file');
    assert.equal(videoForVersion(project, 'v1', pilot), first);
    assert.equal(videoForVersion(project, 'v1', last), last);
    assert.equal(videoForVersion(project, 'v2', first).reference.id, first.reference.id);
});

test('single-output and non-draft projects retain their previous behavior', () => {
    const project = { videos: [{ id: 'delivery', kind: 'delivery', version: 'v2' }, { id: 'comparison', kind: 'comparison', version: 'v4' }] };
    assert.deepEqual(playableDraftVersions(project), []);
    assert.equal(chooseDraftVersion(project), null);
    assert.equal(videosForVersion(project, null).length, 2);
    assert.equal(videoForVersion(project, null, project.videos[1]).id, 'comparison');
});

import { videosForVersionWithComparisons, defaultCompareVersion, counterpartVideo, versionLabel } from '../web/versions.js';

function forkedFixture() {
    const draft = (v, extra = {}) => ({ id: `d-${v}`, version: v, kind: 'draft', reference: { id: 'src' }, ...extra });
    return {
        defaultDraftVersion: 'c3',
        draftVersions: [
            { version: 'c1', videoCount: 1, forkedFrom: null },
            { version: 'c2', videoCount: 1, forkedFrom: 'c1', note: { summary: '口播的字幕对位和语速重做（videos/c2/，从 c1 复制）。' } },
            { version: 'c3', videoCount: 1, forkedFrom: 'c1', label: '模板' },
            { version: 'c4', videoCount: 0, forkedFrom: 'c3' },
        ],
        videos: [draft('c1'), draft('c2'), draft('c3'),
            { id: 'cmp-c2', kind: 'comparison', version: 'v5', forVersion: 'c2' },
            { id: 'cmp-old', kind: 'comparison', version: 'v1' },
            { id: 'film', kind: 'delivery', version: 'v1' }],
    };
}

test('comparisons follow the draft version they were made for; unmatched ones stay visible everywhere', () => {
    const p = forkedFixture();
    assert.deepEqual(videosForVersionWithComparisons(p, 'c2').map((v) => v.id), ['d-c2', 'cmp-c2', 'cmp-old', 'film']);
    assert.deepEqual(videosForVersionWithComparisons(p, 'c3').map((v) => v.id), ['d-c3', 'cmp-old', 'film']);
});

test('version-to-version comparison defaults to the parent, then the neighbour, and matches the same original', () => {
    const p = forkedFixture();
    assert.equal(defaultCompareVersion(p, 'c3'), 'c1', 'forked from c1');
    assert.equal(defaultCompareVersion(p, 'c1'), 'c2', 'no parent: the next one');
    assert.equal(defaultCompareVersion(p, 'c4'), null, 'empty versions are not playable');
    assert.equal(defaultCompareVersion({ ...p, draftVersions: p.draftVersions.slice(0, 1) }, 'c1'), null);
    assert.equal(counterpartVideo(p, 'c1', p.videos[2]).id, 'd-c1');
    assert.equal(counterpartVideo(p, 'c9', p.videos[2]), null);
    assert.equal(versionLabel(p.draftVersions[1]), '口播的字幕对位和语速重做');
    assert.equal(versionLabel(p.draftVersions[2]), '模板');
    assert.equal(versionLabel({ note: { summary: 'x'.repeat(40) } }, 10), `${'x'.repeat(9)}…`);
});

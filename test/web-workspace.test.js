import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceForProject, templatePlaybackVideo, groupTemplatePackages, templateVersionLabel } from '../web/workspace.js';

function templateProject() {
    return {
        templatePackages: [{ name: 'demo-v7' }, { name: 'demo-v10' }],
        videos: [
            { id: 'draft-v7', kind: 'draft', version: 'demo-v7' },
            { id: 'delivery-v10', kind: 'delivery', version: 'demo-v10' },
            { id: 'comparison-v10', kind: 'comparison', version: 'demo-v10' },
        ],
    };
}

test('template projects open in the workspace even when an earlier version has a video', () => {
    const project = templateProject();
    assert.equal(workspaceForProject(project), 'template');
    assert.equal(workspaceForProject({ ...project, videos: [] }), 'template');
    assert.equal(workspaceForProject(project, 'playback'), 'playback', 'explicitly selected playback survives refresh');
    assert.equal(workspaceForProject(project, 'template'), 'template');
    assert.equal(workspaceForProject(project, 'unknown'), 'template');
});

test('legacy projects without template packages keep opening in playback', () => {
    for (const project of [{ videos: [] }, { templatePackages: [], videos: [{ kind: 'delivery', version: 'v1' }] }]) {
        assert.equal(workspaceForProject(project), 'playback');
        assert.equal(workspaceForProject(project, 'template'), 'playback', 'a stale template workspace selection cannot hide a normal project');
        assert.equal(workspaceForProject(project, 'playback'), 'playback');
    }
});

test('unrendered template versions do not borrow older drafts, deliveries or comparisons', () => {
    const project = templateProject();
    assert.equal(templatePlaybackVideo(project, 'demo-v7'), project.videos[0]);
    assert.equal(templatePlaybackVideo(project, 'demo-v10'), null);
    assert.equal(templatePlaybackVideo(project, 'v7'), null, 'suffixes are not template identifiers');
    assert.equal(templatePlaybackVideo({ templatePackages: project.templatePackages, videos: [] }, 'demo-v10'), null);
});

test('a composed template becomes playable through its own registered draft', () => {
    const project = templateProject();
    const rendered = { id: 'draft-v10', kind: 'draft', version: 'demo-v10' };
    project.videos.push(rendered);
    assert.equal(templatePlaybackVideo(project, 'demo-v10'), rendered);
    assert.equal(templatePlaybackVideo(project, 'demo-v7'), project.videos[0]);
});


test('template families group revisions without merging independent v1 templates', () => {
    const packages = [
        { name: 'legacy-v7', lineage: { id: 'source', title: '来源', kind: 'source', version: 7 } },
        { name: 'legacy-v10', lineage: { id: 'blue', title: '冷蓝', kind: 'derived', version: 1 } },
        { name: 'blue-v2', lineage: { id: 'blue', title: '冷蓝', kind: 'derived', version: 2 } },
        { name: 'legacy-v8', lineage: { id: 'green', title: '森林绿', kind: 'derived', version: 1 } },
    ];
    const groups = groupTemplatePackages(packages);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups.find(group => group.id === 'blue').versions.map(pkg => pkg.name), ['legacy-v10', 'blue-v2']);
    assert.equal(templateVersionLabel(packages[0]), '来源 · 原版 v7');
    assert.equal(templateVersionLabel(packages[1]), '冷蓝 · v1');
    assert.equal(templateVersionLabel(packages[3]), '森林绿 · v1');
});

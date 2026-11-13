import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectTitle, projectsInScope, filterProjects, resolveSelection, recentProjects, libraryCounts } from '../web/library-model.js';

const video = (title, kind = 'draft') => ({ id: title, title, kind });
function library() {
    return [
        { slug: 'empty', title: 'empty', videos: [], updatedAt: '2026-11-01T00:00:00Z' },
        { slug: 'series', title: '系列片', videos: [video('第一集'), video('成片', 'delivery')], updatedAt: '2026-11-09T00:00:00Z' },
        { slug: 'shelved', title: '旧项目', archived: true, videos: [video('Old Cut')], updatedAt: '2026-11-10T00:00:00Z' },
        { slug: 'undated', title: '未记录时间', videos: [video('片段')] },
    ];
}
const slugs = projects => projects.map(project => project.slug);

test('a title equal to the slug is shown as the slug, otherwise the title wins', () => {
    assert.equal(projectTitle({ slug: 'demo', title: 'demo' }), 'demo');
    assert.equal(projectTitle({ slug: 'demo', title: '' }), 'demo');
    assert.equal(projectTitle({ slug: 'demo', title: '演示' }), '演示');
});

test('active and archived scopes are disjoint and legacy entries without the flag are active', () => {
    assert.deepEqual(slugs(projectsInScope(library(), 'active')), ['empty', 'series', 'undated']);
    assert.deepEqual(slugs(projectsInScope(library(), 'archived')), ['shelved']);
});

test('playable-only and search narrow within the scope, never across it', () => {
    assert.deepEqual(slugs(filterProjects(library(), { scope: 'active', playableOnly: true })), ['series', 'undated']);
    assert.deepEqual(slugs(filterProjects(library(), { scope: 'active', query: '  第一集 ' })), ['series'], 'video titles are searchable');
    assert.deepEqual(slugs(filterProjects(library(), { scope: 'active', query: 'SERIES' })), ['series'], 'slug match ignores case');
    assert.deepEqual(slugs(filterProjects(library(), { scope: 'active', query: 'old cut' })), [], 'archived projects stay out of the active list');
    assert.deepEqual(slugs(filterProjects(library(), { scope: 'archived', query: 'old cut' })), ['shelved']);
    assert.deepEqual(slugs(filterProjects(library())), ['empty', 'series', 'undated'], 'defaults show every active project');
});

test('the open project survives a refresh even while the sidebar browses the other scope', () => {
    const kept = resolveSelection(library(), { scope: 'archived', slug: 'series' });
    assert.equal(kept.project.slug, 'series');
    assert.equal(kept.scope, 'archived', 'browsing scope is not changed by a refresh');
});

test('a link to an archived project opens it and moves the sidebar to its scope', () => {
    const linked = resolveSelection(library(), { scope: 'active', slug: 'shelved', deepLink: true });
    assert.equal(linked.project.slug, 'shelved');
    assert.equal(linked.scope, 'archived');
    const active = resolveSelection(library(), { scope: 'archived', slug: 'series', deepLink: true });
    assert.equal(active.scope, 'active');
});

test('without a selection the first playable project in scope opens; an empty scope opens nothing', () => {
    assert.equal(resolveSelection(library(), { scope: 'active' }).project.slug, 'series', 'playable beats the empty first entry');
    assert.equal(resolveSelection(library(), { scope: 'active', slug: 'deleted' }).project.slug, 'series', 'a vanished project falls back');
    assert.equal(resolveSelection([library()[0]], { scope: 'active' }).project.slug, 'empty', 'an unplayable project is still better than none');
    assert.deepEqual(resolveSelection(library().filter(project => !project.archived), { scope: 'archived' }), { project: null, scope: 'archived' });
    assert.deepEqual(resolveSelection([], {}), { project: null, scope: 'active' });
});

test('recent projects are newest first, undated last in catalog order, without mutating the input', () => {
    const projects = library();
    assert.deepEqual(slugs(recentProjects(projects)), ['shelved', 'series', 'empty', 'undated']);
    assert.deepEqual(slugs(recentProjects(projects, 2)), ['shelved', 'series']);
    assert.deepEqual(slugs(projects), ['empty', 'series', 'shelved', 'undated']);
    const undated = [{ slug: 'a', videos: [] }, { slug: 'b', videos: [], updatedAt: 'not a date' }, { slug: 'c', videos: [] }];
    assert.deepEqual(slugs(recentProjects(undated)), ['a', 'b', 'c']);
});

test('library counts ignore archived projects', () => {
    assert.deepEqual(libraryCounts(library()), { projects: 3, videos: 3, drafts: 2 });
    assert.deepEqual(libraryCounts([]), { projects: 0, videos: 0, drafts: 0 });
});

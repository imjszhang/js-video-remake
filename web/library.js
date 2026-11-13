/** 制作库：左侧项目列表，以及没有打开项目时的首页（统计、最近制作、开始新制作）。 */
import { api } from './api.js';
import { $, $$, node, button, padded, shortDate, statusLabel, mediaUrl, notify, reflectPressed } from './ui.js';
import { state, onChange } from './state.js';
import { projectTitle, projectsInScope, filterProjects, recentProjects, libraryCounts } from './library-model.js';

const IMPORT_LIMIT = 100 * 1024 * 1024;
let actions = { openProject() {}, openHome() {}, reload: async () => {} };

function renderSidebar() {
    const list = $('#projects'); list.replaceChildren();
    const projects = filterProjects(state.projects, state);
    for (const project of projects) {
        const selected = project.slug === state.selected;
        const item = button(`project-item${selected ? ' active' : ''}`, undefined, () => actions.openProject(project.slug));
        item.setAttribute('aria-current', String(selected));
        const info = node('span');
        info.append(node('strong', '', projectTitle(project)), node('small', '', `${padded(project.videos.length)} 条视频 · ${statusLabel(project)}`));
        item.append(node('span', 'project-icon', project.videos.length ? '▣' : '▧'), info);
        list.append(item);
    }
    if (!projects.length) {
        const scoped = projectsInScope(state.projects, state.scope).length;
        list.append(node('p', 'sidebar-message', scoped ? '没有匹配的项目' : state.scope === 'archived' ? '没有已归档的项目' : '暂无项目'));
    }
    $('#project-count').textContent = padded(projectsInScope(state.projects, state.scope).length);
    reflectPressed('[data-scope]', 'scope', state.scope);
    $('#playable-only').checked = state.playableOnly;
}

function renderStats() {
    const counts = libraryCounts(state.projects);
    const stats = $('#stats'); stats.replaceChildren();
    for (const [value, label] of [[counts.projects, '制作项目'], [counts.videos, '可播放视频'], [counts.drafts, '审阅草稿']]) {
        const stat = node('div', 'stat');
        stat.append(node('strong', '', padded(value)), node('span', '', label));
        stats.append(stat);
    }
}

function projectCard(project) {
    const card = button('project-card', undefined, () => actions.openProject(project.slug));
    const cover = node('span', 'project-card-cover');
    const poster = mediaUrl(project.videos.find(video => video.poster)?.poster);
    if (poster) { const image = node('img'); image.src = poster; image.alt = ''; image.loading = 'lazy'; cover.append(image); }
    else cover.append(node('span', 'project-card-glyph', project.templatePackages?.length ? '▧' : '▷'));
    cover.append(node('span', 'project-card-status', statusLabel(project)));
    const facts = [`${project.videos.length} 条视频`];
    if (project.templatePackages?.length) facts.push(`${project.templatePackages.length} 个模板版本`);
    const updated = shortDate(project.updatedAt);
    if (updated) facts.push(`${updated} 更新`);
    const body = node('span', 'project-card-body');
    body.append(node('strong', '', projectTitle(project)), node('small', '', facts.join(' · ')));
    card.append(cover, body);
    return card;
}

function renderHome() {
    renderStats();
    const active = projectsInScope(state.projects, 'active');
    const grid = $('#recent-projects'); grid.replaceChildren(...recentProjects(active).map(projectCard));
    $('#recent').hidden = !active.length;
    $('#library-empty').hidden = Boolean(active.length);
}

function toggleImport(open) {
    const form = $('#import-form');
    form.hidden = !open;
    $('#import-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('#import-file').focus();
}

async function importTemplate(event) {
    event.preventDefault();
    const file = $('#import-file').files[0];
    const status = $('#import-status');
    if (!file || !file.name.toLowerCase().endsWith('.video')) { status.textContent = '请选择 .video 模板文件。'; return; }
    if (file.size > IMPORT_LIMIT) { status.textContent = '模板文件不能超过 100 MiB。'; return; }
    const form = $('#import-form');
    const controls = [...form.querySelectorAll('input, button'), $('#import-toggle')];
    for (const control of controls) control.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = '正在上传并导入模板…';
    try {
        const result = await api.importTemplate(file, $('#import-slug').value.trim());
        Object.assign(state, { query: '', scope: 'active', playableOnly: false, workspace: 'template' });
        $('#search').value = '';
        await actions.reload();
        actions.openProject(result.slug);
        form.reset(); toggleImport(false);
        status.textContent = '';
        notify(`已导入「${result.title || result.slug}」。接下来准备人物录像、口播和个人信息，合成后即可在这里播放。`);
    } catch (error) {
        status.textContent = error.message || '导入失败，请重试。';
    } finally {
        for (const control of controls) control.disabled = false;
        form.removeAttribute('aria-busy');
    }
}

export function showHome(visible) { $('#library-view').hidden = !visible; }

/** 侧栏「＋」：回到首页并滚到「开始新制作」。 */
function startNew() {
    actions.openHome();
    $('#start-heading').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

export function initLibrary(injected) {
    actions = { ...actions, ...injected };
    onChange(() => { renderSidebar(); renderHome(); });
    $('#search').addEventListener('input', event => { state.query = event.target.value; renderSidebar(); });
    for (const item of $$('[data-scope]')) item.addEventListener('click', () => { state.scope = item.dataset.scope; renderSidebar(); });
    $('#playable-only').addEventListener('change', event => { state.playableOnly = event.target.checked; renderSidebar(); });
    $('#refresh').addEventListener('click', () => actions.reload());
    $('#new-project').addEventListener('click', startNew);
    $('#import-toggle').addEventListener('click', () => toggleImport($('#import-form').hidden));
    $('#import-form').addEventListener('submit', importTemplate);
}

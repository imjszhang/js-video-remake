import { $, node, bytes, downloadUrl } from './ui.js';
import { templateVersionLabel } from './workspace.js';

export function renderTemplates(project, { pack } = {}) {
    const list = $('#template-list');
    list.replaceChildren();
    $('#templates').hidden = false;
    const templates = project.templates || [];
    $('#templates-count').textContent = `${templates.length} 个可下载`;
    for (const template of templates) {
        const row = node('div', 'template-row');
        const pkg = project.templatePackages?.find(item => item.name === template.video);
        row.append(node('strong', '', pkg ? templateVersionLabel(pkg) : template.title || template.name), node('span', '', bytes(template.bytes)));
        const link = node('a', 'download-link', '↓ 下载 .video');
        link.href = downloadUrl(template.url); link.download = template.name;
        row.append(link); list.append(row);
    }
    for (const pkg of project.templatePackages || []) {
        if (templates.some(template => template.video === pkg.name)) continue;
        const row = node('div', 'template-row');
        const button = node('button', 'download-link', '打包 .video');
        button.type = 'button';
        button.addEventListener('click', () => pack?.(pkg, button));
        row.append(node('strong', '', templateVersionLabel(pkg)), button); list.append(row);
    }
    if (!list.children.length) list.append(node('p', '', '暂无可打包模板。代码视频包声明为模板后，会在这里出现。'));
}

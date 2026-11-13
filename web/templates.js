/** 「全部模板包」：已打包的 .video 可下载，未打包的模板版本可就地打包。 */
import { api } from './api.js';
import { $, node, button, bytes, downloadUrl, notify } from './ui.js';
import { templateVersionLabel } from './workspace.js';

export function renderTemplates(project, { onPacked } = {}) {
    const list = $('#template-list'); list.replaceChildren();
    const packed = project.templates || [];
    const packages = project.templatePackages || [];
    $('#templates').hidden = false;
    $('#templates-count').textContent = `${packed.length} 个可下载`;
    for (const template of packed) {
        const pkg = packages.find(item => item.name === template.video);
        const link = node('a', 'download-link', '↓ 下载 .video');
        link.href = downloadUrl(template.url); link.download = template.name;
        const row = node('div', 'template-row');
        row.append(node('strong', '', pkg ? templateVersionLabel(pkg) : template.title || template.name), node('span', '', bytes(template.bytes)), link);
        list.append(row);
    }
    for (const pkg of packages) {
        if (packed.some(template => template.video === pkg.name)) continue;
        const pack = button('download-link', '打包 .video', async () => {
            pack.disabled = true; pack.textContent = '正在打包…';
            try {
                await api.packTemplate(project.slug, pkg.name);
                await onPacked?.();
                notify('模板已打包，点击「下载 .video」保存。');
            } catch (error) { notify(error.message); }
            finally { pack.disabled = false; pack.textContent = '打包 .video'; }
        });
        const row = node('div', 'template-row');
        row.append(node('strong', '', templateVersionLabel(pkg)), pack);
        list.append(row);
    }
    if (!list.children.length) list.append(node('p', '', '暂无可打包模板。代码视频包声明为模板后，会在这里出现。'));
}

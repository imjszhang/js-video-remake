/** 与业务无关的页面工具：取元素、建元素、格式化、把台账路径变成可用链接。 */

export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];
export function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}
export function button(className, text, onClick) {
    const element = node('button', className, text);
    element.type = 'button';
    if (onClick) element.addEventListener('click', onClick);
    return element;
}

export const padded = value => String(value).padStart(2, '0');
export const duration = seconds => Number.isFinite(seconds) ? `${Math.floor(Math.round(seconds) / 60)}:${padded(Math.round(seconds) % 60)}` : '—';
export const bytes = value => Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(1)} MB` : '—';
export const audio = value => ({ none: '无音轨', present: '有音轨', unknown: '未标注' }[value] || '未标注');
export function shortDate(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
}

export const statusLabels = { 'picture-review': '画面审阅', delivered: '已交付', commissioned: '制作中', drafting: '制作中' };
export const statusLabel = project => statusLabels[project.status] || project.status || '制作中';
export const kindLabels = { draft: '审阅草稿', delivery: '正式成片', comparison: '版本对比' };

/** 只接受本站 /media/ 下的地址，台账里的其他路径一律不变成链接。 */
export function mediaUrl(path) {
    if (!path) return null;
    const url = new URL(path, location.href.split('#')[0]);
    return url.origin === location.origin && /\/media\//.test(url.pathname) ? url.href : null;
}
export function sourceUrl(path) {
    try { const url = new URL(path); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function downloadUrl(path) {
    const href = mediaUrl(path);
    if (!href) return null;
    const url = new URL(href); url.searchParams.set('download', '1');
    return url.href;
}
export function setLink(selector, url) {
    const link = $(selector);
    link.hidden = !url;
    if (url) link.href = url; else link.removeAttribute('href');
}

/** 页面顶部的一条提示；传入 onRetry 时附带「重试」。空字符串清除提示。 */
export function notify(message, onRetry) {
    const notice = $('#notice');
    notice.replaceChildren(); notice.hidden = !message;
    if (!message) return;
    notice.append(document.createTextNode(message));
    if (onRetry) notice.append(button('', '重试', onRetry));
}

/** 一组互斥按钮（aria-pressed）与当前值对齐。 */
export function reflectPressed(selector, attribute, value) {
    for (const item of $$(selector)) {
        const active = item.dataset[attribute] === value;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
    }
}

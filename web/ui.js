export const $ = (selector) => document.querySelector(selector);
export const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
export const projectTitle = (project) => project.title && project.title !== project.slug ? project.title : project.slug;
export const duration = (seconds) => Number.isFinite(seconds) ? `${Math.floor(Math.round(seconds) / 60)}:${String(Math.round(seconds) % 60).padStart(2, '0')}` : '—';
export const bytes = (value) => Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(1)} MB` : '—';
export const audio = (value) => ({ none: '无音轨', present: '有音轨', unknown: '未标注' }[value] || '未标注');
export const statusLabels = { 'picture-review': '画面审阅', delivered: '已交付', commissioned: '制作中', drafting: '制作中' };
export const kindLabels = { draft: '审阅草稿', delivery: '正式成片', comparison: '版本对比' };

export function mediaUrl(path) {
    if (!path) return null;
    const url = new URL(path, location.href.split('#')[0]);
    return url.origin === location.origin && /\/media\//.test(url.pathname) ? url.href : null;
}
export function sourceUrl(path) { try { const url = new URL(path); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
export function downloadUrl(path) { const href = mediaUrl(path); if (!href) return null; const url = new URL(href); url.searchParams.set('download', '1'); return url.href; }
export function setLink(selector, url) { const link = $(selector); link.hidden = !url; if (url) link.href = url; else link.removeAttribute('href'); }

let retryHandler = null;
export function setRetryHandler(handler) { retryHandler = handler; }
export function notify(message, retry = false) {
    const notice = $('#notice'); notice.replaceChildren(); notice.hidden = !message;
    if (message) notice.append(document.createTextNode(message));
    if (retry) { const button = node('button', '', '重试'); button.type = 'button'; button.addEventListener('click', () => retryHandler?.()); notice.append(button); }
}

class ApiError extends Error {
    constructor(message, { status = 0, cause = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.cause = cause;
    }
}

async function request(url, { method = 'GET', action, body, headers = {}, signal } = {}) {
    const init = { method, cache: 'no-store', signal };
    const merged = { ...headers };
    if (action) merged['X-Remake-Action'] = action;
    if (body !== undefined) init.body = body;
    if (Object.keys(merged).length) init.headers = merged;
    let response;
    try {
        response = await fetch(url, init);
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new ApiError('无法连接本地服务，请确认工作台仍在运行。', { cause: error });
    }
    const type = response.headers.get('content-type') || '';
    const parsed = type.includes('application/json') ? await response.json().catch(() => null) : null;
    if (!response.ok) throw new ApiError(parsed?.error || `请求失败（${response.status}）`, { status: response.status });
    return parsed;
}

/** 读取型请求；调用方自己决定空数据如何呈现。 */
export const call = (url, options = {}) => request(`./${url}`, options);
/** 写操作；统一附带 X-Remake-Action，服务端据此拒绝跨来源请求。 */
export const post = (url, action, { body, headers } = {}) => request(`./${url}`, { ...(body !== undefined ? { body } : {}), method: 'POST', action, headers });
export const upload = (url, action, file) => post(url, action, {
    body: file,
    headers: { 'Content-Type': 'application/octet-stream' },
});

export const api = {
    projects: () => call('api/projects', { method: 'GET' }),
    importTemplate: (file, slug) => upload(`api/templates/import${slug ? `?${new URLSearchParams({ slug })}` : ''}`, 'import', file),
    packTemplate: (slug, name) => post(`api/projects/${encodeURIComponent(slug)}/templates/${encodeURIComponent(name)}`, 'pack'),
    archiveProject: (slug, archived) => post(`api/projects/${encodeURIComponent(slug)}/${archived ? 'restore' : 'archive'}`, 'archive'),
};

export function appError(code, message, { retryable = false, data } = {}) {
    return Object.assign(new Error(message), { code, retryable, data });
}

export function errorInfo(error) {
    return {
        code: error?.code || 'FAILED',
        message: error?.message || String(error),
        retryable: error?.retryable === true,
    };
}

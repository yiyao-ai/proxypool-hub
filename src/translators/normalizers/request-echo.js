export function buildRequestEcho(base = {}, extra = {}) {
    return {
        ...base,
        ...extra
    };
}

export function attachRequestEcho(target, requestEcho) {
    if (!target || typeof target !== 'object') {
        return target;
    }

    Object.defineProperty(target, '__translatorMeta', {
        value: {
            ...(target.__translatorMeta || {}),
            requestEcho: requestEcho || {}
        },
        enumerable: false,
        configurable: true
    });

    return target;
}

export function readRequestEcho(source) {
    return source?.__translatorMeta?.requestEcho || null;
}

export function mergeRequestEchoIntoContext(context = {}, requestOrEcho = null) {
    const requestEcho = requestOrEcho && requestOrEcho.__translatorMeta
        ? readRequestEcho(requestOrEcho)
        : requestOrEcho;

    if (!requestEcho) {
        return context;
    }

    return {
        ...context,
        requestEcho
    };
}

export function resolveResponseModel(apiResponse, context = {}) {
    return context.model || context.requestEcho?.model || apiResponse?.model;
}

export default {
    buildRequestEcho,
    attachRequestEcho,
    readRequestEcho,
    mergeRequestEchoIntoContext,
    resolveResponseModel
};

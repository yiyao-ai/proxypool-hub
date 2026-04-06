/**
 * Gemini Native API Route
 * Proxies Gemini API requests (generateContent / streamGenerateContent)
 * for Gemini CLI integration.
 *
 * - For Gemini API keys: forwards requests directly (passthrough)
 * - For other providers (OpenAI, Anthropic): converts Gemini ↔ provider format
 */

import { selectKey, recordRateLimit, recordError, recordUsage, hasKeysForTypes } from '../api-key-manager.js';
import { resolveModel } from '../model-mapping.js';
import { logger } from '../utils/logger.js';
import { recordRequest as recordUsageRequest } from '../usage-tracker.js';
import { logRequest } from '../request-logger.js';
import { getServerSettings } from '../server-settings.js';
import { detectRequestApp, resolveAssignedCredentials, orderAssignedCredentials } from '../app-routing.js';

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ─── Gemini ↔ OpenAI format converters ──────────────────────────────────────

/**
 * Convert Gemini request body to OpenAI Chat Completions format.
 */
function _geminiToChatBody(geminiBody, model) {
    const messages = [];

    // System instruction → system message
    if (geminiBody.systemInstruction) {
        const text = geminiBody.systemInstruction.parts?.map(p => p.text).join('\n') || '';
        if (text) messages.push({ role: 'system', content: text });
    }

    // Contents → messages
    for (const content of (geminiBody.contents || [])) {
        const role = content.role === 'model' ? 'assistant' : 'user';

        // Check for functionCall parts
        const functionCalls = (content.parts || []).filter(p => p.functionCall);
        const functionResponses = (content.parts || []).filter(p => p.functionResponse);
        const textParts = (content.parts || []).filter(p => p.text !== undefined);

        if (functionCalls.length > 0) {
            const textContent = textParts.map(p => p.text).join('');
            messages.push({
                role: 'assistant',
                content: textContent || '',
                tool_calls: functionCalls.map((p, i) => ({
                    id: `call_${Date.now()}_${i}`,
                    type: 'function',
                    function: {
                        name: p.functionCall.name,
                        arguments: JSON.stringify(p.functionCall.args || {})
                    }
                }))
            });
        } else if (functionResponses.length > 0) {
            for (const p of functionResponses) {
                messages.push({
                    role: 'tool',
                    tool_call_id: `call_resolved`,
                    name: p.functionResponse.name || 'unknown',
                    content: typeof p.functionResponse.response === 'string'
                        ? p.functionResponse.response
                        : JSON.stringify(p.functionResponse.response || '')
                });
            }
        } else {
            const text = textParts.map(p => p.text).join('');
            messages.push({ role, content: text });
        }
    }

    const body = { model, messages, stream: false };

    // generationConfig → OpenAI params
    const gc = geminiBody.generationConfig || {};
    if (gc.maxOutputTokens) body.max_tokens = gc.maxOutputTokens;
    if (gc.temperature !== undefined) body.temperature = gc.temperature;
    if (gc.topP !== undefined) body.top_p = gc.topP;

    // Tools → OpenAI tools format
    if (Array.isArray(geminiBody.tools)) {
        const tools = [];
        for (const toolGroup of geminiBody.tools) {
            if (Array.isArray(toolGroup.functionDeclarations)) {
                for (const fd of toolGroup.functionDeclarations) {
                    tools.push({
                        type: 'function',
                        function: {
                            name: fd.name,
                            description: fd.description || '',
                            parameters: fd.parameters || { type: 'object', properties: {} }
                        }
                    });
                }
            }
        }
        if (tools.length > 0) body.tools = tools;
    }

    return body;
}

/**
 * Convert OpenAI Chat Completions response to Gemini response format.
 */
function _chatToGeminiResponse(chatResponse) {
    const choice = chatResponse.choices?.[0];
    const msg = choice?.message || {};
    const parts = [];

    // Text content
    if (msg.content) {
        parts.push({ text: msg.content });
    }

    // Tool calls → functionCall parts
    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
            parts.push({
                functionCall: {
                    name: tc.function.name,
                    args
                }
            });
        }
    }

    if (parts.length === 0) {
        parts.push({ text: '' });
    }

    const finishReason = msg.tool_calls ? 'STOP' : 'STOP';

    return {
        candidates: [{
            content: { parts, role: 'model' },
            finishReason,
            index: 0
        }],
        usageMetadata: {
            promptTokenCount: chatResponse.usage?.prompt_tokens || 0,
            candidatesTokenCount: chatResponse.usage?.completion_tokens || 0,
            totalTokenCount: chatResponse.usage?.total_tokens || 0
        },
        modelVersion: chatResponse.model || 'unknown'
    };
}

// ─── Route handlers ─────────────────────────────────────────────────────────

/**
 * Handle Gemini API proxy requests.
 * POST /v1beta/models/{model}:generateContent
 * POST /v1beta/models/{model}:streamGenerateContent
 * GET  /v1beta/models
 */
export async function handleGeminiApiProxy(req, res) {
    const startTime = Date.now();
    const path = req.params[0] || req.params['0'] || '';
    const settings = getServerSettings();
    const appId = detectRequestApp(req);

    // GET /v1beta/models — list models (no wildcard match)
    if (req.method === 'GET' && !path) {
        return _handleListModels(req, res);
    }

    // GET /v1beta/models/{model} — model info
    if (req.method === 'GET') {
        return _handleListModels(req, res);
    }

    // Parse model and action from path like "gemini-3-flash-preview:generateContent"
    const match = path.match(/^([^:]+):(generateContent|streamGenerateContent)$/);
    if (!match) {
        return res.status(404).json({ error: { code: 404, message: `Unknown action: ${path}`, status: 'NOT_FOUND' } });
    }

    const [, requestedModel, action] = match;
    const isStreaming = action === 'streamGenerateContent';
    const geminiBody = req.body;

    console.log(`\n======================================================================`);
    console.log(`[Gemini API Proxy] >>> REQUEST`);
    console.log(`  Model:    ${requestedModel}`);
    console.log(`  Action:   ${action}`);
    console.log(`  Stream:   ${isStreaming}`);
    console.log(`======================================================================`);

    // Determine routing priority
    const keyTypes = ['gemini', 'openai', 'anthropic'];

    // Check if any keys available
    if (!hasKeysForTypes(keyTypes)) {
        return res.status(401).json({
            error: { code: 401, message: 'No API keys configured. Add keys at http://localhost:8081', status: 'UNAUTHENTICATED' }
        });
    }

    if (settings.routingMode === 'app-assigned') {
        const assignment = resolveAssignedCredentials(settings, appId);
        if (assignment.matched) {
            const assigned = await _handleAssignedGeminiRequest(req, res, requestedModel, action, isStreaming, geminiBody, assignment);
            if (assigned !== false) return;
            if (!assignment.fallbackToDefault) {
                return res.status(503).json({
                    error: { code: 503, message: `Assigned credential unavailable for ${appId}: ${assignment.unavailableReason || 'request_failed'}`, status: 'UNAVAILABLE' }
                });
            }
        }
    }

    const MAX_KEY_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
        for (const type of keyTypes) {
            const provider = selectKey(type);
            if (!provider) continue;

            try {
                const mappedModel = resolveModel(type, requestedModel);
                console.log(`[Gemini API Proxy] >>> ${type}/${provider.name} | ${requestedModel}→${mappedModel}`);

                // For Gemini keys: direct passthrough (including streaming)
                if (type === 'gemini') {
                    const baseUrl = provider.baseUrl || DEFAULT_GEMINI_BASE;
                    const url = `${baseUrl}/models/${mappedModel}:${action}?key=${provider.apiKey}`;

                    const upstreamRes = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(geminiBody)
                    });

                    const durationMs = Date.now() - startTime;

                    if (upstreamRes.status === 429) {
                        const retryAfter = upstreamRes.headers?.get?.('retry-after');
                        recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
                        logger.warn(`[Gemini API Proxy] Rate limited: ${provider.name}`);
                        continue;
                    }
                    if (upstreamRes.status === 401 || upstreamRes.status === 403) {
                        recordError(provider.id);
                        continue;
                    }
                    if (!upstreamRes.ok) {
                        const errorBody = await upstreamRes.text();
                        recordError(provider.id);
                        recordUsageRequest({ provider: type, keyId: provider.id, model: mappedModel, durationMs, success: false, error: errorBody.slice(0, 200) });
                        logRequest({ route: `/v1beta/models/${mappedModel}:${action}`, provider: type, keyId: provider.id, model: requestedModel, mappedModel, requestBody: geminiBody, responseBody: errorBody, durationMs, status: upstreamRes.status, success: false, error: errorBody.slice(0, 200) });
                        res.status(upstreamRes.status).type('json').send(errorBody);
                        return;
                    }

                    console.log(`[Gemini API Proxy] <<< OK | ${type}/${provider.name} | ${mappedModel} | ${durationMs}ms`);
                    recordUsageRequest({ provider: type, keyId: provider.id, model: mappedModel, durationMs, success: true });
                    logRequest({ route: `/v1beta/models/${mappedModel}:${action}`, provider: type, keyId: provider.id, model: requestedModel, mappedModel, requestBody: geminiBody, durationMs, status: 200, success: true });

                    // Stream passthrough: pipe upstream response directly to client
                    const contentType = upstreamRes.headers.get('content-type') || 'application/json';
                    res.writeHead(200, { 'Content-Type': contentType });
                    const reader = upstreamRes.body.getReader();
                    const pump = async () => {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            res.write(value);
                        }
                        res.end();
                    };
                    await pump();
                    return;
                }

                // For non-Gemini keys: convert formats
                const response = await _proxyViaConversion(provider, mappedModel, geminiBody);
                const durationMs = Date.now() - startTime;

                if (response.status === 429) {
                    const retryAfter = response.headers?.get?.('retry-after');
                    recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
                    logger.warn(`[Gemini API Proxy] Rate limited: ${provider.name}`);
                    continue;
                }
                if (response.status === 401 || response.status === 403) {
                    recordError(provider.id);
                    continue;
                }
                if (!response.ok) {
                    const errorBody = await response.text();
                    recordError(provider.id);
                    recordUsageRequest({ provider: type, keyId: provider.id, model: mappedModel, durationMs, success: false, error: errorBody.slice(0, 200) });
                    logRequest({ route: `/v1beta/models/${mappedModel}:${action}`, provider: type, keyId: provider.id, model: requestedModel, mappedModel, requestBody: geminiBody, responseBody: errorBody, durationMs, status: response.status, success: false, error: errorBody.slice(0, 200) });
                    logger.warn(`[Gemini API Proxy] Error ${response.status}: ${provider.name} - ${errorBody.slice(0, 200)}`);
                    continue;
                }

                const responseBody = await response.text();
                let parsed;
                try { parsed = JSON.parse(responseBody); } catch {
                    res.status(200).type('json').send(responseBody);
                    return;
                }

                console.log(`[Gemini API Proxy] <<< OK | ${type}/${provider.name} | ${mappedModel} | ${durationMs}ms`);
                recordUsageRequest({ provider: type, keyId: provider.id, model: mappedModel, durationMs, success: true });
                logRequest({ route: `/v1beta/models/${mappedModel}:${action}`, provider: type, keyId: provider.id, model: requestedModel, mappedModel, requestBody: geminiBody, responseBody: responseBody, durationMs, status: 200, success: true });

                if (isStreaming) {
                    _sendGeminiSSE(res, parsed);
                } else {
                    res.json(parsed);
                }
                return;
            } catch (error) {
                recordError(provider.id);
                logger.error(`[Gemini API Proxy] Error: ${provider.name} - ${error.message}`);
                continue;
            }
        }
    }

    res.status(503).json({
        error: { code: 503, message: 'All API keys exhausted. Try again later.', status: 'UNAVAILABLE' }
    });
}

async function _handleAssignedGeminiRequest(req, res, requestedModel, action, isStreaming, geminiBody, assignment) {
    const settings = getServerSettings();
    const baseAssignments = Array.isArray(assignment.assignments)
        ? assignment.assignments
        : (assignment.credential ? [assignment] : []);
    const assignments = orderAssignedCredentials(baseAssignments, settings.accountStrategy || 'sequential');

    for (const candidate of assignments) {
        if (candidate.credentialType !== 'api-key' || !candidate.credential) continue;
        const provider = candidate.credential;

        try {
            const mappedModel = resolveModel(provider.type, requestedModel);
            if (provider.type === 'gemini') {
                const baseUrl = provider.baseUrl || DEFAULT_GEMINI_BASE;
                const url = `${baseUrl}/models/${mappedModel}:${action}?key=${provider.apiKey}`;
                const upstreamRes = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(geminiBody)
                });
                if (!upstreamRes.ok) continue;
                const contentType = upstreamRes.headers.get('content-type') || 'application/json';
                res.writeHead(200, { 'Content-Type': contentType });
                const reader = upstreamRes.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(value);
                }
                res.end();
                return true;
            }

            const response = await _proxyViaConversion(provider, mappedModel, geminiBody);
            if (!response.ok) continue;
            const responseBody = await response.text();
            const parsed = JSON.parse(responseBody);
            if (isStreaming) _sendGeminiSSE(res, parsed); else res.json(parsed);
            return true;
        } catch {
            continue;
        }
    }
    return false;
}

/**
 * Convert Gemini format → Chat Completions, send to provider, convert response back.
 */
async function _proxyViaConversion(provider, model, geminiBody) {
    const chatBody = _geminiToChatBody(geminiBody, model);
    const providerResponse = await provider.sendRequest(chatBody);

    if (!providerResponse.ok) return providerResponse;

    const chatData = await providerResponse.json();
    const geminiResponse = _chatToGeminiResponse(chatData);

    return new Response(JSON.stringify(geminiResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Send Gemini response as SSE (for streamGenerateContent).
 */
function _sendGeminiSSE(res, geminiResponse) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    // Send as a single SSE data chunk (Gemini SSE format)
    res.write(`data: ${JSON.stringify(geminiResponse)}\n\n`);
    res.end();
}

/**
 * Handle GET /v1beta/models — list available models.
 */
async function _handleListModels(req, res) {
    // Return a synthetic model list based on configured providers
    const keyTypes = ['gemini', 'openai', 'anthropic'];

    // Try to get real model list from a Gemini key
    for (const type of keyTypes) {
        if (type !== 'gemini') continue;
        const provider = selectKey(type);
        if (!provider) continue;

        try {
            const baseUrl = provider.baseUrl || DEFAULT_GEMINI_BASE;
            const url = `${baseUrl}/models?key=${provider.apiKey}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                return res.json(data);
            }
        } catch { /* fallthrough */ }
    }

    // Fallback: return minimal model list
    res.json({
        models: [
            { name: 'models/gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
            { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
        ]
    });
}

export default { handleGeminiApiProxy };

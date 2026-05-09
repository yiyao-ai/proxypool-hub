/**
 * Resolve a {type, id} descriptor to a concrete supervisor "candidate" — an
 * object the AssistantLlmClient can send a request through. Replaces the old
 * `selectKey`-based pool selection: the supervisor binds to one specific
 * credential rather than an entire type.
 *
 * Candidate shape:
 *   {
 *     descriptor: { type, id },
 *     kind: 'api-key' | 'claude-account' | 'chatgpt-account',
 *     providerType: 'anthropic' | 'openai' | 'azure-openai',
 *     label: string,
 *     model: string,
 *     send: async (request) => { text, toolCalls, stopReason, usage, raw }
 *   }
 */

import { getProviderById, getAllProviders } from '../api-key-manager.js';
import { getAccount as getChatGptAccount, listAccounts as listChatGptAccounts } from '../account-manager.js';
import { getAccount as getClaudeAccount, listAccounts as listClaudeAccounts } from '../claude-account-manager.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { sendMessageStream } from '../direct-api.js';
import { sendClaudeMessageWithMeta, mapToClaudeModel } from '../claude-api.js';
import { resolveModel } from '../model-mapping.js';

export const DEFAULT_CHATGPT_MODEL = 'gpt-5.4';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

const CREDENTIAL_KIND_BY_TYPE = Object.freeze({
    'api-key': 'api-key',
    'chatgpt-account': 'chatgpt-account',
    'claude-account': 'claude-account'
});

function normalizeAnthropicResponse(response = {}) {
    const content = Array.isArray(response?.content) ? response.content : [];
    const text = content
        .filter((entry) => entry?.type === 'text')
        .map((entry) => entry.text || '')
        .join('\n\n')
        .trim();
    const toolCalls = content
        .filter((entry) => entry?.type === 'tool_use')
        .map((entry) => ({ id: entry.id, name: entry.name, input: entry.input || {} }));
    return {
        text,
        toolCalls,
        stopReason: response?.stop_reason || '',
        usage: response?.usage || null,
        raw: response
    };
}

async function parseJsonResponse(response) {
    if (!response?.ok) {
        const body = await response.text();
        throw new Error(body || `Assistant model request failed with ${response?.status || 500}`);
    }
    return response.json();
}

async function sendChatGptAssistantRequest(request, creds, defaultModel) {
    const content = [];
    let usage = null;
    for await (const event of sendMessageStream({
        ...request,
        model: request.model || defaultModel,
        stream: true
    }, creds.accessToken, creds.accountId)) {
        if (event?.event === 'content_block_delta' && event.data?.delta?.type === 'text_delta') {
            content.push(event.data.delta.text || '');
        }
        if (event?.event === 'message_delta' && event.data?.usage) {
            usage = event.data.usage;
        }
    }
    const text = content.join('').trim();
    return {
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage,
        raw: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model: request.model || defaultModel,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage
        }
    };
}

function buildApiKeyCandidate(provider, defaults) {
    if (!provider) return null;
    const type = provider.type;
    const defaultChatGptModel = defaults.defaultChatGptModel || DEFAULT_CHATGPT_MODEL;
    const defaultClaudeModel = defaults.defaultClaudeModel || DEFAULT_CLAUDE_MODEL;

    if (type === 'anthropic') {
        return {
            kind: 'api-key',
            providerType: 'anthropic',
            label: provider.name,
            model: defaultClaudeModel,
            send: async (request) => normalizeAnthropicResponse(
                await parseJsonResponse(await provider.sendRequest({
                    ...request,
                    model: mapToClaudeModel(request.model || defaultClaudeModel)
                }))
            )
        };
    }

    if (typeof provider.sendAnthropicRequest === 'function') {
        const defaultModel = resolveModel(type, defaultChatGptModel) || defaultChatGptModel;
        return {
            kind: 'api-key',
            providerType: type,
            label: provider.name,
            model: defaultModel,
            send: async (request) => normalizeAnthropicResponse(
                await parseJsonResponse(await provider.sendAnthropicRequest({
                    ...request,
                    model: resolveModel(type, request.model || defaultModel) || request.model || defaultModel
                }))
            )
        };
    }

    return null;
}

function buildClaudeAccountCandidate(account, defaults) {
    if (!account?.accessToken) return null;
    const defaultClaudeModel = defaults.defaultClaudeModel || DEFAULT_CLAUDE_MODEL;
    return {
        kind: 'claude-account',
        providerType: 'anthropic',
        label: account.email || 'claude-account',
        model: defaultClaudeModel,
        send: async (request) => {
            const result = await sendClaudeMessageWithMeta({
                ...request,
                model: mapToClaudeModel(request.model || defaultClaudeModel)
            }, account.accessToken);
            return normalizeAnthropicResponse(result.data);
        }
    };
}

async function buildChatGptAccountCandidate(account, defaults) {
    if (!account?.email) return null;
    const creds = await getCredentialsForAccount(account.email);
    if (!(creds?.accessToken && creds?.accountId)) return null;
    const defaultChatGptModel = defaults.defaultChatGptModel || DEFAULT_CHATGPT_MODEL;
    return {
        kind: 'chatgpt-account',
        providerType: 'openai',
        label: account.email,
        model: defaultChatGptModel,
        send: async (request) => sendChatGptAssistantRequest(request, creds, defaultChatGptModel)
    };
}

/**
 * Resolve a {type, id} descriptor to a working candidate, or null if the
 * credential doesn't exist / isn't enabled / can't produce a send function.
 */
export async function resolveCredential(descriptor, defaults = {}) {
    if (!descriptor || typeof descriptor !== 'object') return null;
    const type = String(descriptor.type || '').trim();
    const id = String(descriptor.id || '').trim();
    const model = typeof descriptor.model === 'string' && descriptor.model.trim()
        ? descriptor.model.trim()
        : '';
    if (!CREDENTIAL_KIND_BY_TYPE[type] || !id) return null;

    if (type === 'api-key') {
        const provider = getProviderById(id);
        if (!provider || provider.enabled === false) return null;
        const candidate = buildApiKeyCandidate(provider, defaults);
        return candidate ? {
            ...candidate,
            model: model || candidate.model,
            descriptor: model ? { type, id, model } : { type, id }
        } : null;
    }

    if (type === 'claude-account') {
        const account = getClaudeAccount(id);
        if (!account || account.enabled === false) return null;
        const candidate = buildClaudeAccountCandidate(account, defaults);
        return candidate ? {
            ...candidate,
            model: model || candidate.model,
            descriptor: model ? { type, id, model } : { type, id }
        } : null;
    }

    if (type === 'chatgpt-account') {
        const account = getChatGptAccount(id);
        if (!account || account.enabled === false) return null;
        const candidate = await buildChatGptAccountCandidate(account, defaults);
        return candidate ? {
            ...candidate,
            model: model || candidate.model,
            descriptor: model ? { type, id, model } : { type, id }
        } : null;
    }

    return null;
}

/**
 * Inventory of every {type, id} pair the user could bind to, with light
 * availability metadata. Drives the supervisor settings dropdown.
 */
export function listAvailableCredentials() {
    const result = {
        apiKeys: {},
        claudeAccounts: [],
        chatgptAccounts: []
    };

    const providers = getAllProviders()
        .filter((provider) => provider && provider.enabled !== false)
        .filter((provider) => provider.type === 'anthropic' || typeof provider.sendAnthropicRequest === 'function');
    for (const provider of providers) {
        const supportedType = String(provider.type || '').trim();
        if (!supportedType) continue;
        if (!Array.isArray(result.apiKeys[supportedType])) {
            result.apiKeys[supportedType] = [];
        }
        result.apiKeys[supportedType].push({
            type: 'api-key',
            id: provider.id,
            providerType: supportedType,
            label: provider.name,
            available: provider.isAvailable !== false,
            detail: provider.rateLimitedUntil && provider.rateLimitedUntil > Date.now()
                ? 'rate-limited'
                : ''
        });
    }

    const claudeSnapshot = listClaudeAccounts();
    const claudeAccounts = Array.isArray(claudeSnapshot?.accounts) ? claudeSnapshot.accounts : [];
    for (const account of claudeAccounts) {
        if (!account || account.enabled === false) continue;
        result.claudeAccounts.push({
            type: 'claude-account',
            id: account.email,
            providerType: 'anthropic',
            label: account.email,
            available: !!account.accessToken,
            detail: account.accessToken ? '' : 'no access token'
        });
    }

    const chatSnapshot = listChatGptAccounts();
    const chatAccounts = Array.isArray(chatSnapshot?.accounts) ? chatSnapshot.accounts : [];
    for (const account of chatAccounts) {
        if (!account || account.enabled === false) continue;
        result.chatgptAccounts.push({
            type: 'chatgpt-account',
            id: account.email,
            providerType: 'openai',
            label: account.email,
            available: true,
            detail: ''
        });
    }

    return result;
}

/**
 * Test whether a descriptor currently resolves to a working candidate without
 * actually sending an LLM message. Used by `POST /test-binding` to give the
 * UI fast "yes/no, is this configured right?" feedback.
 */
export async function describeBinding(descriptor) {
    if (!descriptor) return { ok: false, reason: 'no descriptor' };
    const candidate = await resolveCredential(descriptor);
    if (!candidate) {
        return { ok: false, reason: 'credential not found or disabled', descriptor };
    }
    return {
        ok: true,
        descriptor: candidate.descriptor,
        kind: candidate.kind,
        providerType: candidate.providerType,
        label: candidate.label,
        model: candidate.model
    };
}

export default {
    resolveCredential,
    listAvailableCredentials,
    describeBinding,
    DEFAULT_CHATGPT_MODEL,
    DEFAULT_CLAUDE_MODEL
};

/**
 * Azure OpenAI Provider
 * Forwards requests to Azure OpenAI Service endpoints.
 * Also supports Anthropic Messages API passthrough via format conversion.
 *
 * Required config:
 *   - apiKey:          Azure API key
 *   - baseUrl:         Resource endpoint, e.g. https://my-resource.openai.azure.com
 *   - deploymentName:  The deployment name created in Azure portal
 *   - apiVersion:      API version, e.g. 2024-10-21
 */

import { BaseProvider } from './base.js';
import { hasHostedAnthropicTools, listHostedAnthropicTools } from '../translators/normalizers/tools.js';
import { translateAnthropicToOpenAIResponsesRequest } from '../translators/request/anthropic-to-openai-responses.js';
import { convertOutputToAnthropic, generateMessageId } from '../translators/response/openai-responses-to-anthropic.js';
import { logger } from '../utils/logger.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';
import { normalizeJsonSchema } from '../json-schema-normalizer.js';

const DEFAULT_API_VERSION = '2024-10-21';
const AZURE_NETWORK_RETRY_ATTEMPTS = 2;
const AZURE_NETWORK_RETRY_DELAY_MS = 250;

function sanitizeAnthropicToolSchemaForAzureResponses(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }

    if (
        !Array.isArray(schema.anyOf) &&
        !Array.isArray(schema.oneOf) &&
        !Array.isArray(schema.allOf) &&
        typeof schema.$ref !== 'string'
    ) {
        return stripAzureSchemaMetadata(schema);
    }

    return normalizeJsonSchema(schema);
}

function stripAzureSchemaMetadata(schema) {
    if (Array.isArray(schema)) {
        return schema.map(item => stripAzureSchemaMetadata(item));
    }

    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const result = {};
    for (const [key, value] of Object.entries(schema)) {
        if (['$schema', '$id', '$defs', '$comment', 'definitions', 'examples'].includes(key)) {
            continue;
        }
        if (key === 'const') {
            result.enum = [value];
            continue;
        }
        result[key] = stripAzureSchemaMetadata(value);
    }

    return result;
}

function convertAnthropicToolsForAzureResponses(tools) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return [];
    }

    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: sanitizeAnthropicToolSchemaForAzureResponses(
            tool.input_schema || { type: 'object', properties: {} }
        )
    }));
}

function sanitizeResponsesPayloadForAzure(value, parentKey = '', stats = { encryptedFieldsRemoved: 0, compactionItemsRemoved: 0, includeEntriesRemoved: 0, signatureFieldsRemoved: 0 }) {
    if (Array.isArray(value)) {
        const items = value
            .map(item => sanitizeResponsesPayloadForAzure(item, parentKey, stats))
            .filter(item => item !== undefined);

        if (parentKey === 'include') {
            return items.filter(item => {
                const shouldKeep = item !== 'reasoning.encrypted_content' && item !== 'encrypted_content';
                if (!shouldKeep) stats.includeEntriesRemoved++;
                return shouldKeep;
            });
        }

        return items;
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    if (value.type === 'compaction') {
        stats.compactionItemsRemoved++;
        return undefined;
    }

    const result = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === 'encrypted_content') {
            stats.encryptedFieldsRemoved++;
            continue;
        }
        if (key === 'signature' || key === 'thoughtSignature') {
            stats.signatureFieldsRemoved++;
            continue;
        }

        const sanitized = sanitizeResponsesPayloadForAzure(child, key, stats);
        if (sanitized !== undefined) {
            result[key] = sanitized;
        }
    }

    if (result.type === 'reasoning') {
        const hasUsableReasoningContent = (
            (Array.isArray(result.summary) && result.summary.length > 0) ||
            (typeof result.summary === 'string' && result.summary.length > 0) ||
            (typeof result.text === 'string' && result.text.length > 0)
        );
        if (!hasUsableReasoningContent) {
            return undefined;
        }
    }

    return result;
}

function summarizeAnthropicVisionPayload(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    let imageBlocks = 0;
    let base64Images = 0;
    let urlImages = 0;

    for (const message of messages) {
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const block of content) {
            if (block?.type !== 'image') continue;
            imageBlocks++;
            if (block?.source?.type === 'base64' && block.source.data) base64Images++;
            if (block?.source?.type === 'url' && block.source.url) urlImages++;
        }
    }

    return { imageBlocks, base64Images, urlImages, messageCount: messages.length };
}

function normalizeFunctionCallOutputForAzure(item) {
    if (item?.type !== 'function_call_output') {
        return item;
    }

    if (!Array.isArray(item.output)) {
        return item;
    }

    return {
        ...item,
        output: item.output.map(part => {
            if (part?.type !== 'input_image') {
                return part;
            }

            if (part.image_url) {
                return {
                    type: 'input_image',
                    image_url: typeof part.image_url === 'string'
                        ? part.image_url
                        : part.image_url?.url || ''
                };
            }

            if (part.data) {
                return {
                    type: 'input_image',
                    image_url: `data:${part.media_type || 'image/jpeg'};base64,${part.data}`
                };
            }

            return part;
        })
    };
}

function normalizeInputImagePartForAzure(part) {
    if (part?.type !== 'input_image') {
        return part;
    }

    if (part.image_url) {
        return {
            type: 'input_image',
            image_url: typeof part.image_url === 'string'
                ? part.image_url
                : part.image_url?.url || ''
        };
    }

    if (part.data) {
        return {
            type: 'input_image',
            image_url: `data:${part.media_type || 'image/jpeg'};base64,${part.data}`
        };
    }

    return part;
}

function normalizeResponsesPayloadForAzure(body) {
    const normalizedBody = { ...body };
    if (
        Number.isFinite(normalizedBody.max_completion_tokens)
        && normalizedBody.max_output_tokens === undefined
    ) {
        normalizedBody.max_output_tokens = normalizedBody.max_completion_tokens;
        delete normalizedBody.max_completion_tokens;
    }

    if (normalizedBody.reasoning?.effort === 'auto') {
        normalizedBody.reasoning = {
            ...normalizedBody.reasoning,
            effort: 'medium'
        };
    }

    if (!Array.isArray(normalizedBody?.input)) {
        return normalizedBody;
    }

    return {
        ...normalizedBody,
        input: normalizedBody.input.map(item => {
            if (item?.type === 'message' && Array.isArray(item.content)) {
                return {
                    ...item,
                    content: item.content.map(part => normalizeInputImagePartForAzure(part))
                };
            }
            return normalizeFunctionCallOutputForAzure(item);
        })
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function collectErrorMessages(error) {
    const messages = [];
    const queue = [error];
    const seen = new Set();

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);

        if (typeof current.message === 'string' && current.message.length > 0) {
            messages.push(current.message);
        }
        if (typeof current.code === 'string' && current.code.length > 0) {
            messages.push(current.code);
        }
        if (current.cause && typeof current.cause === 'object') {
            queue.push(current.cause);
        }
    }

    return messages.map(msg => msg.toLowerCase());
}

function isRetryableAzureNetworkError(error) {
    const haystack = collectErrorMessages(error).join(' | ');
    return [
        'other side closed',
        'socket hang up',
        'fetch failed',
        'econnreset',
        'etimedout',
        'eai_again',
        'enotfound',
        'und_err_socket',
        'und_err_connect_timeout',
        'connect timeout',
        'headers timeout',
        'body timeout'
    ].some(pattern => haystack.includes(pattern));
}

export class AzureOpenAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'azure-openai',
            baseUrl: config.baseUrl || ''
        });
        this.deploymentName = config.deploymentName || '';
        this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
    }

    /**
     * Build the chat completions URL.
     * Format: https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}
     */
    _buildChatUrl() {
        const base = this.baseUrl.replace(/\/+$/, '');
        return `${base}/openai/deployments/${this.deploymentName}/chat/completions?api-version=${this.apiVersion}`;
    }

    _isCognitiveServicesEndpoint() {
        return this.baseUrl.includes('cognitiveservices.azure.com');
    }

    _buildResponsesUrl() {
        const base = this.baseUrl.replace(/\/+$/, '');
        if (this._isCognitiveServicesEndpoint()) {
            // cognitiveservices.azure.com 端点不支持 /v1/ 路径，需要显式传递 api-version
            return `${base}/openai/responses?api-version=${this.apiVersion}`;
        }
        // openai.azure.com 使用 /v1/ 统一端点，无需 api-version
        return `${base}/openai/v1/responses`;
    }

    _buildErrorMessage(operation, error) {
        const parts = [
            `Azure OpenAI ${operation} request failed`
        ];
        if (error?.cause?.message && error.cause.message !== error.message) {
            parts.push(error.cause.message);
        } else if (error?.message) {
            parts.push(error.message);
        }
        return parts.join(': ');
    }

    async _fetchWithRetry(operation, url, options) {
        let lastError;

        for (let attempt = 1; attempt <= AZURE_NETWORK_RETRY_ATTEMPTS; attempt++) {
            try {
                return await fetch(url, options);
            } catch (error) {
                lastError = error;
                const retryable = isRetryableAzureNetworkError(error);
                const hasNextAttempt = attempt < AZURE_NETWORK_RETRY_ATTEMPTS;
                if (!retryable || !hasNextAttempt) {
                    break;
                }

                logger.warn(`[Azure OpenAI] Retrying ${operation} after transient network error (attempt ${attempt + 1}/${AZURE_NETWORK_RETRY_ATTEMPTS}): ${error?.cause?.code || error?.code || error?.cause?.message || error?.message}`);
                await sleep(AZURE_NETWORK_RETRY_DELAY_MS * attempt);
            }
        }

        throw new Error(this._buildErrorMessage(operation, lastError), { cause: lastError });
    }

    async sendRequest(body) {
        const url = this._buildChatUrl();
        return this._fetchWithRetry('chat completions', url, {
            method: 'POST',
            headers: {
                'api-key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
    }

    async sendResponsesRequest(body) {
        const url = this._buildResponsesUrl();
        const sanitizeStats = { encryptedFieldsRemoved: 0, compactionItemsRemoved: 0, includeEntriesRemoved: 0, signatureFieldsRemoved: 0 };
        const responsesBody = {
            ...sanitizeResponsesPayloadForAzure(body, '', sanitizeStats),
            model: this.deploymentName || body.model
        };
        if (sanitizeStats.encryptedFieldsRemoved || sanitizeStats.compactionItemsRemoved || sanitizeStats.includeEntriesRemoved || sanitizeStats.signatureFieldsRemoved) {
            logger.info(`[Azure OpenAI] Sanitized responses payload | encrypted_fields=${sanitizeStats.encryptedFieldsRemoved} | signature_fields=${sanitizeStats.signatureFieldsRemoved} | compaction_items=${sanitizeStats.compactionItemsRemoved} | include_entries=${sanitizeStats.includeEntriesRemoved}`);
        }
        return this._fetchWithRetry('responses', url, {
            method: 'POST',
            headers: {
                'api-key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(responsesBody)
        });
    }

    async validateKey() {
        try {
            const url = this._buildChatUrl();
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            });
            // 200 or 400 means key & deployment are valid; 401/403 means auth failed
            return response.status !== 401 && response.status !== 403;
        } catch {
            return false;
        }
    }

    async listModels() {
        try {
            const base = this.baseUrl.replace(/\/+$/, '');
            const url = `${base}/openai/models?api-version=${this.apiVersion}`;
            const response = await fetch(url, {
                headers: { 'api-key': this.apiKey }
            });
            if (!response.ok) return [];
            const data = await response.json();
            return (data.data || []).map(m => ({
                id: m.id,
                name: m.id
            }));
        } catch {
            return [];
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens) ||
            estimateCostWithRegistry(this.type, this.deploymentName, inputTokens, outputTokens);
    }

    toJSON() {
        return {
            ...super.toJSON(),
            deploymentName: this.deploymentName,
            apiVersion: this.apiVersion
        };
    }

    // ─── Anthropic Messages API passthrough (for /v1/messages endpoint) ──────

    /**
     * Accept an Anthropic Messages API body, convert to OpenAI Responses API,
     * send to Azure OpenAI, and return response in Anthropic Messages format.
     *
     * Keep this path non-streaming and let /v1/messages wrap the JSON response
     * into Anthropic SSE when needed. This isolates the fix to Azure's
     * Anthropic-compatible path without affecting Codex native responses flow.
     */
    async sendAnthropicRequest(body) {
        if (hasHostedAnthropicTools(body.tools)) {
            const hosted = listHostedAnthropicTools(body.tools).map(tool => tool.name || tool.hostedType).join(',');
            return new Response(JSON.stringify({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: `Hosted Anthropic tools are not supported by the Azure OpenAI Responses bridge. Requested: ${hosted}. Use an Anthropic provider or Vertex Claude rawPredict instead.`
                }
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const visionStats = summarizeAnthropicVisionPayload(body);
        const responsesBody = normalizeResponsesPayloadForAzure(
            translateAnthropicToOpenAIResponsesRequest(body, { stream: false })
        );
        const responseInputImages = Array.isArray(responsesBody.input)
            ? responsesBody.input.reduce((count, item) => {
                if (item?.type === 'message') {
                    const content = Array.isArray(item.content) ? item.content : [];
                    return count + content.filter(part => part?.type === 'input_image').length;
                }
                if (item?.type === 'function_call_output') {
                    const output = Array.isArray(item.output) ? item.output : [];
                    return count + output.filter(part => part?.type === 'input_image').length;
                }
                return count;
            }, 0)
            : 0;
        if (visionStats.imageBlocks > 0 || responseInputImages > 0) {
            logger.info(`[Azure OpenAI] Anthropic multimodal bridge | messages=${visionStats.messageCount} | anthropic_images=${visionStats.imageBlocks} | base64=${visionStats.base64Images} | url=${visionStats.urlImages} | responses_input_images=${responseInputImages}`);
        }
        if (Array.isArray(body.tools) && body.tools.length > 0) {
            responsesBody.tools = convertAnthropicToolsForAzureResponses(body.tools);
        }
        const response = await this.sendResponsesRequest({
            ...responsesBody,
            stream: false
        });

        if (!response.ok) return response;

        const data = await response.json();
        const content = convertOutputToAnthropic(data.output);
        const stopReason = data.status === 'incomplete'
            ? 'max_tokens'
            : content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
        const anthropicResponse = {
            id: generateMessageId(),
            type: 'message',
            role: 'assistant',
            content,
            model: body.model || data.model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: data.usage?.input_tokens || 0,
                output_tokens: data.usage?.output_tokens || 0,
                cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0
            }
        };

        return new Response(JSON.stringify(anthropicResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static get pricing() {
        return getDefaultPricing('azure-openai');
    }
}

export default AzureOpenAIProvider;

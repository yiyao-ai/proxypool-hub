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
import { convertAnthropicToResponsesAPI, convertOutputToAnthropic, generateMessageId } from '../format-converter.js';
import { logger } from '../utils/logger.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';

const DEFAULT_API_VERSION = '2024-10-21';

function sanitizeAnthropicToolSchemaForAzureResponses(schema) {
    if (Array.isArray(schema)) {
        return schema.map(item => sanitizeAnthropicToolSchemaForAzureResponses(item));
    }

    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const result = {};
    for (const [key, value] of Object.entries(schema)) {
        if (['$schema', '$id', '$ref', '$defs', '$comment', 'definitions', 'examples'].includes(key)) {
            continue;
        }

        if (key === 'const') {
            result.enum = [value];
            continue;
        }

        result[key] = sanitizeAnthropicToolSchemaForAzureResponses(value);
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

    _buildResponsesUrl() {
        const base = this.baseUrl.replace(/\/+$/, '');
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

    async sendRequest(body) {
        try {
            const url = this._buildChatUrl();
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            return response;
        } catch (error) {
            throw new Error(this._buildErrorMessage('chat completions', error), { cause: error });
        }
    }

    async sendResponsesRequest(body) {
        try {
            const url = this._buildResponsesUrl();
            const sanitizeStats = { encryptedFieldsRemoved: 0, compactionItemsRemoved: 0, includeEntriesRemoved: 0, signatureFieldsRemoved: 0 };
            const responsesBody = {
                ...sanitizeResponsesPayloadForAzure(body, '', sanitizeStats),
                model: this.deploymentName || body.model
            };
            if (sanitizeStats.encryptedFieldsRemoved || sanitizeStats.compactionItemsRemoved || sanitizeStats.includeEntriesRemoved || sanitizeStats.signatureFieldsRemoved) {
                logger.info(`[Azure OpenAI] Sanitized responses payload | encrypted_fields=${sanitizeStats.encryptedFieldsRemoved} | signature_fields=${sanitizeStats.signatureFieldsRemoved} | compaction_items=${sanitizeStats.compactionItemsRemoved} | include_entries=${sanitizeStats.includeEntriesRemoved}`);
            }
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(responsesBody)
            });
            return response;
        } catch (error) {
            throw new Error(this._buildErrorMessage('responses', error), { cause: error });
        }
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
        const responsesBody = convertAnthropicToResponsesAPI({
            ...body,
            stream: false
        });
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

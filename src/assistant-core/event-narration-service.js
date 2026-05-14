import assistantLlmClient, { AssistantLlmClient } from '../assistant-agent/llm-client.js';
import { getAssistantControlMode } from './assistant-state.js';

function truncate(value, limit = 800) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;
}

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'runtime');
}

function buildEventSummary({ conversation, session, event }) {
  return {
    controlMode: getAssistantControlMode(conversation),
    conversationId: conversation?.id || '',
    conversationTitle: conversation?.title || '',
    activeRuntimeSessionId: conversation?.activeRuntimeSessionId || '',
    activeTaskId: conversation?.activeTaskId || conversation?.metadata?.supervisor?.taskMemory?.activeTaskId || '',
    provider: providerLabel(session?.provider || event?.payload?.provider || ''),
    sessionId: session?.id || event?.sessionId || '',
    sessionTitle: session?.title || '',
    sessionStatus: session?.status || '',
    eventType: event?.type || '',
    eventPayload: event?.payload || {},
    supervisorBrief: conversation?.metadata?.supervisor?.brief || null,
    pendingApprovalId: conversation?.lastPendingApprovalId || '',
    pendingApprovalSessionId: conversation?.lastPendingApprovalSessionId || '',
    pendingQuestionId: conversation?.lastPendingQuestionId || '',
    pendingQuestionSessionId: conversation?.lastPendingQuestionSessionId || ''
  };
}

function buildSystemPrompt(language = 'en') {
  if (language === 'zh-CN') {
    return [
      '你是 CliGate Assistant。',
      '你正在 assistant mode 下代表用户与 runtime 协作。',
      '你的职责是把 runtime 事件整理成一句或一小段自然、准确、克制的用户可见回复。',
      '不要暴露内部实现，不要说“事件”“payload”“系统”。',
      '如果这是需要批准、需要回答、失败、或当前主线任务完成，直接用协作者口吻告诉用户。',
      '不要编造事实，不要添加未提供的结果。',
      '默认简洁，不要超过 4 句。'
    ].join(' ');
  }

  return [
    'You are CliGate Assistant.',
    'You are speaking in assistant mode on behalf of the user-facing assistant.',
    'Convert runtime facts into a natural, accurate, restrained user-visible reply.',
    'Do not expose internal implementation details such as events, payloads, or system internals.',
    'If this is an approval request, a question, a failure, or the completion of the current task, speak like a practical collaborator.',
    'Do not invent facts or outcomes.',
    'Keep the reply concise and under four sentences.'
  ].join(' ');
}

function buildUserPrompt({ summary, language = 'en' } = {}) {
  if (language === 'zh-CN') {
    return [
      '请根据下面的 runtime 事实，生成一条 assistant 给用户的话。',
      '要求：',
      '1. 保持自然、简洁、像协作者；',
      '2. 如果需要用户行动，要明确说出下一步；',
      '3. 如果不该打断用户，就输出空字符串。',
      '',
      truncate(JSON.stringify(summary, null, 2), 3000)
    ].join('\n');
  }

  return [
    'Given the runtime facts below, produce one assistant message for the user.',
    'Requirements:',
    '1. Natural, concise, collaborator-like tone;',
    '2. If user action is needed, make the next step explicit;',
    '3. If the event should stay silent, output an empty string.',
    '',
    truncate(JSON.stringify(summary, null, 2), 3000)
  ].join('\n');
}

export class AssistantEventNarrationService {
  constructor({
    llmClient = assistantLlmClient
  } = {}) {
    this.llmClient = llmClient instanceof AssistantLlmClient
      ? llmClient
      : llmClient;
  }

  async narrate({ conversation, session, event, fallbackMessage = '' } = {}) {
    const language = /[\u3400-\u9fff]/.test(String(conversation?.title || fallbackMessage || ''))
      ? 'zh-CN'
      : 'en';
    const summary = buildEventSummary({ conversation, session, event });

    try {
      const hasSource = await this.llmClient?.hasAvailableSource?.();
      if (!hasSource) {
        return {
          message: fallbackMessage,
          mode: 'fallback',
          reason: this.llmClient?.getFallbackReason?.() || 'no_available_llm_source'
        };
      }

      const completion = await this.llmClient.complete({
        system: buildSystemPrompt(language),
        messages: [{
          role: 'user',
          content: buildUserPrompt({ summary, language })
        }],
        tools: [],
        maxTokens: 280
      });
      const message = String(completion?.text || '').trim();
      return {
        message: message || fallbackMessage,
        mode: message ? 'llm' : 'fallback',
        source: completion?.source || null,
        reason: message ? '' : 'empty_llm_narration'
      };
    } catch (error) {
      return {
        message: fallbackMessage,
        mode: 'fallback',
        reason: error?.message || 'event_narration_failed'
      };
    }
  }
}

export const assistantEventNarrationService = new AssistantEventNarrationService();

export default assistantEventNarrationService;

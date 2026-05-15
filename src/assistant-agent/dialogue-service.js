import AssistantRunner from '../assistant-core/runner.js';
import createDefaultAssistantToolRegistry from '../assistant-core/tool-registry.js';
import AssistantToolExecutor from '../assistant-core/tool-executor.js';
import assistantTaskViewService from '../assistant-core/task-view-service.js';
import assistantObservationService from '../assistant-core/observation-service.js';
import assistantLlmClient, { AssistantLlmClient } from './llm-client.js';
import AssistantReactEngine from './react-engine.js';
import { resolveReferenceContext } from './reference-resolver.js';
import { filterMainContextDeliveries } from './prompt-builder.js';

// CliGate Assistant mainline dialogue path.
// When available, /cligate should prefer this agent path; runner fallback is only a safety rail.

export class AssistantDialogueService {
  constructor({
    runStore,
    observationService = assistantObservationService,
    taskViewService = assistantTaskViewService,
    toolRegistry = null,
    toolExecutor = null,
    llmClient = assistantLlmClient,
    fallbackRunner = null,
    messageService = null
  } = {}) {
    this.runStore = runStore;
    this.observationService = observationService;
    this.taskViewService = taskViewService;
    this.toolRegistry = toolRegistry || createDefaultAssistantToolRegistry({
      observationService: this.observationService,
      messageService,
      taskViewService: this.taskViewService
    });
    this.toolExecutor = toolExecutor || new AssistantToolExecutor({
      toolRegistry: this.toolRegistry
    });
    this.llmClient = llmClient instanceof AssistantLlmClient
      ? llmClient
      : llmClient;
    this.reactEngine = new AssistantReactEngine({
      llmClient: this.llmClient,
      toolRegistry: this.toolRegistry,
      toolExecutor: this.toolExecutor
    });
    this.fallbackRunner = fallbackRunner || new AssistantRunner({
      runStore,
      observationService: this.observationService,
      messageService,
      taskViewService: this.taskViewService
    });
  }

  buildRecentIntentTimeline({ conversationContext = null, taskSpace = null } = {}) {
    // Filter out scheduled-task notifications so the supervisor LLM does
    // not treat those pings as part of the user's recent intent.
    const deliveries = filterMainContextDeliveries(conversationContext?.deliveries);
    const workspaceContext = this.observationService.getWorkspaceContext({
      runtimeLimit: 4,
      conversationLimit: 4
    });
    return deliveries
      .filter((entry) => String(entry?.direction || '').trim() === 'inbound')
      .slice(0, 8)
      .reverse()
      .map((entry) => {
        const userText = String(entry?.payload?.text || entry?.payload?.content || '').trim();
        const resolution = resolveReferenceContext({
          text: userText,
          taskSpace,
          workspaceContext,
          conversationContext
        });
        return {
          ts: entry?.createdAt || '',
          userText,
          action: resolution?.intent || 'user_message',
          resolvedTargetTaskId: String(resolution?.summary?.preferredTaskId || '').trim(),
          resolvedTargetCwd: String(resolution?.summary?.preferredWorkspaceRef || '').trim(),
          referenceConfidence: String(resolution?.summary?.confidence || '').trim(),
          resolutionAction: String(resolution?.summary?.recommendedAction || '').trim(),
          shouldAskUser: resolution?.summary?.shouldAskUser === true
        };
      });
  }

  // Synthesize a user-facing reply from raw runtime/codex output.
  // Called after delegated runtime sessions reach a terminal status — instead
  // of forwarding the codex transcript verbatim, the supervisor LLM rewrites
  // it into a coherent reply tied to the user's original question. Returns
  // null on any failure so the caller can fall back to the static aggregator.
  async synthesizeRuntimeReply({
    runText = '',
    sessions = [],
    language = null,
    model = ''
  } = {}) {
    const userText = String(runText || '').trim();
    const runtimeSessions = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
    if (!userText || runtimeSessions.length === 0) {
      return null;
    }

    const hasSource = await this.llmClient?.hasAvailableSource?.();
    if (!hasSource) {
      return null;
    }

    const lang = String(language || (/[㐀-鿿]/.test(userText) ? 'zh-CN' : 'en')).trim();
    const isZh = lang === 'zh-CN';

    const blocks = runtimeSessions.map((session, index) => {
      const label = session?.provider === 'claude-code'
        ? 'Claude Code'
        : (session?.provider === 'codex' ? 'Codex' : String(session?.provider || 'runtime'));
      const status = String(session?.status || '').trim();
      const result = String(session?.result || '').trim();
      const summary = String(session?.summary || '').trim();
      const error = String(session?.error || '').trim();
      const body = result || summary || error || (isZh ? '（无内容）' : '(no content)');
      return [
        `### ${index + 1}. ${label} (status: ${status || 'unknown'})`,
        body
      ].join('\n');
    }).join('\n\n');

    const systemPrompt = isZh
      ? [
          '你是 CliGate Assistant 的回复整理器。',
          '用户刚才发起了一个请求，下游 runtime（Codex 或 Claude Code）已经返回了原始结果。',
          '你的任务是把原始结果整理成给用户的最终回复，让用户感觉是助手在与他对话，而不是直接把 runtime 的输出转发过去。',
          '原则：',
          '1. 紧扣用户问题，不要展开无关内容。',
          '2. 把 runtime 已经有的信息按用户问题的结构组织清楚。',
          '3. 不要编造 runtime 没给出的数据。如果某项不确定，按 runtime 的说法明确告知。',
          '4. 不要暴露内部实现（Codex/Claude Code、session id、tool 名等）。',
          '5. 用自然中文，不要列出 Markdown 标题；可以用短列表或简洁段落。',
          '6. 如果 runtime 报错或没有给出有用内容，告诉用户失败原因，并建议下一步。',
          '7. 直接输出最终回复正文，不要再前置"好的"、"以下是"这类客套话。'
        ].join('\n')
      : [
          'You are the CliGate Assistant reply composer.',
          'The user just made a request and the downstream runtime (Codex or Claude Code) returned raw results.',
          'Rewrite the raw output into a final reply for the user so it feels like a conversational answer, not a forwarded transcript.',
          'Rules:',
          '1. Stay tightly focused on the user question.',
          '2. Organize the runtime\'s information to match the question\'s structure.',
          '3. Never invent data the runtime did not provide. When the runtime is uncertain, mirror that uncertainty.',
          '4. Do not reveal internal mechanics (runtime names, session ids, tools).',
          '5. Use natural prose. Short bullets are fine, but no big Markdown headings.',
          '6. If the runtime failed or returned nothing useful, explain that to the user and suggest a next step.',
          '7. Output the final reply directly — no "Sure, here is..." preamble.'
        ].join('\n');

    const userPayload = [
      isZh ? '【用户原始请求】' : '[User original request]',
      userText,
      '',
      isZh ? '【Runtime 返回的原始结果】' : '[Raw runtime results]',
      blocks,
      '',
      isZh ? '请直接输出给用户的最终回复。' : 'Now output the final reply to the user.'
    ].join('\n');

    try {
      const completion = await this.llmClient.complete({
        system: systemPrompt,
        messages: [
          { role: 'user', content: [{ type: 'text', text: userPayload }] }
        ],
        tools: [],
        model,
        maxTokens: 1500
      });
      const text = String(completion?.text || '').trim();
      return text || null;
    } catch {
      return null;
    }
  }

  async run({ run, conversation, text, defaultRuntimeProvider = 'codex', cwd = '', model = '' } = {}) {
    const hasSource = await this.llmClient?.hasAvailableSource?.();
    if (!hasSource) {
      const fallbackReason = this.llmClient?.getFallbackReason?.() || 'no_available_llm_source';
      const fallbackRun = this.runStore.save({
        ...run,
        metadata: {
          ...(run.metadata || {}),
          assistantAgent: {
            mode: 'fallback',
            reason: fallbackReason
          }
        }
      });
      return this.fallbackRunner.run({
        run: fallbackRun,
        conversation,
        text,
        defaultRuntimeProvider,
        cwd,
        model
      });
    }

    const taskRecord = conversation?.id
      ? this.taskViewService.listTasks({
          conversationId: conversation.id,
          limit: 1
        })[0] || null
      : null;
    const taskSpace = conversation?.id
      ? this.taskViewService.getConversationTaskSpace(conversation.id, {
          activeLimit: 5,
          waitingLimit: 5,
          recentLimit: 5
        })
      : null;
    const conversationContext = conversation?.id
      ? this.observationService.getConversationContext(conversation.id, {
          deliveryLimit: 8
      })
      : null;
    const workspaceContext = this.observationService.getWorkspaceContext({
      runtimeLimit: 6,
      conversationLimit: 6
    });
    const referenceResolution = resolveReferenceContext({
      text,
      taskSpace,
      workspaceContext,
      conversationContext
    });
    const recentIntentTimeline = this.buildRecentIntentTimeline({
      conversationContext,
      taskSpace
    });

    try {
      const executed = await this.reactEngine.run({
        run,
        conversation,
        text,
        taskRecord,
        taskSpace,
        conversationContext,
        workspaceContext,
        referenceResolution,
        recentIntentTimeline,
        defaultRuntimeProvider,
        cwd,
        model
      });
      return {
        ...executed,
        run: this.runStore.save(executed.run)
      };
    } catch (error) {
      const fallbackRun = this.runStore.save({
        ...run,
        metadata: {
          ...(run.metadata || {}),
          assistantAgent: {
            mode: 'fallback',
            reason: error?.message || 'assistant_agent_react_failed'
          }
        }
      });
      return this.fallbackRunner.run({
        run: fallbackRun,
        conversation,
        text,
        defaultRuntimeProvider,
        cwd,
        model
      });
    }
  }
}

export default AssistantDialogueService;

import AssistantRunner from '../assistant-core/runner.js';
import createDefaultAssistantToolRegistry from '../assistant-core/tool-registry.js';
import AssistantToolExecutor from '../assistant-core/tool-executor.js';
import assistantTaskViewService from '../assistant-core/task-view-service.js';
import assistantObservationService from '../assistant-core/observation-service.js';
import assistantLlmClient, { AssistantLlmClient } from './llm-client.js';
import AssistantReactEngine from './react-engine.js';
import { resolveReferenceContext } from './reference-resolver.js';

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
    const deliveries = Array.isArray(conversationContext?.deliveries)
      ? conversationContext.deliveries
      : [];
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

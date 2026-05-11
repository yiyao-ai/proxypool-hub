import assistantSessionStore, { AssistantSessionStore } from './session-store.js';
import assistantRunStore, { AssistantRunStore } from './run-store.js';
import { ASSISTANT_RUN_STATUS } from './models.js';
import assistantObservationService, { AssistantObservationService } from './observation-service.js';
import assistantApprovalGovernor, { AssistantApprovalGovernor } from './approval-governor.js';
import assistantEventNarrationService, { AssistantEventNarrationService } from './event-narration-service.js';

function nowIso() {
  return new Date().toISOString();
}

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'runtime');
}

function toText(value) {
  return String(value || '').trim();
}

function isAssistantModeConversation(conversation = null) {
  return String(conversation?.metadata?.assistantCore?.controlMode || conversation?.metadata?.assistantCore?.mode || '').trim() === 'assistant';
}

function isCurrentConversationTask(conversation = null, sessionId = '') {
  const normalized = toText(sessionId);
  if (!normalized) return false;
  const activeRuntimeSessionId = toText(conversation?.activeRuntimeSessionId);
  if (activeRuntimeSessionId && activeRuntimeSessionId === normalized) {
    return true;
  }
  const currentTask = conversation?.metadata?.supervisor?.taskMemory?.currentTask
    || conversation?.metadata?.supervisor?.taskMemory?.current
    || null;
  return toText(currentTask?.sessionId) === normalized;
}

function buildEventMessage({ conversation, session, event }) {
  const zh = /[\u3400-\u9fff]/.test(String(conversation?.title || ''));
  const label = providerLabel(session?.provider || event?.payload?.provider);
  const title = toText(event?.payload?.title || session?.title);
  const taskLabel = title || (zh ? '当前任务' : 'the current task');
  const payload = event?.payload || {};

  switch (String(event?.type || '')) {
    case 'worker.approval_request':
      return zh
        ? `${label} 正在执行“${taskLabel}”，需要你的确认后才能继续。\n\n请求：${toText(payload.title || payload.summary) || '需要权限'}`
        : `${label} needs your approval before it can continue "${taskLabel}".\n\nRequest: ${toText(payload.title || payload.summary) || 'Permission required'}`;
    case 'worker.question':
      return zh
        ? `${label} 在执行“${taskLabel}”时需要你回答一个问题：\n\n${toText(payload.text) || '请继续提供输入。'}`
        : `${label} needs your input while working on "${taskLabel}":\n\n${toText(payload.text) || 'More input is required.'}`;
    case 'worker.failed':
      return zh
        ? `${label} 执行“${taskLabel}”时失败了。\n\n${toText(payload.message || session?.error) || '请查看任务状态并决定下一步。'}`
        : `${label} failed while working on "${taskLabel}".\n\n${toText(payload.message || session?.error) || 'Check the task state before deciding the next step.'}`;
    case 'worker.completed':
      return zh
        ? `你当前关注的任务“${taskLabel}”已经完成。\n\n结果：${toText(payload.result || payload.summary || session?.summary) || '任务已结束。'}`
        : `Your current task "${taskLabel}" has completed.\n\nResult: ${toText(payload.result || payload.summary || session?.summary) || 'The task finished.'}`;
    default:
      return '';
  }
}

function buildApprovalAutoDecisionMessage({ conversation, session, approval, governanceResult }) {
  const zh = /[\u3400-\u9fff]/.test(String(conversation?.title || ''));
  const label = providerLabel(session?.provider || approval?.provider);
  const title = toText(approval?.title || session?.title);
  const taskLabel = title || (zh ? '当前任务' : 'the current task');
  if (governanceResult?.action === 'approve') {
    return zh
      ? `我已根据你之前的授权规则，自动批准 ${label} 执行“${taskLabel}”所需的这次权限请求。`
      : `I auto-approved the permission request for ${label} to continue "${taskLabel}" based on your saved approval rules.`;
  }
  if (governanceResult?.action === 'deny') {
    return zh
      ? `我已根据你之前的授权规则，自动拒绝 ${label} 执行“${taskLabel}”所需的这次权限请求。`
      : `I auto-denied the permission request for ${label} while it was working on "${taskLabel}" based on your saved approval rules.`;
  }
  return '';
}

function shouldNotifyAssistant({ conversation, session, event }) {
  const eventType = String(event?.type || '').trim();
  if (!isAssistantModeConversation(conversation)) {
    return {
      shouldNotify: false,
      reason: 'conversation_not_in_assistant_mode'
    };
  }

  if (eventType === 'worker.approval_request' || eventType === 'worker.question' || eventType === 'worker.failed') {
    return {
      shouldNotify: true,
      reason: 'interactive_or_failure_event'
    };
  }

  if (eventType === 'worker.completed') {
    if (isCurrentConversationTask(conversation, session?.id || event?.sessionId || '')) {
      return {
        shouldNotify: true,
        reason: 'completed_current_task'
      };
    }
    return {
      shouldNotify: false,
      reason: 'completed_non_focus_task'
    };
  }

  return {
    shouldNotify: false,
    reason: 'event_not_selected_for_phase2'
  };
}

export class AssistantEventIngestService {
  constructor({
    assistantSessionStore: assistantSessionStoreArg = assistantSessionStore,
    assistantRunStore: assistantRunStoreArg = assistantRunStore,
    observationService = assistantObservationService,
    approvalGovernor = assistantApprovalGovernor,
    eventNarrationService = assistantEventNarrationService
  } = {}) {
    this.assistantSessionStore = assistantSessionStoreArg instanceof AssistantSessionStore
      ? assistantSessionStoreArg
      : assistantSessionStoreArg;
    this.assistantRunStore = assistantRunStoreArg instanceof AssistantRunStore
      ? assistantRunStoreArg
      : assistantRunStoreArg;
    this.observationService = observationService instanceof AssistantObservationService
      ? observationService
      : observationService;
    this.approvalGovernor = approvalGovernor instanceof AssistantApprovalGovernor
      ? approvalGovernor
      : approvalGovernor;
    this.eventNarrationService = eventNarrationService instanceof AssistantEventNarrationService
      ? eventNarrationService
      : eventNarrationService;
  }

  async ingestRuntimeEvent({ conversation, session, event } = {}) {
    const decision = shouldNotifyAssistant({ conversation, session, event });
    if (!decision.shouldNotify) {
      return {
        notified: false,
        reason: decision.reason,
        assistantRun: null,
        message: ''
      };
    }

    const pendingApproval = String(event?.type || '').trim() === 'worker.approval_request'
      ? this.observationService?.runtimeSessionManager?.approvalService?.getApproval?.(
          session?.id || event?.sessionId || '',
          event?.payload?.approvalId || ''
        ) || {
          approvalId: event?.payload?.approvalId || '',
          provider: session?.provider || '',
          title: event?.payload?.title || '',
          summary: event?.payload?.summary || '',
          rawRequest: event?.payload?.rawRequest || null
        }
      : null;

    if (pendingApproval) {
      const governanceResult = await this.approvalGovernor?.governApproval?.({
        conversation,
        runtimeSession: session,
        approval: pendingApproval
      });
      if (governanceResult?.action === 'approve' || governanceResult?.action === 'deny') {
        const fallbackMessage = buildApprovalAutoDecisionMessage({
          conversation,
          session,
          approval: pendingApproval,
          governanceResult
        });
        const narrated = await this.eventNarrationService.narrate({
          conversation,
          session,
          event,
          fallbackMessage
        });
        const message = narrated.message;
        const assistantSession = this.assistantSessionStore.findOrCreateByConversationId(conversation.id, {
          title: `CliGate Assistant / ${conversation.title || conversation.id}`
        });
        const run = this.assistantRunStore.create({
          assistantSessionId: assistantSession.id,
          conversationId: conversation.id,
          triggerText: `[runtime-event] auto-${governanceResult.action}`,
          mode: 'system',
          status: ASSISTANT_RUN_STATUS.COMPLETED,
          summary: governanceResult.reason || `approval_${governanceResult.action}`,
          result: message,
          relatedRuntimeSessionIds: [session?.id || event?.sessionId].filter(Boolean),
          metadata: {
            source: {
              kind: 'runtime_event',
              eventType: String(event?.type || '').trim(),
              sessionId: session?.id || event?.sessionId || ''
            },
            approvalGovernance: {
              action: governanceResult.action,
              policyId: governanceResult?.policy?.id || '',
              approvalId: pendingApproval?.approvalId || ''
            },
            narration: {
              mode: narrated?.mode || 'fallback',
              source: narrated?.source || null,
              reason: narrated?.reason || ''
            },
            generatedAt: nowIso()
          }
        });
        return {
          notified: true,
          reason: governanceResult.reason || `approval_${governanceResult.action}`,
          assistantSession,
          assistantRun: run,
          message,
          governance: governanceResult
        };
      }
    }

    const assistantSession = this.assistantSessionStore.findOrCreateByConversationId(conversation.id, {
      title: `CliGate Assistant / ${conversation.title || conversation.id}`
    });
    const fallbackMessage = buildEventMessage({ conversation, session, event });
    const narrated = await this.eventNarrationService.narrate({
      conversation,
      session,
      event,
      fallbackMessage
    });
    const message = narrated.message;
    const run = this.assistantRunStore.create({
      assistantSessionId: assistantSession.id,
      conversationId: conversation.id,
      triggerText: `[runtime-event] ${String(event?.type || '').trim()}`,
      mode: 'system',
      status: ASSISTANT_RUN_STATUS.COMPLETED,
      summary: decision.reason,
      result: message,
      relatedRuntimeSessionIds: [session?.id || event?.sessionId].filter(Boolean),
      metadata: {
        source: {
          kind: 'runtime_event',
          eventType: String(event?.type || '').trim(),
          sessionId: session?.id || event?.sessionId || ''
        },
        narration: {
          mode: narrated?.mode || 'fallback',
          source: narrated?.source || null,
          reason: narrated?.reason || ''
        },
        generatedAt: nowIso()
      }
    });

    this.assistantSessionStore.save({
      ...assistantSession,
      lastRunId: run.id,
      lastAssistantSummary: run.summary,
      metadata: {
        ...(assistantSession?.metadata || {}),
        lastSystemEventAt: nowIso()
      }
    });

    return {
      notified: true,
      reason: decision.reason,
      assistantSession,
      assistantRun: run,
      message
    };
  }
}

export const assistantEventIngestService = new AssistantEventIngestService();

export default assistantEventIngestService;

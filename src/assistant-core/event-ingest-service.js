import assistantSessionStore, { AssistantSessionStore } from './session-store.js';
import assistantRunStore, { AssistantRunStore } from './run-store.js';
import { ASSISTANT_RUN_STATUS } from './models.js';
import assistantObservationService, { AssistantObservationService } from './observation-service.js';
import assistantApprovalGovernor, { AssistantApprovalGovernor } from './approval-governor.js';
import assistantEventNarrationService, { AssistantEventNarrationService } from './event-narration-service.js';
import stateCoordinator, { StateCoordinator } from './domain/state-coordinator.js';
import {
  resolvePendingApprovalSessionId,
  resolvePendingQuestionSessionId
} from './pending-runtime-state.js';

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

function mapRuntimeEventToEpisodeKind(eventType = '') {
  switch (toText(eventType)) {
    case 'worker.approval_request':
      return 'runtime.approval_requested';
    case 'worker.approval_resolved':
      return 'runtime.approval_resolved';
    case 'worker.question':
      return 'runtime.question_asked';
    case 'worker.completed':
      return 'runtime.completed';
    case 'worker.failed':
      return 'runtime.failed';
    default:
      return '';
  }
}

function isAssistantModeConversation(conversation = null) {
  return String(conversation?.metadata?.assistantCore?.controlMode || conversation?.metadata?.assistantCore?.mode || '').trim() === 'assistant';
}

function isCurrentConversationTask(conversation = null, sessionId = '') {
  const normalized = toText(sessionId);
  if (!normalized) return false;
  const currentTask = conversation?.metadata?.supervisor?.taskMemory?.currentTask
    || conversation?.metadata?.supervisor?.taskMemory?.current
    || null;
  if (toText(currentTask?.sessionId) === normalized) {
    return true;
  }
  if (toText(resolvePendingApprovalSessionId(conversation)) === normalized) {
    return true;
  }
  if (toText(resolvePendingQuestionSessionId(conversation)) === normalized) {
    return true;
  }
  const activeRuntimeSessionId = toText(conversation?.activeRuntimeSessionId);
  if (activeRuntimeSessionId && activeRuntimeSessionId === normalized) {
    return true;
  }
  return false;
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

function hasPendingUserRunForSession({ conversation, sessionId, assistantRunStore }) {
  if (!conversation?.id || !sessionId || !assistantRunStore?.listByConversationId) {
    return false;
  }
  const recentRuns = assistantRunStore.listByConversationId(conversation.id, { limit: 25 }) || [];
  return recentRuns.some((run) => {
    if (!run) return false;
    const ids = Array.isArray(run.relatedRuntimeSessionIds) ? run.relatedRuntimeSessionIds : [];
    if (!ids.includes(sessionId)) return false;
    // Skip the duplicate when a user-initiated dialogue run is going to deliver
    // the final synthesized reply itself. We accept either a still-waiting
    // run or a freshly-completed dialogue run (within the last 60s) — the
    // dialogue path owns delivery for that user message.
    const triggerText = String(run.triggerText || '');
    const isUserRun = !triggerText.startsWith('[runtime-event]');
    if (!isUserRun) return false;
    if (run.status === 'waiting_runtime') return true;
    const updatedAtMs = Date.parse(String(run.updatedAt || ''));
    if (!Number.isFinite(updatedAtMs)) return false;
    return Date.now() - updatedAtMs < 60_000;
  });
}

function shouldNotifyAssistant({ conversation, session, event, assistantRunStore }) {
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
    const sessionId = session?.id || event?.sessionId || '';
    if (!isCurrentConversationTask(conversation, sessionId)) {
      return {
        shouldNotify: false,
        reason: 'completed_non_focus_task'
      };
    }
    // A user-message-initiated dialogue run owns the final reply via
    // waitForRelatedRuntimeAggregation. Suppress the duplicate runtime-event
    // narration to avoid sending two messages to the channel for one user query.
    if (hasPendingUserRunForSession({ conversation, sessionId, assistantRunStore })) {
      return {
        shouldNotify: false,
        reason: 'dialogue_run_owns_reply'
      };
    }
    return {
      shouldNotify: true,
      reason: 'completed_current_task'
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
    eventNarrationService = assistantEventNarrationService,
    stateCoordinator: stateCoordinatorArg = stateCoordinator
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
    this.stateCoordinator = stateCoordinatorArg instanceof StateCoordinator
      ? stateCoordinatorArg
      : stateCoordinatorArg;
  }

  recordRuntimeEventEpisode({
    conversation,
    session,
    event,
    reason = '',
    assistantRun = null,
    governanceResult = null,
    pendingApproval = null
  } = {}) {
    const episodeKind = mapRuntimeEventToEpisodeKind(event?.type);
    if (!episodeKind || !conversation?.id) {
      return null;
    }

    const runtimeSessionId = toText(session?.id || event?.sessionId);
    return this.stateCoordinator?.recordRuntimeEpisode?.({
      kind: episodeKind,
      runtimeSessionId,
      conversationId: conversation.id,
      payload: {
        eventType: toText(event?.type),
        reason: toText(reason),
        provider: toText(session?.provider || event?.payload?.provider),
        title: toText(event?.payload?.title || session?.title),
        summary: toText(event?.payload?.summary || session?.summary),
        result: toText(event?.payload?.result),
        error: toText(event?.payload?.message || session?.error),
        approvalId: toText(event?.payload?.approvalId || pendingApproval?.approvalId),
        approvalStatus: toText(event?.payload?.decision || event?.payload?.status),
        questionId: toText(event?.payload?.questionId),
        assistantRunId: toText(assistantRun?.id),
        assistantSessionId: toText(assistantRun?.assistantSessionId),
        governanceAction: toText(governanceResult?.action),
        governanceReason: toText(governanceResult?.reason)
      },
      metadata: {
        source: 'assistant_event_ingest',
        rawEventType: toText(event?.type)
      }
    }) || null;
  }

  persistRuntimeEvent({ conversation, session, event } = {}) {
    return this.recordRuntimeEventEpisode({
      conversation,
      session,
      event,
      reason: 'runtime_event_recorded'
    });
  }

  async ingestRuntimeEvent({ conversation, session, event } = {}) {
    const persistedEpisode = this.persistRuntimeEvent({ conversation, session, event });
    const decision = shouldNotifyAssistant({
      conversation,
      session,
      event,
      assistantRunStore: this.assistantRunStore
    });
    if (!decision.shouldNotify) {
      return {
        notified: false,
        reason: decision.reason,
        assistantRun: null,
        message: '',
        episode: persistedEpisode
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
        const episode = persistedEpisode
          ? this.stateCoordinator?.episodeLedger?.save?.({
              ...persistedEpisode,
              payload: {
                ...(persistedEpisode.payload || {}),
                reason: toText(governanceResult.reason || `approval_${governanceResult.action}`),
                assistantRunId: toText(run?.id),
                assistantSessionId: toText(run?.assistantSessionId),
                governanceAction: toText(governanceResult?.action),
                governanceReason: toText(governanceResult?.reason),
                approvalId: toText(event?.payload?.approvalId || pendingApproval?.approvalId)
              }
            }) || persistedEpisode
          : this.recordRuntimeEventEpisode({
              conversation,
              session,
              event,
              reason: governanceResult.reason || `approval_${governanceResult.action}`,
              assistantRun: run,
              governanceResult,
              pendingApproval
            });
        return {
          notified: true,
          reason: governanceResult.reason || `approval_${governanceResult.action}`,
          assistantSession,
          assistantRun: run,
          message,
          governance: governanceResult,
          episode: episode || persistedEpisode
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
    const episode = persistedEpisode
      ? this.stateCoordinator?.episodeLedger?.save?.({
          ...persistedEpisode,
          payload: {
            ...(persistedEpisode.payload || {}),
            reason: toText(decision.reason),
            assistantRunId: toText(run?.id),
            assistantSessionId: toText(run?.assistantSessionId),
            approvalId: toText(event?.payload?.approvalId || pendingApproval?.approvalId)
          }
        }) || persistedEpisode
      : this.recordRuntimeEventEpisode({
          conversation,
          session,
          event,
          reason: decision.reason,
          assistantRun: run,
          pendingApproval
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
      message,
      episode: episode || persistedEpisode
    };
  }
}

export const assistantEventIngestService = new AssistantEventIngestService();

export default assistantEventIngestService;

import { logger } from '../utils/logger.js';
import AgentRuntimeApprovalService from './approval-service.js';
import agentRuntimeApprovalPolicyStore, { AgentRuntimeApprovalPolicyStore } from './approval-policy-store.js';
import AgentRuntimeEventBus from './event-bus.js';
import { createAgentEvent, createAgentSession, createAgentTurn, AGENT_EVENT_TYPE, AGENT_SESSION_STATUS, AGENT_TURN_STATUS } from './models.js';
import { createDefaultAgentRuntimeRegistry } from './registry.js';
import AgentRuntimeSessionStore from './session-store.js';
import { AssistantPolicyService } from '../assistant-core/policy-service.js';

function nowIso() {
  return new Date().toISOString();
}

function patchTurnStats(turn = {}, patch = {}) {
  const current = turn?.stats || {};
  return {
    messageCount: Number(patch.messageCount ?? current.messageCount ?? 0),
    commandCount: Number(patch.commandCount ?? current.commandCount ?? 0),
    fileChangeCount: Number(patch.fileChangeCount ?? current.fileChangeCount ?? 0),
    approvalCount: Number(patch.approvalCount ?? current.approvalCount ?? 0),
    approvalResolvedCount: Number(patch.approvalResolvedCount ?? current.approvalResolvedCount ?? 0),
    questionCount: Number(patch.questionCount ?? current.questionCount ?? 0),
    failureCount: Number(patch.failureCount ?? current.failureCount ?? 0),
    lastMessage: String(patch.lastMessage ?? current.lastMessage ?? '')
  };
}

function incrementTurnStats(turn = {}, type, payload = {}) {
  const stats = patchTurnStats(turn);
  if (type === AGENT_EVENT_TYPE.MESSAGE) {
    stats.messageCount += 1;
    if (payload?.text) {
      stats.lastMessage = String(payload.text);
    }
  }
  if (type === AGENT_EVENT_TYPE.COMMAND) stats.commandCount += 1;
  if (type === AGENT_EVENT_TYPE.FILE_CHANGE) stats.fileChangeCount += 1;
  if (type === AGENT_EVENT_TYPE.APPROVAL_REQUEST) stats.approvalCount += 1;
  if (type === AGENT_EVENT_TYPE.APPROVAL_RESOLVED) stats.approvalResolvedCount += 1;
  if (type === AGENT_EVENT_TYPE.QUESTION) stats.questionCount += 1;
  if (type === AGENT_EVENT_TYPE.FAILED) stats.failureCount += 1;
  return stats;
}

function buildTurnTerminalSummary(turn = {}, { provider = '', summary = '', error = '' } = {}) {
  const explicit = String(summary || '').trim();
  if (explicit) {
    return explicit;
  }

  const stats = turn?.stats || {};
  const parts = [];
  if (stats.lastMessage) {
    parts.push(String(stats.lastMessage).replace(/\s+/g, ' ').slice(0, 240));
  }

  const activity = [];
  if (Number(stats.commandCount || 0) > 0) activity.push(`${stats.commandCount} commands`);
  if (Number(stats.fileChangeCount || 0) > 0) activity.push(`${stats.fileChangeCount} file changes`);
  if (Number(stats.approvalCount || 0) > 0) activity.push(`${stats.approvalCount} approvals`);
  if (Number(stats.questionCount || 0) > 0) activity.push(`${stats.questionCount} questions`);
  if (activity.length > 0) {
    parts.push(activity.join(', '));
  }

  if (error) {
    parts.push(`error: ${String(error).slice(0, 160)}`);
  }

  if (parts.length > 0) {
    return parts.join(' | ');
  }

  return `${String(provider || 'runtime')} turn completed`;
}

export class AgentRuntimeSessionManager {
  constructor({
    registry = createDefaultAgentRuntimeRegistry(),
    store = new AgentRuntimeSessionStore(),
    eventBus = new AgentRuntimeEventBus(),
    approvalService = new AgentRuntimeApprovalService(),
    approvalPolicyStore = agentRuntimeApprovalPolicyStore,
    policyService = null
  } = {}) {
    this.registry = registry;
    this.store = store;
    this.eventBus = eventBus;
    this.approvalService = approvalService;
    this.approvalPolicyStore = approvalPolicyStore instanceof AgentRuntimeApprovalPolicyStore
      ? approvalPolicyStore
      : approvalPolicyStore;
    this.policyService = policyService instanceof AssistantPolicyService
      ? policyService
      : new AssistantPolicyService({
          approvalPolicyStore: this.approvalPolicyStore
        });
    this.questionsBySession = new Map();
    this.sessions = new Map();
    this.seqBySession = new Map();
    this.turnHandles = new Map();
    this.turnsBySession = new Map();

    for (const session of this.store.loadSessions()) {
      const normalized = this._normalizeLoadedSession(session);
      this.sessions.set(normalized.id, normalized);
      this.seqBySession.set(normalized.id, Number(normalized.lastEventSeq || 0));
      this.turnsBySession.set(normalized.id, this.store.loadTurns(normalized.id));
    }
  }

  _normalizeLoadedSession(session) {
    if (!session) return session;
    if (session.status === AGENT_SESSION_STATUS.STARTING || session.status === AGENT_SESSION_STATUS.RUNNING) {
      return {
        ...session,
        status: AGENT_SESSION_STATUS.FAILED,
        error: session.error || 'Session interrupted during previous runtime',
        updatedAt: nowIso()
      };
    }
    return session;
  }

  _persistSessions() {
    const sessions = [...this.sessions.values()]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    this.store.saveSessions(sessions);
  }

  _saveSession(session) {
    this.sessions.set(session.id, session);
    this._persistSessions();
    return session;
  }

  _patchSession(sessionId, patch = {}) {
    const current = this.getSession(sessionId);
    if (!current) return null;
    const updated = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };
    return this._saveSession(updated);
  }

  _emitEvent(sessionId, type, payload = {}) {
    const nextSeq = (this.seqBySession.get(sessionId) || 0) + 1;
    this.seqBySession.set(sessionId, nextSeq);
    const event = createAgentEvent(sessionId, nextSeq, type, payload);
    const session = this.getSession(sessionId);
    if (session) {
      session.lastEventSeq = nextSeq;
      session.updatedAt = event.ts;
      this.sessions.set(sessionId, session);
      this._persistSessions();
    }
    this.store.appendEvent(sessionId, event);
    this.eventBus.publish(event);
    return event;
  }

  _saveTurns(sessionId) {
    this.store.saveTurns(sessionId, this.turnsBySession.get(sessionId) || []);
  }

  _listTurns(sessionId) {
    return [...(this.turnsBySession.get(sessionId) || [])]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }

  _getTurn(sessionId, turnId) {
    return (this.turnsBySession.get(sessionId) || []).find((entry) => entry.id === String(turnId || '')) || null;
  }

  _saveTurn(sessionId, turn) {
    const turns = this.turnsBySession.get(sessionId) || [];
    const index = turns.findIndex((entry) => entry.id === turn.id);
    const updated = {
      ...turn,
      updatedAt: nowIso()
    };
    if (index >= 0) {
      turns[index] = updated;
    } else {
      turns.push(updated);
    }
    this.turnsBySession.set(sessionId, turns);
    this._saveTurns(sessionId);
    return updated;
  }

  _patchTurn(sessionId, turnId, patch = {}) {
    const current = this._getTurn(sessionId, turnId);
    if (!current) return null;
    return this._saveTurn(sessionId, {
      ...current,
      ...patch
    });
  }

  _refreshInteractiveState(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if ([AGENT_SESSION_STATUS.READY, AGENT_SESSION_STATUS.FAILED, AGENT_SESSION_STATUS.CANCELLED].includes(session.status)) {
      return session;
    }

    const pendingApprovals = this.approvalService.listPending(sessionId).length;
    const pendingQuestions = (this.questionsBySession.get(sessionId) || [])
      .filter((entry) => entry.status === 'pending')
      .length;

    if (pendingApprovals > 0) {
      return this._patchSession(sessionId, {
        status: AGENT_SESSION_STATUS.WAITING_APPROVAL
      });
    }

    if (pendingQuestions > 0) {
      return this._patchSession(sessionId, {
        status: AGENT_SESSION_STATUS.WAITING_USER
      });
    }

    return this._patchSession(sessionId, {
      status: AGENT_SESSION_STATUS.RUNNING
    });
  }

  listProviders() {
    return this.registry.list();
  }

  listSessions({ limit = 50 } = {}) {
    return [...this.sessions.values()]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getEvents(sessionId, options = {}) {
    const recent = this.eventBus.getRecentEvents(sessionId, options.limit || 200);
    if (recent.length > 0) {
      const afterSeq = Number(options.afterSeq || 0);
      return recent.filter((event) => event.seq > afterSeq);
    }
    return this.store.listEvents(sessionId, options);
  }

  subscribe(sessionId, listener) {
    return this.eventBus.subscribe(sessionId, listener);
  }

  listTurns(sessionId, { limit = 50 } = {}) {
    return this._listTurns(String(sessionId || '')).slice(0, Math.max(1, limit));
  }

  getTurn(sessionId, turnId) {
    return this._getTurn(String(sessionId || ''), String(turnId || ''));
  }

  listTurnEvents(sessionId, turnId, { limit = 200 } = {}) {
    const normalizedSessionId = String(sessionId || '');
    const normalizedTurnId = String(turnId || '');
    const maxScan = Math.max(limit * 10, 1000);
    return this.getEvents(normalizedSessionId, {
      afterSeq: 0,
      limit: maxScan
    })
      .filter((event) => String(event?.turnId || event?.payload?.turnId || '') === normalizedTurnId)
      .slice(-Math.max(1, limit));
  }

  async createSession({ provider, input, cwd, model = '', metadata = {} } = {}) {
    if (!provider || typeof provider !== 'string') {
      throw new Error('provider is required');
    }
    if (!input || typeof input !== 'string' || !input.trim()) {
      throw new Error('input is required');
    }

    const runtimeProvider = this.registry.get(provider);
    if (!runtimeProvider) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    const session = createAgentSession({
      provider,
      input,
      cwd,
      model,
      metadata
    });
    this._saveSession(session);
    this._emitEvent(session.id, AGENT_EVENT_TYPE.STARTED, {
      provider,
      title: session.title,
      cwd: session.cwd,
      model: session.model
    });

    try {
      await this._startTurn(session.id, input);
    } catch (error) {
      this._patchSession(session.id, {
        status: AGENT_SESSION_STATUS.FAILED,
        error: error.message || 'Failed to start worker session',
        currentTurnId: null
      });
      this._emitEvent(session.id, AGENT_EVENT_TYPE.FAILED, {
        message: error.message || 'Failed to start worker session'
      });
      throw error;
    }
    return this.getSession(session.id);
  }

  async sendInput(sessionId, input) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }
    if (!input || typeof input !== 'string' || !input.trim()) {
      throw new Error('input is required');
    }
    if (this.turnHandles.has(sessionId)) {
      throw new Error('session is already running');
    }

    await this._startTurn(sessionId, input);
    return this.getSession(sessionId);
  }

  async resolveApproval(sessionId, approvalId, decision) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const approval = this.approvalService.resolveApproval(sessionId, approvalId, decision);
    if (!approval) {
      throw new Error('approval not found');
    }

    const handle = this.turnHandles.get(sessionId);
    if (handle?.respondApproval) {
      await handle.respondApproval({ approval, decision });
    } else {
      const provider = this.registry.get(session.provider);
      if (!provider?.respondApproval) {
        throw new Error(`Provider ${session.provider} does not support approval responses`);
      }
      await provider.respondApproval({ session, approval, decision });
    }
    const currentTurn = approval?.turnId ? this._getTurn(sessionId, approval.turnId) : null;
    if (currentTurn) {
      this._patchTurn(sessionId, currentTurn.id, {
        stats: incrementTurnStats(currentTurn, AGENT_EVENT_TYPE.APPROVAL_RESOLVED, {
          approvalId
        })
      });
    }
    this._refreshInteractiveState(sessionId);
    this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_RESOLVED, {
      approvalId,
      decision: approval.status,
      turnId: approval?.turnId || session.currentTurnId || null
    });
    return approval;
  }

  listPendingQuestions(sessionId) {
    return this.questionsBySession.get(sessionId) || [];
  }

  async answerQuestion(sessionId, questionId, answer) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const questions = this.questionsBySession.get(sessionId) || [];
    const question = questions.find((entry) => entry.questionId === questionId && entry.status === 'pending');
    if (!question) {
      throw new Error('question not found');
    }

    const handle = this.turnHandles.get(sessionId);
    if (!handle?.respondQuestion) {
      throw new Error(`Provider ${session.provider} does not support question responses`);
    }

    await handle.respondQuestion({ question, answer });
    question.status = 'answered';
    question.answeredAt = nowIso();
    this._refreshInteractiveState(sessionId);
    return question;
  }

  cancelSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const handle = this.turnHandles.get(sessionId);
    handle?.cancel?.();
    this.turnHandles.delete(sessionId);

    const updated = this._patchSession(sessionId, {
      status: AGENT_SESSION_STATUS.CANCELLED,
      error: null
    });

    this._emitEvent(sessionId, AGENT_EVENT_TYPE.FAILED, {
      message: 'Session cancelled by user'
    });

    return updated;
  }

  async _startTurn(sessionId, input) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const provider = this.registry.get(session.provider);
    if (!provider) {
      throw new Error(`Provider ${session.provider} is unavailable`);
    }

    const turnId = `${session.id}:turn:${session.turnCount + 1}`;
    this._saveTurn(sessionId, createAgentTurn({
      sessionId,
      turnId,
      input,
      status: AGENT_TURN_STATUS.RUNNING
    }));
    const turnState = { settled: false };
    let handle = null;
    const deferredApprovalResponses = [];
    const patched = this._patchSession(sessionId, {
      status: AGENT_SESSION_STATUS.RUNNING,
      currentTurnId: turnId,
      turnCount: Number(session.turnCount || 0) + 1,
      error: null
    });

    logger.info(`[AgentRuntime] Starting ${patched.provider} turn ${patched.turnCount} | session=${patched.id}`);

    this._emitEvent(sessionId, AGENT_EVENT_TYPE.INPUT, {
      text: String(input || ''),
      turnId,
      turnNumber: patched.turnCount
    });

    handle = await provider.startTurn({
      session: patched,
      input,
      onProviderEvent: ({ type, payload }) => {
        const turn = this._getTurn(sessionId, turnId);
        this._patchTurn(sessionId, turnId, {
          eventCount: Number(turn?.eventCount || 0) + 1,
          stats: incrementTurnStats(turn, type, payload)
        });
        this._emitEvent(sessionId, type, {
          ...(payload || {}),
          turnId
        });
      },
      onApprovalRequest: ({ kind = 'tool_permission', title, summary, rawRequest }) => {
        const approval = this.approvalService.createApproval({
          sessionId,
          turnId,
          provider: patched.provider,
          kind,
          title,
          summary,
          rawRequest
        });
        const conversationId = patched?.metadata?.source?.conversationId || patched?.metadata?.conversationId || '';
        const rememberedPolicy = this.policyService?.findAutoApprovalPolicy?.({
          conversation: conversationId ? { id: conversationId } : null,
          runtimeSession: patched,
          cwd: patched?.cwd || '',
          metadata: patched?.metadata || {},
          provider: patched.provider,
          rawRequest
        });

        if (rememberedPolicy) {
          this.approvalService.resolveApproval(sessionId, approval.approvalId, 'approve');
          this._emitEvent(sessionId, AGENT_EVENT_TYPE.PROGRESS, {
            phase: 'approval_auto_resolved',
            approvalId: approval.approvalId,
            policyId: rememberedPolicy.id,
            message: 'Supervisor auto-approved this request using a remembered session rule.'
          });
          const runResponse = async () => {
            if (!handle?.respondApproval) {
              deferredApprovalResponses.push({
                approval: { ...approval, status: 'approved' },
                decision: 'approve',
                policyId: rememberedPolicy.id
              });
              return;
            }
            await handle.respondApproval({ approval: { ...approval, status: 'approved' }, decision: 'approve' });
          };
          Promise.resolve(runResponse())
            .then(() => {
              if (!handle?.respondApproval) return;
              this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_RESOLVED, {
                approvalId: approval.approvalId,
                decision: 'approved',
                autoApproved: true,
                policyId: rememberedPolicy.id
              });
              this._refreshInteractiveState(sessionId);
            })
            .catch((error) => {
              this._patchSession(sessionId, {
                status: AGENT_SESSION_STATUS.FAILED,
                error: error?.message || 'Failed to auto-resolve approval',
                currentTurnId: null
              });
              this._emitEvent(sessionId, AGENT_EVENT_TYPE.FAILED, {
                message: error?.message || 'Failed to auto-resolve approval'
              });
            });
          return;
        }
        this._patchSession(sessionId, {
          status: AGENT_SESSION_STATUS.WAITING_APPROVAL
        });
        const currentTurn = this._getTurn(sessionId, turnId);
        this._patchTurn(sessionId, turnId, {
          status: AGENT_TURN_STATUS.WAITING_APPROVAL,
          stats: incrementTurnStats(currentTurn, AGENT_EVENT_TYPE.APPROVAL_REQUEST, approval)
        });
        this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_REQUEST, {
          ...approval,
          turnId
        });
      },
      onQuestionRequest: ({ text, options = [], rawRequest = null, questionId = null }) => {
        const questions = this.questionsBySession.get(sessionId) || [];
        const question = {
          questionId: questionId || `${sessionId}:question:${questions.length + 1}`,
          sessionId,
          turnId,
          provider: patched.provider,
          status: 'pending',
          text: String(text || ''),
          options: Array.isArray(options) ? options : [],
          rawRequest,
          createdAt: nowIso(),
          answeredAt: null
        };
        questions.push(question);
        this.questionsBySession.set(sessionId, questions);
        this._patchSession(sessionId, {
          status: AGENT_SESSION_STATUS.WAITING_USER
        });
        const currentTurn = this._getTurn(sessionId, turnId);
        this._patchTurn(sessionId, turnId, {
          status: AGENT_TURN_STATUS.WAITING_USER,
          stats: incrementTurnStats(currentTurn, AGENT_EVENT_TYPE.QUESTION, question)
        });
        this._emitEvent(sessionId, AGENT_EVENT_TYPE.QUESTION, {
          ...question,
          turnId
        });
      },
      onSessionPatch: (delta) => {
        this._patchSession(sessionId, delta);
      },
      onTurnFinished: ({ status = 'ready', summary = '' } = {}) => {
        turnState.settled = true;
        this.turnHandles.delete(sessionId);
        const currentTurn = this._getTurn(sessionId, turnId);
        const terminalSummary = buildTurnTerminalSummary(currentTurn, {
          provider: patched.provider,
          summary
        });
        this._patchSession(sessionId, {
          status: status === 'ready' ? AGENT_SESSION_STATUS.READY : status,
          summary: terminalSummary,
          currentTurnId: null
        });
        this.questionsBySession.delete(sessionId);
        this._patchTurn(sessionId, turnId, {
          status: status === 'ready' ? AGENT_TURN_STATUS.READY : status,
          summary: terminalSummary,
          completedAt: nowIso()
        });
        this._emitEvent(sessionId, AGENT_EVENT_TYPE.COMPLETED, {
          summary: terminalSummary,
          turnId
        });
      },
      onTurnFailed: (error) => {
        turnState.settled = true;
        this.turnHandles.delete(sessionId);
        const message = error?.message || 'Worker turn failed';
        this._patchSession(sessionId, {
          status: AGENT_SESSION_STATUS.FAILED,
          error: message,
          currentTurnId: null
        });
        this.questionsBySession.delete(sessionId);
        const currentTurn = this._getTurn(sessionId, turnId);
        this._patchTurn(sessionId, turnId, {
          status: AGENT_TURN_STATUS.FAILED,
          summary: buildTurnTerminalSummary(currentTurn, {
            provider: patched.provider,
            error: message
          }),
          error: message,
          stats: incrementTurnStats(currentTurn, AGENT_EVENT_TYPE.FAILED, {
            message
          }),
          completedAt: nowIso()
        });
        this._emitEvent(sessionId, AGENT_EVENT_TYPE.FAILED, {
          message,
          turnId
        });
      }
    });

    for (const deferred of deferredApprovalResponses) {
      await handle.respondApproval?.({
        approval: deferred.approval,
        decision: deferred.decision
      });
      this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_RESOLVED, {
        approvalId: deferred.approval.approvalId,
        decision: 'approved',
        autoApproved: true,
        policyId: deferred.policyId
      });
      this._refreshInteractiveState(sessionId);
    }

    if (handle?.pid) {
      this._patchSession(sessionId, { pid: handle.pid });
    }
    if (!turnState.settled) {
      this.turnHandles.set(sessionId, handle);
    }
  }
}

export const agentRuntimeSessionManager = new AgentRuntimeSessionManager();

export default agentRuntimeSessionManager;

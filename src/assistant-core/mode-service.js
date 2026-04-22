import { ASSISTANT_CONTROL_MODE, ASSISTANT_RUN_STATUS } from './models.js';
import assistantSessionStore, { AssistantSessionStore } from './session-store.js';
import assistantRunStore, { AssistantRunStore } from './run-store.js';
import assistantObservationService, { AssistantObservationService } from './observation-service.js';
import AssistantRunner from './runner.js';

function nowIso() {
  return new Date().toISOString();
}

function parseModeCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;

  const cligateMatch = trimmed.match(/^\/cligate(?:\s+(.+))?$/is);
  if (cligateMatch) {
    return {
      command: 'cligate',
      args: String(cligateMatch[1] || '').trim()
    };
  }

  if (/^\/runtime$/i.test(trimmed)) {
    return {
      command: 'runtime',
      args: ''
    };
  }

  return null;
}

function buildAssistantMetadata(current = {}, patch = {}) {
  return {
    ...current,
    ...patch,
    updatedAt: nowIso()
  };
}

export class AssistantModeService {
  constructor({
    conversationStore,
    assistantSessionStore: assistantSessionStoreArg = assistantSessionStore,
    assistantRunStore: assistantRunStoreArg = assistantRunStore,
    observationService = assistantObservationService,
    runner = null
  } = {}) {
    this.conversationStore = conversationStore;
    this.assistantSessionStore = assistantSessionStoreArg instanceof AssistantSessionStore
      ? assistantSessionStoreArg
      : assistantSessionStoreArg;
    this.assistantRunStore = assistantRunStoreArg instanceof AssistantRunStore
      ? assistantRunStoreArg
      : assistantRunStoreArg;
    this.observationService = observationService instanceof AssistantObservationService
      ? observationService
      : observationService;
    this.runner = runner || new AssistantRunner({
      runStore: this.assistantRunStore,
      observationService: this.observationService
    });
  }

  getConversationAssistantState(conversation) {
    return conversation?.metadata?.assistantCore || {};
  }

  isAssistantModeActive(conversation) {
    return this.getConversationAssistantState(conversation).mode === ASSISTANT_CONTROL_MODE.ASSISTANT;
  }

  patchConversation(conversation, patch = {}) {
    const metadataPatch = patch.metadata
      ? {
          ...(conversation.metadata || {}),
          ...(patch.metadata || {})
        }
      : undefined;
    return this.conversationStore.patch(conversation.id, {
      ...patch,
      ...(metadataPatch ? { metadata: metadataPatch } : {})
    });
  }

  ensureAssistantSession(conversation) {
    const state = this.getConversationAssistantState(conversation);
    const session = state.assistantSessionId
      ? this.assistantSessionStore.get(state.assistantSessionId)
      : null;
    if (session) return session;

    return this.assistantSessionStore.findOrCreateByConversationId(conversation.id, {
      title: `CliGate Assistant / ${conversation.title || conversation.id}`
    });
  }

  async maybeHandleMessage({
    conversation,
    text,
    defaultRuntimeProvider = 'codex',
    cwd = '',
    model = ''
  } = {}) {
    const parsed = parseModeCommand(text);
    const assistantModeActive = this.isAssistantModeActive(conversation);

    if (parsed?.command === 'runtime') {
      const nextConversation = this.patchConversation(conversation, {
        metadata: {
          assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
            mode: ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME
          })
        }
      });

      return {
        type: 'assistant_mode_exited',
        message: conversation?.activeRuntimeSessionId
          ? `Returned to direct runtime mode. Your next message will continue runtime session ${conversation.activeRuntimeSessionId}.`
          : 'Returned to direct runtime mode. Your next message will go to the runtime path directly.',
        conversation: nextConversation
      };
    }

    if (!parsed && !assistantModeActive) {
      return null;
    }

    const assistantSession = this.ensureAssistantSession(conversation);
    const isEnterOnly = parsed?.command === 'cligate' && !parsed.args;
    const runText = parsed?.command === 'cligate'
      ? parsed.args
      : String(text || '').trim();

    if (isEnterOnly) {
      const nextConversation = this.patchConversation(conversation, {
        metadata: {
          assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
            mode: ASSISTANT_CONTROL_MODE.ASSISTANT,
            assistantSessionId: assistantSession.id,
            lastActivatedAt: nowIso()
          })
        }
      });

      return {
        type: 'assistant_mode_entered',
        message: 'CliGate Assistant mode is active. Send your next message here, or use /runtime to return to direct runtime mode.',
        conversation: nextConversation,
        assistantSession
      };
    }

    const run = this.assistantRunStore.create({
      assistantSessionId: assistantSession.id,
      conversationId: conversation.id,
      triggerText: runText,
      mode: assistantModeActive ? 'session' : 'one-shot',
      status: ASSISTANT_RUN_STATUS.QUEUED,
      metadata: {
        observationHint: {
          activeRuntimeSessionId: conversation?.activeRuntimeSessionId || null
        }
      }
    });

    try {
      const executed = await this.runner.run({
        run,
        conversation,
        text: runText,
        defaultRuntimeProvider,
        cwd,
        model
      });

      this.assistantSessionStore.save({
        ...assistantSession,
        lastRunId: executed.run.id,
        lastUserMessage: runText,
        lastAssistantSummary: executed.reply.summary
      });

      const nextConversation = this.patchConversation(conversation, {
        metadata: {
          assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
            mode: assistantModeActive ? ASSISTANT_CONTROL_MODE.ASSISTANT : ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME,
            assistantSessionId: assistantSession.id,
            lastRunId: executed.run.id,
            lastRunSummary: executed.reply.summary
          })
        }
      });

      return {
        type: 'assistant_response',
        message: executed.reply.message,
        assistantSession,
        assistantRun: executed.run,
        toolResults: executed.toolResults,
        conversation: nextConversation
      };
    } catch (error) {
      const failedRun = error?.assistantRun || this.assistantRunStore.save({
        ...run,
        status: ASSISTANT_RUN_STATUS.FAILED,
        summary: error.message || 'Assistant run failed',
        metadata: {
          ...(run.metadata || {}),
          error: error.message || 'Assistant run failed'
        }
      });

      this.assistantSessionStore.save({
        ...assistantSession,
        lastRunId: failedRun.id,
        lastUserMessage: runText,
        lastAssistantSummary: failedRun.summary || ''
      });

      const nextConversation = this.patchConversation(conversation, {
        metadata: {
          assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
            mode: assistantModeActive ? ASSISTANT_CONTROL_MODE.ASSISTANT : ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME,
            assistantSessionId: assistantSession.id,
            lastRunId: failedRun.id,
            lastRunSummary: failedRun.summary || ''
          })
        }
      });

      return {
        type: 'assistant_response',
        message: error.message || 'Assistant run failed',
        isError: true,
        assistantSession,
        assistantRun: failedRun,
        conversation: nextConversation
      };
    }
  }
}

export default AssistantModeService;

import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantEventNarrationService } from '../../src/assistant-core/event-narration-service.js';
import { AssistantEventIngestService } from '../../src/assistant-core/event-ingest-service.js';
import { ASSISTANT_RUN_STATUS } from '../../src/assistant-core/models.js';

test('AssistantEventNarrationService prefers LLM narration when available', async () => {
  const service = new AssistantEventNarrationService({
    llmClient: {
      async hasAvailableSource() {
        return true;
      },
      async complete() {
        return {
          text: 'I checked the runtime update and need your approval before I continue.',
          source: {
            kind: 'api-key',
            label: 'test-llm',
            model: 'gpt-test'
          }
        };
      }
    }
  });

  const result = await service.narrate({
    conversation: {
      id: 'conv-1',
      title: 'test conversation',
      metadata: {
        assistantCore: {
          controlMode: 'assistant'
        }
      }
    },
    session: {
      id: 'session-1',
      provider: 'codex',
      title: 'Inspect repo'
    },
    event: {
      type: 'worker.approval_request',
      payload: {
        title: 'Read workspace file'
      }
    },
    fallbackMessage: 'Fallback approval text'
  });

  assert.equal(result.mode, 'llm');
  assert.match(result.message, /need your approval/i);
  assert.equal(result.source?.model, 'gpt-test');
});

test('AssistantEventNarrationService falls back when no LLM source is available', async () => {
  const service = new AssistantEventNarrationService({
    llmClient: {
      async hasAvailableSource() {
        return false;
      },
      getFallbackReason() {
        return 'no_available_llm_source';
      }
    }
  });

  const result = await service.narrate({
    conversation: {
      id: 'conv-2',
      title: 'test conversation',
      metadata: {
        assistantCore: {
          controlMode: 'assistant'
        }
      }
    },
    session: {
      id: 'session-2',
      provider: 'codex',
      title: 'Inspect repo'
    },
    event: {
      type: 'worker.completed',
      payload: {
        result: 'done'
      }
    },
    fallbackMessage: 'Fallback completion text'
  });

  assert.equal(result.mode, 'fallback');
  assert.equal(result.message, 'Fallback completion text');
});

test('AssistantEventIngestService records narration metadata and keeps fallback behavior available', async () => {
  const ingest = new AssistantEventIngestService({
    assistantSessionStore: {
      findOrCreateByConversationId() {
        return {
          id: 'assistant-session-1',
          conversationId: 'conv-3'
        };
      },
      save(session) {
        return session;
      }
    },
    assistantRunStore: {
      create(payload) {
        return {
          id: 'assistant-run-1',
          ...payload
        };
      }
    },
    observationService: {
      runtimeSessionManager: {
        approvalService: {
          getApproval() {
            return null;
          }
        }
      }
    },
    approvalGovernor: {
      async governApproval() {
        return {
          action: 'ask_user'
        };
      }
    },
    eventNarrationService: {
      async narrate({ fallbackMessage }) {
        return {
          message: `Narrated: ${fallbackMessage}`,
          mode: 'llm',
          source: {
            model: 'gpt-test'
          },
          reason: ''
        };
      }
    }
  });

  const result = await ingest.ingestRuntimeEvent({
    conversation: {
      id: 'conv-3',
      title: 'test conversation',
      activeRuntimeSessionId: 'session-3',
      metadata: {
        assistantCore: {
          controlMode: 'assistant'
        }
      }
    },
    session: {
      id: 'session-3',
      provider: 'codex',
      title: 'Inspect repo'
    },
    event: {
      type: 'worker.completed',
      payload: {
        result: 'done'
      }
    }
  });

  assert.equal(result.notified, true);
  assert.match(result.message, /^Narrated:/);
  assert.equal(result.assistantRun.status, ASSISTANT_RUN_STATUS.COMPLETED);
  assert.equal(result.assistantRun.metadata?.narration?.mode, 'llm');
  assert.equal(result.assistantRun.metadata?.narration?.source?.model, 'gpt-test');
});

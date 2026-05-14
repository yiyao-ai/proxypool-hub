import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { AssistantConversationControlService } from '../../src/assistant-core/conversation-control.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('AssistantConversationControlService reset clears pending ids and pending session hints', () => {
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-assistant-conversation-control-')
  });
  const service = new AssistantConversationControlService({
    conversationStore
  });

  const conversation = conversationStore.findOrCreateBySessionId('assistant-conversation-control-1');
  conversationStore.bindRuntimeSession(conversation.id, 'session_active', {
    lastPendingApprovalId: 'approval-1',
    lastPendingApprovalSessionId: 'session_waiting_approval',
    lastPendingQuestionId: 'question-1',
    lastPendingQuestionSessionId: 'session_waiting_question'
  });

  const updated = service.resetConversationBinding({
    conversationId: conversation.id
  });

  assert.equal(updated.activeRuntimeSessionId, null);
  assert.equal(updated.lastPendingApprovalId, null);
  assert.equal(updated.lastPendingApprovalSessionId, null);
  assert.equal(updated.lastPendingQuestionId, null);
  assert.equal(updated.lastPendingQuestionSessionId, null);
});

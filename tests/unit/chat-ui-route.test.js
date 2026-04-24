import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGetChatAgentSession } from '../../src/routes/chat-ui-route.js';
import chatUiConversationStore from '../../src/chat-ui/conversation-store.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

test('handleGetChatAgentSession returns persisted background assistant messages for a chat-ui session', async () => {
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  chatUiConversationStore.getBySessionId = () => ({
    id: 'conversation-1',
    activeRuntimeSessionId: 'runtime-1',
    metadata: {
      assistantCore: {
        mode: 'assistant',
        lastRunId: 'run-1'
      },
      uiChatMessages: [{
        role: 'assistant',
        kind: 'agent-message',
        content: 'Background result arrived.',
        assistantRunId: 'run-1',
        runStatus: 'completed',
        createdAt: '2026-04-23T00:00:00.000Z'
      }]
    }
  });

  try {
    const res = mockRes();
    await handleGetChatAgentSession({ params: { sessionId: 'chat-session-1' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.session.sessionId, 'chat-session-1');
    assert.equal(res._body.session.conversationId, 'conversation-1');
    assert.equal(res._body.session.activeRuntimeSessionId, 'runtime-1');
    assert.equal(res._body.session.assistantState.mode, 'assistant');
    assert.equal(res._body.session.uiChatMessages.length, 1);
    assert.equal(res._body.session.uiChatMessages[0].assistantRunId, 'run-1');
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
  }
});

test('handleGetChatAgentSession returns 404 when the chat-ui session has no persisted conversation', async () => {
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  chatUiConversationStore.getBySessionId = () => null;

  try {
    const res = mockRes();
    await handleGetChatAgentSession({ params: { sessionId: 'missing-session' } }, res);
    assert.equal(res._status, 404);
    assert.equal(res._body.success, false);
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
  }
});

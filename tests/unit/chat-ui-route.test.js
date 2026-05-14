import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGetChatAgentSession, handleRouteChatAgentMessage } from '../../src/routes/chat-ui-route.js';
import chatUiConversationStore from '../../src/chat-ui/conversation-store.js';
import assistantPendingActionStore from '../../src/assistant-core/pending-action-store.js';
import chatUiConversationService from '../../src/chat-ui/conversation-service.js';

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

test('handleRouteChatAgentMessage consumes latest assistant pending action on affirmative confirmation', async () => {
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalGet = chatUiConversationStore.get;
  const originalRouteMessage = chatUiConversationService.routeMessage;

  const conversation = {
    id: 'conversation-confirm-1',
    externalConversationId: 'chat-session-confirm-1',
    metadata: {}
  };
  const pendingAction = assistantPendingActionStore.create({
    conversationId: conversation.id,
    assistantRunId: 'run-confirm-1',
    toolName: 'delegate_to_runtime',
    input: {
      provider: 'codex',
      task: '帮我查一下今天深圳的天气',
      cwd: 'D:\\github\\proxypool-hub'
    },
    title: '需要确认后继续执行',
    summary: 'Target scope: D:\\github\\proxypool-hub'
  });

  chatUiConversationStore.getBySessionId = () => conversation;
  chatUiConversationStore.get = () => conversation;
  chatUiConversationService.routeMessage = async ({ text }) => ({
    type: 'assistant_response',
    message: `continued:${text}`,
    assistantRun: {
      id: 'run-confirmed-1',
      status: 'completed'
    },
    observability: null
  });

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-confirm-1',
        input: '同意',
        provider: 'codex',
        cwd: 'D:\\github\\proxypool-hub',
        model: ''
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.result.type, 'assistant_response');
    assert.match(String(res._body.result.message || ''), /continued:帮我查一下今天深圳的天气/);
    assert.equal(assistantPendingActionStore.get(pendingAction.confirmToken), null);
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.get = originalGet;
    chatUiConversationService.routeMessage = originalRouteMessage;
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
  }
});

test('handleRouteChatAgentMessage records pending assistant run id for async chat-ui runs', async () => {
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalGet = chatUiConversationStore.get;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;
  const originalPatch = chatUiConversationStore.patch;

  const patches = [];
  const conversation = {
    id: 'conversation-pending-run-1',
    metadata: {
      uiChatMessages: []
    }
  };

  chatUiConversationService.routeMessage = async () => ({
    type: 'assistant_run_accepted',
    assistantRun: {
      id: 'run-pending-1',
      status: 'waiting_runtime'
    },
    conversation: {
      id: conversation.id
    }
  });
  chatUiConversationStore.get = () => conversation;
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  chatUiConversationStore.patch = (conversationId, patch) => {
    patches.push({ conversationId, patch });
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch.metadata || {})
    };
    return conversation;
  };

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-pending-run-1',
        input: '/cligate weather sanya',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(conversation.metadata.uiChatPendingAssistantRunId, 'run-pending-1');
    assert.ok(patches.some((entry) => entry.patch?.metadata?.uiChatPendingAssistantRunId === 'run-pending-1'));
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.get = originalGet;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    chatUiConversationStore.patch = originalPatch;
  }
});

test('handleRouteChatAgentMessage ignores stale background results from an older assistant run', async () => {
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;
  const originalPatch = chatUiConversationStore.patch;

  let capturedBackgroundHandler = null;
  let patchCount = 0;
  const conversation = {
    id: 'conversation-stale-background-1',
    metadata: {
      uiChatPendingAssistantRunId: 'run-new',
      uiChatMessages: []
    }
  };

  chatUiConversationService.routeMessage = async ({ onBackgroundResult }) => {
    capturedBackgroundHandler = onBackgroundResult;
    return {
      type: 'assistant_run_accepted',
      assistantRun: {
        id: 'run-new',
        status: 'waiting_runtime'
      },
      conversation: {
        id: conversation.id
      }
    };
  };
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  chatUiConversationStore.patch = (_conversationId, patch) => {
    patchCount += 1;
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch.metadata || {})
    };
    return conversation;
  };

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-stale-background-1',
        input: '/cligate weather sanya',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    assert.equal(typeof capturedBackgroundHandler, 'function');

    await capturedBackgroundHandler({
      message: 'Qingdao weather: cloudy',
      assistantRun: {
        id: 'run-old',
        status: 'completed'
      }
    });

    assert.equal(patchCount, 1);
    assert.deepEqual(conversation.metadata.uiChatMessages, []);
    assert.equal(conversation.metadata.uiChatPendingAssistantRunId, 'run-new');
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    chatUiConversationStore.patch = originalPatch;
  }
});

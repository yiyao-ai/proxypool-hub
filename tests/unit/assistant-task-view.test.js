import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import { AGENT_EVENT_TYPE } from '../../src/agent-runtime/models.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import { AssistantTaskViewService } from '../../src/assistant-core/task-view-service.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

class FakeProvider {
  constructor() {
    this.id = 'codex';
    this.capabilities = {};
  }

  async startTurn({ input, onProviderEvent, onTurnFinished }) {
    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: `echo:${input}` }
    });
    onTurnFinished({
      status: 'ready',
      summary: `done:${input}`
    });
    return { pid: 888 };
  }
}

function createFixture() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-task-view-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-task-view-policy-')
    })
  });
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-assistant-task-view-conv-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-assistant-task-view-task-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-task-view-delivery-')
  });
  const assistantRunStore = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-task-view-run-')
  });

  return {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    assistantRunStore,
    taskViewService: new AssistantTaskViewService({
      runtimeSessionManager,
      conversationStore,
      taskStore,
      deliveryStore,
      assistantRunStore
    })
  };
}

test('AssistantTaskViewService returns unified task records for assistant conversations', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    assistantRunStore,
    taskViewService
  } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo'
  });
  const conversation = conversationStore.findOrCreateBySessionId('task-view-chat-1', {
    assistantCore: {
      mode: 'assistant',
      assistantSessionId: 'assistant-session-1',
      lastRunId: 'placeholder'
    }
  });
  const run = assistantRunStore.create({
    assistantSessionId: 'assistant-session-1',
    conversationId: conversation.id,
    triggerText: '/cligate inspect repo',
    status: 'completed',
    summary: 'assistant summarized the runtime result',
    result: 'Workspace looks healthy.',
    relatedRuntimeSessionIds: [session.id]
  });
  conversationStore.bindRuntimeSession(conversation.id, session.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantCore: {
        ...(conversation.metadata?.assistantCore || {}),
        mode: 'assistant',
        assistantSessionId: 'assistant-session-1',
        lastRunId: run.id
      },
      supervisor: {
        brief: {
          status: 'completed',
          summary: 'inspect repo finished',
          waitingReason: '',
          nextSuggestion: 'Ask for a follow-up.'
        }
      }
    }
  });
  taskStore.create({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    provider: session.provider,
    title: 'inspect repo',
    status: 'completed',
    summary: 'task summary',
    result: 'task result'
  });
  deliveryStore.saveOutbound({
    channel: 'chat-ui',
    conversationId: conversation.id,
    sessionId: session.id,
    payload: { text: 'User-facing completion message' }
  });

  const tasks = taskViewService.listTasks({ limit: 10 });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].conversation.id, conversation.id);
  assert.equal(tasks[0].assistantRun.id, run.id);
  assert.equal(tasks[0].runtimeSession.id, session.id);
  assert.equal(tasks[0].latestTurn.input, 'inspect repo');
  assert.equal(tasks[0].state, 'completed');
  assert.equal(tasks[0].summary, 'assistant summarized the runtime result');
  assert.equal(tasks[0].resultPreview, 'Workspace looks healthy.');
  assert.equal(tasks[0].lastUserVisibleMessage.text, 'User-facing completion message');

  const detail = taskViewService.getTask(tasks[0].id);
  assert.equal(detail.id, tasks[0].id);
  assert.equal(detail.pending.approvalCount, 0);
  assert.equal(detail.pending.questionCount, 0);
});

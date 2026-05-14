import '../test-env.js';
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
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AgentChannelOutboundDispatcher } from '../../src/agent-channels/outbound-dispatcher.js';
import { buildAssistantCoreDeliveryState } from '../../src/agent-channels/conversation-delivery-arbiter.js';
import { StateCoordinator } from '../../src/assistant-core/domain/state-coordinator.js';
import { PersonStore } from '../../src/assistant-core/domain/person-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ScheduledTaskStore } from '../../src/assistant-core/domain/scheduled-task-store.js';
import { EpisodeLedger } from '../../src/assistant-core/domain/episode-ledger.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createStateCoordinatorFixture(conversationStore) {
  const configDir = createTempDir('cligate-assistant-event-domain-');
  const coordinator = new StateCoordinator({
    conversationStore,
    personStore: new PersonStore({ configDir }),
    projectStore: new ProjectStore({ configDir }),
    taskStore: new TaskStore({ configDir }),
    executionStore: new ExecutionStore({ configDir }),
    scheduledTaskStore: new ScheduledTaskStore({ configDir }),
    episodeLedger: new EpisodeLedger({ configDir })
  });
  return {
    configDir,
    coordinator
  };
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
    return { pid: 777 };
  }
}

class FakeInteractiveProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
  }

  async startTurn() {
    return {
      pid: 888,
      respondApproval: async () => {},
      respondQuestion: async () => {},
      cancel() {}
    };
  }
}

function createRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeInteractiveProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-event-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-event-policy-')
    })
  });
}

async function createConversationAndSession({
  runtimeSessionManager,
  conversationStore,
  controlMode = 'assistant',
  externalConversationId = 'assistant-event-chat-1',
  externalUserId = 'user-1',
  input = 'inspect repo',
  provider = 'codex'
} = {}) {
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId,
    externalUserId,
    title: 'tester / telegram',
    metadata: {
      assistantCore: buildAssistantCoreDeliveryState({}, {
        controlMode
      })
    }
  });
  const session = await runtimeSessionManager.createSession({
    provider,
    input,
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: conversation.id,
      source: {
        kind: controlMode === 'assistant' ? 'assistant' : 'channel',
        conversationId: conversation.id
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, session.id);
  return { conversation, session };
}

test('assistant mode forwards approval requests as assistant-authored messages', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-event-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-event-delivery-')
  });
  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage(payload) {
            sent.push(payload);
            return { messageId: `assistant_event_${sent.length}` };
          }
        };
      }
    }
  });

  const { conversation, session } = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    provider: 'claude-code'
  });
  const createdApproval = runtimeSessionManager.approvalService.createApproval({
    sessionId: session.id,
    provider: 'claude-code',
    title: 'Read workspace file',
    summary: 'Need permission to continue',
    rawRequest: {
      tool_name: 'Read',
      input: {
        file_path: 'D:\\github\\proxypool-hub\\README.md'
      }
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: session.id,
    seq: 2001,
    type: AGENT_EVENT_TYPE.APPROVAL_REQUEST,
    ts: new Date().toISOString(),
    payload: {
      approvalId: createdApproval.approvalId,
      title: 'Read workspace file',
      summary: 'Need permission to continue',
      rawRequest: {
        tool_name: 'Read',
        input: {
          file_path: 'D:\\github\\proxypool-hub\\README.md'
        }
      }
    }
  });

  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text || ''), /需要你的确认|needs your approval/i);
  assert.deepEqual(sent[0].buttons, [
    { id: 'approve', text: 'Approve', action: 'approve', approvalId: createdApproval.approvalId },
    { id: 'deny', text: 'Deny', action: 'deny', approvalId: createdApproval.approvalId }
  ]);
  const deliveries = deliveryStore.listBySession(session.id, { limit: 20 });
  assert.ok(deliveries.some((entry) => entry.status === 'suppressed' && entry.payload?.sourceType === 'runtime_event'));
  assert.ok(deliveries.some((entry) => entry.status === 'sent' && entry.payload?.sourceType === 'assistant_run_result'));
  const updatedConversation = conversationStore.get(conversation.id);
  assert.equal(updatedConversation.lastPendingApprovalId, createdApproval.approvalId);
});

test('assistant mode reports current-task completion through assistant but keeps unrelated completions silent', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-event-complete-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-event-complete-delivery-')
  });
  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage({ text }) {
            sent.push(text);
            return { messageId: `assistant_complete_${sent.length}` };
          }
        };
      }
    }
  });

  const primary = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    externalConversationId: 'assistant-event-complete-chat-1',
    input: 'current task'
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: primary.session.id,
    seq: 2002,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'current task complete',
      summary: 'done'
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /当前关注的任务|current task/i);

  const secondarySession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'old task',
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: primary.conversation.id,
      source: {
        kind: 'assistant',
        conversationId: primary.conversation.id
      }
    }
  });
  conversationStore.trackRuntimeSessions(primary.conversation.id, [secondarySession.id]);

  await dispatcher.handleRuntimeEvent({
    sessionId: secondarySession.id,
    seq: 2003,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'old task complete',
      summary: 'done'
    }
  });

  assert.equal(sent.length, 1);
  const deliveries = deliveryStore.listByConversation(primary.conversation.id, { limit: 30 });
  assert.ok(deliveries.some((entry) => entry.status === 'suppressed' && entry.sessionId === secondarySession.id));
  assert.ok(!deliveries.some((entry) => entry.status === 'sent' && entry.sessionId === secondarySession.id && entry.payload?.sourceType === 'assistant_run_result'));
});

test('assistant mode treats current-task session as focus even when conversation active runtime differs', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-event-focus-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-event-focus-delivery-')
  });
  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage({ text }) {
            sent.push(text);
            return { messageId: `assistant_focus_${sent.length}` };
          }
        };
      }
    }
  });

  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-event-focus-chat-1',
    externalUserId: 'user-1',
    title: 'tester / telegram',
    metadata: {
      assistantCore: buildAssistantCoreDeliveryState({}, {
        controlMode: 'assistant'
      }),
      supervisor: {
        taskMemory: {
          currentTask: {
            taskId: 'task-focus',
            sessionId: 'session-focus',
            title: 'focused task',
            status: 'running'
          }
        }
      }
    }
  });

  const activeSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'active runtime',
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: conversation.id,
      source: {
        kind: 'assistant',
        conversationId: conversation.id
      }
    }
  });
  const focusSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'focused task',
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: conversation.id,
      source: {
        kind: 'assistant',
        conversationId: conversation.id
      }
    }
  });

  conversationStore.bindRuntimeSession(conversation.id, activeSession.id, {
    trackedRuntimeSessionIds: [activeSession.id, focusSession.id],
    metadata: {
      ...(conversation.metadata || {}),
      supervisor: {
        ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
          ? conversation.metadata.supervisor
          : {}),
        taskMemory: {
          currentTask: {
            taskId: 'task-focus',
            sessionId: focusSession.id,
            title: 'focused task',
            status: 'running'
          }
        }
      }
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: focusSession.id,
    seq: 2010,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'focused task complete',
      summary: 'done'
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /当前关注的任务|current task/i);
});

test('assistant event ingest records approval and completion episodes in EpisodeLedger', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-event-ledger-conv-')
  });
  const { coordinator } = createStateCoordinatorFixture(conversationStore);
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-event-ledger-delivery-')
  });
  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    eventIngestService: undefined,
    registry: {
      get() {
        return {
          async sendMessage({ text }) {
            sent.push(text);
            return { messageId: `assistant_ledger_${sent.length}` };
          }
        };
      }
    }
  });
  dispatcher.eventIngestService.stateCoordinator = coordinator;

  const { conversation, session } = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    provider: 'claude-code',
    externalConversationId: 'assistant-event-ledger-chat-1'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });
  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: 'Inspect repo approvals',
    goal: 'Track runtime approvals in ledger',
    conversationId: conversation.id
  });
  const execution = coordinator.createExecution({
    taskId: task.id,
    ownerPersonId: person.id,
    provider: session.provider,
    role: 'primary',
    objective: 'Inspect repo approvals',
    conversationId: conversation.id
  });
  coordinator.bindExecutionRuntime({
    executionId: execution.id,
    runtimeSessionId: session.id,
    providerSessionId: session.providerSessionId || '',
    status: session.status,
    conversationId: conversation.id
  });

  const createdApproval = runtimeSessionManager.approvalService.createApproval({
    sessionId: session.id,
    provider: 'claude-code',
    title: 'Read workspace file',
    summary: 'Need permission to continue',
    rawRequest: {
      tool_name: 'Read',
      input: {
        file_path: 'D:\\github\\proxypool-hub\\README.md'
      }
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: session.id,
    seq: 2101,
    type: AGENT_EVENT_TYPE.APPROVAL_REQUEST,
    ts: new Date().toISOString(),
    payload: {
      approvalId: createdApproval.approvalId,
      title: createdApproval.title,
      summary: createdApproval.summary,
      rawRequest: createdApproval.rawRequest
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: session.id,
    seq: 2102,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'approval handled and task complete',
      summary: 'done'
    }
  });

  assert.equal(sent.length, 2);

  const approvalEpisodes = coordinator.episodeLedger.listByEntity({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    kind: 'runtime.approval_requested',
    limit: 10
  });
  assert.equal(approvalEpisodes.length, 1);
  assert.equal(approvalEpisodes[0].personId, person.id);
  assert.equal(approvalEpisodes[0].projectId, project.id);
  assert.equal(approvalEpisodes[0].taskId, task.id);
  assert.equal(approvalEpisodes[0].executionId, execution.id);
  assert.equal(approvalEpisodes[0].payload.approvalId, createdApproval.approvalId);
  assert.ok(approvalEpisodes[0].payload.assistantRunId);

  const completionEpisodes = coordinator.episodeLedger.listByEntity({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    kind: 'runtime.completed',
    limit: 10
  });
  assert.equal(completionEpisodes.length, 1);
  assert.equal(completionEpisodes[0].executionId, execution.id);
  assert.equal(completionEpisodes[0].payload.result, 'approval handled and task complete');
  assert.ok(completionEpisodes[0].payload.assistantRunId);
});

test('assistant event ingest records non-notified completion and approval resolved episodes', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-event-passive-ledger-conv-')
  });
  const { coordinator } = createStateCoordinatorFixture(conversationStore);
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-event-passive-ledger-delivery-')
  });
  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage({ text }) {
            sent.push(text);
            return { messageId: `assistant_passive_${sent.length}` };
          }
        };
      }
    }
  });
  dispatcher.eventIngestService.stateCoordinator = coordinator;

  const primary = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    provider: 'claude-code',
    externalConversationId: 'assistant-event-passive-chat-1'
  });
  const secondarySession = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: 'background task',
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: primary.conversation.id,
      source: {
        kind: 'assistant',
        conversationId: primary.conversation.id
      }
    }
  });
  conversationStore.trackRuntimeSessions(primary.conversation.id, [secondarySession.id]);

  const backgroundApproval = runtimeSessionManager.approvalService.createApproval({
    sessionId: secondarySession.id,
    provider: 'claude-code',
    title: 'Background approval',
    summary: 'Need permission in background task',
    rawRequest: {
      tool_name: 'Read',
      input: {
        file_path: 'D:\\github\\proxypool-hub\\package.json'
      }
    }
  });

  await runtimeSessionManager.resolveApproval(secondarySession.id, backgroundApproval.approvalId, 'approve');
  await dispatcher.handleRuntimeEvent({
    sessionId: secondarySession.id,
    seq: 2201,
    type: AGENT_EVENT_TYPE.APPROVAL_RESOLVED,
    ts: new Date().toISOString(),
    payload: {
      approvalId: backgroundApproval.approvalId,
      decision: 'approved'
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: secondarySession.id,
    seq: 2202,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'background task finished',
      summary: 'done'
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /current task|当前关注的任务/i);

  const approvalResolvedEpisodes = coordinator.episodeLedger.listByEntity({
    conversationId: primary.conversation.id,
    runtimeSessionId: secondarySession.id,
    kind: 'runtime.approval_resolved',
    limit: 10
  });
  assert.equal(approvalResolvedEpisodes.length, 1);
  assert.equal(approvalResolvedEpisodes[0].payload.approvalId, backgroundApproval.approvalId);
  assert.equal(approvalResolvedEpisodes[0].payload.approvalStatus, 'approved');
  assert.equal(approvalResolvedEpisodes[0].payload.assistantRunId, '');

  const completionEpisodes = coordinator.episodeLedger.listByEntity({
    conversationId: primary.conversation.id,
    runtimeSessionId: secondarySession.id,
    kind: 'runtime.completed',
    limit: 10
  });
  assert.equal(completionEpisodes.length, 1);
  assert.equal(completionEpisodes[0].payload.result, 'background task finished');
  assert.ok(completionEpisodes[0].payload.assistantRunId);
  const deliveries = deliveryStore.listBySession(secondarySession.id, { limit: 20 });
  assert.ok(!deliveries.some((entry) => (
    entry.status === 'sent'
    && entry.eventSeq === 2201
    && entry.payload?.sourceType === 'assistant_run_result'
  )));
});

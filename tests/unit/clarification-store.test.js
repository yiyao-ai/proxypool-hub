import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantClarificationStore } from '../../src/assistant-core/clarification-store.js';
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import createDefaultAssistantToolRegistry from '../../src/assistant-core/tool-registry.js';
import { AssistantConversationControlService } from '../../src/assistant-core/conversation-control.js';
import { AssistantObservationService } from '../../src/assistant-core/observation-service.js';
import { AssistantTaskViewService } from '../../src/assistant-core/task-view-service.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import { AssistantWorkspaceStore } from '../../src/assistant-core/workspace-store.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('AssistantClarificationStore creates, lists, and answers pending clarifications', () => {
  const store = new AssistantClarificationStore({
    configDir: createTempDir('cligate-clarification-store-')
  });

  const created = store.create({
    conversationId: 'conv-clarification-1',
    question: 'Which task should I continue?',
    candidates: [
      { kind: 'task', id: 'task-a', label: 'Task A', confidence: 0.9 },
      { kind: 'task', id: 'task-b', label: 'Task B', confidence: 0.6 }
    ],
    ttlSec: 60
  });

  const pending = store.getPendingByConversationId('conv-clarification-1');
  const listed = store.list({
    conversationId: 'conv-clarification-1',
    status: 'pending'
  });

  assert.equal(created.status, 'pending');
  assert.equal(created.candidates.length, 2);
  assert.equal(pending?.id, created.id);
  assert.equal(listed[0]?.id, created.id);

  const answered = store.answer(created.id, {
    selectedCandidateId: 'task-a',
    freeTextAnswer: '继续 task a'
  });

  assert.equal(answered?.status, 'answered');
  assert.equal(answered?.resolution?.selectedCandidateId, 'task-a');
  assert.equal(answered?.resolution?.freeTextAnswer, '继续 task a');
  assert.equal(store.getPendingByConversationId('conv-clarification-1'), null);
});

test('AssistantClarificationStore expires stale pending clarifications', () => {
  const store = new AssistantClarificationStore({
    configDir: createTempDir('cligate-clarification-expire-')
  });

  const created = store.create({
    conversationId: 'conv-clarification-2',
    question: 'Agent 还是 agent-monitor?',
    ttlSec: 1
  });

  store.save({
    ...created,
    askedAt: new Date(Date.now() - 5_000).toISOString(),
    createdAt: new Date(Date.now() - 5_000).toISOString(),
    updatedAt: new Date(Date.now() - 5_000).toISOString()
  });

  const changed = store.expirePending();
  const expired = store.get(created.id);

  assert.equal(changed, true);
  assert.equal(expired?.status, 'expired');
});

test('AgentChannelConversationStore persists lastPendingClarificationId and clears it on reset', () => {
  const store = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-conversation-clarification-')
  });

  const conversation = store.findOrCreateByExternal({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'cid-clarification-1',
    externalUserId: 'user-clarification-1',
    title: 'clarification'
  });

  assert.equal(conversation.lastPendingClarificationId, null);

  const patched = store.patch(conversation.id, {
    activeRuntimeSessionId: 'session-1',
    lastPendingClarificationId: 'clarification-1'
  });

  assert.equal(patched?.lastPendingClarificationId, 'clarification-1');

  const cleared = store.clearActiveRuntimeSession(conversation.id);
  assert.equal(cleared?.lastPendingClarificationId, null);
});

test('assistant clarification tools persist and clear conversation pending clarification state', async () => {
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-clarification-tools-conv-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: new AgentRuntimeRegistry(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-clarification-tools-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-clarification-tools-policy-')
    })
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-clarification-tools-task-')
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-clarification-tools-supervisor-')
  });
  const workspaceStore = new AssistantWorkspaceStore({
    configDir: createTempDir('cligate-clarification-tools-workspace-')
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-clarification-tools-run-')
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    workspaceStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    assistantRunStore: runStore
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    supervisorTaskStore
  });
  const clarificationStore = new AssistantClarificationStore({
    configDir: createTempDir('cligate-clarification-tools-store-')
  });
  const registry = createDefaultAssistantToolRegistry({
    observationService,
    messageService,
    taskViewService,
    clarificationStore,
    workspaceStore,
    conversationControlService: new AssistantConversationControlService({
      conversationStore
    })
  });
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'clarification-tools-1',
    externalUserId: 'local-user',
    title: 'clarification tools'
  });

  const asked = await registry.get('ask_user').execute({
    input: {
      question: 'Which task should I continue?',
      candidates: [
        { kind: 'task', id: 'task-a', label: 'Task A' },
        { kind: 'task', id: 'task-b', label: 'Task B' }
      ]
    },
    context: { conversation }
  });

  assert.ok(asked.clarificationId);
  assert.equal(conversationStore.get(conversation.id)?.lastPendingClarificationId, asked.clarificationId);

  const resolved = await registry.get('resolve_clarification').execute({
    input: {
      clarificationId: asked.clarificationId,
      candidateId: 'task-a'
    },
    context: { conversation: conversationStore.get(conversation.id) }
  });

  assert.equal(resolved.status, 'answered');
  assert.equal(conversationStore.get(conversation.id)?.lastPendingClarificationId, null);
});

test('cwd tools return cwd info and persist aliases on known workspaces', async () => {
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-cwd-tools-conv-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: new AgentRuntimeRegistry(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-cwd-tools-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-cwd-tools-policy-')
    })
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-cwd-tools-task-')
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-cwd-tools-supervisor-')
  });
  const workspaceStore = new AssistantWorkspaceStore({
    configDir: createTempDir('cligate-cwd-tools-workspace-')
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-cwd-tools-run-')
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    workspaceStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    assistantRunStore: runStore
  });
  const registry = createDefaultAssistantToolRegistry({
    observationService,
    messageService: new AgentOrchestratorMessageService({
      runtimeSessionManager,
      supervisorTaskStore
    }),
    taskViewService,
    workspaceStore,
    conversationControlService: new AssistantConversationControlService({
      conversationStore
    })
  });

  const workspace = workspaceStore.upsert({
    workspaceRef: 'd:\\projects\\agent\\',
    patch: {
      aliases: ['agent project'],
      summary: 'Known project',
      taskIds: ['task-a'],
      openTaskIds: ['task-a']
    }
  });
  supervisorTaskStore.create({
    id: 'task-a',
    conversationId: 'conv-a',
    title: 'Inspect agent',
    status: 'running',
    cwd: 'D:\\projects\\agent',
    cwdBasename: 'agent',
    workspaceId: workspace.id
  });

  const info = await registry.get('get_cwd_info').execute({
    input: {
      cwd: 'D:\\projects\\agent'
    }
  });

  assert.equal(info?.id, workspace.id);
  assert.equal(info?.linkedTasks?.[0]?.id, 'task-a');

  const updated = await registry.get('add_cwd_alias').execute({
    input: {
      cwd: 'D:\\projects\\agent',
      alias: '智能体项目'
    }
  });

  assert.ok(updated?.aliases.includes('智能体项目'));
  assert.ok(updated?.aliases.includes('agent project'));
});

test('link_task_to_conversation adopts an existing task into the current conversation', async () => {
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-link-task-conv-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: new AgentRuntimeRegistry(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-link-task-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-link-task-policy-')
    })
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-link-task-task-')
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-link-task-supervisor-')
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-link-task-run-')
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    assistantRunStore: runStore
  });
  const registry = createDefaultAssistantToolRegistry({
    observationService,
    messageService: new AgentOrchestratorMessageService({
      runtimeSessionManager,
      supervisorTaskStore
    }),
    taskViewService,
    conversationControlService: new AssistantConversationControlService({
      conversationStore
    })
  });
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'link-task-tools-1',
    externalUserId: 'local-user',
    title: 'link task tools'
  });
  supervisorTaskStore.create({
    id: 'task-link-1',
    conversationId: 'conv-elsewhere',
    lastConversationId: 'conv-elsewhere',
    title: 'Adopt me',
    status: 'running',
    primaryExecutionId: 'session-link-1',
    executionIds: ['session-link-1'],
    metadata: {
      runtimeSessionId: 'session-link-1',
      latestExecutionId: 'session-link-1',
      provider: 'codex'
    }
  });

  const linked = await registry.get('link_task_to_conversation').execute({
    input: {
      taskId: 'task-link-1'
    },
    context: {
      conversation
    }
  });

  assert.equal(linked?.taskId, 'task-link-1');
  assert.equal(linked?.conversation?.activeTaskId, 'task-link-1');
  assert.equal(linked?.conversation?.activeRuntimeSessionId, 'session-link-1');
  assert.equal(conversationStore.get(conversation.id)?.trackedTaskIds.includes('task-link-1'), true);
  assert.equal(supervisorTaskStore.get('task-link-1')?.lastConversationId, conversation.id);
});

test('link_session_to_task appends a runtime session into the task without overriding primary execution', async () => {
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-link-session-supervisor-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-link-session-task-')
  });
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-link-session-conv-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: new AgentRuntimeRegistry(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-link-session-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-link-session-policy-')
    })
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-link-session-run-')
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    assistantRunStore: runStore
  });
  const registry = createDefaultAssistantToolRegistry({
    observationService,
    messageService: new AgentOrchestratorMessageService({
      runtimeSessionManager,
      supervisorTaskStore
    }),
    taskViewService,
    conversationControlService: new AssistantConversationControlService({
      conversationStore
    })
  });

  supervisorTaskStore.create({
    id: 'task-misroute-1',
    conversationId: 'conv-misroute-1',
    title: 'Original',
    status: 'running',
    primaryExecutionId: 'session-original',
    executionIds: ['session-original'],
    metadata: {
      runtimeSessionId: 'session-original',
      latestExecutionId: 'session-original',
      provider: 'codex'
    }
  });

  const linked = await registry.get('link_session_to_task').execute({
    input: {
      taskId: 'task-misroute-1',
      sessionId: 'session-late-arrival'
    }
  });

  assert.equal(linked?.taskId, 'task-misroute-1');
  assert.equal(linked?.sessionId, 'session-late-arrival');
  assert.equal(linked?.alreadyLinked, false);
  assert.deepEqual(linked?.executionIds, ['session-original', 'session-late-arrival']);

  const updatedTask = supervisorTaskStore.get('task-misroute-1');
  assert.equal(updatedTask.primaryExecutionId, 'session-original');
  assert.equal(updatedTask.metadata.latestExecutionId, 'session-late-arrival');
  assert.equal(updatedTask.metadata.runtimeSessionId, 'session-late-arrival');

  // 二次 link 同一 session 应当幂等
  const replayed = await registry.get('link_session_to_task').execute({
    input: {
      taskId: 'task-misroute-1',
      sessionId: 'session-late-arrival'
    }
  });
  assert.equal(replayed.alreadyLinked, true);
  assert.deepEqual(replayed.executionIds, ['session-original', 'session-late-arrival']);
});

test('link_session_to_task throws when task does not exist', async () => {
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-link-session-missing-supervisor-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-link-session-missing-task-')
  });
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-link-session-missing-conv-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: new AgentRuntimeRegistry(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-link-session-missing-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-link-session-missing-policy-')
    })
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-link-session-missing-run-')
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    assistantRunStore: runStore
  });
  const registry = createDefaultAssistantToolRegistry({
    observationService,
    messageService: new AgentOrchestratorMessageService({
      runtimeSessionManager,
      supervisorTaskStore
    }),
    taskViewService,
    conversationControlService: new AssistantConversationControlService({
      conversationStore
    })
  });

  await assert.rejects(
    () => registry.get('link_session_to_task').execute({
      input: {
        taskId: 'task-does-not-exist',
        sessionId: 'session-x'
      }
    }),
    /task not found/i
  );
});

test('recall returns task and delivery matches for historical queries', async () => {
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-recall-conv-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: new AgentRuntimeRegistry(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-recall-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-recall-policy-')
    })
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-recall-task-')
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-recall-supervisor-')
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-recall-run-')
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    assistantRunStore: runStore
  });
  const registry = createDefaultAssistantToolRegistry({
    observationService,
    messageService: new AgentOrchestratorMessageService({
      runtimeSessionManager,
      supervisorTaskStore
    }),
    taskViewService,
    conversationControlService: new AssistantConversationControlService({
      conversationStore
    })
  });
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'recall-tools-1',
    externalUserId: 'local-user',
    title: 'recall tools'
  });
  supervisorTaskStore.create({
    id: 'task-celery',
    conversationId: conversation.id,
    title: 'Inspect celery entry',
    summary: 'Checked the celery worker entrypoint',
    result: 'Found the celery bootstrap',
    status: 'completed',
    cwd: 'D:\\projects\\agent',
    postmortem: {
      purpose: 'Inspect celery entry',
      outcome: 'Found the celery bootstrap',
      deliverables: ['celery entry analysis'],
      next: 'Check worker startup path',
      keywords: ['celery', '入口']
    }
  });
  observationService.deliveryStore.saveInbound({
    conversationId: conversation.id,
    sessionId: '',
    payload: {
      text: '上周那个 celery 入口'
    }
  });

  const recalled = await registry.get('recall').execute({
    input: {
      query: 'celery 入口',
      scope: 'conversation'
    },
    context: {
      conversation
    }
  });

  assert.equal(typeof recalled?.summary?.bestScore, 'number');
  assert.match(String(recalled?.summary?.primaryKind || ''), /task|delivery|conversation/);
  assert.equal(recalled?.tasks?.[0]?.id, 'task-celery');
  assert.ok(recalled?.deliveries?.some((entry) => String(entry?.text || '').includes('celery')));
});

test('resolve_reference tool re-checks candidates against current conversation context', async () => {
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-resolve-ref-conv-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: new AgentRuntimeRegistry(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-resolve-ref-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-resolve-ref-policy-')
    })
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-resolve-ref-task-')
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-resolve-ref-supervisor-')
  });
  const workspaceStore = new AssistantWorkspaceStore({
    configDir: createTempDir('cligate-resolve-ref-workspace-')
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-resolve-ref-run-')
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    workspaceStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    assistantRunStore: runStore
  });
  const registry = createDefaultAssistantToolRegistry({
    observationService,
    messageService: new AgentOrchestratorMessageService({
      runtimeSessionManager,
      supervisorTaskStore
    }),
    taskViewService,
    workspaceStore,
    conversationControlService: new AssistantConversationControlService({
      conversationStore
    })
  });
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'resolve-ref-tools-1',
    externalUserId: 'local-user',
    title: 'resolve ref tools',
    metadata: {
      supervisor: {
        taskMemory: {
          activeTaskId: 'task-agent'
        }
      }
    }
  });
  supervisorTaskStore.create({
    id: 'task-agent',
    conversationId: conversation.id,
    title: 'Inspect agent',
    status: 'running',
    cwd: 'D:\\projects\\agent',
    cwdBasename: 'agent',
    lastConversationId: conversation.id
  });
  workspaceStore.upsert({
    workspaceRef: 'D:\\projects\\agent',
    patch: {
      aliases: ['agent project']
    }
  });

  const resolved = await registry.get('resolve_reference').execute({
    input: {
      phrase: '刚才那个 agent 项目'
    },
    context: {
      conversation
    }
  });

  assert.equal(resolved?.intent, 'freeform');
  assert.ok(resolved?.references?.[0]?.topCandidates?.some((entry) => entry.kind === 'task'));
  assert.ok(resolved?.references?.[0]?.topCandidates?.some((entry) => entry.kind === 'cwd'));
  assert.match(String(resolved?.references?.[0]?.confidence || ''), /high|medium|low/);
  assert.match(String(resolved?.references?.[0]?.recommendedAction || ''), /reuse_task|inspect_workspace|ask_user/);
  assert.equal(typeof resolved?.summary?.shouldAskUser, 'boolean');
});

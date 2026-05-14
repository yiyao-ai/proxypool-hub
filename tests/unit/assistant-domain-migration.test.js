import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantDomainBackfillPlanner } from '../../scripts/migrate-assistant-agent/lib/domain-migration.js';
import { reconcileAssistantDomainLinks, verifyAssistantDomainConsistency } from '../../scripts/migrate-assistant-agent/lib/consistency-checks.js';

function createStateFixture() {
  return {
    files: {},
    supervisorTasks: [
      {
        id: 'sup-1',
        conversationId: 'conv-1',
        lastConversationId: 'conv-1',
        title: '分析 proxypool-hub',
        goal: '分析 proxypool-hub',
        status: 'completed',
        executorStrategy: 'codex',
        primaryExecutionId: 'rt-1',
        executionIds: ['rt-1'],
        cwd: 'D:\\github\\proxypool-hub',
        workspaceId: 'ws-1',
        metadata: {
          runtimeSessionId: 'rt-1',
          provider: 'codex',
          originKind: 'assistant'
        }
      }
    ],
    conversations: [
      {
        id: 'conv-1',
        channel: 'dingtalk',
        externalUserId: 'manager3311',
        title: 'DingTalk / manager3311',
        activeTaskId: 'sup-1',
        metadata: {
          supervisor: {
            taskMemory: {
              activeTaskId: 'sup-1',
              byTask: {
                'sup-1': {
                  taskId: 'sup-1',
                  sessionId: 'rt-1',
                  provider: 'codex',
                  title: '分析 proxypool-hub',
                  status: 'completed',
                  summary: 'done'
                }
              }
            }
          }
        }
      }
    ],
    runtimeSessions: [
      {
        id: 'rt-1',
        provider: 'codex',
        providerSessionId: 'provider-1',
        status: 'ready',
        cwd: 'D:\\github\\proxypool-hub',
        summary: 'done',
        updatedAt: '2026-05-13T00:00:00.000Z',
        metadata: {}
      }
    ],
    approvalPolicies: [],
    workspaces: [
      {
        id: 'ws-1',
        workspaceRef: 'D:\\github\\proxypool-hub',
        name: 'proxypool-hub',
        defaultRuntimeProvider: 'codex',
        summary: 'workspace summary'
      }
    ],
    assistantDomain: {
      persons: [],
      projects: [],
      tasks: [],
      executions: [],
      scheduledTasks: [],
      episodes: []
    }
  };
}

test('AssistantDomainBackfillPlanner backfills task/execution links and conversation working set', () => {
  const planner = new AssistantDomainBackfillPlanner(createStateFixture());
  const result = planner.planBackfill();
  const nextState = planner.exportState();

  assert.equal(result.changes.tasksCreated, 1);
  assert.equal(result.changes.executionsCreated, 1);
  assert.equal(nextState.tasks.length, 1);
  assert.equal(nextState.executions.length, 1);

  const task = nextState.tasks[0];
  const execution = nextState.executions[0];
  const project = nextState.projects.find((entry) => entry.id === task.projectId);
  const conversation = nextState.conversations[0];
  const supervisorTask = nextState.supervisorTasks[0];

  assert.equal(execution.taskId, task.id);
  assert.ok(task.allExecutionIds.includes(execution.id));
  assert.ok(project);
  assert.equal(project.cwd, 'D:\\github\\proxypool-hub');
  assert.equal(conversation.metadata.assistantDomain.workingSet.primaryTaskId, task.id);
  assert.equal(conversation.metadata.assistantDomain.workingSet.primaryProjectId, project.id);
  assert.equal(supervisorTask.metadata.assistantTaskId, task.id);
  assert.equal(supervisorTask.metadata.assistantExecutionId, execution.id);
});

test('consistency checks pass on a coherent migrated state', () => {
  const planner = new AssistantDomainBackfillPlanner(createStateFixture());
  planner.planBackfill();
  const nextState = planner.exportState();

  const linkResult = reconcileAssistantDomainLinks({
    supervisorTasks: nextState.supervisorTasks,
    assistantDomain: {
      persons: nextState.persons,
      tasks: nextState.tasks,
      executions: nextState.executions
    }
  });
  const consistencyIssues = verifyAssistantDomainConsistency({
    assistantDomain: {
      tasks: nextState.tasks,
      projects: nextState.projects,
      executions: nextState.executions
    },
    conversations: nextState.conversations
  });

  assert.equal(linkResult.missingTaskLinks.length, 0);
  assert.equal(linkResult.missingExecutionLinks.length, 0);
  assert.equal(linkResult.missingPersonLinks.length, 0);
  assert.equal(consistencyIssues.length, 0);
});

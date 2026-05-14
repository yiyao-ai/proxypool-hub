import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAssistantWorkbenchPageModule } from '../../public/js/modules/assistant-workbench-page.js';

function createHarness(responders = {}) {
  const calls = [];
  const module = createAssistantWorkbenchPageModule();
  const app = {
    ...module,
    api: async (url) => {
      calls.push(url);
      for (const [prefix, response] of Object.entries(responders)) {
        if (url.startsWith(prefix)) {
          return typeof response === 'function' ? response(url) : response;
        }
      }
      return { ok: false, error: `Unhandled URL: ${url}` };
    }
  };
  return { app, calls };
}

test('assistant workbench loads project -> task -> dashboard -> transcript/context chain', async () => {
  const project = { id: 'project-1', name: 'Repo', kind: 'code_project', cwd: 'D:\\repo' };
  const task = {
    id: 'task-1',
    title: 'Route cleanup',
    goal: 'Cleanup routes',
    lifecycleState: 'open',
    lastConversationId: 'conversation-1'
  };
  const execution = {
    id: 'execution-1',
    provider: 'codex',
    role: 'primary',
    status: 'running',
    recentScope: ['src/routes'],
    recentCommands: ['node --test'],
    handoffInbox: [{ kind: 'review_request', title: 'Review route patch' }]
  };
  const dashboard = {
    task: {
      ...task,
      summary: 'Working through route migration',
      plan: ['inspect', 'patch', 'verify'],
      todos: ['verify new route'],
      blockers: ['need ui follow-up'],
      openQuestions: ['ship with old page?'],
      completionCriteria: 'explicit_user_close'
    },
    project,
    executions: [execution],
    activitySnapshot: {
      activeExecutionCount: 1
    }
  };

  const { app, calls } = createHarness({
    '/api/assistant/projects?': { ok: true, data: { projects: [project] } },
    '/api/assistant/projects/project-1/tasks?': { ok: true, data: { tasks: [task] } },
    '/api/assistant/tasks/task-1/dashboard': { ok: true, data: { dashboard } },
    '/api/assistant/episodes?taskId=task-1': {
      ok: true,
      data: {
        episodes: [{ id: 'episode-1', kind: 'task.updated', payload: { summary: 'updated' } }]
      }
    },
    '/api/assistant/executions/execution-1/transcript': {
      ok: true,
      data: {
        transcript: {
          session: { id: 'runtime-1' },
          turns: [{ turn: { id: 'turn-1', input: 'continue' }, events: [] }]
        }
      }
    },
    '/api/assistant/conversations/conversation-1': {
      ok: true,
      data: {
        detail: {
          conversation: {
            id: 'conversation-1',
            assistantMode: 'assistant',
            trackedTaskIds: ['task-1']
          },
          workspace: {
            workspaceRef: 'D:\\repo'
          },
          pendingQuestions: [],
          pendingApprovals: []
        }
      }
    }
  });

  await app.loadAssistantWorkbench();

  assert.equal(app.assistantWorkbenchProjects.length, 1);
  assert.equal(app.assistantWorkbenchTasks.length, 1);
  assert.equal(app.assistantWorkbenchDashboard?.task?.id, 'task-1');
  assert.equal(app.assistantWorkbenchEpisodes.length, 1);
  assert.equal(app.assistantWorkbenchTranscript?.session?.id, 'runtime-1');
  assert.equal(app.assistantWorkbenchConversationContext?.conversation?.id, 'conversation-1');
  assert.deepEqual(app.assistantWorkbenchList(app.assistantWorkbenchDashboard?.task?.plan), ['inspect', 'patch', 'verify']);
  assert.ok(calls.some((entry) => entry.startsWith('/api/assistant/conversations/conversation-1')));
});

test('assistant workbench clears transcript and conversation context when dashboard has no execution or conversation', async () => {
  const { app } = createHarness({});

  app.assistantWorkbenchTranscript = { session: { id: 'old' } };
  app.assistantWorkbenchConversationContext = { conversation: { id: 'old' } };

  await app.loadAssistantWorkbenchTranscript({ executions: [] });
  await app.loadAssistantWorkbenchConversationContext({ task: { lastConversationId: '' } });

  assert.equal(app.assistantWorkbenchTranscript, null);
  assert.equal(app.assistantWorkbenchConversationContext, null);
});

test('assistant workbench selection resets stale detail state before loading next project', async () => {
  const { app } = createHarness({
    '/api/assistant/projects/project-2/tasks?': { ok: true, data: { tasks: [] } }
  });

  app.assistantWorkbenchDashboard = { task: { id: 'task-old' } };
  app.assistantWorkbenchEpisodes = [{ id: 'episode-old' }];
  app.assistantWorkbenchTranscript = { session: { id: 'runtime-old' } };
  app.assistantWorkbenchConversationContext = { conversation: { id: 'conversation-old' } };

  await app.selectAssistantWorkbenchProject('project-2');

  assert.equal(app.selectedAssistantWorkbenchProjectId, 'project-2');
  assert.equal(app.selectedAssistantWorkbenchTaskId, '');
  assert.equal(app.assistantWorkbenchDashboard, null);
  assert.deepEqual(app.assistantWorkbenchEpisodes, []);
  assert.equal(app.assistantWorkbenchTranscript, null);
  assert.equal(app.assistantWorkbenchConversationContext, null);
});

test('assistant workbench filters episodes by selected category', () => {
  const { app } = createHarness({});

  app.assistantWorkbenchEpisodes = [
    { id: 'episode-1', kind: 'task.updated', payload: { summary: 'task change' } },
    { id: 'episode-2', kind: 'execution_handoff_prepared', payload: { title: 'review' } },
    { id: 'episode-3', kind: 'runtime.completed', payload: { status: 'done' } },
    { id: 'episode-4', kind: 'delivery.sent', payload: { text: 'sent' } },
    { id: 'episode-5', kind: 'approval.requested', payload: { title: 'Need approval' } }
  ];

  app.assistantWorkbenchSetEpisodeFilter('execution');
  assert.deepEqual(app.assistantWorkbenchFilteredEpisodes().map((entry) => entry.id), ['episode-2']);

  app.assistantWorkbenchSetEpisodeFilter('runtime');
  assert.deepEqual(app.assistantWorkbenchFilteredEpisodes().map((entry) => entry.id), ['episode-3']);

  app.assistantWorkbenchSetEpisodeFilter('delivery');
  assert.deepEqual(app.assistantWorkbenchFilteredEpisodes().map((entry) => entry.id), ['episode-4']);

  app.assistantWorkbenchSetEpisodeFilter('approval');
  assert.deepEqual(app.assistantWorkbenchFilteredEpisodes().map((entry) => entry.id), ['episode-5']);

  app.assistantWorkbenchSetEpisodeFilter('all');
  assert.equal(app.assistantWorkbenchFilteredEpisodes().length, 5);
});

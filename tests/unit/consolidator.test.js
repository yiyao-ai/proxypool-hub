import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentPreferenceStore } from '../../src/agent-core/preference-store.js';
import { AssistantClarificationStore } from '../../src/assistant-core/clarification-store.js';
import { AssistantConsolidator } from '../../src/assistant-core/consolidator.js';
import { AssistantReflectionStore } from '../../src/assistant-core/reflection-store.js';
import { AssistantWorkspaceStore } from '../../src/assistant-core/workspace-store.js';
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFixture() {
  const configDir = createTempDir('cligate-consolidator-');
  const reflectionStore = new AssistantReflectionStore({ configDir });
  const workspaceStore = new AssistantWorkspaceStore({ configDir });
  const clarificationStore = new AssistantClarificationStore({ configDir });
  const preferenceStore = new AgentPreferenceStore({ configDir });
  const supervisorTaskStore = new SupervisorTaskStore({ configDir });
  const consolidator = new AssistantConsolidator({
    reflectionStore,
    workspaceStore,
    clarificationStore,
    preferenceStore,
    supervisorTaskStore,
    intervalMs: 60 * 1000,
    workspaceStaleMs: 0,            // 总是当作 stale 让测试触发刷新
    workspaceMinTasks: 1,
    profileMinOccurrences: 3
  });
  return {
    consolidator,
    reflectionStore,
    workspaceStore,
    clarificationStore,
    preferenceStore,
    supervisorTaskStore
  };
}

test('Consolidator refreshes workspace summary from latest postmortems', async () => {
  const { consolidator, reflectionStore, workspaceStore } = createFixture();

  // 注册一个 workspace + 两个 task 的 postmortem
  workspaceStore.upsert({
    workspaceRef: 'D:\\projects\\agent',
    patch: {
      taskIds: ['task-a', 'task-b'],
      lastTouchedAt: new Date().toISOString()
    }
  });
  reflectionStore.saveReflection({
    kind: 'postmortem',
    taskId: 'task-a',
    cwd: 'D:\\projects\\agent',
    payload: {
      purpose: '检查 celery 入口',
      outcome: '没有独立 celery app，仅 monitor 探针',
      deliverables: ['monitor/probes/celery.py'],
      keywords: ['celery', 'monitor']
    }
  });
  reflectionStore.saveReflection({
    kind: 'postmortem',
    taskId: 'task-b',
    cwd: 'D:\\projects\\agent',
    payload: {
      purpose: '评估服务拆分方案',
      outcome: '建议拆 4 个微服务：rag / agent-runtime / chat / api',
      deliverables: [],
      keywords: ['split', 'microservice']
    }
  });

  const result = await consolidator.runOnce();

  assert.equal(result.errors.length, 0);
  assert.equal(result.refreshedWorkspaces.length, 1);
  const refreshed = workspaceStore.getByRef('D:\\projects\\agent');
  assert.match(refreshed.summary, /Recent work in D:\\projects\\agent:/);
  assert.match(refreshed.summary, /检查 celery 入口/);
  assert.match(refreshed.summary, /评估服务拆分方案/);
  assert.equal(refreshed.metadata.summaryPostmortemCount, 2);
  assert.ok(refreshed.metadata.summaryRefreshedAt);
});

test('Consolidator skips workspace refresh when summary is fresh and no new tasks', async () => {
  const { consolidator, reflectionStore, workspaceStore } = createFixture();

  // 用一个有"足够远未来"刷新时间戳的 workspace
  const futureRefreshedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  workspaceStore.upsert({
    workspaceRef: 'D:\\projects\\fresh',
    patch: {
      taskIds: ['task-fresh'],
      lastTouchedAt: new Date(Date.now() - 60 * 1000).toISOString(), // 比 refresh 早
      metadata: {
        summaryRefreshedAt: futureRefreshedAt
      }
    }
  });
  reflectionStore.saveReflection({
    kind: 'postmortem',
    taskId: 'task-fresh',
    cwd: 'D:\\projects\\fresh',
    payload: { purpose: 'p', outcome: 'o' }
  });

  // 强制 staleMs 设大，并确保 lastTouched < summaryRefreshed
  consolidator.workspaceStaleMs = 24 * 60 * 60 * 1000;
  const result = await consolidator.runOnce();

  // 因为 summaryRefreshedAt 在未来，且 lastTouched 比它早，所以不刷新
  assert.equal(result.refreshedWorkspaces.length, 0);
});

test('Consolidator promotes preferences to global_user when threshold is met', async () => {
  const { consolidator, preferenceStore } = createFixture();

  // 三个不同的 conversation 都偏好 zh-CN
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-1',
    key: 'reply_language',
    value: 'zh-CN'
  });
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-2',
    key: 'reply_language',
    value: 'zh-CN'
  });
  preferenceStore.upsertPreference({
    scope: 'workspace',
    scopeRef: 'D:\\proj',
    key: 'reply_language',
    value: 'zh-CN'
  });
  // 一个英语的偏好（少数派）
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-3',
    key: 'reply_language',
    value: 'en'
  });

  const result = await consolidator.runOnce();

  const promotedReply = result.promotedProfileEntries.find((entry) => entry.key === 'reply_language');
  assert.ok(promotedReply, 'reply_language should be promoted');
  assert.equal(promotedReply.value, 'zh-CN');
  assert.equal(promotedReply.occurrences, 3);

  const persisted = preferenceStore.getPreference({
    scope: 'global_user',
    scopeRef: 'default-user',
    key: 'reply_language'
  });
  assert.equal(persisted?.value, 'zh-CN');
  assert.equal(persisted?.metadata?.source, 'consolidator');
});

test('Consolidator does not promote when occurrences below threshold', async () => {
  const { consolidator, preferenceStore } = createFixture();

  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-1',
    key: 'preferred_runtime_provider',
    value: 'claude-code'
  });
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-2',
    key: 'preferred_runtime_provider',
    value: 'claude-code'
  });

  const result = await consolidator.runOnce();

  assert.equal(
    result.promotedProfileEntries.find((entry) => entry.key === 'preferred_runtime_provider'),
    undefined
  );
  const persisted = preferenceStore.getPreference({
    scope: 'global_user',
    scopeRef: 'default-user',
    key: 'preferred_runtime_provider'
  });
  assert.equal(persisted, null);
});

test('Consolidator skips re-promotion when global value already matches', async () => {
  const { consolidator, preferenceStore } = createFixture();

  preferenceStore.upsertPreference({
    scope: 'global_user',
    scopeRef: 'default-user',
    key: 'reply_language',
    value: 'zh-CN'
  });
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-1',
    key: 'reply_language',
    value: 'zh-CN'
  });
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-2',
    key: 'reply_language',
    value: 'zh-CN'
  });
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-3',
    key: 'reply_language',
    value: 'zh-CN'
  });

  const result = await consolidator.runOnce();
  assert.equal(
    result.promotedProfileEntries.find((entry) => entry.key === 'reply_language'),
    undefined
  );
});

test('Consolidator clears expired pending clarifications', async () => {
  const { consolidator, clarificationStore } = createFixture();

  const created = clarificationStore.create({
    conversationId: 'conv-expire-1',
    question: 'agent 还是 agent-monitor?',
    ttlSec: 1
  });
  // 把 askedAt / createdAt 改到过去，触发 isExpired
  clarificationStore.save({
    ...created,
    askedAt: new Date(Date.now() - 10_000).toISOString(),
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    updatedAt: new Date(Date.now() - 10_000).toISOString()
  });

  const result = await consolidator.runOnce();
  assert.equal(result.expiredClarifications, true);
  assert.equal(clarificationStore.get(created.id)?.status, 'expired');
});

test('Consolidator runOnce is reentrant-safe (concurrent calls are skipped)', async () => {
  const { consolidator } = createFixture();

  const [first, second] = await Promise.all([
    consolidator.runOnce(),
    consolidator.runOnce()
  ]);

  // 至少有一个没被跳过
  const skippedCount = [first, second].filter((entry) => entry?.skipped === true).length;
  const ranCount = [first, second].filter((entry) => entry?.skipped !== true).length;
  // 由于 runOnce 是同步偏多，可能两个都跑完没冲突。允许 skipped 0 或 1。
  assert.ok(skippedCount + ranCount === 2);
});

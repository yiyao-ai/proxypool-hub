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

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// 模拟 codex/claude 行为：通过 onProviderEvent 自己发了 COMPLETED，
// 然后通过 onTurnFinished 通知 session-manager turn 结束。
// 期望 session-manager 只在事件流里写入一次 COMPLETED，不做重复兜底。
class ProviderThatEmitsCompletedItself {
  constructor() {
    this.id = 'codex';
    this.capabilities = {};
  }
  async startTurn({ onProviderEvent, onTurnFinished }) {
    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: 'analysis result', itemType: 'agent_message' }
    });
    onProviderEvent({
      type: AGENT_EVENT_TYPE.COMPLETED,
      payload: {
        result: 'analysis result',
        summary: 'analysis result',
        usage: { input_tokens: 100, output_tokens: 50 }
      }
    });
    onTurnFinished({ status: 'ready', summary: 'analysis result' });
    return { pid: 5001 };
  }
}

// 旧行为：provider 不直接 emit COMPLETED，只通过 onTurnFinished 通知。
// 此时 session-manager 应当作为兜底自己发一次 COMPLETED——保证向后兼容。
class ProviderWithoutDirectCompleted {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
  }
  async startTurn({ onProviderEvent, onTurnFinished }) {
    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: 'plain reply', itemType: 'assistant' }
    });
    onTurnFinished({ status: 'ready', summary: 'plain reply done' });
    return { pid: 5002 };
  }
}

function createManager(provider, label) {
  const registry = new AgentRuntimeRegistry();
  registry.register(provider);
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir(`cligate-terminal-dedup-runtime-${label}-`)
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir(`cligate-terminal-dedup-policy-${label}-`)
    })
  });
}

test('session-manager does not re-emit COMPLETED when provider already emitted via onProviderEvent', async () => {
  const manager = createManager(new ProviderThatEmitsCompletedItself(), 'codex-style');

  const session = await manager.createSession({
    provider: 'codex',
    input: 'analyze something'
  });

  const events = manager.getEvents(session.id);
  const completedEvents = events.filter((entry) => entry.type === AGENT_EVENT_TYPE.COMPLETED);
  assert.equal(completedEvents.length, 1, 'should have exactly one COMPLETED in event stream');
  // provider 自己发的 COMPLETED 应当带 result/usage 这种富 payload
  assert.equal(completedEvents[0]?.payload?.result, 'analysis result');
  assert.ok(completedEvents[0]?.payload?.usage);
});

test('session-manager still emits COMPLETED as fallback when provider only signals via onTurnFinished', async () => {
  const manager = createManager(new ProviderWithoutDirectCompleted(), 'claude-style');

  const session = await manager.createSession({
    provider: 'claude-code',
    input: 'do something'
  });

  const events = manager.getEvents(session.id);
  const completedEvents = events.filter((entry) => entry.type === AGENT_EVENT_TYPE.COMPLETED);
  assert.equal(completedEvents.length, 1, 'fallback path still emits exactly one COMPLETED');
  assert.equal(completedEvents[0]?.payload?.summary, 'plain reply done');
});

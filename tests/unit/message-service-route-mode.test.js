import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

class FakeInteractiveProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
  }

  async startTurn({ onApprovalRequest, onQuestionRequest }) {
    onApprovalRequest({
      title: 'Need permission',
      summary: 'Run command',
      rawRequest: {
        requestId: 'approval-request-1'
      }
    });
    onQuestionRequest({
      questionId: 'question-1',
      text: 'Continue?'
    });
    return {
      pid: 888,
      respondApproval: async () => {},
      respondQuestion: async () => {},
      cancel() {}
    };
  }
}

function createInteractiveRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeInteractiveProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-message-route-mode-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-message-route-mode-policy-')
    })
  });
}

test('assistant mode does not auto-route pending approvals or questions before the main LLM', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });
  const pendingApproval = runtimeSessionManager.approvalService.listPending(started.id)[0];
  const pendingQuestion = runtimeSessionManager.listPendingQuestions(started.id)
    .find((entry) => entry.status === 'pending');

  const approvalLike = await service.routeUserMessage({
    message: { text: '同意' },
    conversation: {
      activeRuntimeSessionId: started.id,
      lastPendingApprovalId: pendingApproval.approvalId,
      lastPendingQuestionId: pendingQuestion.questionId,
      metadata: {
        assistantCore: {
          mode: 'assistant'
        }
      }
    },
    metadata: {
      assistantMode: 'assistant'
    }
  });

  assert.notEqual(approvalLike.type, 'approval_resolved');
  assert.notEqual(approvalLike.type, 'question_answered');

  const questionLike = await service.routeUserMessage({
    message: { text: '继续' },
    conversation: {
      activeRuntimeSessionId: started.id,
      lastPendingApprovalId: pendingApproval.approvalId,
      lastPendingQuestionId: pendingQuestion.questionId,
      metadata: {
        assistantCore: {
          mode: 'assistant'
        }
      }
    },
    metadata: {
      assistantMode: 'assistant'
    }
  });

  assert.notEqual(questionLike.type, 'approval_resolved');
  assert.notEqual(questionLike.type, 'question_answered');
});

test('direct-runtime mode keeps auto-routing pending approvals and questions', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });
  const pendingApproval = runtimeSessionManager.approvalService.listPending(started.id)[0];
  const pendingQuestion = runtimeSessionManager.listPendingQuestions(started.id)
    .find((entry) => entry.status === 'pending');

  const approvalResult = await service.routeUserMessage({
    message: { text: '同意' },
    conversation: {
      activeRuntimeSessionId: started.id,
      lastPendingApprovalId: pendingApproval.approvalId,
      lastPendingQuestionId: pendingQuestion.questionId,
      metadata: {
        assistantCore: {
          mode: 'direct-runtime'
        }
      }
    },
    metadata: {
      assistantMode: 'direct-runtime'
    }
  });

  assert.equal(approvalResult.type, 'approval_resolved');
  assert.equal(approvalResult.approval.status, 'approved');

  const questionResult = await service.routeUserMessage({
    message: { text: '继续' },
    conversation: {
      activeRuntimeSessionId: started.id,
      lastPendingApprovalId: null,
      lastPendingQuestionId: pendingQuestion.questionId,
      metadata: {
        assistantCore: {
          mode: 'direct-runtime'
        }
      }
    },
    metadata: {
      assistantMode: 'direct-runtime'
    }
  });

  assert.equal(questionResult.type, 'question_answered');
  assert.equal(questionResult.question.status, 'answered');
});

import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConversationRuntimeEventPatch,
  buildPendingResolutionPatch,
  buildPendingRuntimeEventPatch
} from '../../src/assistant-core/conversation-runtime-binding.js';
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('buildPendingResolutionPatch clears only the requested pending kind', () => {
  assert.deepEqual(buildPendingResolutionPatch('approval'), {
    lastPendingApprovalId: null,
    lastPendingApprovalSessionId: null
  });
  assert.deepEqual(buildPendingResolutionPatch('question'), {
    lastPendingQuestionId: null,
    lastPendingQuestionSessionId: null
  });
  assert.deepEqual(buildPendingResolutionPatch('other'), {});
});

test('buildPendingRuntimeEventPatch maps approval/question/completion events to pending marker patches', () => {
  assert.deepEqual(buildPendingRuntimeEventPatch({
    type: 'worker.approval_request',
    sessionId: 'session-a',
    payload: {
      approvalId: 'approval-a'
    }
  }), {
    lastPendingApprovalId: 'approval-a',
    lastPendingApprovalSessionId: 'session-a'
  });

  assert.deepEqual(buildPendingRuntimeEventPatch({
    type: 'worker.question',
    sessionId: 'session-q',
    payload: {
      questionId: 'question-q'
    }
  }), {
    lastPendingQuestionId: 'question-q',
    lastPendingQuestionSessionId: 'session-q'
  });

  assert.deepEqual(buildPendingRuntimeEventPatch({
    type: 'worker.approval_resolved'
  }), {
    lastPendingApprovalId: null,
    lastPendingApprovalSessionId: null
  });

  assert.deepEqual(buildPendingRuntimeEventPatch({
    type: 'worker.completed'
  }), {
    lastPendingApprovalId: null,
    lastPendingApprovalSessionId: null,
    lastPendingQuestionId: null,
    lastPendingQuestionSessionId: null
  });
});

test('buildConversationRuntimeEventPatch merges supervisor state and pending marker patch', () => {
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-conversation-runtime-binding-')
  });

  const patch = buildConversationRuntimeEventPatch({
    conversation: {
      id: 'conv-1',
      activeRuntimeSessionId: 'session-1',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: null
          }
        }
      }
    },
    session: {
      id: 'session-1',
      provider: 'codex',
      title: 'inspect repo',
      status: 'waiting_approval',
      metadata: {}
    },
    event: {
      type: 'worker.approval_request',
      sessionId: 'session-1',
      payload: {
        approvalId: 'approval-1',
        title: 'Read file'
      }
    },
    supervisorTaskStore
  });

  assert.equal(patch.lastPendingApprovalId, 'approval-1');
  assert.equal(patch.lastPendingApprovalSessionId, 'session-1');
  assert.equal(patch.metadata?.supervisor?.brief?.status, 'waiting_approval');
  assert.equal(patch.metadata?.supervisor?.taskMemory?.activeTaskId, 'session-1');
});

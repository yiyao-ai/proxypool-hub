import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveAssistantRunStopState } from '../../src/assistant-agent/stop-policy.js';
import { composeAssistantReply } from '../../src/assistant-agent/response-composer.js';

test('stop policy marks assistant_done when assistant reply is complete without runtime wait', () => {
  const stopState = deriveAssistantRunStopState({
    toolResults: [],
    assistantText: 'All done.'
  });

  assert.equal(stopState.status, 'completed');
  assert.equal(stopState.closure, 'assistant_done');
});

test('stop policy marks executor_done when tool work finished without assistant summary', () => {
  const stopState = deriveAssistantRunStopState({
    toolResults: [{
      toolName: 'list_tasks',
      result: [{ id: 'task-1' }]
    }],
    assistantText: ''
  });

  assert.equal(stopState.status, 'completed');
  assert.equal(stopState.closure, 'executor_done');
});

test('stop policy marks awaiting_summary when loop ends after tool execution without final assistant text', () => {
  const stopState = deriveAssistantRunStopState({
    toolResults: [{
      toolName: 'list_tasks',
      result: [{ id: 'task-1' }]
    }],
    assistantText: '',
    maxIterationsReached: true
  });

  assert.equal(stopState.status, 'completed');
  assert.equal(stopState.closure, 'awaiting_summary');
});

test('stop policy marks partial when runtime is still running but assistant already produced partial text', () => {
  const stopState = deriveAssistantRunStopState({
    toolResults: [{
      toolName: 'delegate_to_codex',
      result: {
        id: 'session-1',
        provider: 'codex',
        status: 'running'
      }
    }],
    assistantText: 'I started the work and have an early update.'
  });

  assert.equal(stopState.status, 'waiting_runtime');
  assert.equal(stopState.closure, 'partial');
});

test('stop policy maps waiting approvals and questions to waiting_user', () => {
  const approvalState = deriveAssistantRunStopState({
    toolResults: [{
      toolName: 'get_runtime_session',
      result: {
        session: {
          id: 'session-1',
          provider: 'claude-code',
          status: 'waiting_approval'
        },
        pendingApprovals: [{ approvalId: 'approval-1' }]
      }
    }]
  });
  const questionState = deriveAssistantRunStopState({
    toolResults: [{
      toolName: 'get_runtime_session',
      result: {
        session: {
          id: 'session-2',
          provider: 'claude-code',
          status: 'waiting_user'
        },
        pendingQuestions: [{ questionId: 'question-1' }]
      }
    }]
  });

  assert.equal(approvalState.status, 'waiting_user');
  assert.equal(approvalState.closure, 'waiting_user');
  assert.equal(approvalState.reason, 'runtime_waiting_approval');
  assert.equal(questionState.status, 'waiting_user');
  assert.equal(questionState.closure, 'waiting_user');
  assert.equal(questionState.reason, 'runtime_waiting_user_input');
});

test('response composer generates supervisor-style approval and question replies', () => {
  const approvalReply = composeAssistantReply({
    language: 'en',
    assistantText: '',
    finalStatus: 'waiting_user',
    stopReason: 'runtime_waiting_approval',
    toolResults: [{
      toolName: 'get_runtime_session',
      result: {
        title: 'Edit config',
        pendingApprovals: [{
          approvalId: 'approval-1',
          title: 'Write package.json'
        }]
      }
    }]
  });
  const questionReply = composeAssistantReply({
    language: 'en',
    assistantText: '',
    finalStatus: 'waiting_user',
    stopReason: 'runtime_waiting_user_input',
    toolResults: [{
      toolName: 'get_runtime_session',
      result: {
        title: 'Investigate bug',
        pendingQuestions: [{
          questionId: 'question-1',
          text: 'Which environment should I use?'
        }]
      }
    }]
  });

  assert.match(approvalReply.message, /waiting for your approval/i);
  assert.match(approvalReply.message, /Write package\.json/);
  assert.match(questionReply.message, /waiting for your answer/i);
  assert.match(questionReply.message, /Which environment should I use\?/);
});

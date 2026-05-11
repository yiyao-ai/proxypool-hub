import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAssistantCoreDeliveryState } from '../../src/agent-channels/conversation-delivery-arbiter.js';
import { getAssistantControlMode, isAssistantOwnedConversation } from '../../src/assistant-core/assistant-state.js';
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('buildAssistantCoreDeliveryState keeps mode/controlMode/deliveryOwnership in sync', () => {
  const assistantState = buildAssistantCoreDeliveryState({}, {
    controlMode: 'assistant'
  });
  assert.equal(assistantState.controlMode, 'assistant');
  assert.equal(assistantState.mode, 'assistant');
  assert.equal(assistantState.deliveryOwnership, 'assistant-owned');

  const runtimeState = buildAssistantCoreDeliveryState({}, {
    mode: 'direct-runtime'
  });
  assert.equal(runtimeState.controlMode, 'direct-runtime');
  assert.equal(runtimeState.mode, 'direct-runtime');
  assert.equal(runtimeState.deliveryOwnership, 'runtime-owned');
});

test('assistant state helpers prefer controlMode and only fall back to legacy mode', () => {
  const conversation = {
    metadata: {
      assistantCore: {
        controlMode: 'assistant',
        mode: 'direct-runtime'
      }
    }
  };
  assert.equal(getAssistantControlMode(conversation), 'assistant');
  assert.equal(isAssistantOwnedConversation(conversation), true);

  const legacyConversation = {
    metadata: {
      assistantCore: {
        mode: 'assistant'
      }
    }
  };
  assert.equal(getAssistantControlMode(legacyConversation), 'assistant');
  assert.equal(isAssistantOwnedConversation(legacyConversation), true);
});

test('conversation store normalizes assistantCore state for persisted conversations', () => {
  const store = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-state-model-conv-')
  });

  const conversation = store.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-state-chat-1',
    externalUserId: 'user-1',
    title: 'tester / telegram',
    metadata: {
      assistantCore: {
        controlMode: 'assistant'
      }
    }
  });

  assert.equal(conversation.metadata?.assistantCore?.controlMode, 'assistant');
  assert.equal(conversation.metadata?.assistantCore?.mode, 'assistant');
  assert.equal(conversation.metadata?.assistantCore?.deliveryOwnership, 'assistant-owned');
});

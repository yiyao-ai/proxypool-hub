import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChannelsConfig } from '../../src/server-settings.js';

test('normalizeChannelsConfig removes legacy per-channel model fields from instances', () => {
  const normalized = normalizeChannelsConfig({
    telegram: {
      instances: [{
        id: 'default',
        label: 'Default',
        enabled: true,
        model: 'gpt-5.4',
        defaultRuntimeProvider: 'codex'
      }]
    },
    feishu: {
      enabled: true,
      model: 'gpt-5.4',
      defaultRuntimeProvider: 'claude-code'
    },
    dingtalk: {
      instances: [{
        id: 'work',
        label: 'Work',
        enabled: true,
        model: 'gpt-5.4',
        defaultRuntimeProvider: 'claude-code'
      }]
    }
  });

  assert.equal('model' in normalized.telegram.instances[0], false);
  assert.equal('model' in normalized.feishu.instances[0], false);
  assert.equal('model' in normalized.dingtalk.instances[0], false);
  assert.equal(normalized.telegram.instances[0].defaultRuntimeProvider, 'codex');
  assert.equal(normalized.feishu.instances[0].defaultRuntimeProvider, 'claude-code');
  assert.equal(normalized.dingtalk.instances[0].defaultRuntimeProvider, 'claude-code');
});

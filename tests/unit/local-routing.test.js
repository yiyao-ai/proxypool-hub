import test from 'node:test';
import assert from 'node:assert/strict';

import { setServerSettings } from '../../src/server-settings.js';
import { updateLocalRuntime } from '../../src/local-runtime-manager.js';
import { tryHandleLocalAnthropic } from '../../src/local-routing.js';

function createMockRes() {
  return {
    headers: new Map(),
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    flushHeaders() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send() {
      this.writableEnded = true;
      return this;
    },
    end() {
      this.writableEnded = true;
    }
  };
}

test('tryHandleLocalAnthropic returns false when Ollama is unreachable instead of throwing', async () => {
  const originalFetch = global.fetch;
  const previousSettings = setServerSettings({});
  const previousRoutingEnabled = previousSettings.localModelRoutingEnabled;
  const previousRuntime = updateLocalRuntime('ollama-local', {});

  setServerSettings({ localModelRoutingEnabled: true });
  updateLocalRuntime('ollama-local', {
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434'
  });

  global.fetch = async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    cause.code = 'ECONNREFUSED';
    throw new TypeError('fetch failed', { cause });
  };

  try {
    const req = {
      headers: {
        'anthropic-version': '2023-06-01'
      }
    };
    const res = createMockRes();
    const result = await tryHandleLocalAnthropic(req, res, {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    }, {
      appId: 'claude-code',
      requestedModel: 'claude-opus-4-6'
    });

    assert.equal(result, false);
    assert.equal(res.writableEnded, false);
  } finally {
    global.fetch = originalFetch;
    setServerSettings({ localModelRoutingEnabled: previousRoutingEnabled });
    updateLocalRuntime('ollama-local', previousRuntime);
  }
});

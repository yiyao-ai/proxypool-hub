import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentPreferenceStore } from '../../src/agent-core/preference-store.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import { AssistantMemoryService } from '../../src/assistant-core/memory-service.js';
import { AssistantPolicyService } from '../../src/assistant-core/policy-service.js';
import {
  handleGetAssistantMemory,
  handleGetAssistantPolicies
} from '../../src/routes/assistant-memory-route.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

test('assistant memory and policy routes return scoped records and merged memory', async () => {
  const preferenceStore = new AgentPreferenceStore({
    configDir: createTempDir('cligate-assistant-memory-route-pref-')
  });
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-assistant-memory-route-policy-')
  });
  const memoryService = new AssistantMemoryService({ preferenceStore });
  const policyService = new AssistantPolicyService({ approvalPolicyStore });

  preferenceStore.upsertPreference({
    scope: 'workspace',
    scopeRef: 'D:\\repo',
    key: 'preferred_runtime_provider',
    value: 'claude-code'
  });
  approvalPolicyStore.createPolicy({
    scope: 'workspace',
    scopeRef: 'D:\\repo',
    provider: 'claude-code',
    toolName: 'Read'
  });

  const memorySingleton = (await import('../../src/assistant-core/memory-service.js')).default;
  const policySingleton = (await import('../../src/assistant-core/policy-service.js')).default;
  const originalResolve = memorySingleton.resolvePreferences;
  const originalListMemory = memorySingleton.listMemory;
  const originalListPolicies = policySingleton.listPolicies;
  memorySingleton.resolvePreferences = memoryService.resolvePreferences.bind(memoryService);
  memorySingleton.listMemory = memoryService.listMemory.bind(memoryService);
  policySingleton.listPolicies = policyService.listPolicies.bind(policyService);

  try {
    const mergedRes = mockRes();
    handleGetAssistantMemory({ query: { cwd: 'D:\\repo' } }, mergedRes);
    assert.equal(mergedRes._status, 200);
    assert.equal(mergedRes._body.memory.values.preferred_runtime_provider, 'claude-code');

    const scopedRes = mockRes();
    handleGetAssistantMemory({ query: { scope: 'workspace', scopeRef: 'D:\\repo' } }, scopedRes);
    assert.equal(scopedRes._body.records.length, 1);

    const policyRes = mockRes();
    handleGetAssistantPolicies({ query: { scope: 'workspace', scopeRef: 'D:\\repo' } }, policyRes);
    assert.equal(policyRes._body.policies.length, 1);

    const invalidRes = mockRes();
    handleGetAssistantPolicies({ query: {} }, invalidRes);
    assert.equal(invalidRes._status, 400);
  } finally {
    memorySingleton.resolvePreferences = originalResolve;
    memorySingleton.listMemory = originalListMemory;
    policySingleton.listPolicies = originalListPolicies;
  }
});

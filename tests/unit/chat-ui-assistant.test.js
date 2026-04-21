import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleChatWithSource, handleConfirmAssistantToolAction } from '../../src/routes/chat-ui-route.js';
import { createPendingAssistantAction } from '../../src/assistant/tool-executor.js';
import { prepareAssistantRequest } from '../../src/assistant/assistant-chat-service.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

function mockReq(body = {}) {
  return {
    body,
    app: { locals: { port: 8081 } },
    socket: { localPort: 8081 }
  };
}

test('handleChatWithSource returns a pending action for Claude proxy enable requests in assistant mode', async () => {
  const req = mockReq({
    sourceId: 'chatgpt:test@example.com',
    model: 'gpt-5.2',
    assistantMode: true,
    uiLang: 'zh',
    messages: [
      { role: 'user', content: '帮我设置 Claude Code 使用代理' }
    ]
  });
  const res = mockRes();

  await handleChatWithSource(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.reply.role, 'assistant');
  assert.equal(res._body.assistant.intent, 'tool_request');
  assert.equal(res._body.reply.pendingAction.toolName, 'enable_claude_code_proxy');
  assert.ok(res._body.reply.pendingAction.confirmToken);
});

test('handleConfirmAssistantToolAction validates missing confirm token', async () => {
  const req = mockReq({});
  const res = mockRes();

  await handleConfirmAssistantToolAction(req, res);

  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleConfirmAssistantToolAction executes pending Claude proxy action against temp config path', async () => {
  const originalConfigPath = process.env.CLAUDE_CONFIG_PATH;
  const tempConfigDir = mkdtempSync(join(tmpdir(), 'cligate-claude-config-'));
  process.env.CLAUDE_CONFIG_PATH = tempConfigDir;

  try {
    const pendingAction = createPendingAssistantAction('enable_claude_code_proxy', {
      language: 'en',
      port: 8081
    });

    const req = mockReq({
      confirmToken: pendingAction.confirmToken
    });
    const res = mockRes();

    await handleConfirmAssistantToolAction(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.match(res._body.result, /proxy mode/i);
    assert.ok(res._body.configPath.endsWith('settings.json'));

    const persisted = JSON.parse(readFileSync(res._body.configPath, 'utf8'));
    assert.equal(persisted.env.ANTHROPIC_BASE_URL, 'http://localhost:8081');
    assert.equal(persisted.env.ANTHROPIC_API_KEY, 'sk-ant-claude-code-proxy');
  } finally {
    if (originalConfigPath === undefined) {
      delete process.env.CLAUDE_CONFIG_PATH;
    } else {
      process.env.CLAUDE_CONFIG_PATH = originalConfigPath;
    }
  }
});

test('handleChatWithSource returns saved preference confirmation for assistant session preference input', async () => {
  const req = mockReq({
    sourceId: 'unsupported:test',
    model: 'gpt-5.2',
    assistantMode: true,
    sessionId: 'chat-session-pref-1',
    uiLang: 'zh',
    messages: [
      { role: 'user', content: '记住：以后默认用中文，并且回答简洁一些。' }
    ]
  });
  const res = mockRes();

  await handleChatWithSource(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.assistant.intent, 'preference_saved');
  assert.match(String(res._body.reply.content || ''), /Preference saved:/);
  assert.equal(res._body.reply.usage, null);
});

test('prepareAssistantRequest applies remembered session preferences to later assistant requests', () => {
  const sessionId = `chat-session-pref-${Date.now()}`;

  const saved = prepareAssistantRequest({
    uiLang: 'en',
    sessionId,
    messages: [{ role: 'user', content: 'Remember: always reply in Chinese and keep replies concise.' }]
  });

  assert.equal(saved.intent.type, 'preference_saved');

  const prepared = prepareAssistantRequest({
    uiLang: 'en',
    sessionId,
    messages: [{ role: 'user', content: 'How do I use Claude Code with a proxy?' }]
  });

  assert.equal(prepared.language, 'zh-CN');
  assert.equal(prepared.preferences.response_style, 'concise');
  assert.equal(prepared.intent.type, 'manual_qa');
  assert.match(String(prepared.messages?.[0]?.content || ''), /回答保持简洁|Keep answers concise/i);
});

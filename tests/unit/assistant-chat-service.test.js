import test from 'node:test';
import assert from 'node:assert/strict';

import { detectMessageLanguage, resolveManualLanguage } from '../../src/assistant/language-service.js';
import { detectAssistantIntent } from '../../src/assistant/intent-service.js';
import { getManualContext } from '../../src/assistant/manual-service.js';
import { prepareAssistantRequest } from '../../src/assistant/assistant-chat-service.js';

test('detectMessageLanguage detects Chinese content', () => {
  const language = detectMessageLanguage([
    { role: 'user', content: '请告诉我怎么配置 Claude Code 使用代理' }
  ], 'en');

  assert.equal(language, 'zh-CN');
});

test('resolveManualLanguage prefers detected message language over UI fallback', () => {
  const language = resolveManualLanguage({
    uiLang: 'en',
    messages: [{ role: 'user', content: '如何使用这个产品？' }]
  });

  assert.equal(language, 'zh-CN');
});

test('detectAssistantIntent classifies manual questions and tool requests', () => {
  assert.equal(
    detectAssistantIntent([{ role: 'user', content: '这个产品怎么用？' }]).type,
    'manual_qa'
  );

  assert.equal(
    detectAssistantIntent([{ role: 'user', content: '帮我设置 Claude Code 使用代理' }]).type,
    'tool_request'
  );
});

test('getManualContext returns relevant sections from the selected manual language', () => {
  const context = getManualContext({
    language: 'zh-CN',
    query: 'Claude Code 使用代理'
  });

  assert.equal(context.language, 'zh-CN');
  assert.ok(context.contextText.includes('Claude Code'));
  assert.ok(Array.isArray(context.citations));
  assert.ok(context.citations.length > 0);
});

test('prepareAssistantRequest leaves general chat unchanged when no manual intent is detected', () => {
  const messages = [{ role: 'user', content: 'Hello there' }];
  const prepared = prepareAssistantRequest({
    uiLang: 'en',
    messages
  });

  assert.equal(prepared.intent.type, 'general');
  assert.equal(prepared.messages, messages);
  assert.equal(prepared.manualContext, null);
  assert.deepEqual(prepared.citations, []);
});

test('prepareAssistantRequest injects manual context for manual questions', () => {
  const prepared = prepareAssistantRequest({
    uiLang: 'zh',
    messages: [{ role: 'user', content: 'Claude Code 怎么使用代理？' }]
  });

  assert.equal(prepared.intent.type, 'manual_qa');
  assert.equal(prepared.language, 'zh-CN');
  assert.ok(Array.isArray(prepared.messages));
  assert.equal(prepared.messages[0].role, 'system');
  assert.match(prepared.messages[0].content, /产品使用说明书/);
  assert.ok(prepared.citations.length > 0);
});

test('prepareAssistantRequest applies remembered scoped preferences to later general chat', () => {
  const sessionId = `assistant-pref-${Date.now()}`;

  const saved = prepareAssistantRequest({
    uiLang: 'en',
    sessionId,
    messages: [{ role: 'user', content: 'Remember: always reply in Chinese and keep replies concise.' }]
  });

  assert.equal(saved.intent.type, 'preference_saved');

  const prepared = prepareAssistantRequest({
    uiLang: 'en',
    sessionId,
    messages: [{ role: 'user', content: 'Summarize the current features.' }]
  });

  assert.equal(prepared.intent.type, 'general');
  assert.equal(prepared.language, 'zh-CN');
  assert.equal(prepared.preferences.response_style, 'concise');
  assert.equal(prepared.messages[0].role, 'system');
  assert.match(String(prepared.messages[0].content || ''), /回答保持简洁|Keep answers concise/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';

function normalizeModelMappingProvider(type) {
  switch (type) {
    case 'openai':
    case 'moonshot':
    case 'minimax':
    case 'zhipu':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
      return 'gemini';
    case 'vertex-ai':
      return 'vertex-ai';
    case 'deepseek':
      return 'deepseek';
    default:
      return type || null;
  }
}

test('normalizeModelMappingProvider folds OpenAI-compatible providers into the openai mapping family', () => {
  assert.equal(normalizeModelMappingProvider('openai'), 'openai');
  assert.equal(normalizeModelMappingProvider('moonshot'), 'openai');
  assert.equal(normalizeModelMappingProvider('minimax'), 'openai');
  assert.equal(normalizeModelMappingProvider('zhipu'), 'openai');
});

test('normalizeModelMappingProvider preserves native mapping families', () => {
  assert.equal(normalizeModelMappingProvider('anthropic'), 'anthropic');
  assert.equal(normalizeModelMappingProvider('gemini'), 'gemini');
  assert.equal(normalizeModelMappingProvider('vertex-ai'), 'vertex-ai');
  assert.equal(normalizeModelMappingProvider('deepseek'), 'deepseek');
});

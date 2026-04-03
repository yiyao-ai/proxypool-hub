import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { translateAnthropicToOpenAIResponsesRequest } from '../../src/translators/request/anthropic-to-openai-responses.js';
import { translateOpenAIResponsesToAnthropicMessage } from '../../src/translators/response/openai-responses-to-anthropic.js';
import { streamOpenAIResponsesAsAnthropicEvents } from '../../src/translators/response/openai-responses-sse-to-anthropic-sse.js';

function loadFixture(...parts) {
  return JSON.parse(readFileSync(join('tests', 'fixtures', 'translators', ...parts), 'utf8'));
}

function createSseResponse(events) {
  const payload = events.map(event => `data: ${JSON.stringify(event)}\n`).join('') + '\n';
  return new Response(payload, {
    headers: {
      'Content-Type': 'text/event-stream'
    }
  });
}

for (const fixture of loadFixture('request', 'anthropic-to-openai-responses.json')) {
  test(`translator fixture request: ${fixture.name}`, () => {
    const result = translateAnthropicToOpenAIResponsesRequest(fixture.input, fixture.context || {});

    if (fixture.assert.model) assert.equal(result.model, fixture.assert.model);
    if ('stream' in fixture.assert) assert.equal(result.stream, fixture.assert.stream);
    if ('instructions' in fixture.assert) assert.equal(result.instructions, fixture.assert.instructions);
    if ('tool_choice' in fixture.assert) assert.deepEqual(result.tool_choice, fixture.assert.tool_choice);
    if ('toolsLength' in fixture.assert) assert.equal(result.tools.length, fixture.assert.toolsLength);
    if ('unsupportedToolsLength' in fixture.assert) assert.equal(result.__translatorMeta.unsupportedTools.length, fixture.assert.unsupportedToolsLength);
    if ('unsupportedHostedType' in fixture.assert) assert.equal(result.__translatorMeta.unsupportedTools[0].hostedType, fixture.assert.unsupportedHostedType);
    if ('toolChoiceReason' in fixture.assert) assert.equal(result.__translatorMeta.toolChoiceMeta.reason, fixture.assert.toolChoiceReason);
    if (fixture.assert.firstInputContentTypes) {
      assert.deepEqual(result.input[0].content.map(item => item.type), fixture.assert.firstInputContentTypes);
    }
  });
}

for (const fixture of loadFixture('response', 'openai-responses-to-anthropic.json')) {
  test(`translator fixture response: ${fixture.name}`, () => {
    const result = translateOpenAIResponsesToAnthropicMessage(fixture.input, fixture.context || {});

    if ('model' in fixture.assert) assert.equal(result.model, fixture.assert.model);
    if ('stop_reason' in fixture.assert) assert.equal(result.stop_reason, fixture.assert.stop_reason);
    if (fixture.assert.contentTypes) assert.deepEqual(result.content.map(item => item.type), fixture.assert.contentTypes);
    if (fixture.assert.usage) assert.deepEqual(result.usage, fixture.assert.usage);
    if ('firstText' in fixture.assert) assert.equal(result.content[0].text, fixture.assert.firstText);
  });
}

for (const fixture of loadFixture('sse', 'openai-responses-sse.json')) {
  test(`translator fixture sse: ${fixture.name}`, async () => {
    const response = createSseResponse(fixture.events);
    const events = [];

    for await (const event of streamOpenAIResponsesAsAnthropicEvents(response, fixture.model)) {
      events.push(event);
    }

    if (fixture.assert.eventTypes) {
      assert.deepEqual(events.slice(0, fixture.assert.eventTypes.length).map(event => event.event), fixture.assert.eventTypes);
    }
    assert.equal(events.at(-2).data.delta.stop_reason, fixture.assert.stop_reason);
    if ('output_tokens' in fixture.assert) {
      assert.equal(events.at(-2).data.usage.output_tokens, fixture.assert.output_tokens);
    }
  });
}

for (const fixture of loadFixture('roundtrip', 'anthropic-responses-anthropic.json')) {
  test(`translator fixture roundtrip: ${fixture.name}`, () => {
    const responsesRequest = translateAnthropicToOpenAIResponsesRequest(fixture.request, { stream: false });

    if ('functionCallId' in fixture.assert) {
      const functionCall = responsesRequest.input.find(item => item.type === 'function_call');
      assert.equal(functionCall.call_id, fixture.assert.functionCallId);

      const roundTripped = translateOpenAIResponsesToAnthropicMessage({
        model: responsesRequest.model,
        output: [functionCall],
        usage: { input_tokens: 2, output_tokens: 1 }
      }, {
        requestEcho: responsesRequest.__translatorMeta?.requestEcho
      });

      assert.equal(roundTripped.content[0].id, fixture.assert.toolUseId);
      assert.equal(roundTripped.content[0].name, fixture.assert.toolName);
      assert.equal(roundTripped.stop_reason, fixture.assert.stop_reason);
    }

    if ('inputFileName' in fixture.assert) {
      const userMessage = responsesRequest.input.find(item => item.type === 'message' && item.role === 'user');
      assert.equal(userMessage.content[0].filename, fixture.assert.inputFileName);

      const roundTripped = translateOpenAIResponsesToAnthropicMessage({
        model: responsesRequest.model,
        output: [{
          type: 'message',
          content: userMessage.content
        }],
        usage: { input_tokens: 4, output_tokens: 2 }
      }, {
        requestEcho: responsesRequest.__translatorMeta?.requestEcho
      });

      assert.equal(roundTripped.content[0].type, fixture.assert.outputType);
      assert.equal(roundTripped.content[0].source.media_type, fixture.assert.outputMediaType);
    }
  });
}

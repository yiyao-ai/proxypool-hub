const ASSISTANT_SYSTEM_PROMPTS = {
  'zh-CN': [
    '你是 CliGate 的产品助手。',
    '优先依据提供的产品使用说明书回答。',
    '如果说明书没有明确写到，就直接说明未在说明书中找到，不要编造。',
    '回答尽量简洁，并尽量引用相关章节名称。'
  ].join(' '),
  en: [
    'You are the CliGate product assistant.',
    'Prioritize the provided product manual when answering.',
    'If the manual does not state something clearly, say it was not found in the manual and do not invent details.',
    'Keep answers concise and cite the relevant section titles when possible.'
  ].join(' ')
};

export function buildAssistantMessages(messages, { manualContext, language, intent, preferences = {} } = {}) {
  const systemParts = [ASSISTANT_SYSTEM_PROMPTS[language] || ASSISTANT_SYSTEM_PROMPTS.en];

  if (preferences.response_style === 'detailed') {
    systemParts.push(
      language === 'zh-CN'
        ? '回答时可以更详细一些，但仍需保持准确，不要编造信息。'
        : 'You may answer in more detail, but keep the response accurate and do not invent information.'
    );
  }

  if (preferences.response_style === 'concise') {
    systemParts.push(
      language === 'zh-CN'
        ? '回答保持简洁，优先直接给出结论。'
        : 'Keep answers concise and prioritize direct conclusions.'
    );
  }

  if (intent?.type === 'manual_qa' || intent?.type === 'tool_request') {
    systemParts.push(
      language === 'zh-CN'
        ? `以下是产品使用说明书摘录，请优先基于这些内容回答：\n\n${manualContext.contextText}`
        : `Below are excerpts from the product manual. Prioritize these excerpts when answering:\n\n${manualContext.contextText}`
    );
  }

  const mergedSystem = systemParts.join('\n\n');
  const sanitizedMessages = Array.isArray(messages) ? messages : [];
  const existingSystem = sanitizedMessages
    .filter((message) => message?.role === 'system' && typeof message.content === 'string' && message.content.trim())
    .map((message) => message.content.trim());

  const nonSystemMessages = sanitizedMessages.filter((message) => message?.role !== 'system');

  return [
    { role: 'system', content: [...existingSystem, mergedSystem].join('\n\n') },
    ...nonSystemMessages
  ];
}

export default {
  buildAssistantMessages
};

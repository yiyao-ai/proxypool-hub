function truncate(value, limit = 220) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function firstSentence(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const match = source.match(/^(.+?[。.!?！？])(?:\s|$)/);
  return truncate(match ? match[1] : source, 160);
}

function collectPendingContext(toolResults = []) {
  for (const entry of [...toolResults].reverse()) {
    const result = entry?.result;
    if (!result || typeof result !== 'object') continue;
    const title = String(result?.title || result?.session?.title || '').trim();
    const approvals = Array.isArray(result?.pendingApprovals)
      ? result.pendingApprovals
      : [];
    const questions = Array.isArray(result?.pendingQuestions)
      ? result.pendingQuestions
      : [];
    if (approvals.length > 0 || Number(result?.pendingApprovals || 0) > 0) {
      return {
        kind: 'approval',
        title,
        detail: String(approvals[0]?.title || approvals[0]?.summary || '').trim()
      };
    }
    if (questions.length > 0 || Number(result?.pendingQuestions || 0) > 0) {
      return {
        kind: 'question',
        title,
        detail: String(questions[0]?.text || '').trim()
      };
    }
  }
  return null;
}

export function composeAssistantReply({
  language = 'en',
  assistantText = '',
  toolResults = [],
  finalStatus = 'completed',
  stopReason = ''
} = {}) {
  const text = String(assistantText || '').trim();
  if (text) {
    return {
      message: text,
      summary: firstSentence(text) || truncate(text, 160)
    };
  }

  const latestSummary = [...toolResults]
    .reverse()
    .map((entry) => entry?.summary || entry?.result?.summary || '')
    .find(Boolean);

  if (latestSummary) {
    return {
      message: String(latestSummary),
      summary: truncate(latestSummary, 160)
    };
  }

  if (language === 'zh-CN') {
    if (finalStatus === 'waiting_user') {
      const pending = collectPendingContext(toolResults);
      if (stopReason === 'runtime_waiting_approval') {
        return {
          message: pending?.detail
            ? `当前有一个任务在等待你的批准：${pending.detail}`
            : '当前有一个任务在等待你的批准，我收到你的决定后会继续推进。',
          summary: pending?.title
            ? `等待批准: ${truncate(pending.title, 120)}`
            : '等待批准'
        };
      }
      if (stopReason === 'runtime_waiting_user_input') {
        return {
          message: pending?.detail
            ? `当前有一个任务在等你回答：${pending.detail}`
            : '当前有一个任务在等你补充回答，我收到后会继续推进。',
          summary: pending?.title
            ? `等待回复: ${truncate(pending.title, 120)}`
            : '等待用户回复'
        };
      }
      return {
        message: '我已经推进到需要你回应的步骤，等你回复后我会继续。',
        summary: '等待用户回应'
      };
    }
    if (finalStatus === 'waiting_runtime') {
      return {
        message: '我已经开始推进这个任务，后台完成后会继续汇总结果。',
        summary: '后台执行中'
      };
    }
    return {
      message: '我已经处理完这次请求。',
      summary: '请求已处理'
    };
  }

  if (finalStatus === 'waiting_user') {
    const pending = collectPendingContext(toolResults);
    if (stopReason === 'runtime_waiting_approval') {
      return {
        message: pending?.detail
          ? `One task is waiting for your approval: ${pending.detail}`
          : 'One task is waiting for your approval before I can continue.',
        summary: pending?.title
          ? `Waiting for approval: ${truncate(pending.title, 120)}`
          : 'Waiting for approval'
      };
    }
    if (stopReason === 'runtime_waiting_user_input') {
      return {
        message: pending?.detail
          ? `One task is waiting for your answer: ${pending.detail}`
          : 'One task is waiting for your answer before I can continue.',
        summary: pending?.title
          ? `Waiting for user reply: ${truncate(pending.title, 120)}`
          : 'Waiting for user reply'
      };
    }
    return {
      message: 'I have moved this forward and now I need your reply before I can continue.',
      summary: 'Waiting for user input'
    };
  }
  if (finalStatus === 'waiting_runtime') {
    return {
      message: 'I have started the work and will continue once the runtime progresses.',
      summary: 'Running in background'
    };
  }
  return {
    message: 'I have handled this request.',
    summary: 'Request handled'
  };
}

export default {
  composeAssistantReply
};

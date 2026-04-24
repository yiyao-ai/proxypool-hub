import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';

const RAW_RESULT_MAX_LENGTH = 900;
const SUMMARY_SNIPPET_MAX_LENGTH = 480;

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function shortenSingleLine(text, maxLength = SUMMARY_SNIPPET_MAX_LENGTH) {
  const normalized = normalizeText(text).replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function extractCandidatePaths(text) {
  const matches = text.match(/[A-Za-z]:\\[^\s"'<>|]+|\/[A-Za-z0-9._\-\/]+(?:\.[A-Za-z0-9]+)?/g) || [];
  return [...new Set(matches.map((item) => item.trim()).filter(Boolean))].slice(0, 4);
}

function detectWriteOutcome(text) {
  const normalized = text.toLowerCase();
  if (
    normalized.includes('read-only') ||
    normalized.includes('read only') ||
    normalized.includes('cannot write') ||
    normalized.includes("can't write") ||
    normalized.includes('could not write') ||
    normalized.includes('could not create') ||
    normalized.includes("can't create")
  ) {
    return 'write_blocked';
  }

  if (
    normalized.includes('created file') ||
    normalized.includes('wrote file') ||
    normalized.includes('saved to') ||
    normalized.includes('written to') ||
    normalized.includes('file created') ||
    normalized.includes('已写入') ||
    normalized.includes('创建了文件') ||
    normalized.includes('保存到')
  ) {
    return 'write_success';
  }

  return null;
}

function buildCompletedMessage({ providerLabel, session, resultText, summaryText }) {
  const raw = resultText || summaryText;
  if (!raw) {
    return {
      text: `${providerLabel} task completed.`,
      fullText: `${providerLabel} task completed.`
    };
  }

  return {
    text: raw,
    fullText: raw
  };
}

function buildApprovalMessage(providerLabel, payload = {}) {
  const lines = [];
  lines.push(`${providerLabel} needs permission so this task can continue.`);
  if (payload?.title) {
    lines.push(`Request: ${payload.title}`);
  }
  if (payload?.summary) {
    lines.push(payload.summary);
  }
  lines.push('Reply with: 同意 / approve / ok, 拒绝 / deny / no, or say “本会话允许这个目录后续操作”.');
  return lines.join('\n\n').trim();
}

export function formatAgentRuntimeEventForChannel({ event, session } = {}) {
  const providerLabel = session?.provider || event?.payload?.provider || 'agent';
  const taskTitle = event?.payload?.title || session?.title || 'Untitled task';

  switch (event?.type) {
    case AGENT_EVENT_TYPE.STARTED:
      return {
        text: `Task started: ${taskTitle} (${providerLabel})`,
        buttons: []
      };
    case AGENT_EVENT_TYPE.APPROVAL_REQUEST:
      return {
        text: buildApprovalMessage(providerLabel, event?.payload || {}),
        buttons: [
          { id: 'approve', text: 'Approve', action: 'approve', approvalId: event?.payload?.approvalId },
          { id: 'deny', text: 'Deny', action: 'deny', approvalId: event?.payload?.approvalId }
        ]
      };
    case AGENT_EVENT_TYPE.QUESTION:
      return {
        text: `Task needs your reply: ${event?.payload?.text || ''}`.trim(),
        buttons: []
      };
    case AGENT_EVENT_TYPE.COMPLETED:
      {
        const resultText = String(event?.payload?.result || '').trim();
        const summaryText = String(event?.payload?.summary || session?.summary || '').trim();
        const completed = buildCompletedMessage({
          providerLabel,
          session,
          resultText,
          summaryText
        });
        if (completed?.text) {
          return {
            text: completed.text,
            fullText: completed.fullText || completed.text,
            buttons: []
          };
        }
      }
      return {
        text: `Task completed: ${taskTitle}`,
        fullText: `Task completed: ${taskTitle}`,
        buttons: []
      };
    case AGENT_EVENT_TYPE.FAILED:
      return {
        text: `Task failed: ${taskTitle}${event?.payload?.message || session?.error ? `\n${event?.payload?.message || session?.error}` : ''}`,
        buttons: []
      };
    default:
      return null;
  }
}

export default {
  formatAgentRuntimeEventForChannel
};

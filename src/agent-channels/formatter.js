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
    return `${providerLabel} task completed.`;
  }

  if (raw.length <= RAW_RESULT_MAX_LENGTH) {
    return raw;
  }

  const snippet = shortenSingleLine(raw);
  const paths = extractCandidatePaths(raw);
  const writeOutcome = detectWriteOutcome(raw);
  const lines = [`${providerLabel} task completed.`];

  if (snippet) {
    lines.push(`Summary: ${snippet}`);
  }

  if (writeOutcome === 'write_success' && paths.length > 0) {
    lines.push(`Files: ${paths.join(', ')}`);
  } else if (writeOutcome === 'write_blocked') {
    lines.push('Write status: the runtime reported it could not write files in the current environment.');
    if (session?.cwd) {
      lines.push(`Working directory: ${session.cwd}`);
    }
    if (paths.length > 0) {
      lines.push(`Referenced paths: ${paths.join(', ')}`);
    }
  } else if (paths.length > 0) {
    lines.push(`Related paths: ${paths.join(', ')}`);
  }

  if (session?.id) {
    lines.push(`Full output is available in CliGate session ${session.id}.`);
  }

  return lines.join('\n');
}

export function formatAgentRuntimeEventForChannel({ event, session } = {}) {
  const providerLabel = session?.provider || event?.payload?.provider || 'agent';

  switch (event?.type) {
    case AGENT_EVENT_TYPE.STARTED:
      return {
        text: `${providerLabel} task started: ${event?.payload?.title || session?.title || 'Untitled task'}`,
        buttons: []
      };
    case AGENT_EVENT_TYPE.APPROVAL_REQUEST:
      return {
        text: `${providerLabel} requires approval: ${event?.payload?.title || 'Permission request'}\n${event?.payload?.summary || ''}`.trim(),
        buttons: [
          { id: 'approve', text: 'Approve', action: 'approve', approvalId: event?.payload?.approvalId },
          { id: 'deny', text: 'Deny', action: 'deny', approvalId: event?.payload?.approvalId }
        ]
      };
    case AGENT_EVENT_TYPE.QUESTION:
      return {
        text: `${providerLabel} asks: ${event?.payload?.text || ''}`.trim(),
        buttons: []
      };
    case AGENT_EVENT_TYPE.COMPLETED:
      {
        const resultText = String(event?.payload?.result || '').trim();
        const summaryText = String(event?.payload?.summary || session?.summary || '').trim();
        const finalText = buildCompletedMessage({
          providerLabel,
          session,
          resultText,
          summaryText
        });
        if (finalText) {
          return {
            text: finalText,
            buttons: []
          };
        }
      }
      return {
        text: `${providerLabel} task completed.`,
        buttons: []
      };
    case AGENT_EVENT_TYPE.FAILED:
      return {
        text: `${providerLabel} task failed: ${event?.payload?.message || session?.error || 'Unknown error'}`,
        buttons: []
      };
    default:
      return null;
  }
}

export default {
  formatAgentRuntimeEventForChannel
};

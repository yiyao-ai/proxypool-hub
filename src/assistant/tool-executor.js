import crypto from 'crypto';

import { getClaudeConfigPath, readClaudeConfig, setDirectMode, setProxyMode } from '../claude-config.js';

// Chat assistant compatibility layer only.
// Pending confirm actions for ordinary chat stay here; /cligate run semantics belong to assistant-core/assistant-agent.

const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;
const pendingActions = new Map();

function cleanupExpiredActions() {
  const now = Date.now();
  for (const [token, action] of pendingActions.entries()) {
    if (action.expiresAt <= now) {
      pendingActions.delete(token);
    }
  }
}

function buildLocalizedAction(actionName, { language = 'en', port } = {}) {
  if (actionName === 'enable_claude_code_proxy') {
    const proxyUrl = `http://localhost:${port}`;
    if (language === 'zh-CN') {
      return {
        toolName: actionName,
        title: '设置 Claude Code 使用代理',
        summary: `将 Claude Code 配置为通过本地代理 ${proxyUrl} 访问。`,
        confirmLabel: '确认执行'
      };
    }
    return {
      toolName: actionName,
      title: 'Enable Claude Code Proxy',
      summary: `Configure Claude Code to use the local proxy at ${proxyUrl}.`,
      confirmLabel: 'Confirm'
    };
  }

  if (language === 'zh-CN') {
    return {
      toolName: actionName,
      title: '取消 Claude Code 代理',
      summary: '移除 Claude Code 的代理配置并恢复直连模式。',
      confirmLabel: '确认执行'
    };
  }

  return {
    toolName: actionName,
    title: 'Disable Claude Code Proxy',
    summary: 'Remove the Claude Code proxy configuration and restore direct mode.',
    confirmLabel: 'Confirm'
  };
}

export function createPendingAssistantAction(actionName, { language = 'en', port } = {}) {
  cleanupExpiredActions();

  const token = crypto.randomUUID();
  const preview = buildLocalizedAction(actionName, { language, port });

  pendingActions.set(token, {
    token,
    actionName,
    language,
    port,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_ACTION_TTL_MS
  });

  return {
    ...preview,
    confirmToken: token
  };
}

export async function executePendingAssistantAction(confirmToken) {
  cleanupExpiredActions();

  const pending = pendingActions.get(confirmToken);
  if (!pending) {
    return {
      success: false,
      error: pendingActionErrorMessage('expired_or_missing', 'en')
    };
  }

  pendingActions.delete(confirmToken);

  try {
    let config;
    if (pending.actionName === 'enable_claude_code_proxy') {
      const proxyUrl = `http://localhost:${pending.port}`;
      config = await setProxyMode(proxyUrl, {
        default: 'claude-sonnet-4-6',
        opus: 'claude-opus-4-6',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5'
      });
    } else if (pending.actionName === 'disable_claude_code_proxy') {
      config = await setDirectMode();
    } else {
      return {
        success: false,
        error: pendingActionErrorMessage('unsupported', pending.language)
      };
    }

    const latestConfig = config || await readClaudeConfig();
    const configPath = getClaudeConfigPath();
    return {
      success: true,
      result: buildSuccessMessage(pending.actionName, pending.language),
      configPath,
      config: latestConfig
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || pendingActionErrorMessage('unknown', pending.language)
    };
  }
}

function buildSuccessMessage(actionName, language) {
  if (actionName === 'enable_claude_code_proxy') {
    return language === 'zh-CN'
      ? 'Claude Code 已切换为代理模式。'
      : 'Claude Code has been switched to proxy mode.';
  }

  return language === 'zh-CN'
    ? 'Claude Code 代理已取消，已恢复直连模式。'
    : 'Claude Code proxy has been removed and direct mode is restored.';
}

function pendingActionErrorMessage(code, language) {
  const isZh = language === 'zh-CN';
  if (code === 'expired_or_missing') {
    return isZh
      ? '待确认操作不存在或已过期，请重新发起请求。'
      : 'The pending action is missing or expired. Please request it again.';
  }
  if (code === 'unsupported') {
    return isZh ? '暂不支持该操作。' : 'This action is not supported.';
  }
  return isZh ? '执行操作时发生未知错误。' : 'An unknown error occurred while executing the action.';
}

export default {
  createPendingAssistantAction,
  executePendingAssistantAction
};

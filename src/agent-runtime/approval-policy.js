function normalizePath(value) {
  return String(value || '')
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .trim();
}

function trimTrailingWildcard(pathPattern) {
  return normalizePath(pathPattern).replace(/\\\*\*$/, '').replace(/\\\*$/, '');
}

export function normalizeApprovalPath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return '';
  if (/^[A-Za-z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }
  return normalized;
}

// Heuristic: does the final path segment look like a file name (has a real
// extension, not a Windows drive or just dots)? File approvals must store
// their policy against the parent directory so the next file in the same
// directory auto-approves — otherwise the policy degenerates into a
// nonsensical "<file>\**" pattern that can never match sibling files.
export function resolvePolicyBaseDirectory(value) {
  const normalized = normalizeApprovalPath(value);
  if (!normalized) return '';
  if (normalized.endsWith('\\')) return normalized;
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  const lastSep = normalized.lastIndexOf('\\');
  if (lastSep < 0) return normalized;
  const lastSegment = normalized.slice(lastSep + 1);
  const hasFileExtension = /\.[A-Za-z0-9]{1,10}$/.test(lastSegment) && !/^\.+$/.test(lastSegment);
  if (!hasFileExtension) return normalized;
  const parent = normalized.slice(0, lastSep);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || normalized;
}

export function extractApprovalRequestPath(rawRequest = {}) {
  const blockedPath = normalizeApprovalPath(rawRequest?.blocked_path || rawRequest?.blockedPath || '');
  if (blockedPath) {
    if (/^\\[A-Za-z](\\|$)/.test(blockedPath)) {
      const drive = blockedPath.slice(1, 2).toUpperCase();
      return `${drive}:\\${blockedPath.slice(3)}`.replace(/\\+/g, '\\');
    }
    return blockedPath;
  }

  const filePath = normalizeApprovalPath(rawRequest?.input?.file_path || rawRequest?.input?.filePath || '');
  if (filePath) {
    return filePath;
  }

  return '';
}

export function buildApprovalSessionPolicy(approval, options = {}) {
  const rawRequest = approval?.rawRequest || {};
  const toolName = String(rawRequest?.tool_name || rawRequest?.display_name || '').trim();
  const requestPath = extractApprovalRequestPath(rawRequest);
  const explicitPath = normalizeApprovalPath(options.path || '');
  const basePath = explicitPath || requestPath;

  if (!toolName || !basePath) {
    return null;
  }

  // Broaden file-path approvals to their containing directory so sibling
  // files in the same project don't each demand a fresh approval. A user
  // who says "remember this for the session" while editing index.html
  // clearly does not want to re-approve script.js a moment later.
  const directoryBase = resolvePolicyBaseDirectory(basePath);
  const pathPatterns = [directoryBase.endsWith('\\') ? `${directoryBase}**` : `${directoryBase}\\**`];
  const command = String(rawRequest?.input?.command || '').trim();

  return {
    provider: approval?.provider || '',
    toolName,
    decision: 'allow',
    pathPatterns,
    commandPrefixes: command ? [command] : [],
    metadata: {
      approvalId: approval?.approvalId || null,
      reason: 'session_approval_memory'
    }
  };
}

export function approvalPolicyMatchesRequest(policy, rawRequest = {}) {
  if (!policy || policy.decision !== 'allow') {
    return false;
  }

  const toolName = String(rawRequest?.tool_name || rawRequest?.display_name || '').trim();
  if (policy.toolName && toolName && String(policy.toolName) !== toolName) {
    return false;
  }

  const requestPath = extractApprovalRequestPath(rawRequest);
  const normalizedPath = normalizeApprovalPath(requestPath);
  if (normalizedPath && Array.isArray(policy.pathPatterns) && policy.pathPatterns.length > 0) {
    const pathMatched = policy.pathPatterns.some((pattern) => {
      const prefix = trimTrailingWildcard(pattern);
      return prefix ? normalizedPath.toLowerCase().startsWith(prefix.toLowerCase()) : false;
    });
    if (!pathMatched) {
      return false;
    }
  }

  const command = String(rawRequest?.input?.command || '').trim();
  if (command && Array.isArray(policy.commandPrefixes) && policy.commandPrefixes.length > 0) {
    const commandMatched = policy.commandPrefixes.some((prefix) => command.startsWith(String(prefix || '')));
    if (!commandMatched) {
      return false;
    }
  }

  return true;
}

export default {
  normalizeApprovalPath,
  extractApprovalRequestPath,
  buildApprovalSessionPolicy,
  approvalPolicyMatchesRequest
};

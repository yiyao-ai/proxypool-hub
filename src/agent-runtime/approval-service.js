import crypto from 'crypto';

export class AgentRuntimeApprovalService {
  constructor() {
    this.approvalsBySession = new Map();
  }

  createApproval({ sessionId, provider, kind = 'tool_permission', title, summary, rawRequest = null }) {
    const rawApprovalId = rawRequest?.approval_request_id
      || rawRequest?.approvalRequestId
      || rawRequest?.request_id
      || rawRequest?.requestId
      || rawRequest?.id;
    const approval = {
      approvalId: String(rawApprovalId || crypto.randomUUID()),
      sessionId,
      provider,
      status: 'pending',
      kind,
      title: String(title || 'Permission request'),
      summary: String(summary || ''),
      rawRequest,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };

    const approvals = this.approvalsBySession.get(sessionId) || [];
    approvals.push(approval);
    this.approvalsBySession.set(sessionId, approvals);
    return approval;
  }

  listPending(sessionId) {
    return (this.approvalsBySession.get(sessionId) || []).filter((approval) => approval.status === 'pending');
  }

  getApproval(sessionId, approvalId) {
    const approvals = this.approvalsBySession.get(sessionId) || [];
    return approvals.find((entry) => entry.approvalId === approvalId) || null;
  }

  resolveApproval(sessionId, approvalId, decision) {
    const approvals = this.approvalsBySession.get(sessionId) || [];
    const approval = approvals.find((entry) => entry.approvalId === approvalId);
    if (!approval) return null;

    approval.status = decision === 'approve' ? 'approved' : 'denied';
    approval.resolvedAt = new Date().toISOString();
    return approval;
  }
}

export default AgentRuntimeApprovalService;


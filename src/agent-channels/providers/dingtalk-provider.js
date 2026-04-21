import crypto from 'crypto';
import { URL } from 'url';

import { createNormalizedChannelMessage } from '../models.js';

const DINGTALK_TOKEN_CACHE_TTL_MS = 60 * 60 * 1000;
const DINGTALK_TIMESTAMP_SKEW_MS = 60 * 60 * 1000;
const DINGTALK_STREAM_CALLBACK_TOPIC = '/v1.0/im/bot/messages/get';
const DINGTALK_STREAM_RECONNECT_DELAY_MS = 3000;

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function buildRouterResultText(result) {
  switch (result?.type) {
    case 'pairing_required':
      return `Pairing required. Code: ${result?.pairing?.code || ''}`.trim();
    case 'command_error':
      return result.message || 'Command error';
    case 'runtime_started':
      if (result?.message) {
        return `${result.message}\nSession ${result?.session?.id || ''} started with ${providerLabel(result?.session?.provider || result?.provider)}.`.trim();
      }
      if (result?.startedFresh && result?.replacedSessionId) {
        return `Started a fresh task with ${providerLabel(result?.session?.provider || result?.provider)}. Previous session ${result.replacedSessionId} was detached. New session: ${result?.session?.id || ''}`.trim();
      }
      return `Task accepted. Session ${result?.session?.id || ''} started with ${providerLabel(result?.session?.provider || result?.provider)}.`.trim();
    case 'runtime_continued':
      if (result?.message) {
        return `${result.message}\nSent follow-up to session ${result?.session?.id || ''}.`.trim();
      }
      return `Sent follow-up to session ${result?.session?.id || ''}.`.trim();
    case 'runtime_cancelled':
      return `Session ${result?.session?.id || ''} cancelled.`.trim();
    case 'conversation_reset':
      return result?.message || 'Runtime session detached.';
    case 'runtime_status':
      return `Session ${result?.session?.id || ''}: ${result?.session?.status || 'unknown'}${result?.session?.summary ? `\n${result.session.summary}` : ''}`.trim();
    case 'supervisor_status':
      return result?.message || 'No supervisor status available.';
    case 'approval_resolved':
      return result?.message || `Approval ${result?.approval?.status || 'resolved'}.`;
    case 'question_answered':
      return 'Answer sent to the active task.';
    case 'preference_saved':
      return result?.message || 'Preference saved.';
    default:
      return '';
  }
}

function readTextCandidate(payload = {}) {
  if (payload?.text && typeof payload.text === 'object' && typeof payload.text.content === 'string') {
    return payload.text.content;
  }
  if (typeof payload?.text === 'string') {
    return payload.text;
  }
  if (typeof payload?.content === 'string') {
    return payload.content;
  }
  return '';
}

function buildWebhookTextBody(text) {
  return {
    msgtype: 'text',
    text: {
      content: String(text || '')
    }
  };
}

function buildSingleTextBody({ robotCode, userId, text }) {
  return {
    robotCode: String(robotCode || ''),
    userIds: [String(userId || '')],
    msgKey: 'sampleText',
    msgParam: JSON.stringify({
      content: String(text || '')
    })
  };
}

function buildGroupTextBody({ robotCode, openConversationId, text }) {
  return {
    robotCode: String(robotCode || ''),
    openConversationId: String(openConversationId || ''),
    msgKey: 'sampleText',
    msgParam: JSON.stringify({
      content: String(text || '')
    })
  };
}

function coerceTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed > 10_000_000_000) {
    return parsed;
  }
  return parsed * 1000;
}

function chooseSetting(settings = {}, ...keys) {
  for (const key of keys) {
    const value = settings?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

export class DingTalkChannelProvider {
  constructor({
    fetchImpl = globalThis.fetch,
    webSocketFactory = null,
    reconnectDelayMs = DINGTALK_STREAM_RECONNECT_DELAY_MS
  } = {}) {
    this.id = 'dingtalk';
    this.label = 'DingTalk';
    this.fetchImpl = fetchImpl;
    this.webSocketFactory = webSocketFactory;
    this.reconnectDelayMs = reconnectDelayMs;
    this.capabilities = {
      mode: 'stream',
      supportedModes: ['stream', 'webhook'],
      supportsWebhook: true,
      supportsPolling: false,
      supportsWebsocket: true,
      supportsInteractiveApproval: false,
      supportsRichCard: false,
      supportsThreading: false,
      supportsEditMessage: false
    };
    this.configFields = [
      { key: 'enabled', type: 'boolean', labelKey: 'channelEnabled', section: 'basic' },
      {
        key: 'mode',
        type: 'select',
        labelKey: 'channelMode',
        section: 'basic',
        options: [
          { value: 'stream', labelKey: 'channelModeStream' },
          { value: 'webhook', labelKey: 'channelModeWebhook' }
        ],
        descriptionKey: 'channelDingTalkModeDesc'
      },
      { key: 'clientId', type: 'text', labelKey: 'channelClientId', section: 'auth' },
      { key: 'clientSecret', type: 'password', labelKey: 'channelClientSecret', section: 'auth' },
      { key: 'robotCode', type: 'text', labelKey: 'channelRobotCode', section: 'auth' },
      { key: 'signingSecret', type: 'password', labelKey: 'channelSigningSecret', section: 'security' },
      { key: 'defaultRuntimeProvider', type: 'runtime-provider', labelKey: 'channelDefaultRuntime', section: 'runtime' },
      { key: 'model', type: 'text', labelKey: 'chatModel', placeholderKey: 'chatModelPlaceholder', section: 'runtime' },
      { key: 'cwd', type: 'text', labelKey: 'channelWorkingDirectory', section: 'runtime' },
      { key: 'requirePairing', type: 'boolean', labelKey: 'channelRequirePairing', section: 'security' }
    ];
    this.settings = null;
    this.router = null;
    this.logger = console;
    this.tokenCache = {
      accessToken: '',
      expiresAt: 0
    };
    this.streamSocket = null;
    this.streamReconnectTimer = null;
    this.streamClosedByProvider = false;
  }

  async start({ settings, router, logger } = {}) {
    this.settings = settings || {};
    this.router = router || null;
    this.logger = logger || console;
    this.streamClosedByProvider = false;

    if (!this.fetchImpl) {
      return { started: false, reason: 'fetch is unavailable' };
    }
    if (!this.router) {
      return { started: false, reason: 'router is unavailable' };
    }

    const mode = this.settings?.mode || 'stream';
    if (!['stream', 'webhook'].includes(mode)) {
      return { started: false, reason: `unsupported dingtalk mode: ${this.settings?.mode}` };
    }

    if (mode === 'stream') {
      const clientId = chooseSetting(this.settings, 'clientId', 'appKey');
      const clientSecret = chooseSetting(this.settings, 'clientSecret', 'appSecret');
      if (!clientId || !clientSecret) {
        return { started: false, reason: 'dingtalk clientId/clientSecret is not configured' };
      }
      await this.openStreamConnection();
    }

    return { started: true, mode };
  }

  async stop() {
    this.streamClosedByProvider = true;
    if (this.streamReconnectTimer) {
      clearTimeout(this.streamReconnectTimer);
      this.streamReconnectTimer = null;
    }
    try {
      this.streamSocket?.close?.();
    } catch (error) {
      this.logger?.warn?.(`[DingTalk] Failed to close stream socket: ${error.message}`);
    }
    this.streamSocket = null;
    return { stopped: true };
  }

  async createWebSocket(url) {
    if (this.webSocketFactory) {
      return this.webSocketFactory(url);
    }
    if (typeof globalThis.WebSocket === 'function') {
      return new globalThis.WebSocket(url);
    }
    throw new Error('WebSocket is unavailable. Provide webSocketFactory or install a runtime with global WebSocket support.');
  }

  async openStreamConnection() {
    const connection = await this.registerStreamConnection();
    const target = new URL(String(connection.endpoint || ''));
    target.searchParams.set('ticket', String(connection.ticket || ''));

    const socket = await this.createWebSocket(target.toString());
    this.streamSocket = socket;

    socket.addEventListener?.('message', (event) => {
      void this.handleStreamFrame(event?.data);
    });
    socket.addEventListener?.('error', (error) => {
      this.logger?.warn?.(`[DingTalk] Stream socket error: ${error?.message || 'unknown error'}`);
    });
    socket.addEventListener?.('close', () => {
      if (this.streamSocket === socket) {
        this.streamSocket = null;
      }
      this.scheduleStreamReconnect();
    });

    if (typeof socket.on === 'function') {
      socket.on('message', (data) => {
        void this.handleStreamFrame(data);
      });
      socket.on('error', (error) => {
        this.logger?.warn?.(`[DingTalk] Stream socket error: ${error?.message || 'unknown error'}`);
      });
      socket.on('close', () => {
        if (this.streamSocket === socket) {
          this.streamSocket = null;
        }
        this.scheduleStreamReconnect();
      });
    }
  }

  scheduleStreamReconnect() {
    if (this.streamClosedByProvider || (this.settings?.mode || 'stream') !== 'stream') {
      return;
    }
    if (this.streamReconnectTimer) {
      return;
    }
    this.streamReconnectTimer = setTimeout(() => {
      this.streamReconnectTimer = null;
      void this.openStreamConnection().catch((error) => {
        this.logger?.warn?.(`[DingTalk] Failed to reconnect stream: ${error.message}`);
        this.scheduleStreamReconnect();
      });
    }, this.reconnectDelayMs);
  }

  async registerStreamConnection() {
    const clientId = chooseSetting(this.settings, 'clientId', 'appKey');
    const clientSecret = chooseSetting(this.settings, 'clientSecret', 'appSecret');
    const response = await this.fetchImpl('https://api.dingtalk.com/v1.0/gateway/connections/open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        subscriptions: [
          {
            type: 'CALLBACK',
            topic: DINGTALK_STREAM_CALLBACK_TOPIC
          }
        ],
        ua: 'cligate-dingtalk/1.1.1'
      })
    });

    const data = await response.json();
    if (!response.ok || !data?.endpoint || !data?.ticket) {
      throw new Error(data?.message || data?.msg || 'Failed to open DingTalk stream connection');
    }
    return data;
  }

  buildStreamAck(frame = {}, data = { response: null }) {
    return {
      code: 200,
      headers: {
        messageId: String(frame?.headers?.messageId || ''),
        contentType: 'application/json'
      },
      message: 'OK',
      data: JSON.stringify(data)
    };
  }

  sendStreamAck(frame, data) {
    if (!this.streamSocket) {
      return;
    }
    this.streamSocket.send(JSON.stringify(this.buildStreamAck(frame, data)));
  }

  async handleStreamFrame(rawFrame) {
    let frame;
    try {
      frame = JSON.parse(Buffer.isBuffer(rawFrame) ? rawFrame.toString('utf8') : String(rawFrame || ''));
    } catch {
      return;
    }

    const topic = String(frame?.headers?.topic || '');
    if (frame?.type === 'SYSTEM' && topic === 'ping') {
      let pingData = {};
      try {
        pingData = JSON.parse(String(frame?.data || '{}'));
      } catch {
        pingData = {};
      }
      this.sendStreamAck(frame, { opaque: pingData?.opaque || '' });
      return;
    }

    if (frame?.type === 'SYSTEM' && topic === 'disconnect') {
      return;
    }

    if (frame?.type !== 'CALLBACK' || topic !== DINGTALK_STREAM_CALLBACK_TOPIC) {
      this.sendStreamAck(frame, { response: null });
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(String(frame?.data || '{}'));
    } catch {
      payload = null;
    }

    if (!payload) {
      this.sendStreamAck(frame, { response: null });
      return;
    }

    try {
      await this.handleWebhook(payload, { skipVerification: true });
      this.sendStreamAck(frame, { response: null });
    } catch (error) {
      this.logger?.warn?.(`[DingTalk] Failed to process stream callback: ${error.message}`);
      this.sendStreamAck(frame, {
        status: 'LATER',
        message: error.message
      });
    }
  }

  verifySignature(payload = {}, options = {}) {
    const signingSecret = chooseSetting(this.settings, 'signingSecret', 'secret');
    if (!signingSecret) {
      return { ok: true, mode: 'disabled' };
    }

    const timestamp = coerceTimestamp(
      options?.headers?.['x-dingtalk-timestamp']
      || options?.headers?.timestamp
      || payload?.timestamp
    );
    const sign = String(
      options?.headers?.['x-dingtalk-signature']
      || options?.headers?.sign
      || payload?.sign
      || ''
    ).trim();

    if (!timestamp || !sign) {
      return { ok: false, reason: 'missing dingtalk signature headers' };
    }

    if (Math.abs(Date.now() - timestamp) > DINGTALK_TIMESTAMP_SKEW_MS) {
      return { ok: false, reason: 'dingtalk signature timestamp expired' };
    }

    const stringToSign = `${timestamp}\n${signingSecret}`;
    const expected = crypto
      .createHmac('sha256', signingSecret)
      .update(stringToSign)
      .digest('base64');

    let actualBuffer;
    let expectedBuffer;
    try {
      actualBuffer = Buffer.from(decodeURIComponent(sign), 'utf8');
      expectedBuffer = Buffer.from(expected, 'utf8');
    } catch {
      return { ok: false, reason: 'invalid dingtalk signature encoding' };
    }

    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      return { ok: false, reason: 'dingtalk signature mismatch' };
    }

    return { ok: true, mode: 'hmac' };
  }

  normalizeInbound(payload = {}) {
    if (payload?.challenge) {
      return {
        type: 'challenge',
        challenge: String(payload.challenge || '')
      };
    }

    const text = String(readTextCandidate(payload) || '').trim();
    const conversationId = String(
      payload?.conversationId
      || payload?.openConversationId
      || payload?.chatbotConversationId
      || ''
    ).trim();
    const staffId = String(
      payload?.senderStaffId
      || payload?.staffId
      || payload?.userId
      || ''
    ).trim();
    const userId = String(
      staffId
      || payload?.senderId
      || ''
    ).trim();

    if (!text || !conversationId || !userId) {
      return null;
    }

    return createNormalizedChannelMessage({
      channel: 'dingtalk',
      accountId: this.instanceId || 'default',
      deliveryMode: 'webhook',
      externalMessageId: String(payload?.msgId || payload?.messageId || payload?.eventId || ''),
      externalConversationId: conversationId,
      externalUserId: userId,
      externalUserName: String(payload?.senderNick || payload?.senderName || payload?.nick || ''),
      text,
      messageType: 'text',
      metadata: {
        sessionWebhook: String(payload?.sessionWebhook || payload?.sessionWebhookExpiredTime ? payload?.sessionWebhook || '' : ''),
        sessionWebhookExpiredTime: String(payload?.sessionWebhookExpiredTime || ''),
        robotCode: String(payload?.robotCode || ''),
        conversationType: String(payload?.conversationType || ''),
        tenantId: String(payload?.conversationTenantId || payload?.tenantId || ''),
        rawConversationId: conversationId,
        senderStaffId: staffId,
        senderId: String(payload?.senderId || ''),
        senderUnionId: String(payload?.senderUnionId || '')
      },
      raw: payload
    });
  }

  async getAccessToken() {
    if (this.tokenCache.accessToken && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const clientId = chooseSetting(this.settings, 'clientId', 'appKey');
    const clientSecret = chooseSetting(this.settings, 'clientSecret', 'appSecret');
    if (!clientId || !clientSecret) {
      throw new Error('dingtalk clientId/clientSecret is not configured');
    }

    const response = await this.fetchImpl('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        appKey: clientId,
        appSecret: clientSecret
      })
    });

    const data = await response.json();
    if (!response.ok || !data?.accessToken) {
      throw new Error(data?.message || data?.msg || 'Failed to get DingTalk access token');
    }

    this.tokenCache = {
      accessToken: String(data.accessToken || ''),
      expiresAt: Date.now() + DINGTALK_TOKEN_CACHE_TTL_MS
    };
    return this.tokenCache.accessToken;
  }

  async sendViaSessionWebhook(sessionWebhook, text) {
    const response = await this.fetchImpl(String(sessionWebhook), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildWebhookTextBody(text))
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || (data && Number(data?.errcode || 0) !== 0)) {
      throw new Error(data?.errmsg || data?.message || 'Failed to send DingTalk session webhook message');
    }

    return {
      messageId: String(data?.processQueryKey || data?.messageId || '')
    };
  }

  async sendViaAppApi({ conversationId, text, robotCode, conversationType = '', senderStaffId = '' }) {
    const effectiveRobotCode = String(robotCode || chooseSetting(this.settings, 'robotCode')).trim();
    if (!effectiveRobotCode) {
      throw new Error('dingtalk robotCode is not configured');
    }

    const accessToken = await this.getAccessToken();
    const isGroupConversation = String(conversationType || '').trim() === '2';
    const requestUrl = isGroupConversation
      ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
      : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

    if (!isGroupConversation && !String(senderStaffId || '').trim()) {
      throw new Error('dingtalk senderStaffId is required for single-chat app API fallback');
    }

    const response = await this.fetchImpl(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken
      },
      body: JSON.stringify(
        isGroupConversation
          ? buildGroupTextBody({
            robotCode: effectiveRobotCode,
            openConversationId: conversationId,
            text
          })
          : buildSingleTextBody({
            robotCode: effectiveRobotCode,
            userId: senderStaffId,
            text
          })
      )
    });

    const data = await response.json();
    if (!response.ok || data?.code || data?.message) {
      if (!response.ok || data?.code || (data?.success === false)) {
        throw new Error(data?.message || data?.msg || 'Failed to send DingTalk app message');
      }
    }

    return {
      messageId: String(data?.processQueryKey || data?.messageId || '')
    };
  }

  async handleWebhook(payload, options = {}) {
    if (!options.skipVerification) {
      const verification = this.verifySignature(payload, options);
      if (!verification.ok) {
        return {
          status: 401,
          body: {
            success: false,
            error: verification.reason
          }
        };
      }
    }

    const normalized = this.normalizeInbound(payload);
    if (normalized?.type === 'challenge') {
      return {
        status: 200,
        body: {
          challenge: normalized.challenge
        }
      };
    }

    if (!normalized) {
      return {
        status: 200,
        body: {
          success: true,
          ignored: true
        }
      };
    }

    const result = await this.router.routeInboundMessage(normalized, {
      defaultRuntimeProvider: this.settings?.defaultRuntimeProvider || 'codex',
      requirePairing: this.settings?.requirePairing === true,
      cwd: this.settings?.cwd || options.cwd || '',
      model: this.settings?.model || options.model || ''
    });

    await this.handleRouterResult(normalized, result);
    return {
      status: 200,
      body: {
        success: true
      }
    };
  }

  async handleRouterResult(inbound, result) {
    const text = buildRouterResultText(result);
    if (!text || result?.type === 'duplicate') {
      return null;
    }

    return this.sendMessage({
      conversation: {
        externalConversationId: inbound.externalConversationId,
        metadata: {
          channelContext: {
            ...((inbound.metadata && typeof inbound.metadata === 'object') ? inbound.metadata : {})
          }
        }
      },
      text
    });
  }

  async sendMessage({ conversation, text } = {}) {
    const channelContext = conversation?.metadata?.channelContext || {};
    const sessionWebhook = String(channelContext.sessionWebhook || '').trim();
    const expiredAt = coerceTimestamp(channelContext.sessionWebhookExpiredTime);
    const now = Date.now();

    if (sessionWebhook && (!expiredAt || expiredAt > now + 15_000)) {
      return this.sendViaSessionWebhook(sessionWebhook, text);
    }

    return this.sendViaAppApi({
      conversationId: conversation?.externalConversationId,
      text,
      robotCode: channelContext.robotCode || '',
      conversationType: channelContext.conversationType || '',
      senderStaffId: channelContext.senderStaffId || ''
    });
  }
}

export default DingTalkChannelProvider;

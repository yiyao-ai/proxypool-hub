import { createNormalizedChannelMessage } from '../models.js';
import * as Lark from '@larksuiteoapi/node-sdk';

const FEISHU_SAFE_MESSAGE_LIMIT = 3500;

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
    case 'assistant_mode_entered':
    case 'assistant_mode_exited':
    case 'assistant_run_accepted':
    case 'assistant_response':
      return result?.message || '';
    default:
      return '';
  }
}

function buildRouterFailureText(error) {
  const message = String(error?.message || '').trim() || 'Unknown error';
  return `Task failed before the runtime session could be established.\n${message}`;
}

function readMessageText(content) {
  if (!content) return '';
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return String(parsed?.text || '');
    } catch {
      return String(content);
    }
  }
  return String(content?.text || '');
}

function splitFeishuText(text, maxLength = FEISHU_SAFE_MESSAGE_LIMIT) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) {
    return [''];
  }

  if (source.length <= maxLength) {
    return [source];
  }

  const chunks = [];
  let remaining = source;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  if (chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

export class FeishuChannelProvider {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.id = 'feishu';
    this.label = 'Feishu';
    this.fetchImpl = fetchImpl;
    this.capabilities = {
      mode: 'websocket',
      supportedModes: ['websocket', 'webhook'],
      supportsWebhook: true,
      supportsPolling: false,
      supportsWebsocket: true,
      supportsInteractiveApproval: true,
      supportsRichCard: true,
      supportsThreading: true,
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
          { value: 'websocket', labelKey: 'channelModeWebsocket' },
          { value: 'webhook', labelKey: 'channelModeWebhook' }
        ],
        descriptionKey: 'channelFeishuModeDesc'
      },
      { key: 'appId', type: 'text', labelKey: 'channelAppId', section: 'auth' },
      { key: 'appSecret', type: 'password', labelKey: 'channelAppSecret', section: 'auth' },
      { key: 'verificationToken', type: 'text', labelKey: 'channelVerificationToken', section: 'security' },
      { key: 'encryptKey', type: 'text', labelKey: 'channelEncryptKey', section: 'security' },
      { key: 'defaultRuntimeProvider', type: 'runtime-provider', labelKey: 'channelDefaultRuntime', section: 'runtime' },
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
    this.wsClient = null;
    this.sdkClient = null;
  }

  async start({ settings, router, logger } = {}) {
    this.settings = settings || {};
    this.router = router || null;
    this.logger = logger || console;

    if (!this.fetchImpl) {
      return { started: false, reason: 'fetch is unavailable' };
    }
    if (!this.settings?.appId || !this.settings?.appSecret) {
      return { started: false, reason: 'feishu appId/appSecret is not configured' };
    }

    if ((this.settings?.mode || 'websocket') === 'websocket') {
      this.sdkClient = new Lark.Client({
        appId: this.settings.appId,
        appSecret: this.settings.appSecret
      });

      this.wsClient = new Lark.WSClient({
        appId: this.settings.appId,
        appSecret: this.settings.appSecret,
        loggerLevel: Lark.LoggerLevel.info
      });

      this.wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data) => {
            await this.handleWebhook({
              header: { event_type: 'im.message.receive_v1' },
              event: data
            });
          }
        })
      });
    }

    return { started: true, mode: this.settings?.mode || 'websocket' };
  }

  async stop() {
    try {
      this.wsClient?.close?.({ force: true });
    } catch (error) {
      this.logger?.warn?.(`[Feishu] Failed to close websocket client: ${error.message}`);
    }
    this.wsClient = null;
    this.sdkClient = null;
    return { stopped: true };
  }

  async getTenantAccessToken() {
    if (this.tokenCache.accessToken && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const response = await this.fetchImpl(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          app_id: this.settings?.appId,
          app_secret: this.settings?.appSecret
        })
      }
    );

    const data = await response.json();
    if (!response.ok || Number(data?.code) !== 0 || !data?.tenant_access_token) {
      throw new Error(data?.msg || 'Failed to get Feishu tenant access token');
    }

    const expiresIn = Number(data.expire || 7200);
    this.tokenCache = {
      accessToken: String(data.tenant_access_token || ''),
      expiresAt: Date.now() + Math.max(60000, (expiresIn - 60) * 1000)
    };
    return this.tokenCache.accessToken;
  }

  normalizeInbound(payload) {
    const event = payload?.event || payload?.header?.event_type ? payload.event || payload : null;
    const eventType = payload?.header?.event_type || payload?.schema || '';

    if (payload?.challenge) {
      return {
        type: 'challenge',
        challenge: String(payload.challenge || '')
      };
    }

    if (eventType === 'im.message.receive_v1' && event?.message?.message_type === 'text') {
      return createNormalizedChannelMessage({
        channel: 'feishu',
        accountId: this.instanceId || 'default',
        deliveryMode: 'webhook',
        externalMessageId: String(event.message?.message_id || ''),
        externalConversationId: String(event.message?.chat_id || ''),
        externalUserId: String(event.sender?.sender_id?.open_id || ''),
        externalUserName: String(event.sender?.sender_type || 'user'),
        text: readMessageText(event.message?.content),
        messageType: 'text',
        raw: payload
      });
    }

    return null;
  }

  async handleWebhook(payload, options = {}) {
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

    try {
      const result = await this.router.routeInboundMessage(normalized, {
        defaultRuntimeProvider: this.settings?.defaultRuntimeProvider || 'codex',
        requirePairing: this.settings?.requirePairing === true,
        cwd: this.settings?.cwd || options.cwd || ''
      });

      await this.handleRouterResult(normalized, result);
    } catch (error) {
      await this.sendMessage({
        conversation: {
          externalConversationId: normalized.externalConversationId
        },
        text: buildRouterFailureText(error)
      });
    }
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
        externalConversationId: inbound.externalConversationId
      },
      text
    });
  }

  async sendMessage({ conversation, text, buttons = [] } = {}) {
    const tail = buttons.length > 0
      ? `\n\nActions: ${buttons.map((button) => `/${button.action || button.id}`).join(' / ')}`
      : '';
    const textChunks = splitFeishuText(`${String(text || '')}${tail}`);
    let result = null;

    if (this.sdkClient) {
      for (const chunk of textChunks) {
        const response = await this.sdkClient.im.v1.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: conversation?.externalConversationId,
            msg_type: 'text',
            content: JSON.stringify({
              text: chunk
            })
          }
        });

        if (Number(response?.code) !== 0) {
          throw new Error(response?.msg || 'Failed to send Feishu message');
        }

        result = response;
      }

      return {
        messageId: String(result?.data?.message_id || '')
      };
    }

    const token = await this.getTenantAccessToken();
    for (const chunk of textChunks) {
      const response = await this.fetchImpl(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            receive_id: conversation?.externalConversationId,
            msg_type: 'text',
            content: JSON.stringify({
              text: chunk
            })
          })
        }
      );

      const data = await response.json();
      if (!response.ok || Number(data?.code) !== 0) {
        throw new Error(data?.msg || 'Failed to send Feishu message');
      }

      result = data;
    }

    return {
      messageId: String(result?.data?.message_id || '')
    };
  }

  async replyCardAction(payload = {}) {
    return this.sendMessage(payload);
  }
}

export default FeishuChannelProvider;

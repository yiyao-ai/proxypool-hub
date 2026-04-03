# Architecture

## Overview

Related design docs:

- [协议转换层重构计划](D:/proxypool-hub/docs/TRANSLATOR_REFACTOR_PLAN.md)

```
┌─────────────┐  ┌───────────┐  ┌────────────┐  ┌──────────┐
│ Claude Code │  │ Codex CLI │  │ Gemini CLI │  │ OpenClaw │
└──────┬──────┘  └─────┬─────┘  └──────┬─────┘  └────┬─────┘
       │               │               │              │
       └───────────────┼───────────────┼──────────────┘
                       ▼
            ┌─────────────────────┐
            │   ProxyPool Hub     │
            │   localhost:8081    │
            │                     │
            │  ┌───────────────┐  │
            │  │ Protocol      │  │
            │  │ Translation   │  │
            │  └───────┬───────┘  │
            │          │          │
            │  ┌───────▼───────┐  │
            │  │ Account Pool  │  │
            │  │ & Key Router  │  │
            │  └───────┬───────┘  │
            └──────────┼──────────┘
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Anthropic│    │  OpenAI  │    │ Kilo AI  │
│   API    │    │   API    │    │  (Free)  │
└──────────┘    └──────────┘    └──────────┘
```

## Supported Protocols

| Endpoint | Protocol | Clients |
|----------|----------|---------|
| `POST /v1/messages` | Anthropic Messages | Claude Code, OpenClaw |
| `POST /v1/chat/completions` | OpenAI Chat Completions | Codex CLI, OpenClaw |
| `POST /v1/responses` | OpenAI Responses | Codex CLI |
| `POST /backend-api/codex/responses` | Codex Internal | Codex CLI |
| `POST /v1beta/models/*` | Gemini API | Gemini CLI |

## Project Structure

```
proxypool-hub/
├── bin/cli.js                  # CLI entry point
├── electron-main.cjs           # Electron desktop app entry
├── package.json
├── README.md / README_CN.md
├── docs/                       # Documentation
├── public/                     # Web Dashboard
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js              # Dashboard logic
│       └── i18n.js             # EN/CN translations
└── src/
    ├── index.js                # Server entry point
    ├── server.js               # Express server setup
    │
    ├── account-manager.js      # ChatGPT account pool
    ├── claude-account-manager.js # Claude account pool
    ├── api-key-manager.js      # API key pool (OpenAI, Anthropic, Gemini, etc.)
    ├── account-rotation/       # Account rotation strategies
    │
    ├── oauth.js                # ChatGPT OAuth PKCE flow
    ├── claude-oauth.js         # Claude OAuth PKCE flow
    │
    ├── direct-api.js           # ChatGPT upstream client
    ├── claude-api.js           # Anthropic upstream client
    ├── kilo-api.js             # Kilo AI free model client
    │
    ├── format-converter.js     # Anthropic ↔ OpenAI Responses conversion
    ├── kilo-format-converter.js # Anthropic ↔ OpenAI Chat conversion
    ├── response-streamer.js    # SSE stream converter
    ├── thinking-utils.js       # Extended thinking support
    │
    ├── model-mapper.js         # Model → upstream routing (Kilo/account)
    ├── model-mapping.js        # Model name mapping per provider
    │
    ├── claude-config.js        # Claude Code settings.json manager
    ├── openclaw-config.js      # OpenClaw openclaw.json manager
    ├── server-settings.js      # Server-wide settings
    │
    ├── usage-tracker.js        # Usage & cost tracking
    ├── request-logger.js       # Request/response logging
    ├── signature-cache.js      # Request dedup cache
    │
    ├── providers/              # API key provider implementations
    │   ├── openai.js
    │   ├── anthropic.js
    │   ├── azure-openai.js
    │   ├── gemini.js
    │   ├── vertex-ai.js
    │   └── ...
    │
    ├── routes/                 # Express route handlers
    │   ├── api-routes.js       # Route registration
    │   ├── messages-route.js   # /v1/messages (Anthropic)
    │   ├── chat-route.js       # /v1/chat/completions (OpenAI)
    │   ├── responses-route.js  # /v1/responses (Codex)
    │   ├── codex-route.js      # /backend-api/codex/* (Codex)
    │   ├── gemini-api-route.js # /v1beta/models/* (Gemini)
    │   ├── accounts-route.js   # ChatGPT account management
    │   ├── claude-accounts-route.js # Claude account management
    │   ├── claude-config-route.js   # Claude Code config
    │   ├── codex-config-route.js    # Codex CLI config
    │   ├── gemini-config-route.js   # Gemini CLI config
    │   ├── openclaw-config-route.js # OpenClaw config
    │   ├── api-keys-route.js   # API key management
    │   ├── usage-route.js      # Usage analytics
    │   ├── request-logs-route.js # Request log viewer
    │   ├── gateway-route.js    # External API gateway
    │   └── ...
    │
    ├── cli/accounts.js         # CLI account management
    └── utils/
        ├── logger.js
        └── responses-sse.js
```

## Module Responsibilities

| Module | Purpose |
|--------|---------|
| `account-manager.js` | ChatGPT account CRUD, token refresh, Codex credential writeback |
| `claude-account-manager.js` | Claude account CRUD, token refresh, Claude Code credential writeback |
| `api-key-manager.js` | API key pool with rate limit tracking and auto-failover |
| `account-rotation/` | Random, sequential strategies for multi-account routing |
| `model-mapper.js` | Routes models to Kilo (free) or account pool |
| `model-mapping.js` | Maps model names to provider-native equivalents |
| `format-converter.js` | Bidirectional Anthropic ↔ OpenAI Responses API conversion |
| `usage-tracker.js` | Per-request cost estimation and usage aggregation |
| `request-logger.js` | Persistent request/response logging with daily rotation |

## Data Flow

### Request Flow (example: Claude Code → ChatGPT)

1. Claude Code sends Anthropic-format request to `POST /v1/messages`
2. `messages-route.js` resolves model routing (Kilo free / ChatGPT account / Claude account / API key)
3. Account rotator selects an account based on strategy (random/sequential)
4. `format-converter.js` converts Anthropic format to OpenAI Responses API format
5. `direct-api.js` sends request to ChatGPT backend with account credentials
6. `response-streamer.js` converts OpenAI SSE events back to Anthropic SSE format
7. Response is streamed to Claude Code

### Smart Token Refresh

1. `_checkAndRefreshExpiring()` runs every 10 minutes
2. Only refreshes tokens with < 5 minutes remaining (not blind refresh)
3. For imported accounts (`source === 'claude-code-import'` or `source === 'imported'`), refreshed tokens are written back to the source CLI tool's credentials file

## Model Mapping

| Requested Model | Routed To | Auth Required |
|-----------------|-----------|:---:|
| `claude-opus-4-6` | GPT-5.3 Codex / Anthropic API | Yes |
| `claude-sonnet-4-6` | GPT-5.2 Codex / Anthropic API | Yes |
| `claude-haiku-4-5` | Free model via Kilo AI | No |

Haiku routing target is configurable from the dashboard Settings page.

## Data Storage

| Data | Location |
|------|----------|
| ChatGPT accounts | `~/.proxypool-hub/accounts.json` |
| Claude accounts | `~/.proxypool-hub/claude-accounts.json` |
| API keys | `~/.proxypool-hub/api-keys.json` |
| Server settings | `~/.proxypool-hub/settings.json` |
| Usage data | `~/.proxypool-hub/usage/` |
| Request logs | `~/.proxypool-hub/request-logs/` |

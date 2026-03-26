# ProxyPool Hub

![ProxyPool Hub Dashboard](./images/dashboard.png)

[![AGPL-3.0 License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/Node.js-18%2B-blue.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/yiyao-ai/proxypool-hub?style=social)](https://github.com/yiyao-ai/proxypool-hub)

**[English](#features) | [中文](./README_CN.md)**

> A multi-protocol AI API proxy server with account pooling, API key management, and a visual dashboard.
> Use **Claude Code**, **Codex CLI**, **Gemini CLI**, and **OpenClaw** through a unified local proxy — with multi-account rotation, free model routing, usage analytics, and one-click configuration.

---

## Features

### Multi-CLI Proxy Support
- **Claude Code** — Proxies Anthropic Messages API (`/v1/messages`) with streaming
- **Codex CLI** — Proxies OpenAI Responses API (`/v1/responses`) and Chat Completions (`/v1/chat/completions`)
- **Gemini CLI** — Proxies Gemini API (`/v1beta/models/*`) with one-click patch
- **OpenClaw** — Custom provider injection via `anthropic-messages` or `openai-completions`

### Account & Key Management
- **ChatGPT Account Pool** — OAuth login, multi-account rotation (sticky / round-robin / random), auto token refresh
- **Claude Account Pool** — OAuth PKCE login, token refresh with source writeback to Claude Code credentials
- **API Key Pool** — Support for OpenAI, Azure OpenAI, Anthropic, Google Gemini, Vertex AI, MiniMax, Moonshot, ZhipuAI keys with automatic failover and load balancing
- **Key Validation** — One-click connectivity test for each API key
- **Smart Token Refresh** — Only refreshes when tokens are about to expire (< 5 min), syncs back to source CLI tools

### Free Model Routing
- **Kilo AI Gateway** — Routes `claude-haiku` requests to free models (DeepSeek, Qwen, MiniMax, etc.) via Kilo AI — no API key needed
- **Configurable Haiku Model** — Choose which free model to use from the dashboard

### Analytics & Monitoring
- **Usage Dashboard** — Per-account, per-model, per-provider usage statistics
- **Request Logs** — Full request/response logging with date filtering
- **Real-time Log Stream** — Live SSE log stream for debugging

### Web Dashboard
- **One-click CLI Configuration** — Configure Claude Code, Codex CLI, Gemini CLI, OpenClaw with a single button
- **One-click Tool Installer** — Detect and install Node.js, Claude Code, Codex CLI, Gemini CLI, OpenClaw from the dashboard — auto-detects OS, installs Node.js first, then uses npm for all CLI tools
- **API Key Test & Edit** — Test API key connectivity with one click, edit key details including provider-specific fields (Azure deployment name/API version, Vertex project ID/location)
- **Account Management UI** — Add, remove, enable/disable, switch accounts visually
- **Model Mapping** — Customize which upstream model each provider resolves to
- **API Gateway** — Expose your proxy to external apps via API keys with usage tracking
- **i18n** — English and Chinese interface

---

## Screenshots

| Dashboard | Account Management |
|:-:|:-:|
| ![Dashboard](./images/dashboard.png) | ![Accounts](./images/accounts.png) |

| Settings & Model Mapping | API Key Management |
|:-:|:-:|
| ![Settings](./images/settings.png) | ![API Keys](./images/apikeys.png) |

| Usage & Costs | Request Logs |
|:-:|:-:|
| ![Usage](./images/usage_costs.png) | ![Request Logs](./images/request_logs.png) |

### Demo

![Demo](./images/demo.gif)

---

## Architecture

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

---

## Quick Start

### Option 1: npx (No install)

```bash
npx proxypool-hub@latest start
```

### Option 2: Global install

```bash
npm install -g proxypool-hub
proxypool-hub start
```

### Option 3: Desktop App (Electron)

Download the latest release from [Releases](https://github.com/yiyao-ai/proxypool-hub/releases).

---

## Setup

### 1. Start the server

```bash
proxypool-hub start
```

Dashboard opens at **http://localhost:8081**

### 2. Add accounts

**Web Dashboard** (recommended):
1. Open http://localhost:8081 → **Accounts** tab
2. Click **Add Account** → Login with ChatGPT/Claude
3. Accounts are automatically saved and tokens are auto-refreshed

**CLI**:
```bash
proxypool-hub accounts add            # Opens browser
proxypool-hub accounts add --no-browser  # Headless/VM
```

### 3. Configure your CLI tool

Click the **one-click configure** button in the Settings tab, or manually:

**Claude Code:**
```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=any-key
claude
```

**Codex CLI:**
```toml
# ~/.codex/config.toml
chatgpt_base_url = "http://localhost:8081/backend-api/"
openai_base_url = "http://localhost:8081"
```

**Gemini CLI:** Use the one-click patch button in the dashboard.

**OpenClaw:** Use the one-click configure button, or add manually to `~/.openclaw/openclaw.json`:
```json
{
  "models": {
    "providers": {
      "proxypool": {
        "baseUrl": "http://localhost:8081",
        "apiKey": "sk-ant-proxy",
        "api": "anthropic-messages"
      }
    }
  }
}
```

---

## Model Mapping

| Requested Model | Routed To | Auth Required |
|:---|:---|:---:|
| `claude-sonnet-4-6` | GPT-5.2 Codex / Anthropic API | Yes |
| `claude-opus-4-6` | GPT-5.3 Codex / Anthropic API | Yes |
| `claude-haiku-4-5` | Free model via Kilo AI | No |

The haiku model can be changed to any free model (DeepSeek R1, Qwen3, MiniMax, etc.) from the Settings tab.

---

## API Endpoints

| Endpoint | Protocol | Used By |
|:---|:---|:---|
| `POST /v1/messages` | Anthropic Messages | Claude Code, OpenClaw |
| `POST /v1/chat/completions` | OpenAI Chat Completions | Codex CLI, OpenClaw |
| `POST /v1/responses` | OpenAI Responses | Codex CLI |
| `POST /backend-api/codex/responses` | Codex Internal | Codex CLI |
| `POST /v1beta/models/*` | Gemini API | Gemini CLI |
| `GET /v1/models` | OpenAI Models | All |
| `GET /health` | Health Check | Monitoring |

See [API Documentation](./docs/API.md) for the full reference.

---

## Security & Privacy

- **100% Local** — Runs entirely on `localhost`, no external server involved
- **Direct Connection** — Connects directly to official APIs (OpenAI, Anthropic, Google), no third-party relay
- **No Telemetry** — Zero data collection, zero tracking
- **Token Safety** — Credentials stored locally with `0600` permissions, smart refresh avoids unnecessary token rotation
- **Source Writeback** — When tokens are refreshed for imported accounts, they are synced back to the source CLI tool so it keeps working

---

## License

This project is licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0).

## Disclaimer

This project is an independent open-source tool. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or Google. All trademarks belong to their respective owners. Use responsibly and in accordance with applicable Terms of Service.

---

<div align="center">
  <sub>Built for developers who use multiple AI coding assistants.</sub>
  <br>
  <a href="https://github.com/yiyao-ai/proxypool-hub">
    <img src="https://img.shields.io/github/stars/yiyao-ai/proxypool-hub?style=social" alt="Star on GitHub">
  </a>
</div>

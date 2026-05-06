# CliGate

![CliGate Dashboard](./images/dashboard.png)

[![AGPL-3.0 License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/Node.js-24%2B-blue.svg)](https://nodejs.org/)
[![npm Version](https://img.shields.io/npm/v/cligate)](https://www.npmjs.com/package/cligate)
[![GitHub stars](https://img.shields.io/github/stars/codeking-ai/cligate?style=social)](https://github.com/codeking-ai/cligate)

**[English](#features) | [中文](./README_CN.md)**

> A multi-protocol AI API proxy server with account pooling, API key management, and a visual dashboard.
> Use **Claude Code**, **Codex CLI**, **Gemini CLI**, and **OpenClaw** through a unified local proxy — with multi-account rotation, intelligent routing, local runtime integration, channel gateways, usage analytics, and one-click configuration.

---

## Features

### Multi-CLI Proxy Support
- **Claude Code** — Proxies Anthropic Messages API (`/v1/messages`) with streaming
- **Codex CLI** — Proxies OpenAI Responses API (`/v1/responses`), Chat Completions (`/v1/chat/completions`), and Codex Internal API (`/backend-api/codex/responses`)
- **Gemini CLI** — Proxies Gemini API (`/v1beta/models/*`) with one-click patch
- **OpenClaw** — Custom provider injection via `anthropic-messages` or `openai-completions`
- **Agent Runtime Providers** — Built-in runtime orchestration for Codex and Claude Code sessions through the dashboard and channel gateways

### Account & Key Management
- **ChatGPT Account Pool** — OAuth login, multi-account rotation (sticky / round-robin / random), auto token refresh, per-account quota tracking
- **Claude Account Pool** — OAuth PKCE login, token refresh with source writeback to Claude Code credentials
- **Antigravity Account Pool** — Google OAuth login for enterprise models, automatic model discovery and project management
- **API Key Pool** — Support for OpenAI, Azure OpenAI, Anthropic, Google Gemini, Vertex AI, MiniMax, Moonshot, ZhipuAI keys with automatic failover and load balancing
- **Key Validation** — One-click connectivity test for each API key
- **Smart Token Refresh** — Only refreshes when tokens are about to expire (< 5 min), syncs back to source CLI tools

### Intelligent Routing
- **Priority Mode** — Choose between Account Pool First or API Key First when both are available
- **Routing Mode** — Automatic routing or manual per-app credential assignments
- **App Routing** — Bind each app (Claude Code, Codex, Gemini CLI, OpenClaw) to a specific ChatGPT account, Claude account, Antigravity account, API key, or local model runtime
- **Model Mapping** — Customize which upstream model each provider resolves to
- **Free Model Routing** — Routes `claude-haiku` requests to free models (DeepSeek, Qwen, MiniMax, etc.) via Kilo AI — no API key needed
- **Local Model Routing** — Route supported requests to locally configured runtimes such as Ollama when you want an on-device path

### Channels & Runtime Operations
- **Channel Gateway** — Connect Telegram and Feishu to CliGate so mobile conversations can enter the same orchestration layer as the web chat; Feishu supports local desktop use via WebSocket mode
- **Conversation Records** — Inspect channel-linked runtime session records, message transcripts, pairing state, and execution progress from the dashboard
- **Sticky Runtime Sessions** — Continue the same runtime session across follow-up messages in web chat or channel conversations until explicitly reset
- **Approval-aware Execution** — Surface runtime questions and approval requirements in the dashboard workflow instead of hiding them in logs

### Analytics & Monitoring
- **Usage & Costs** — Per-account, per-model, per-provider usage and cost statistics with daily/monthly breakdown
- **Request Logs** — Full request/response logging with date and provider filtering, error-only view
- **Real-time Log Stream** — Live SSE log stream for debugging
- **Pricing Registry** — View and customize per-provider, per-model pricing with manual overrides
- **API Explorer** — Send live requests to local CliGate endpoints and inspect formatted request/response payloads in one place

### Web Dashboard
- **Dashboard** — Quick status metrics (total/available accounts, expired tokens, default plan), quick test buttons, Claude Code usage example
- **Chat UI** — Interactive chat interface with source selector, runtime provider selection, system prompt, session history, and direct testing for routed models
- **Account Management** — Tabbed interface for ChatGPT, Claude, and Antigravity accounts with add/remove/enable/disable/switch
- **Channels** — Configure Telegram polling plus Feishu WebSocket/Webhook providers, default runtimes, pairing requirements, and working directories
- **Conversation Records** — Review channel threads and message transcripts without reading raw JSONL logs
- **API Key Management** — Add, test, edit, disable API keys with provider-specific fields (Azure deployment name/API version, Vertex project ID/location)
- **Local Models** — Register local runtimes, check health, refresh discovered models, and enable local model routing
- **API Explorer** — Built-in panel for live endpoint testing and debugging
- **Request Logs** — Dedicated dashboard tab for request and response history
- **Tool Installer** — Detect and install/update Node.js, Claude Code, Codex CLI, Gemini CLI, OpenClaw — auto-detects OS, shows version status, checks for updates
- **Resources Catalog** — Curated directory of free and trial LLM API resources with provider details, limits, and compatibility info
- **One-click CLI Configuration** — Configure Claude Code, Codex CLI, Gemini CLI, OpenClaw with a single button
- **i18n** — English and Chinese interface
- **Dark/Light Theme** — Toggle between dark and light mode

---

## Screenshots

<table>
  <tr>
    <td align="center"><strong>Dashboard</strong></td>
    <td align="center"><strong>Chat UI</strong></td>
  </tr>
  <tr>
    <td align="center"><img src="./images/dashboard.png" alt="Dashboard" width="420"></td>
    <td align="center"><img src="./images/chat.png" alt="Chat" width="420"></td>
  </tr>
  <tr>
    <td align="center"><strong>Account Management</strong></td>
    <td align="center"><strong>API Key Management</strong></td>
  </tr>
  <tr>
    <td align="center"><img src="./images/accounts.png" alt="Accounts" width="420"></td>
    <td align="center"><img src="./images/apikeys.png" alt="API Keys" width="420"></td>
  </tr>
  <tr>
    <td align="center"><strong>Channels</strong></td>
    <td align="center"><strong>Local Models</strong></td>
  </tr>
  <tr>
    <td align="center"><img src="./images/channel.png" alt="Channels" width="420"></td>
    <td align="center"><img src="./images/localmodel.png" alt="Local Models" width="420"></td>
  </tr>
  <tr>
    <td align="center"><strong>Request Logs</strong></td>
    <td align="center"><strong>Settings &amp; App Routing</strong></td>
  </tr>
  <tr>
    <td align="center"><img src="./images/request_logs.png" alt="Request Logs" width="420"></td>
    <td align="center"><img src="./images/settings.png" alt="Settings" width="420"></td>
  </tr>
  <tr>
    <td align="center"><strong>Usage &amp; Costs</strong></td>
    <td align="center"><strong>Pricing Registry</strong></td>
  </tr>
  <tr>
    <td align="center"><img src="./images/usage_costs.png" alt="Usage" width="420"></td>
    <td align="center"><img src="./images/pricing.png" alt="Pricing" width="420"></td>
  </tr>
  <tr>
    <td align="center"><strong>Tool Installer</strong></td>
    <td align="center"><strong>Resources Catalog</strong></td>
  </tr>
  <tr>
    <td align="center"><img src="./images/tools_install.png" alt="Tool Installer" width="420"></td>
    <td align="center"><img src="./images/resources.png" alt="Resources" width="420"></td>
  </tr>
</table>

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
            │   CliGate     │
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
       ┌───────┬───────┼───────┬───────┐
       ▼       ▼       ▼       ▼       ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐
│Anthropic││ OpenAI ││Google  ││Vertex  ││Kilo AI │
│  API   ││  API   ││Gemini  ││  AI    ││ (Free) │
└────────┘└────────┘└────────┘└────────┘└────────┘
```

---

## Quick Start

### Option 1: npx (No install)

```bash
npx cligate@latest start
```

### Option 2: Global install

```bash
npm install -g cligate
cligate start
```

### Option 3: Desktop App (Electron)

Download the latest release from [Releases](https://github.com/codeking-ai/cligate/releases).

Starting with `v1.2.0`, a tagged release is expected to publish both GitHub release artifacts and the npm package from the same workflow. If `npx cligate@latest` or `npm install -g cligate` returns a registry `404`, check whether the matching GitHub tag finished the publish workflow successfully.

---

## Setup

### 1. Start the server

```bash
cligate start
```

Dashboard opens at **http://localhost:8081**

### 2. Add accounts or API keys

**Web Dashboard** (recommended):
1. Open http://localhost:8081 → **Accounts** tab
2. Click **Add Account** → Login with ChatGPT / Claude / Google (Antigravity)
3. Or go to **API Keys** tab → **Add API Key** with your OpenAI, Azure, Gemini, Vertex AI, or other provider keys
4. Optionally configure **Channels** (Telegram / Feishu) or **Local Models** for local runtime routing
   Feishu local desktop setups should use **WebSocket** mode; **Webhook** mode is only needed when you have a public callback URL
5. Accounts are automatically saved and tokens are auto-refreshed

Antigravity note:
- Browser OAuth requires `ANTIGRAVITY_GOOGLE_CLIENT_SECRET` in the server environment before you start the Google login flow
- If that secret is unavailable, use the manual import flow instead of browser OAuth

**CLI**:
```bash
cligate accounts add            # Opens browser
cligate accounts add --no-browser  # Headless/VM
```

### 3. Configure your CLI tool

Click the **one-click configure** button in the Dashboard or Settings tab, or manually:

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
      "cligate": {
        "baseUrl": "http://localhost:8081",
        "apiKey": "sk-ant-proxy",
        "api": "anthropic-messages"
      }
    }
  }
}
```

### 4. Configure routing (optional)

In the **Settings** tab:
- **Priority Mode** — Choose "Account Pool First" or "API Key First"
- **Routing Mode** — "Automatic" for smart routing, or "App Assigned" to bind each app to a specific credential
- **App Assignments** — Bind Claude Code, Codex, Gemini CLI, or OpenClaw to a specific account, Antigravity account, API key, or local runtime

### 5. Configure channels or local runtimes (optional)

- **Channels** tab — Configure Telegram polling or Feishu WebSocket/Webhook settings, default runtime provider, working directory, and pairing requirements
- For **Feishu** on a local desktop install, choose **WebSocket** mode in the dashboard and set Feishu Open Platform event subscription to persistent connection mode
- **Conversation Records** tab — Inspect mobile session threads and runtime transcripts
- **Local Models** tab — Register a local runtime endpoint, check availability, and import discovered models into routing

### 6. Control Codex and Claude Code from Telegram / Feishu

Each channel has a **Default Runtime Provider** for new conversations. Once a runtime session is started, follow-up plain messages stay attached to that same provider until you reset or explicitly switch it.

Use these commands from Telegram or Feishu:

- `/cx <task>` — Start a fresh **Codex** session
- `/cc <task>` — Start a fresh **Claude Code** session
- `/agent codex <task>` — Explicit long form for Codex
- `/agent claude <task>` — Explicit long form for Claude Code
- `/new` — Detach the current runtime session; the next plain message starts fresh with the channel default provider
- `/new cx <task>` or `/new codex <task>` — Start a fresh Codex session immediately
- `/new cc <task>` or `/new claude <task>` — Start a fresh Claude Code session immediately

Suggested operating model:

- Set the channel default to the provider you use most often
- Use `/cx` or `/cc` when you want to switch tools for the current conversation
- Keep sending plain follow-up messages to continue the bound session
- Use `/new` before starting a different task thread

Supervisor behavior on mobile channels:

- If you ask natural-language status questions such as `progress`, `status`, `done?`, `进展如何`, or `现在做到哪了`, CliGate will answer from remembered task state when possible instead of forwarding that message as a new runtime prompt
- If a task is waiting for approval or user input, CliGate will mention the current task and what it is waiting for
- Repeated permissions can be remembered at session scope or conversation scope, so later requests in the same thread can be auto-approved
- If you say things like `开始新任务：...` or `start a new task: ...`, CliGate will treat that as a fresh task request instead of blindly continuing the current runtime session
- If you say things like `另外再做一个：...`, `单独做一个：...`, or `另起一个：...`, CliGate will also treat that as a sibling fresh task in the same conversation
- If you say things like `基于刚才那个再做一个：...`, CliGate will treat that as a related sibling task instead of editing the current one
- If you say `切到 Codex` or `切到 Claude Code`, CliGate will guide you to use `/new cx ...` or `/new cc ...` so provider switching stays explicit and predictable
- If you ask for a wrap-up using phrases like `总结一下`, `收尾`, `summarize`, or `recap`, CliGate will try to answer from remembered task context before forwarding anything to the runtime
- If you say `再加一个...`, `顺便加上...`, or `把...改成...`, CliGate will keep the same runtime session and treat it as an update to the current task
- Internally, CliGate now maintains a structured supervisor brief per channel conversation so status replies, wrap-ups, and busy-state explanations all use the same remembered task context
- If the current runtime session is already gone but the conversation still has a remembered supervisor brief, high-confidence follow-up phrases such as revisions or related-task requests will revive that remembered context and keep using the same provider instead of silently falling back to the channel default
- When that remembered follow-up path is used, CliGate also writes the origin relationship back into the current task memory and supervisor brief, so later status updates and wrap-ups can explain which earlier task this run came from
- Supervisor next-step suggestions are now also derived from that same structured brief, so status, wrap-up, and failure replies all use the same controlled recommendation logic instead of ad-hoc text
- For failed remembered tasks, CliGate now also supports high-confidence recovery intents such as `重试刚才那个` / `retry that` and `回到上一个任务` / `return to the previous task`, but it only acts when the remembered brief makes the recovery target explicit

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
| `GET /api/agent-runtimes/providers` | Runtime Registry | Dashboard, channels |
| `GET /api/agent-runtimes/sessions` | Runtime Sessions | Dashboard |
| `GET /api/agent-channels/providers` | Channel Status | Dashboard |
| `GET /api/agent-channels/session-records` | Channel Runtime Session Records | Dashboard |
| `GET /api/agent-channels/conversations` | Channel Conversations | Dashboard |
| `GET /api/local-runtimes` | Local Runtime Status | Dashboard |
| `GET /api/resources` | Resource Catalog | Dashboard |
| `GET /api/tools/status` | Tool Installer Status | Dashboard |
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

## Community

- [GitHub Discussions](https://github.com/codeking-ai/cligate/discussions) — Ask questions, share ideas, report issues
- [Discord](https://discord.gg/GgxZSehxqG) — Real-time chat with the community
- **WeChat** — Scan to add the author, note "CliGate" to join the group

  <img src="./images/wechat.jpg" alt="WeChat" width="200">

Issue routing:
- Use `Installation / release` for npm publish, desktop release, or version mismatch problems
- Use `Accounts / OAuth` for ChatGPT, Claude, or Antigravity login and token refresh failures
- Use `App routing / model mapping` when bindings or model mapping do not take effect
- Use `Web dashboard UX` when the product flow is hard to understand or requires too many steps

---

## Support

If this project helps you, consider supporting its development:

[![Sponsor](https://img.shields.io/badge/Sponsor-afdian-purple)](https://afdian.com/a/yiyaoai)

---

## License

This project is licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0).

## Disclaimer

This project is an independent open-source tool. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or Google. All trademarks belong to their respective owners. Use responsibly and in accordance with applicable Terms of Service.

---

<div align="center">
  <sub>Built for developers who use multiple AI coding assistants.</sub>
  <br>
  <a href="https://github.com/codeking-ai/cligate">
    <img src="https://img.shields.io/github/stars/codeking-ai/cligate?style=social" alt="Star on GitHub">
  </a>
</div>

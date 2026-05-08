# CliGate

![CliGate Dashboard](./images/dashboard.png)

[![AGPL-3.0 License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/Node.js-24%2B-blue.svg)](https://nodejs.org/)
[![npm Version](https://img.shields.io/npm/v/cligate)](https://www.npmjs.com/package/cligate)
[![GitHub stars](https://img.shields.io/github/stars/codeking-ai/cligate?style=social)](https://github.com/codeking-ai/cligate)

**[English](./README.md) | [中文](./README_CN.md)**

CliGate is a local AI gateway for CLI tools, agent runtimes, and channel-based workflows.

It lets you run **Claude Code**, **Codex CLI**, **Gemini CLI**, and **OpenClaw** through one local control plane with account pooling, API key routing, local runtimes, channel gateways, a dashboard, and one-click configuration.

## Why CliGate

- One local entry point for multiple AI coding tools
- Account pools and API keys can coexist in the same routing layer
- Web dashboard for setup, testing, routing, logs, usage, and operations
- Runtime session orchestration for web chat and mobile channels
- Local-first deployment on `localhost` without a hosted relay

## What It Includes

### Protocol and tool compatibility

- `POST /v1/messages` for Claude Code and Anthropic-compatible clients
- `POST /v1/responses` and `POST /backend-api/codex/responses` for Codex flows
- `POST /v1beta/models/*` for Gemini CLI
- OpenClaw configuration helpers for Anthropic/OpenAI-style providers

### Routing and credentials

- ChatGPT, Claude, and Antigravity account pools
- API key pools for OpenAI, Azure OpenAI, Anthropic, Gemini, Vertex AI, MiniMax, Moonshot, and ZhipuAI
- Routing priority, app-level bindings, provider model mapping, and free-model routing
- Optional local model routing through Ollama-style runtimes

### Runtime and channel operations

- Dashboard chat for direct testing and product-assistant flows
- Codex and Claude Code runtime sessions in the dashboard
- Telegram and Feishu channel gateways
- Conversation records, approvals, pending questions, and task continuity

### Observability and operations

- Usage and pricing views
- Request logs and live log streaming
- API explorer
- Tool installer and CLI config helpers
- Resources catalog for free/trial model providers

## Quick Start

### 1. Start CliGate

```bash
npx cligate@latest start
```

Or install globally:

```bash
npm install -g cligate
cligate start
```

Default dashboard:

`http://localhost:8081`

### 2. Add at least one working credential

Use the dashboard:

- `Accounts` for ChatGPT / Claude / Antigravity
- `API Keys` for provider keys
- `Local Models` for on-device runtimes

### 3. Point your tool to CliGate

Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=any-key
claude
```

Codex CLI:

```toml
# ~/.codex/config.toml
chatgpt_base_url = "http://localhost:8081/backend-api/"
openai_base_url = "http://localhost:8081"
```

Gemini CLI and OpenClaw can be configured from the dashboard.

## User Paths

### CLI users

Start the service, add one credential, run one-click config, and send your first request.

### Dashboard operators

Use the dashboard to manage accounts, API keys, routing priority, model mapping, local runtimes, pricing, request logs, and usage.

### Runtime and channel users

Use `Chat`, `Assistant Tasks`, `Conversation Records`, and `Channels` to run Codex or Claude Code sessions from the web UI or Telegram / Feishu.

## Screenshots

| Dashboard | Chat |
|:--|:--|
| ![Dashboard](./images/dashboard.png) | ![Chat](./images/chat.png) |

| Routing and Settings | Channels |
|:--|:--|
| ![Settings](./images/settings.png) | ![Channels](./images/channel.png) |

| Usage and Costs |
|:--|
| ![Usage and Costs](./images/usage_costs.png) |

## Documentation

Start here if you want the shortest path to the right document:

- [Documentation Hub](./docs/README.md)
- [Product Manual (English)](./docs/product-manual.en.md)
- [Product Manual (Chinese)](./docs/product-manual.zh-CN.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API Reference](./docs/API.md)
- [App Routing](./docs/APP_ROUTING.md)
- [Accounts](./docs/ACCOUNTS.md)
- [OpenClaw Integration](./docs/OPENCLAW.md)
- [Screenshot Guide](./docs/SCREENSHOTS.md)
- [Release Guide](./docs/RELEASING.md)
- [Community](./docs/COMMUNITY.md)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Changelog](./CHANGELOG.md)

After the server starts, a lightweight product guide is also available at:

- `http://localhost:8081/manual/`
- `http://localhost:8081/resources/`

## Local Architecture

```text
Clients and Channels
  Claude Code / Codex CLI / Gemini CLI / OpenClaw / Web Chat / Telegram / Feishu
           |
           v
CliGate Local Control Plane (localhost:8081)
  - Protocol translation
  - Account and API key routing
  - App-level bindings and model mapping
  - Agent runtime orchestration
  - Dashboard, logs, usage, and operations
           |
           v
Upstream Providers and Local Runtimes
  OpenAI / Anthropic / Gemini / Vertex AI / Kilo / Ollama / others
```

## API Surface

| Endpoint | Use |
|:--|:--|
| `POST /v1/messages` | Anthropic Messages proxy |
| `POST /v1/chat/completions` | OpenAI Chat Completions proxy |
| `POST /v1/responses` | OpenAI Responses proxy |
| `POST /backend-api/codex/responses` | Codex internal compatibility |
| `POST /v1beta/models/*` | Gemini CLI proxy |
| `GET /api/agent-runtimes/providers` | Runtime provider catalog |
| `GET /api/agent-channels/conversations` | Channel conversation records |
| `GET /api/local-runtimes` | Local runtime status |
| `GET /api/resources` | Resource catalog |
| `GET /health` | Health and version |

See [docs/API.md](./docs/API.md) for more detail.

## Community

- [GitHub Discussions](https://github.com/codeking-ai/cligate/discussions)
- [Issues](https://github.com/codeking-ai/cligate/issues)
- [Discord](https://discord.gg/GgxZSehxqG)
- [X](https://x.com/GengSteven58767)
- [Community Guide](./docs/COMMUNITY.md)
- [Releases](https://github.com/codeking-ai/cligate/releases)

For Chinese-speaking users, you can also add the maintainer directly on personal WeChat:

<img src="./images/wechat.jpg" alt="CliGate WeChat" width="220">

Please include a short note such as `CliGate` when sending the request.

If you plan to contribute, read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## License

This project is licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0).

## Disclaimer

CliGate is an independent open-source project and is not affiliated with Anthropic, OpenAI, Google, or other upstream providers.

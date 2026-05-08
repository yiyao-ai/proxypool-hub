# CliGate

![CliGate Dashboard](./images/dashboard.png)

[![AGPL-3.0 License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/Node.js-24%2B-blue.svg)](https://nodejs.org/)
[![npm Version](https://img.shields.io/npm/v/cligate)](https://www.npmjs.com/package/cligate)
[![GitHub stars](https://img.shields.io/github/stars/codeking-ai/cligate?style=social)](https://github.com/codeking-ai/cligate)

**[English](./README.md) | 中文**

CliGate 是一个本地 AI gateway，面向 CLI 工具、运行时编排和渠道工作流。

它把 **Claude Code**、**Codex CLI**、**Gemini CLI**、**OpenClaw** 接到同一个本地控制平面里，统一处理账户池、API Key 路由、本地运行时、渠道网关、可视化仪表盘和一键配置。

## 为什么是 CliGate

- 一个本地入口承接多种 AI 编程工具
- 账户池和 API Key 可以共存于同一套路由层
- Web 仪表盘统一做配置、测试、路由、日志、用量和运维
- Web Chat 与移动端渠道可共享运行时会话编排
- 默认运行在 `localhost`，无需托管中转服务

## 当前能力

### 协议与工具兼容

- `POST /v1/messages`，支持 Claude Code 和 Anthropic 兼容客户端
- `POST /v1/responses` 与 `POST /backend-api/codex/responses`，支持 Codex 相关流量
- `POST /v1beta/models/*`，支持 Gemini CLI
- OpenClaw 的 Anthropic/OpenAI 风格配置接入

### 路由与凭证管理

- ChatGPT、Claude、Antigravity 账户池
- OpenAI、Azure OpenAI、Anthropic、Gemini、Vertex AI、MiniMax、Moonshot、ZhipuAI 等 API Key 池
- 路由优先级、按应用绑定、模型映射、免费模型路由
- 可选本地模型路由，例如 Ollama

### 运行时与渠道能力

- Web Chat 与 Product Assistant
- 仪表盘里的 Codex / Claude Code runtime session
- Telegram / 飞书渠道网关
- 会话记录、审批、追问和任务连续性管理

### 观测与运维

- 用量统计和定价
- 请求日志和实时日志流
- API Explorer
- 工具安装器和 CLI 配置助手
- 免费 / 试用模型资源目录

## 快速开始

### 1. 启动 CliGate

```bash
npx cligate@latest start
```

或者全局安装：

```bash
npm install -g cligate
cligate start
```

默认仪表盘地址：

`http://localhost:8081`

### 2. 至少添加一个可用凭证

在仪表盘中使用：

- `Accounts` 添加 ChatGPT / Claude / Antigravity
- `API Keys` 添加各类 provider key
- `Local Models` 配置本地运行时

### 3. 让 CLI 工具接入 CliGate

Claude Code：

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=any-key
claude
```

Codex CLI：

```toml
# ~/.codex/config.toml
chatgpt_base_url = "http://localhost:8081/backend-api/"
openai_base_url = "http://localhost:8081"
```

Gemini CLI 和 OpenClaw 可直接在仪表盘完成配置。

## 用户入口

### CLI 用户

启动服务，添加一个凭证，执行一键配置，然后发出第一条请求。

### 仪表盘运维用户

通过仪表盘管理账户、API Key、路由优先级、模型映射、本地运行时、定价、请求日志和用量。

### Runtime / 渠道用户

通过 `Chat`、`Assistant Tasks`、`Conversation Records`、`Channels` 在 Web 或 Telegram / 飞书中运行 Codex 或 Claude Code 会话。

## 界面预览

| 仪表盘 | Chat |
|:--|:--|
| ![Dashboard](./images/dashboard.png) | ![Chat](./images/chat.png) |

| 路由与设置 | 渠道管理 |
|:--|:--|
| ![Settings](./images/settings.png) | ![Channels](./images/channel.png) |

| 用量与成本 |
|:--|
| ![Usage and Costs](./images/usage_costs.png) |

## 文档导航

如果你想快速找到正确的说明，建议从这里开始：

- [文档中心](./docs/README.md)
- [产品使用说明书（英文）](./docs/product-manual.en.md)
- [产品使用说明书（中文）](./docs/product-manual.zh-CN.md)
- [架构说明](./docs/ARCHITECTURE.md)
- [API 文档](./docs/API.md)
- [应用路由](./docs/APP_ROUTING.md)
- [账户说明](./docs/ACCOUNTS.md)
- [OpenClaw 集成](./docs/OPENCLAW.md)
- [截图维护规范](./docs/SCREENSHOTS.md)
- [发布说明](./docs/RELEASING.md)
- [社区与联系方式](./docs/COMMUNITY.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [支持与反馈](./SUPPORT.md)
- [更新记录](./CHANGELOG.md)

服务启动后，还可以直接在本地打开轻量说明页：

- `http://localhost:8081/manual/`
- `http://localhost:8081/resources/`

## 本地架构

```text
客户端与渠道
  Claude Code / Codex CLI / Gemini CLI / OpenClaw / Web Chat / Telegram / 飞书
           |
           v
CliGate 本地控制平面 (localhost:8081)
  - 协议转换
  - 账户与 API Key 路由
  - 应用绑定与模型映射
  - Agent Runtime 编排
  - 仪表盘、日志、用量与运维
           |
           v
上游 Provider 与本地运行时
  OpenAI / Anthropic / Gemini / Vertex AI / Kilo / Ollama / others
```

## 核心接口

| 端点 | 用途 |
|:--|:--|
| `POST /v1/messages` | Anthropic Messages 代理 |
| `POST /v1/chat/completions` | OpenAI Chat Completions 代理 |
| `POST /v1/responses` | OpenAI Responses 代理 |
| `POST /backend-api/codex/responses` | Codex 内部兼容接口 |
| `POST /v1beta/models/*` | Gemini CLI 代理 |
| `GET /api/agent-runtimes/providers` | Runtime provider 列表 |
| `GET /api/agent-channels/conversations` | 渠道会话记录 |
| `GET /api/local-runtimes` | 本地运行时状态 |
| `GET /api/resources` | 资源目录 |
| `GET /health` | 健康检查和版本 |

更完整内容见 [docs/API.md](./docs/API.md)。

## 社区

- [GitHub Discussions](https://github.com/codeking-ai/cligate/discussions)
- [Issues](https://github.com/codeking-ai/cligate/issues)
- [Discord](https://discord.gg/GgxZSehxqG)
- [X](https://x.com/GengSteven58767)
- [社区与联系方式](./docs/COMMUNITY.md)
- [Releases](https://github.com/codeking-ai/cligate/releases)

如需直接联系作者，可直接扫码添加个人微信：

<img src="./images/wechat.jpg" alt="CliGate 微信" width="220">

添加时建议备注 `CliGate`，便于识别。

如果你准备提 PR，请先看 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

本项目基于 [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0) 开源。

## 免责声明

CliGate 是独立的开源项目，与 Anthropic、OpenAI、Google 及其他上游 provider 没有隶属关系。

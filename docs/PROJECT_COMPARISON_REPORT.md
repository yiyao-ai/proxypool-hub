# ProxyPool Hub 与 CLIProxyAPI 对比分析报告

## 1. 报告目的

本文档用于对比分析以下两个项目：

- 当前项目：`D:\proxypool-hub`
- 参考项目：`D:\localagentdemo\proxy\CLIProxyAPI`

分析重点包括：

- 当前项目的主要功能梳理
- 两个项目在功能层面的差异与相同点
- 两个项目在架构与实现层面的差异与相同点
- 两个项目各自的适用场景与选型建议

---

## 2. 项目概述

### 2.1 ProxyPool Hub

`ProxyPool Hub` 是一个基于 Node.js / Express 构建的本地 AI API 代理工具，带有完整的 Web 仪表盘，并支持 Electron 打包为桌面应用。它的核心目标是为开发者提供一个开箱即用的本地代理入口，使 Claude Code、Codex CLI、Gemini CLI、OpenClaw 等工具能够通过统一代理访问不同账户池与 API Key 池。

从产品形态上看，`ProxyPool Hub` 更偏向“本地一体化管理产品”，强调：

- 本地开箱即用
- 可视化操作
- 账户池与 API Key 池统一管理
- 一键配置与工具安装
- 使用分析、日志、定价管理等产品化能力

核心入口与实现位置：

- 服务入口：[src/index.js](D:/proxypool-hub/src/index.js)
- 服务启动：[src/server.js](D:/proxypool-hub/src/server.js)
- 路由注册：[src/routes/api-routes.js](D:/proxypool-hub/src/routes/api-routes.js)
- 账户管理：[src/account-manager.js](D:/proxypool-hub/src/account-manager.js)
- API Key 管理：[src/api-key-manager.js](D:/proxypool-hub/src/api-key-manager.js)

### 2.2 CLIProxyAPI

`CLIProxyAPI` 是一个基于 Go 构建的通用 CLI 代理 API 服务，目标是为 OpenAI / Gemini / Claude / Codex 等模型生态提供兼容 API 接口，并作为更底层、更可复用的代理运行时平台存在。

从项目定位上看，`CLIProxyAPI` 更偏向“代理内核 / 平台底座”，强调：

- 多 Provider 统一代理
- 多账户与认证调度
- 配置驱动与热更新
- 管理 API
- TUI 管理能力
- SDK 化与可嵌入能力

核心入口与实现位置：

- 程序入口：[cmd/server/main.go](D:/localagentdemo/proxy/CLIProxyAPI/cmd/server/main.go)
- 服务启动：[internal/cmd/run.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/cmd/run.go)
- HTTP 服务：[internal/api/server.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/api/server.go)
- 服务构建器：[sdk/cliproxy/builder.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/cliproxy/builder.go)
- 服务核心：[sdk/cliproxy/service.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/cliproxy/service.go)

---

## 3. 当前项目 ProxyPool Hub 的主要功能梳理

结合 `README_CN.md`、`package.json` 和源码结构，当前项目主要能力可归纳为以下几类。

### 3.1 多协议 AI 代理能力

项目对多个主流 AI 客户端协议提供兼容代理：

- `POST /v1/messages`：兼容 Anthropic Messages API
- `POST /v1/chat/completions`：兼容 OpenAI Chat Completions
- `POST /v1/responses`：兼容 OpenAI Responses API
- `POST /backend-api/codex/responses`：兼容 Codex 内部 API
- `POST /v1beta/models/*`：兼容 Gemini API

对应实现：

- [src/routes/api-routes.js](D:/proxypool-hub/src/routes/api-routes.js)
- [src/routes/chat-route.js](D:/proxypool-hub/src/routes/chat-route.js)
- [src/routes/messages-route.js](D:/proxypool-hub/src/routes/messages-route.js)
- [src/routes/codex-route.js](D:/proxypool-hub/src/routes/codex-route.js)
- [src/routes/gemini-api-route.js](D:/proxypool-hub/src/routes/gemini-api-route.js)

### 3.2 多账户池管理

当前项目支持多种 OAuth 账户类型：

- ChatGPT 账户池
- Claude 账户池
- Antigravity 账户池

每类账户均支持：

- 添加 / 导入
- 启用 / 禁用
- 切换活动账户
- 自动刷新 token
- 状态与配额查看

对应实现：

- [src/account-manager.js](D:/proxypool-hub/src/account-manager.js)
- [src/claude-account-manager.js](D:/proxypool-hub/src/claude-account-manager.js)
- [src/antigravity-account-manager.js](D:/proxypool-hub/src/antigravity-account-manager.js)

### 3.3 API Key 池管理

项目支持管理多个提供商的 API Key，包括：

- OpenAI
- Azure OpenAI
- Anthropic
- Gemini
- Vertex AI
- MiniMax
- Moonshot
- ZhipuAI

能力包括：

- 添加 / 更新 / 删除
- 可用性验证
- 负载均衡
- 错误统计
- 速率限制标记
- 成本估算与用量记录

对应实现：

- [src/api-key-manager.js](D:/proxypool-hub/src/api-key-manager.js)
- [src/providers](D:/proxypool-hub/src/providers)

### 3.4 智能路由与模型映射

项目具备多层路由控制能力：

- 账户优先 / API Key 优先
- 自动路由 / 应用绑定
- 按应用绑定凭证
- 模型映射
- 免费模型路由

它可以识别不同请求来源，例如：

- Codex
- Claude Code
- Gemini CLI
- OpenClaw
- unknown-openai-client
- unknown-anthropic-client

对应实现：

- [src/app-routing.js](D:/proxypool-hub/src/app-routing.js)
- [src/model-mapping.js](D:/proxypool-hub/src/model-mapping.js)
- [src/model-mapper.js](D:/proxypool-hub/src/model-mapper.js)
- [src/routes/settings-route.js](D:/proxypool-hub/src/routes/settings-route.js)

### 3.5 协议转换与上游调用

当前项目的重要实现特征是手写协议转换与直连上游：

- 在 Anthropic Messages 与 OpenAI Responses/Codex 协议之间做双向转换
- 处理 tool call ID 映射
- 处理 thinking/signature 缓存
- 兼容多模态内容

对应实现：

- [src/translators](D:/proxypool-hub/src/translators)
- [src/direct-api.js](D:/proxypool-hub/src/direct-api.js)

### 3.6 Web 仪表盘与产品化能力

`ProxyPool Hub` 除了代理能力，还提供完整产品层功能：

- 仪表盘
- Chat 聊天页
- 账户管理页面
- API Key 管理页面
- 请求日志查看
- 使用量与成本统计
- 定价管理
- 资源目录
- 设置页面

路由层面可以看到大量配套 API：

- `/api/usage/*`
- `/api/request-logs/*`
- `/api/pricing`
- `/api/resources/*`
- `/api/chat/*`

对应实现：

- [src/routes/usage-route.js](D:/proxypool-hub/src/routes/usage-route.js)
- [src/routes/request-logs-route.js](D:/proxypool-hub/src/routes/request-logs-route.js)
- [src/routes/pricing-route.js](D:/proxypool-hub/src/routes/pricing-route.js)
- [src/routes/resources-route.js](D:/proxypool-hub/src/routes/resources-route.js)
- [src/routes/chat-ui-route.js](D:/proxypool-hub/src/routes/chat-ui-route.js)

### 3.7 工具安装与一键配置

这是当前项目相对鲜明的产品特性。它支持：

- 检测 Node.js
- 检测 Claude Code / Codex CLI / Gemini CLI / OpenClaw
- 安装 / 更新这些工具
- 一键写入配置文件

对应实现：

- [src/tool-installer.js](D:/proxypool-hub/src/tool-installer.js)
- [src/tool-launcher.js](D:/proxypool-hub/src/tool-launcher.js)
- [src/routes/tools-route.js](D:/proxypool-hub/src/routes/tools-route.js)
- [src/routes/claude-config-route.js](D:/proxypool-hub/src/routes/claude-config-route.js)
- [src/routes/codex-config-route.js](D:/proxypool-hub/src/routes/codex-config-route.js)
- [src/routes/gemini-config-route.js](D:/proxypool-hub/src/routes/gemini-config-route.js)
- [src/routes/openclaw-config-route.js](D:/proxypool-hub/src/routes/openclaw-config-route.js)

---

## 4. 功能对比分析

### 4.1 总体定位差异

| 维度 | ProxyPool Hub | CLIProxyAPI |
|---|---|---|
| 项目定位 | 本地一体化代理产品 | 通用代理内核 / 服务平台 |
| 面向对象 | 终端用户、个人开发者、小团队 | 开发者、集成方、二次开发者 |
| 核心价值 | 易用、可视化、开箱即用 | 可扩展、可嵌入、配置化 |
| 产品形态 | Web UI + Electron + CLI | HTTP Server + TUI + 管理 API + SDK |

`ProxyPool Hub` 更像是一个成品工具。  
`CLIProxyAPI` 更像一个平台底座，很多上层产品可以建立在它上面。

### 4.2 协议支持能力对比

两者都支持 OpenAI / Claude / Gemini / Codex 相关兼容协议，但侧重点不同。

`ProxyPool Hub` 支持的协议面向当前已集成的工具和场景，强调对 Claude Code、Codex CLI、Gemini CLI、OpenClaw 的直接接入。

`CLIProxyAPI` 不仅支持这些协议，还通过更系统的 translator / executor 体系扩展到：

- Qwen Code
- iFlow
- Kimi
- Amp CLI / Amp IDE
- OpenAI-Compatible 上游提供商

在功能覆盖面上，`CLIProxyAPI` 的 provider 覆盖更广，扩展余量更大。

### 4.3 账户与凭证管理能力对比

| 对比项 | ProxyPool Hub | CLIProxyAPI |
|---|---|---|
| ChatGPT / Codex OAuth | 支持 | 支持 |
| Claude OAuth | 支持 | 支持 |
| Gemini OAuth | 间接通过 Antigravity / Gemini 路由支持 | 支持 |
| Antigravity | 支持 | 支持 |
| Qwen | 未见完整集成 | 支持 |
| iFlow | 未见支持 | 支持 |
| Kimi | 未见支持 | 支持 |
| 多账户轮询 | 支持 | 支持 |
| 认证来源扩展性 | 中等 | 高 |

从支持面来说，`CLIProxyAPI` 的 OAuth 与认证体系更完整，尤其在中国生态 provider 和扩展 provider 上更强。

### 4.4 可视化与运维能力对比

| 对比项 | ProxyPool Hub | CLIProxyAPI |
|---|---|---|
| Web 仪表盘 | 内置完整 | 主要依赖管理面板或外部项目 |
| TUI | 无 | 有 |
| Electron 桌面版 | 有 | 无 |
| 管理 API | 有，但偏产品服务内部使用 | 很完整，面向平台管理 |
| 第三方管理面板生态 | 较少 | 明确存在多个衍生项目 |

在最终用户体验上，`ProxyPool Hub` 更强。  
在平台运维与二次开发接入上，`CLIProxyAPI` 更强。

### 4.5 工具链集成能力对比

这一点是当前项目的明显优势。

`ProxyPool Hub` 内置：

- 工具检测
- 工具安装
- 工具更新
- 配置写入
- 启动辅助

`CLIProxyAPI` 并不承担这些职责。它更专注于代理层、认证层、模型路由层，不负责 CLI 工具安装与本地环境准备。

因此：

- 如果目标是降低最终用户的接入门槛，`ProxyPool Hub` 更完整
- 如果目标是构建可复用代理服务，`CLIProxyAPI` 更聚焦

---

## 5. 实现层面对比分析

## 5.1 技术栈与实现语言

| 项目 | 技术栈 |
|---|---|
| ProxyPool Hub | Node.js + Express + Electron |
| CLIProxyAPI | Go + Gin + Bubble Tea TUI + SDK 模块体系 |

这直接影响了两个项目的实现风格。

`ProxyPool Hub`：

- 更适合快速迭代产品功能
- UI 与本地系统能力结合方便
- 上手门槛低

`CLIProxyAPI`：

- 更适合做长期维护的代理内核
- 类型结构更稳定
- 并发、watcher、运行时管理更适合复杂服务场景

## 5.2 架构风格差异

### ProxyPool Hub：应用式单体架构

`ProxyPool Hub` 的结构是典型的产品型单体后端：

- `server.js` 负责初始化
- `api-routes.js` 统一挂载所有模块路由
- `src/routes/*` 中按业务划分处理器
- `account-manager.js` / `api-key-manager.js` 直接承担状态管理职责

优点：

- 路径直观
- 便于快速做产品功能
- Web UI、配置、代理逻辑整合紧密

缺点：

- 核心代理能力和 UI / 本地工具链能力耦合较高
- 作为独立代理内核复用时需要拆分

### CLIProxyAPI：分层式平台架构

`CLIProxyAPI` 更接近平台内核设计：

- `cmd/server` 只是启动壳
- `sdk/cliproxy` 负责 service builder 与 lifecycle
- `internal/api` 负责 HTTP 服务
- `internal/runtime/executor` 负责 provider 执行器
- `internal/translator` 负责协议转换
- `internal/watcher` 负责热更新
- `sdk/*` 提供外部可复用能力

优点：

- 边界清晰
- 可扩展性强
- 便于复用与二次开发

缺点：

- 初始理解成本高
- 相比单体产品实现更复杂

## 5.3 协议转换实现方式差异

### ProxyPool Hub：定制转换逻辑

`ProxyPool Hub` 在协议转换上更偏“围绕当前支持的工具做深度兼容”：

- 明确处理 Anthropic 与 OpenAI Responses 之间的转换
- 明确处理工具调用 ID 的正反映射
- 缓存 thinking/signature
- 定制兼容 Claude Code / Codex 的请求与响应形态

典型实现：

- [src/translators](D:/proxypool-hub/src/translators)
- [src/direct-api.js](D:/proxypool-hub/src/direct-api.js)

优点：

- 对特定工具兼容性细节控制更直接
- 有利于快速解决实际使用中的兼容问题

不足：

- 扩展新的协议组合时，容易继续增加定制分支
- 转换能力沉淀为通用框架的程度较低

### CLIProxyAPI：Pipeline + Registry 抽象

`CLIProxyAPI` 则把协议转换抽象为：

- format
- registry
- request middleware
- response middleware
- streaming / non-streaming pipeline

典型实现：

- [sdk/translator/pipeline.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/translator/pipeline.go)
- [sdk/translator/registry.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/translator/registry.go)
- [internal/translator](D:/localagentdemo/proxy/CLIProxyAPI/internal/translator)

优点：

- 可组合性强
- 新增协议转换更规范
- 便于 SDK 化与测试

不足：

- 实现复杂度更高
- 排查单一场景问题时链路更深

## 5.4 路由与认证调度差异

### ProxyPool Hub：应用导向的路由

`ProxyPool Hub` 的路由逻辑核心是：

- 判断请求来自哪个应用
- 判断优先使用账户池还是 API Key 池
- 判断是否存在应用绑定
- 根据模型映射决定最终上游

这种设计非常贴近用户心智：

- “Codex 用哪个账号”
- “Claude Code 用哪个提供商”
- “Gemini CLI 是否固定走某个配置”

典型实现：

- [src/app-routing.js](D:/proxypool-hub/src/app-routing.js)
- [src/routes/chat-route.js](D:/proxypool-hub/src/routes/chat-route.js)

### CLIProxyAPI：运行时调度导向

`CLIProxyAPI` 的认证选择更加运行时化：

- Selector 负责选择 auth
- 支持 round-robin 与 fill-first
- 支持 model cooldown
- 支持 websocket 优先选择
- 支持虚拟 parent 分组调度
- 支持动态 executor 注册

典型实现：

- [sdk/cliproxy/auth/selector.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/cliproxy/auth/selector.go)
- [sdk/cliproxy/service.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/cliproxy/service.go)

优点是调度精细；缺点是实现复杂，产品层表达不如 `ProxyPool Hub` 直接。

## 5.5 配置、持久化与热更新差异

### ProxyPool Hub：本地状态型持久化

当前项目主要通过本地文件保存状态，例如：

- `accounts.json`
- `api-keys.json`
- 本地配置目录与 auth 文件

特点：

- 简单直接
- 单机可用性强
- 易于理解

但在多环境、多后端存储、远程统一管理方面能力有限。

### CLIProxyAPI：配置驱动 + 多后端存储

`CLIProxyAPI` 支持：

- YAML 配置
- auth 文件目录
- watcher 热更新
- Postgres token store
- Git token store
- Object store
- 管理 API 修改配置并持久化

相关实现：

- [cmd/server/main.go](D:/localagentdemo/proxy/CLIProxyAPI/cmd/server/main.go)
- [internal/watcher/watcher.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/watcher/watcher.go)
- [internal/store](D:/localagentdemo/proxy/CLIProxyAPI/internal/store)

这意味着 `CLIProxyAPI` 更适合被部署成长期运行服务，而不仅仅是个人本地工具。

## 5.6 管理界面与交互形态差异

### ProxyPool Hub

强调图形化和桌面化：

- 静态 Web UI
- Electron 打包
- 浏览器中完成绝大部分操作

### CLIProxyAPI

强调管理 API 与终端管理：

- TUI
- 管理接口
- 外部面板生态

典型实现：

- [internal/tui/app.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/tui/app.go)
- [internal/api/handlers/management/handler.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/api/handlers/management/handler.go)

这说明两个项目虽然都具备“管理能力”，但交互哲学不同：

- `ProxyPool Hub` 偏产品体验
- `CLIProxyAPI` 偏平台治理

---

## 6. 两个项目的相同点

尽管定位不同，但两个项目有明显共通点。

### 6.1 都是本地或近本地代理网关

两者都试图提供一个本地可访问的统一 API 入口，使不同 CLI 工具或兼容 SDK 可以通过相同风格的接口访问上游模型能力。

### 6.2 都支持 OAuth 账户能力复用

两个项目都强调将官方 CLI/订阅账户转换为可供兼容 API 使用的认证来源，从而减少对传统 API Key 的依赖。

### 6.3 都支持多账户轮换

两者都具备多账户轮换和负载分担能力，只是实现层复杂度不同。

### 6.4 都支持多协议兼容

两个项目都围绕以下生态做兼容：

- OpenAI
- Claude
- Gemini
- Codex

### 6.5 都具备日志与使用统计能力

两者都不是单纯的“透传代理”，而是在代理层附带了：

- 日志
- 用量记录
- 一定程度的运营视角

---

## 7. 两个项目的主要差异总结

### 7.1 本质差异

用一句话概括：

- `ProxyPool Hub`：更像“面向用户的完整代理产品”
- `CLIProxyAPI`：更像“面向平台和集成的代理运行时内核”

### 7.2 差异矩阵

| 维度 | ProxyPool Hub | CLIProxyAPI |
|---|---|---|
| 目标用户 | 直接使用的开发者 | 集成方 / 平台开发者 |
| 产品完成度 | 高 | 中，偏底层 |
| Web 可视化 | 强 | 相对弱 |
| 工具安装与配置 | 强 | 基本不做 |
| Provider 扩展深度 | 中 | 高 |
| SDK 化 | 弱 | 强 |
| 配置驱动 | 中 | 强 |
| 热更新 | 中 | 强 |
| 存储后端灵活性 | 低 | 高 |
| 作为底层复用能力 | 中偏低 | 高 |

---

## 8. 各自优劣势分析

## 8.1 ProxyPool Hub 优势

- 产品形态完整，适合直接交付给用户
- Web 仪表盘丰富，学习成本低
- 工具安装与一键配置体验强
- 应用绑定路由更贴近终端用户使用习惯
- Electron 打包提升桌面场景可用性

## 8.2 ProxyPool Hub 局限

- 架构更偏产品单体，内核可复用性较弱
- Provider 扩展深度和配置能力不如 CLIProxyAPI
- 持久化与部署模型更偏单机
- 协议转换框架化程度不高

## 8.3 CLIProxyAPI 优势

- 分层设计清晰，扩展性强
- 支持更多 provider 和认证来源
- 有 watcher、management API、selector、executor 等成熟内核能力
- 适合做平台底座和二次开发
- 提供 SDK，可作为其他应用的基础设施

## 8.4 CLIProxyAPI 局限

- 初始使用和配置复杂度较高
- 默认产品体验不如内置完整 Web 产品的项目直观
- 对普通终端用户来说门槛更高
- 如果没有上层面板，使用感受偏工程化

---

## 9. 适用场景与选型建议

### 9.1 适合选择 ProxyPool Hub 的场景

如果你的目标是：

- 做一个开箱即用的本地代理工具
- 面向个人开发者或小团队直接使用
- 强调 Web 可视化、配置便利、环境准备便利
- 需要把工具安装、CLI 配置、代理管理整合到一起

那么 `ProxyPool Hub` 更合适。

### 9.2 适合选择 CLIProxyAPI 的场景

如果你的目标是：

- 构建统一代理底层能力
- 做二次开发或嵌入到其他项目
- 需要更丰富的 provider 支持
- 需要更强的配置化、热更新、管理 API
- 需要长期演进为平台服务

那么 `CLIProxyAPI` 更合适。

---

## 10. 对当前项目的演进建议

结合对比结果，如果 `ProxyPool Hub` 希望进一步增强内核能力，可以重点借鉴 `CLIProxyAPI` 的以下方向：

### 10.1 抽象更清晰的协议转换层

建议逐步从“按场景手写转换”演进到：

- translator registry
- request/response middleware
- stream/non-stream pipeline

这样可以降低未来继续支持新 provider、新协议的复杂度。

### 10.2 强化认证调度层

当前项目的路由已经很实用，但更偏产品逻辑。可以进一步增加：

- 更标准的 selector 抽象
- cooldown / recovery 机制
- auth 状态模型
- 模型级别可用性状态

### 10.3 强化热更新与配置治理

可以考虑增加：

- 更清晰的配置模型
- 文件变更 watcher
- 管理接口驱动的配置持久化
- 未来兼容更多存储后端

### 10.4 适度解耦 UI 与代理内核

如果未来考虑做更强的平台化能力，可以将：

- 代理内核
- 本地 UI
- 工具安装器
- 账户管理前端

做模块边界上的进一步拆分，使核心代理服务更容易独立复用。

---

## 11. 结论

本次对比分析的核心结论如下：

`ProxyPool Hub` 和 `CLIProxyAPI` 都属于“为 AI CLI 工具提供统一代理能力”的项目，但两者的定位明显不同。

`ProxyPool Hub` 偏向产品化、一体化、本地用户体验优先。它在 Web 仪表盘、账户管理、API Key 管理、工具安装与一键配置方面明显更强，更适合直接给终端用户使用。

`CLIProxyAPI` 偏向平台化、内核化、可扩展性优先。它在 provider 覆盖、运行时调度、热更新、管理 API、SDK 能力和架构抽象方面更强，更适合作为底层服务或二次开发基础设施。

因此，两者并不是简单的替代关系，而更像是两种不同方向的实现：

- 一个更接近“完整产品”
- 一个更接近“平台底座”

如果从工程演进角度看，二者也存在明显互补关系：

- `ProxyPool Hub` 可以借鉴 `CLIProxyAPI` 的内核抽象与调度能力
- `CLIProxyAPI` 可以借鉴 `ProxyPool Hub` 的产品体验与用户交互方式

---

## 12. 参考文件

### ProxyPool Hub

- [README_CN.md](D:/proxypool-hub/README_CN.md)
- [package.json](D:/proxypool-hub/package.json)
- [src/server.js](D:/proxypool-hub/src/server.js)
- [src/routes/api-routes.js](D:/proxypool-hub/src/routes/api-routes.js)
- [src/account-manager.js](D:/proxypool-hub/src/account-manager.js)
- [src/api-key-manager.js](D:/proxypool-hub/src/api-key-manager.js)
- [src/app-routing.js](D:/proxypool-hub/src/app-routing.js)
- [src/translators](D:/proxypool-hub/src/translators)
- [src/direct-api.js](D:/proxypool-hub/src/direct-api.js)
- [src/tool-installer.js](D:/proxypool-hub/src/tool-installer.js)

### CLIProxyAPI

- [README_CN.md](D:/localagentdemo/proxy/CLIProxyAPI/README_CN.md)
- [cmd/server/main.go](D:/localagentdemo/proxy/CLIProxyAPI/cmd/server/main.go)
- [internal/cmd/run.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/cmd/run.go)
- [internal/api/server.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/api/server.go)
- [sdk/cliproxy/builder.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/cliproxy/builder.go)
- [sdk/cliproxy/service.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/cliproxy/service.go)
- [sdk/cliproxy/auth/selector.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/cliproxy/auth/selector.go)
- [sdk/translator/pipeline.go](D:/localagentdemo/proxy/CLIProxyAPI/sdk/translator/pipeline.go)
- [internal/watcher/watcher.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/watcher/watcher.go)
- [internal/tui/app.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/tui/app.go)
- [internal/api/handlers/management/handler.go](D:/localagentdemo/proxy/CLIProxyAPI/internal/api/handlers/management/handler.go)

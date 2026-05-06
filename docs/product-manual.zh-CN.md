# 产品使用说明书

## 简介

CliGate 是一个本地运行的多协议 AI 代理系统，用于统一承接 Claude Code、Codex CLI、Gemini CLI 和 OpenClaw 的请求。它的核心能力包括：

- 账户池管理
- API Key 管理
- 请求路由与模型映射
- 可视化仪表盘
- 在 Web Chat 中直接测试对话
- 一键配置 Claude Code、Codex CLI、Gemini CLI 和 OpenClaw

CliGate 默认运行在本机，不依赖第三方中转服务器。大多数场景下，你只需要启动服务、添加可用账户或 API Key，然后在设置页或聊天页中进行测试。

## 快速开始

### 启动服务

启动方式：

1. 直接运行：`npx cligate@latest start`
2. 全局安装后运行：`cligate start`

从 `v1.2.0` 开始，正式 tag 发布应同时产出 GitHub 桌面安装包和 npm 包。如果 npm 返回 `404`，优先检查对应 GitHub tag 的发布流程是否成功。

启动成功后，默认仪表盘地址为：

`http://localhost:8081`

### 首次使用步骤

推荐按下面的顺序完成初始化：

1. 启动 CliGate 服务
2. 打开仪表盘
3. 进入“账户管理”或“API Keys”
4. 添加至少一个可用账户或一个可用 API Key
5. 进入“Chat”页面，选择来源和模型进行测试
6. 如果你要给 Claude Code 或其他 CLI 使用，再去“设置”页面执行一键配置

## 仪表盘主要页面

### Dashboard

Dashboard 用于展示整体状态，包括账户数量、可用状态、默认配置、快速测试入口，以及 Claude Code / Codex CLI / Gemini CLI / OpenClaw 的常用接入方式。

### Chat

Chat 页面是 Web 内置对话窗口，用来直接测试当前系统里的账户、Claude 账户或 API Key。

你可以在 Chat 页面中配置：

- Chat Source：选择当前对话要使用的来源
- Model：输入或选择模型名称
- Product Assistant：打开后，助手会优先依据本说明书回答产品使用问题
- System Prompt：可选系统提示词

Chat 页面是测试入口，不会自动改变系统代理行为。只有当你明确执行配置操作时，系统才会修改实际配置文件。

### 账户管理

账户管理页用于管理：

- ChatGPT 账户
- Claude 账户
- Antigravity 账户

你可以进行添加、切换、启用、禁用、删除、刷新等操作。

### API Keys

API Keys 页面用于管理不同供应商的密钥，例如：

- OpenAI
- Anthropic
- Azure OpenAI
- Gemini
- Vertex AI
- MiniMax
- Moonshot
- ZhipuAI

添加完成后，这些 Key 既可以参与代理路由，也可以在 Chat 页面中直接作为对话来源。

### Settings

Settings 页面用于管理：

- Claude Code 一键配置
- Codex CLI 一键配置
- Gemini CLI 一键配置
- OpenClaw 一键配置
- 路由优先级
- 应用绑定
- 免费模型开关
- 本地模型路由
- 模型映射

## 账户与 API Key

### ChatGPT 账户

ChatGPT 账户通过 OAuth 添加。添加成功后，CliGate 会在本地保存令牌并参与路由。你可以配置账户选择策略，例如顺序或随机。

### Claude 账户

Claude 账户通过 Claude OAuth 添加。Claude 账户既可以用于 Anthropic 兼容请求，也可以在聊天页中作为直接对话来源。

### Antigravity 账户

Antigravity 浏览器 OAuth 登录依赖服务端环境变量 `ANTIGRAVITY_GOOGLE_CLIENT_SECRET`。如果没有这个 secret，请使用手动导入，不要直接走浏览器登录流程。

### API Key

如果你不希望使用账户池，也可以添加 API Key。启用后，系统会将它视为一个可用 provider，并可在聊天页中直接选择使用。

### 至少需要什么才能正常工作

至少满足下面任意一种条件：

1. 有可用的 ChatGPT 账户
2. 有可用的 Claude 账户
3. 有可用的 API Key

如果一个都没有，请求将无法正常路由。

## Chat 页面使用方法

### 如何开始一段测试对话

1. 打开 Chat 页面
2. 在 Chat Source 中选择一个来源
3. 在 Model 中输入或选择模型名
4. 在输入框中输入问题
5. 点击发送

### Product Assistant 有什么用

当你开启 Product Assistant 时，Chat 页面会优先依据本说明书回答“如何使用本产品”的问题。例如：

- 这个产品怎么配置 Claude Code？
- 如何添加 API Key？
- 路由模式是什么意思？
- 如何取消 Claude Code 代理？

如果你只是普通聊天，Product Assistant 不会改变你选择的上游来源和模型。

### Product Assistant 会不会影响原有代理

不会。Product Assistant 只工作在 Web Chat 页面中。Claude Code、Codex CLI、Gemini CLI 和 OpenClaw 原本使用的代理接口不会因此改变。

## Claude Code 使用说明

### 一键配置 Claude Code 使用代理

你可以通过设置页的一键按钮将 Claude Code 指向本地代理。执行后，CliGate 会更新 Claude Code 的配置文件，使其通过本地代理访问。

默认代理地址：

`http://localhost:8081`

配置后，Claude Code 会使用类似下面的环境配置：

- `ANTHROPIC_BASE_URL=http://localhost:8081`
- `ANTHROPIC_API_KEY=sk-ant-claude-code-proxy`

并同时写入默认模型配置，例如 Sonnet、Opus 和 Haiku 的默认映射。

### 在产品助手中执行 Claude Code 代理配置

如果你在 Chat 页面开启 Product Assistant，可以直接输入类似：

- 帮我设置 Claude Code 使用代理

系统会先生成待确认操作，只有你点击确认后，才会真正写入 Claude Code 配置。

### 取消 Claude Code 代理

如果你不再希望 Claude Code 使用 CliGate，可以执行取消代理。取消后，系统会移除 Claude Code 配置中的代理相关环境变量，并恢复为直连模式。

在产品助手中可以输入类似：

- 帮我取消 Claude Code 代理
- 帮我关闭 Claude Code 代理

同样会先出现待确认操作，确认后才会执行。

### 查看当前 Claude Code 配置

你可以通过 API 或界面查看当前 Claude 配置。相关接口为：

- `GET /claude/config`

## 路由与模型

### Routing Priority

系统支持两种优先模式：

- Account Pool First：优先走账户池
- API Key First：优先走 API Key 池

如果两者都可用，系统会按这个优先级进行选择。

### Routing Mode

系统支持两种路由模式：

1. automatic：保留原有自动路由行为
2. app-assigned：按应用绑定指定凭证

### App Assignments

在应用绑定模式下，你可以为不同客户端绑定固定凭证，例如：

- Codex 固定走某个 ChatGPT 账户
- Claude Code 固定走某个 Claude 账户
- OpenClaw 固定走某个 API Key

### Model Mapping

系统支持按 provider 做模型映射。也就是说，请求侧模型名和最终上游调用模型名可以不完全相同。

### Free Models

你可以启用或关闭系统免费模型路由。关闭后，相关请求将不再走免费模型，而是只从你的账户或 API Key 中选择。

## 常见使用场景

### 场景一：我只想测试模型是否可用

做法：

1. 添加一个账户或 API Key
2. 进入 Chat 页面
3. 选择来源
4. 输入模型名
5. 发送一个简单问题

### 场景二：我想让 Claude Code 走本地代理

做法：

1. 确保 CliGate 正在运行
2. 在设置页点击“一键配置 Claude Code”
3. 或在 Product Assistant 中输入“帮我设置 Claude Code 使用代理”
4. 确认操作后再启动 Claude Code

### 场景三：我想恢复 Claude Code 直连

做法：

1. 在设置页执行取消代理
2. 或在 Product Assistant 中输入“帮我取消 Claude Code 代理”
3. 确认执行

## 故障排查

### 打不开仪表盘

先确认服务是否已经启动。默认地址是：

`http://localhost:8081`

### Claude Code 没有走代理

检查下面几项：

1. CliGate 是否正在运行
2. Claude Code 是否已完成一键配置
3. 当前配置中 `ANTHROPIC_BASE_URL` 是否指向 `http://localhost:8081`

### 聊天页请求失败

优先检查：

1. 是否已经添加可用账户或 API Key
2. 当前所选 Chat Source 是否有效
3. 当前模型名称是否可被上游接受

### 产品助手回答不符合预期

Product Assistant 只基于本说明书回答产品使用问题。如果说明书里没有明确写到，助手应明确说明未找到，而不是推断实现细节。

## 重要说明

1. Product Assistant 仅影响 Web Chat 页面
2. 它不会自动改动原有代理行为
3. 只有在你明确发起操作并确认后，系统才会写入 Claude Code 配置
4. 如果你只是询问使用方法，系统不会自动执行操作

# 协议转换层重构计划

## 1. 背景

配套文档：

- [协议转换能力矩阵](D:/proxypool-hub/docs/TRANSLATOR_CAPABILITY_MATRIX.md)
- [Phase 1 实施清单](D:/proxypool-hub/docs/TRANSLATOR_PHASE1_CHECKLIST.md)

当前项目已经具备 Claude Code、Codex CLI、Gemini CLI、OpenClaw 等多协议接入能力，但协议转换逻辑逐步分散到了多个路由、provider、streamer 和格式转换文件中。随着兼容 provider 数量增加，底层模型返回格式差异扩大，现有实现开始暴露以下问题：

- Anthropic/OpenAI/Gemini 之间的请求与响应转换逻辑分散，重复实现较多。
- 同类兼容问题在多个文件中分别修补，行为容易不一致。
- SSE 流式响应、tool call、thinking、usage 的组装缺少统一内核。
- 某个 provider 的兼容修复无法自然复用到其他 provider。
- 后续继续叠加模型或 provider 时，维护成本会持续上升。

对比 `CLIProxyAPI` 的实现方式后，可以确认更稳的方向不是继续在现有分支上补丁式修补，而是为项目引入一层独立的“协议转换内核”。

---

## 2. 重构目标

本次重构的目标是：

- 建立统一的请求转换与响应转换层。
- 将“协议转换”和“上游请求执行”职责分离。
- 为不同 provider 提供统一的内部转换入口。
- 在不破坏现有对外接口的前提下，逐步迁移旧实现。
- 保留旧链路，支持阶段性回滚。
- 保持项目的核心产品目标不变：客户端可以无感切换模型、供应商和凭证来源。
- 保持多模态能力不退化，包括图片输入、图片理解以及相关内容块转换。

本次重构的非目标：

- 不改变现有 HTTP API 对外路径。
- 不一次性重写全部 route 和 provider。
- 不在第一阶段重做 UI、账户管理或日志系统。
- 不在第一阶段修改所有协议，只先打通最复杂、最有价值的链路。

---

## 2.1 必须保持的产品目标

以下能力属于本项目初衷，重构后必须完整保留，不能因为架构调整而退化。

### A. 客户端无感切换模型、供应商、凭证

无论客户端是：

- Claude Code
- Codex CLI
- OpenClaw
- Gemini CLI

都必须能够在不要求用户改变使用方式的前提下，通过本地代理实现：

- 切换模型
- 切换上游供应商
- 切换凭证来源

其中“凭证来源”至少包括：

- ChatGPT 账户
- Claude 账户
- Antigravity 账户
- 各类 API Key

这意味着重构后仍需支持以下能力：

- northbound client 协议与 upstream provider 解耦
- 同一个客户端请求可以路由到不同 provider
- 同一个逻辑模型名可以映射到不同上游原生模型
- provider 切换不能要求 route 侧重新手写转换逻辑
- 账户池 / API Key 池切换不能影响 northbound 协议兼容

### B. 多模态能力必须保留

重构后必须保留现有多模态兼容能力，不能只保留纯文本路径。

至少包括：

- 图片输入
- 图片 URL 输入
- base64 图片输入
- 工具结果中携带图像内容
- 不同协议之间的图像内容块转换

对 Claude/Anthropic 风格内容块，需要继续支持：

- `image`
- `document`
- `tool_result` 中嵌套富内容

对 OpenAI Responses / Chat / Gemini 风格，需要继续支持：

- `input_image`
- `image_url`
- `file_data` / 文档类输入
- Gemini `inlineData` / `fileData`

结论是：

- 多模态不是附加功能，而是 translator 和 normalizer 的一等能力。
- 后续任何阶段的迁移，如果只验证 text path，不验证 multimodal path，视为未完成。

---

## 3. 当前问题清单

### 3.1 转换逻辑分散

当前与协议转换直接相关的逻辑散落在如下位置：

- `src/format-converter.js`
- `src/kilo-format-converter.js`
- `src/response-streamer.js`
- `src/routes/messages-route.js`
- `src/routes/responses-route.js`
- `src/routes/codex-route.js`
- `src/providers/openai.js`
- `src/providers/azure-openai.js`
- `src/providers/vertex-ai.js`
- `src/providers/gemini.js`

直接后果：

- tool id 映射在多个地方各自实现。
- usage、stop_reason、thinking、signature 的处理方式不完全统一。
- 流式和非流式转换路径拆得过散，问题定位成本高。

### 3.2 provider 承担了过多协议拼装职责

按理说 provider 应该只关心：

- 如何发请求到上游
- 如何认证
- 如何拿到原始响应

但当前部分 provider 同时负责：

- 解析 Anthropic body
- 拼接 OpenAI/Gemini 请求
- 将响应重新组装为 Anthropic

这会导致 provider 之间耦合协议细节，后续难以统一行为。

### 3.3 缺少统一内部语义层

当前项目虽然有若干 converter，但还没有清晰的“内部转换注册表”和“转换管线”概念。结果是：

- 新增一种 northbound protocol 时，往往要同时修改多个入口。
- 新增一个 provider 时，常常要重新复制一套格式桥接逻辑。

---

## 4. 核心决策

本次重构采用以下原则：

### 4.1 不原地大改旧链路

不在现有 `messages-route`、`direct-api`、`provider.sendAnthropicRequest()` 上直接大面积改写，以避免：

- 边重构边替换，造成行为漂移
- 流式兼容回归难定位
- 回滚只能依赖 git 回退，缺少运行时切换空间

### 4.2 新建转换内核目录，旧实现保留迁移

新增统一转换层目录，将旧逻辑逐步迁入，而不是复制整套旧代码。

推荐新增目录结构：

```text
src/
  translators/
    registry.js
    request/
      anthropic-to-openai-responses.js
      anthropic-to-openai-chat.js
      anthropic-to-gemini.js
      ...
    response/
      openai-responses-to-anthropic.js
      openai-chat-to-anthropic.js
      gemini-to-anthropic.js
      ...
    normalizers/
      messages.js
      tools.js
      schema.js
      thinking.js
      usage.js
      stop-reason.js
    shared/
      tool-id.js
      content-blocks.js
      sse.js
  executors/
    chatgpt-responses-executor.js
    openai-chat-executor.js
    gemini-executor.js
    anthropic-executor.js
```

### 4.3 旧入口优先适配新内核，而不是先删旧代码

迁移策略不是：

- 直接删旧 converter
- 再全部替换

而是：

- 先引入新 translator
- 让旧 route 或旧 client 先调用新 translator
- 行为稳定后再移除旧实现

### 4.4 分阶段迁移，不做全量同时切换

第一阶段只选择一条最有代表性的链路试点：

- `Anthropic Messages -> OpenAI Responses -> Anthropic`

原因：

- 当前项目里这条链路最依赖复杂转换
- 涉及流式、非流式、tool call、thinking、usage，覆盖面最大
- 一旦打通，其余兼容链路可以复用大量基础模块

---

## 5. 目标架构

目标架构分为四层：

### 5.1 Northbound Protocol Layer

负责接收客户端协议请求，例如：

- Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses
- Gemini API

这一层只做：

- 读取请求
- 基础校验
- 路由到对应转换管线

### 5.2 Translator Layer

负责协议间的双向转换：

- 请求转换：`source protocol -> upstream protocol`
- 响应转换：`upstream protocol -> source protocol`

这一层不负责发网络请求。

Translator Layer 在本项目里还必须承担一个关键职责：

- 保证 northbound client 与 upstream model/provider 解耦

也就是说，translator 的职责不只是“字段改名”，还包括：

- 将 northbound 协议下的模型表达映射到统一 routing 输入
- 将 upstream provider 的原生响应恢复成 northbound client 能理解的协议
- 在 provider 切换时尽量不改 route 层与客户端兼容层

### 5.3 Executor Layer

负责真正访问上游：

- URL 构造
- 鉴权
- 请求发送
- 原始响应读取

这一层尽量不理解北向客户端协议，只处理上游协议。

### 5.4 Normalizer Layer

负责所有跨 provider 共享的归一化能力：

- message 顺序修正
- tool schema 归一化
- tool id 映射
- thinking/signature 缓存与还原
- multimodal content 规范化
- usage 规范化
- stop_reason 映射
- SSE event 规范化
- multimodal content 规范化
- provider capability 兼容降级

其中 provider capability 兼容降级特指：

- 某些 provider 不支持原生图像块时，如何安全降级
- 某些 provider 不支持 reasoning/signature 时，如何保持协议兼容
- 某些 provider 不支持完整工具 schema 时，如何归一化后继续可用

---

## 6. 分阶段实施计划

## Phase 0: 文档与边界冻结

目标：

- 明确现有转换链路
- 定义重构边界与迁移顺序
- 形成统一文档

产出：

- 本文档
- 当前转换点清单
- 第一阶段范围界定

验收标准：

- 所有参与开发的人能明确知道哪些文件暂时不删
- 能明确区分“旧链路”和“新内核”

## Phase 1: 抽离公共 normalizer

目标：

- 从旧实现中抽离纯函数级公共能力

首批应抽离的模块：

- `message normalizer`
  - 首条消息修正
  - 连续 role 合并
  - `system` 抽取与整理
- `tool id mapper`
  - `toolu_*`、`call_*`、`fc_*` 之间统一映射
- `schema normalizer`
  - `$ref`、`oneOf`、`anyOf`、`allOf` 等兼容处理
- `thinking normalizer`
  - thinking block 顺序
  - signature 缓存与恢复
- `usage normalizer`
  - 各 provider usage 字段统一
- `stop reason normalizer`
  - OpenAI/Gemini/Anthropic 的 stop_reason 统一
- `multimodal normalizer`
  - image/url/base64/document 输入归一化
  - tool_result 富内容归一化
  - 各 provider 图像字段适配

实施步骤：

1. 新建 `src/translators/normalizers/`
2. 把现有纯函数从旧文件迁移到新目录
3. 旧代码先改为调用新 pure functions
4. 保持对外行为不变

验收标准：

- 不改变现有接口行为
- 原有测试保持通过
- 新 normalizer 至少覆盖现有核心路径测试

## Phase 2: 建立 translator registry

目标：

- 为请求转换与响应转换建立统一注册入口

基础能力：

- `registerRequestTranslator(from, to, fn)`
- `registerResponseTranslator(from, to, mode, fn)`
- `translateRequest(from, to, payload, context)`
- `translateResponse(from, to, payloadOrChunk, context)`

必要上下文：

- `sourceProtocol`
- `targetProtocol`
- `stream`
- `model`
- `originalRequest`
- `translatedRequest`
- `requestMeta`

实施步骤：

1. 新建 `src/translators/registry.js`
2. 为请求/响应 translator 建立注册机制
3. 建立 stream/non-stream 区分
4. 建立 translator context 结构

验收标准：

- translator 调用路径独立于 route
- route 不再直接依赖某个具体 converter 文件

## Phase 3: 迁移第一条主链路

目标：

- 用新 translator 取代现有 `Anthropic <-> OpenAI Responses` 主链路

迁移范围：

- 当前 `src/format-converter.js`
- 当前 `src/response-streamer.js`
- 当前 `src/direct-api.js` 中与格式转换直接相关的部分

建议拆分：

- `request/anthropic-to-openai-responses.js`
- `response/openai-responses-to-anthropic.js`
- `executors/chatgpt-responses-executor.js`

实施步骤：

1. 将 `convertAnthropicToResponsesAPI()` 拆入 request translator
2. 将 `convertOutputToAnthropic()` 拆入 response translator
3. 将 `streamResponsesAPI()` 拆入 streaming response translator
4. `direct-api.js` 改为：
   - 调 request translator
   - 调 executor
   - 调 response translator

验收标准：

- Claude Code 经 ChatGPT backend 的流式/非流式行为与现状一致
- tool call、tool result、thinking、usage、stop_reason 保持兼容
- image / multimodal 输入保持兼容
- provider 切换后 northbound client 行为不变

## Phase 4: 迁移兼容 provider

目标：

- 让 OpenAI、Azure OpenAI、Gemini、Vertex AI 等 provider 退出协议拼装职责

期望状态：

- provider 只接收目标协议的请求
- provider 只返回上游原始协议响应
- Anthropic/OpenAI/Gemini 的返回组装全部由 response translator 负责

优先迁移顺序：

1. OpenAI provider
2. Azure OpenAI provider
3. Vertex AI provider
4. Gemini provider

验收标准：

- `sendAnthropicRequest()` 中的格式组装逻辑显著减少
- provider 代码聚焦认证、URL、请求发送、错误处理
- 同一 northbound 请求可切换不同 provider 而不需要额外协议特判
- 多模态路径在 OpenAI / Azure / Vertex / Gemini 间行为一致或有明确降级规则

## Phase 5: 路由层瘦身

目标：

- route 只负责 northbound 协议入口，不再承载细碎转换逻辑

重点收敛对象：

- `messages-route.js`
- `responses-route.js`
- `codex-route.js`

期望结果：

- route 主要处理：
  - 认证与路由决策
  - 选择 northbound/source protocol
  - 调 translator + executor
  - 输出最终响应

验收标准：

- route 文件显著缩短
- `_emitAnthropicContentBlockSSE()` 这一类低层协议拼装代码逐步从 route 迁出

## Phase 6: 删除旧实现

前置条件：

- 新链路稳定运行
- 旧链路不再被任何 route/provider 直接调用
- 对应测试已迁移

执行内容：

- 删除过时 converter
- 删除重复实现
- 更新 architecture 文档

---

## 7. 测试与验收策略

重构必须配套测试迁移，不能只做代码搬运。

### 7.1 测试优先级

优先补的测试：

- Anthropic 请求转 OpenAI Responses 请求
- OpenAI Responses 非流式响应转 Anthropic message
- OpenAI Responses SSE 转 Anthropic SSE
- tool_use / tool_result 映射
- thinking/signature 还原
- image / multimodal block 兼容
- usage / stop_reason 映射
- schema 归一化
- 同一客户端请求切换 provider 后的等价行为
- 同一逻辑模型切换到底层不同原生模型后的协议稳定性

### 7.2 测试类型

- 单元测试：针对 normalizer 和 translator 纯函数
- 协议快照测试：同一输入，转换结果必须稳定
- 集成测试：通过现有 route 打通整条链路
- 回归测试：覆盖已修复过的 Azure/Vertex/tool sequence 问题
- 能力矩阵测试：验证不同客户端协议在不同 provider 下的可用能力

建议补一份能力矩阵，至少覆盖：

- Client: Claude Code / Codex CLI / OpenClaw / Gemini CLI
- Provider: ChatGPT account / Claude account / OpenAI key / Azure OpenAI / Gemini / Vertex AI
- Capability: text / streaming / tools / images / reasoning / tool_result rich content

### 7.3 验收准则

每迁移一条链路，都要满足：

- 非流式响应兼容
- 流式响应兼容
- 工具调用兼容
- usage 字段兼容
- 错误响应兼容
- 多模态输入兼容
- 模型切换兼容
- provider 切换兼容

---

## 8. 回滚策略

本次重构不采用“复制旧目录一份”的方式回滚，而采用“旧入口保留、新内核逐步接管”的方式。

推荐回滚策略：

- 旧文件先不删除
- 旧 route 入口继续保留
- 新链路通过明确调用接入
- 某条链路若回归，可临时切回旧实现

不建议：

- 复制整套旧 `src/` 到 `src-legacy/`
- 长期维护两套并行完整实现

原因：

- 两套逻辑会持续漂移
- 修 bug 时容易只修一边
- 后续很难判断哪个才是正确实现

正确做法是：

- 保留旧入口
- 新建内核
- 渐进迁移
- 稳定后删除旧逻辑

---

## 9. 重要记录点

以下点必须在实施过程中持续记录：

### 9.1 内部标准定义

需要明确：

- 内部是否直接复用某个外部协议作为中间格式
- 或者只通过 `from -> to` translator，不引入统一中间 message schema

当前建议：

- 第一阶段不额外发明大而全的内部 schema
- 先做协议对协议 translator registry
- 等核心路径稳定后，再判断是否需要抽象统一中间格式

### 9.2 SSE 状态机边界

必须明确：

- 哪一层负责事件状态累计
- 哪一层负责 `content_block_start/delta/stop`
- 哪一层负责 `function_call_arguments.delta/done`
- 哪一层负责 `message_delta` 和最终 usage

当前建议：

- SSE 状态机放在 response translator
- route 和 executor 不参与 chunk 组装

### 9.2.1 能力不对等时的降级策略

必须记录：

- 哪些 provider 原生支持图像理解
- 哪些 provider 只支持文本
- 哪些 provider 支持 Responses 风格 reasoning
- 哪些 provider 只支持有限工具 schema

对每种能力不对等，都要明确：

- 是否透传
- 是否归一化
- 是否降级
- 是否拒绝请求并返回明确错误

### 9.3 tool id 规则

必须统一：

- Anthropic `toolu_*`
- OpenAI `fc_*`
- 某些 provider 的自定义 call id

当前建议：

- 抽出单独 `tool-id.js`
- 所有路径只通过公共方法做映射

### 9.4 thinking/signature 策略

必须统一：

- 何时缓存 signature
- 何时恢复 signature
- 哪些 provider 支持原生返回
- 哪些 provider 只能降级处理

### 9.5 usage 规范

必须统一：

- `input_tokens`
- `output_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- OpenAI/Gemini/Vertex 的 usage 口径

### 9.6 模型与 provider 解耦约束

必须持续记录：

- northbound model 名称与 upstream 原生模型的映射规则
- route 层做路由决策时使用的逻辑模型标识
- provider 层只接收“已决定好的目标协议 + 目标原生模型”

设计约束是：

- 不允许在每个 provider 里各自发明一套 northbound 模型兼容规则
- 不允许因为新增 provider 而要求客户端请求格式发生变化

### 9.7 多模态兼容约束

必须持续记录：

- Anthropic `image/document/tool_result rich content` 与 OpenAI/Gemini 对应结构的映射关系
- 哪些映射是等价转换
- 哪些映射是信息有损降级
- 哪些路径必须保留 `base64`
- 哪些路径允许转为 URL 或文本摘要

---

## 10. 第一阶段具体落地建议

第一阶段只做以下事情：

1. 新建 `src/translators/` 目录结构
2. 抽离公共 normalizer
3. 新建 `anthropic -> openai-responses` request translator
4. 新建 `openai-responses -> anthropic` response translator
5. 新建 `chatgpt-responses-executor`
6. 让 `direct-api.js` 优先接入新 translator
7. 保留旧 `format-converter.js` 和 `response-streamer.js`，待验证稳定后再删

第一阶段同时必须确认：

- Anthropic 图片输入到 OpenAI Responses 的映射不退化
- `tool_result` 中富内容在新 translator 中有明确处理路径
- provider 切换能力不被第一阶段架构锁死

第一阶段不要做的事情：

- 不一次性迁移 OpenAI/Azure/Gemini/Vertex 全部 provider
- 不同时重构 `messages-route.js`、`responses-route.js`、`codex-route.js`
- 不引入过度设计的统一 message DSL

---

## 11. 推荐实施顺序

建议按以下顺序执行：

1. 建目录
2. 抽公共 normalizer
3. 补测试
4. 接 Anthropic <-> OpenAI Responses 主链路
5. 验证 Claude Code 路径
6. 再迁 OpenAI/Azure/Vertex/Gemini provider
7. 最后瘦身 route

---

## 12. 结论

本次重构的重点不是“把旧文件换个位置”，而是把当前项目中分散的协议转换逻辑，收敛为一套可复用、可测试、可迁移、可回滚的转换内核。

最终方向应当是：

- 路由负责接入和路由
- translator 负责协议转换
- executor 负责访问上游
- normalizer 负责共享兼容逻辑

在实施策略上，采用：

- 新建目录
- 保留旧实现
- 渐进迁移
- 分阶段替换

这是当前项目风险最小、收益最大的重构方式。

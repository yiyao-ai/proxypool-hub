# 协议转换能力矩阵

## 1. 目的

本文档用于记录当前项目在“客户端协议 -> 上游 provider / 凭证 -> 能力”三个维度上的实际支持情况，并作为协议转换层重构后的验收基线。

这份矩阵回答的是以下问题：

- 当前哪些客户端可以切换到底层不同 provider
- 当前哪些链路支持工具调用
- 当前哪些链路支持图片/多模态
- 当前哪些链路支持 thinking / reasoning
- 当前哪些链路存在明确降级行为

后续任何重构阶段，都必须以本文档为基线，避免能力静默退化。

---

## 2. 范围

本文档聚焦以下 northbound client：

- Claude Code
- Codex CLI
- OpenClaw
- Gemini CLI

本文档聚焦以下 upstream provider / credential source：

- ChatGPT account
- Claude account
- Antigravity account
- OpenAI API key
- Azure OpenAI API key
- Gemini API key
- Vertex AI API key
- Kilo free route

本文档聚焦以下能力：

- 文本
- 流式响应
- 工具调用
- 模型切换
- provider 切换
- 多模态图片输入
- `tool_result` 富内容
- thinking / reasoning

---

## 3. 关键结论

### 3.1 当前项目已经具备“客户端与底层 provider 解耦”的产品雏形

从现有路由设计看：

- `POST /v1/messages` 不只服务 Claude 官方上游，也会路由到 ChatGPT、Anthropic Key、兼容 provider、Gemini、Vertex、Kilo 等。
- `detectRequestApp()` 和 routing 逻辑已经区分不同 northbound client。
- `model-mapper.js` / `model-mapping.js` 已经承担一部分“逻辑模型名 -> 上游原生模型”的映射职责。

这说明“客户端无感切换模型和供应商”不是重构新增目标，而是现有目标，需要在新架构中保持。

### 3.2 多模态能力已经存在，但分布不均

当前项目已经覆盖以下多模态场景：

- Anthropic image block -> OpenAI Responses `input_image`
- Anthropic image block -> Azure Responses `input_image`
- Anthropic image block -> Gemini / Vertex `inlineData` / `fileData`
- `tool_result` 中图像内容 -> Responses multimodal output
- `tool_result` 中图像内容 -> Gemini/Vertex functionResponse 或降级 user multimodal parts

但这些能力分散在多个 provider 和 converter 中，且存在 provider 差异化降级逻辑。

### 3.3 thinking / reasoning 兼容也已存在，但目前实现分散

当前项目已经覆盖：

- Anthropic `thinking` block 清洗与重排
- signature 缓存与恢复
- OpenAI Responses `reasoning` -> Anthropic `thinking`
- Gemini / Vertex 在工具调用时禁用 thinking 的兼容策略

这类逻辑必须在重构中纳入共享 normalizer，而不是继续分散在各 provider。

---

## 4. 能力矩阵

状态说明：

- `支持`：当前已有明确实现与测试覆盖
- `支持（有降级）`：当前支持，但存在信息有损转换或 provider 限制
- `部分支持`：已有实现，但覆盖不完整或只在部分路径工作
- `未确认`：代码路径存在但缺少足够测试基线

## 4.1 Claude Code / Anthropic Messages 入口

| Upstream | 文本 | 流式 | 工具调用 | 模型切换 | provider 切换 | 图片输入 | `tool_result` 富内容 | thinking / reasoning | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| ChatGPT account via Responses | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 主链路，当前最复杂，重构第一优先级 |
| Claude account | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 近似直通 Anthropic，主要做 body sanitize |
| Anthropic API key | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 近似直通 Anthropic |
| Azure OpenAI | 支持 | 当前主要为非流式 Anthropic bridge | 支持 | 支持 | 支持 | 支持 | 支持 | 支持（有清洗） | 依赖 Responses bridge，已覆盖多模态测试 |
| OpenAI API key | 支持 | 取决于 chat path | 支持 | 支持 | 支持 | 支持（图片转 chat image_url） | `tool_result` 主要降为 text/tool | thinking 主要跳过 | 当前基于 chat-completions bridge，能力不如 Responses 路径完整 |
| Gemini API key | 支持 | 非流式 bridge | 支持 | 支持 | 支持 | 支持 | 支持（有降级） | 支持（有降级） | tool + thinking 并存时会禁用 thinking |
| Vertex AI | 支持 | 非流式 bridge，Claude rawPredict 可直通 | 支持 | 支持 | 支持 | 支持 | 支持（有降级） | 支持（有降级） | Claude 模型与 Gemini 模型桥接路径不同 |
| Kilo free route | 支持 | 支持 | 支持 | 支持 | 路由内切换 | 未见明确图片路径 | 主要文本工具结果 | 支持部分 reasoning 适配 | 当前更偏文本工具链路 |

## 4.2 Codex CLI / OpenAI Responses 与 Codex Internal

| Upstream | 文本 | 流式 | 工具调用 | 模型切换 | provider 切换 | 图片输入 | `tool_result` 富内容 | thinking / reasoning | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| ChatGPT account | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 当前原生路径之一 |
| Claude account | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 依赖 `codex-route.js` 中 OpenAI/Anthropic 双向转换 |
| OpenAI / Azure OpenAI | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 已有 tool sequence 修复与 responses 兼容逻辑 |
| Gemini / Vertex | 支持 | 取决于具体 route | 支持（有降级） | 支持 | 支持 | 支持（有降级） | 支持（有降级） | 支持（有降级） | 受 Gemini thought signature 等限制 |

## 4.3 OpenClaw

| Upstream | 文本 | 流式 | 工具调用 | 模型切换 | provider 切换 | 图片输入 | `tool_result` 富内容 | thinking / reasoning | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| Anthropic Messages family | 支持 | 支持 | 支持 | 支持 | 支持 | 基本沿用 `/v1/messages` 路径 | 基本沿用 `/v1/messages` 路径 | 基本沿用 `/v1/messages` 路径 | OpenClaw 主要复用 Anthropic-compatible 路由 |
| OpenAI Chat family | 支持 | 支持 | 支持 | 支持 | 支持 | 取决于 chat/response bridge | 取决于 bridge | 取决于 bridge | 需要在重构后继续依赖统一 translator，而不是单独分叉 |

## 4.4 Gemini CLI

| Upstream | 文本 | 流式 | 工具调用 | 模型切换 | provider 切换 | 图片输入 | `tool_result` 富内容 | thinking / reasoning | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| Gemini native | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 原生最完整 |
| 非 Gemini upstream | 部分支持 | 部分支持 | 部分支持 | 支持 | 支持 | 需要依赖 route bridge | 需要依赖 bridge | 需要依赖 bridge | 后续重构中要补更清晰的兼容矩阵 |

---

## 5. 当前已确认的重要能力点

以下能力在现有代码与测试中已经可以确认。

## 5.1 Anthropic -> OpenAI Responses 主链路支持多模态

当前已确认：

- Anthropic `image` block 可转为 Responses `input_image`
- Anthropic 图片 URL 可转为 `input_image.image_url`
- `tool_result` 中图像内容可转为 `function_call_output.output[]`

现有基线主要分布在：

- [format-converter.js](D:/proxypool-hub/src/format-converter.js)
- [format-converter.test.js](D:/proxypool-hub/tests/unit/format-converter.test.js)

## 5.2 Azure OpenAI Anthropic bridge 已覆盖工具和多模态

当前已确认：

- Anthropic body -> Azure Responses path
- tool schema 保留 Claude Code 所需约束
- 图片输入可保留为 `input_image`
- `tool_result` 图像内容可保留为 multimodal output
- Responses 返回可再组装为 Anthropic `tool_use`

现有基线主要分布在：

- [azure-openai.js](D:/proxypool-hub/src/providers/azure-openai.js)
- [azure-openai-provider.test.js](D:/proxypool-hub/tests/unit/azure-openai-provider.test.js)

## 5.3 Gemini 与 Vertex 已支持多模态，但有明确降级

当前已确认：

- Anthropic `image` -> Gemini/Vertex `inlineData` / `fileData`
- `tool_result` 多模态内容在部分情况下会降级为 user multimodal parts
- 当 tools 与 thinking 组合存在兼容风险时，会禁用 thinking

现有基线主要分布在：

- [gemini.js](D:/proxypool-hub/src/providers/gemini.js)
- [vertex-ai.js](D:/proxypool-hub/src/providers/vertex-ai.js)
- [gemini-provider.test.js](D:/proxypool-hub/tests/unit/gemini-provider.test.js)
- [vertex-ai-provider.test.js](D:/proxypool-hub/tests/unit/vertex-ai-provider.test.js)

## 5.4 Kilo / OpenAI Chat bridge 以文本工具链为主

当前已确认：

- Anthropic -> OpenAI Chat 的 text/tool/tool_result 路径存在
- finish_reason -> stop_reason 的映射存在
- reasoning 有部分兼容

当前限制：

- 没有像 Responses 路径那样清晰的图片多模态基线

现有基线主要分布在：

- [kilo-format-converter.js](D:/proxypool-hub/src/kilo-format-converter.js)
- [kilo-format-converter.test.js](D:/proxypool-hub/tests/unit/kilo-format-converter.test.js)
- [format-bridge.js](D:/proxypool-hub/src/providers/format-bridge.js)

---

## 6. 当前已知降级策略

这些降级行为不是 bug，但必须在重构后保留或显式重设计。

### 6.1 Gemini / Vertex 的 thinking 与 tools 组合限制

当前行为：

- 当 Claude Code tool path 需要兼容 Gemini / Vertex 时，会禁用 thinking
- 原因是 Gemini thought signature round-trip 难以在当前桥接中保持

这意味着：

- 重构后不能默认假设所有 provider 都能完整保留 thinking + tools
- 必须把这类能力不对等明确建模

### 6.2 多模态 `tool_result` 在 Gemini / Vertex 上可能降级

当前行为：

- 当 `tool_result` 包含图像等富内容时，某些路径会降级为 user multimodal parts
- 这是为了兼容 functionResponse 限制

这意味着：

- response translator / normalizer 必须支持“等价转换”和“有损降级”两种路径

### 6.3 OpenAI Chat bridge 的多模态能力弱于 Responses bridge

当前行为：

- chat-completions bridge 支持图片，但整体能力不如 Responses 路径完整
- `tool_result` 更偏向 text/tool message 扁平化

这意味着：

- 第一阶段优先迁移 Responses 主链路是正确的

---

## 7. 重构后的最低验收要求

重构完成后，以下能力不能退化：

- Claude Code 仍可切换到底层不同 provider 与不同凭证来源
- Codex CLI 仍可切换到底层不同 provider 与不同凭证来源
- OpenClaw 仍可复用同一套兼容层切换 provider
- Gemini CLI 路径不因重构被锁死为单一 provider
- Anthropic -> OpenAI Responses 的图片和 `tool_result` 富内容支持必须保留
- Azure Anthropic bridge 的多模态支持必须保留
- Gemini / Vertex 的当前降级行为必须有明确记录和测试
- tool call、thinking、usage、stop_reason 的当前兼容行为必须保留

---

## 8. 第一阶段基线

第一阶段重构必须至少验证以下链路：

### 8.1 主链路

- Claude Code -> Anthropic Messages -> ChatGPT Responses -> Anthropic

必须验证：

- text
- stream
- tool_use
- tool_result
- 图片输入
- `tool_result` 图像富内容
- thinking / signature
- usage

### 8.2 对照链路

- Claude Code -> Anthropic Messages -> Azure Responses -> Anthropic
- Claude Code -> Anthropic Messages -> Gemini -> Anthropic
- Claude Code -> Anthropic Messages -> Vertex -> Anthropic

必须验证：

- provider 切换后 northbound 协议行为不变
- 当前已知降级仍然可预期

---

## 9. 后续维护要求

后续每当新增 provider 或新增协议桥接，必须补充：

- 本文档中的能力矩阵
- 对应的单元测试 / 集成测试
- 若存在降级，必须在本文档中显式记录

如果某条链路无法做到完全等价转换，必须明确写出：

- 退化点是什么
- 为什么退化
- 是否可以接受
- 是否有计划后续补齐

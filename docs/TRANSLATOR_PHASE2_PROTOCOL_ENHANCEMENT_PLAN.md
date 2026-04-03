# 协议转换层 Phase 2 补强计划

## 1. 目的

本文档用于记录协议转换层第二阶段工作的范围、设计原则、实施顺序与验收标准。

Phase 1 已完成以下目标：

- 建立 `src/translators/` 目录与 registry
- 落地 `Anthropic Messages <-> OpenAI Responses` 主链路
- 收敛 `thinking/signature`、多模态图片、`tool_result`、SSE 的第一版实现

Phase 2 的目标不是推翻当前架构，而是：

- **继续沿用现有 normalizer + translator 分层**
- **补齐协议参数与边界场景覆盖**
- **提高协议保真度，同时维持代码可读性和可测试性**

---

## 2. 设计原则

第二阶段必须遵守以下原则：

### 2.1 不改总体架构

继续沿用当前结构：

- `normalizers/` 负责语义清洗与协议差异归一
- `request/response/` 负责 northbound 与 upstream 之间的协议映射
- `shared/` 负责 content block 与 SSE 事件组装

不采用 CLIProxyAPI 那种大面积 raw JSON patch 风格，不把所有逻辑塞进超长状态机函数。

### 2.2 优先补规则，不优先补抽象

第二阶段重点是补协议规则覆盖：

- 更多请求参数映射
- 更完整的 `thinking/reasoning` 互转
- 更完整的 tool 调用参数与邻接规则
- 更完整的 `response.completed` / final response 字段保留
- 更完整的多模态文件类输入

只有在规则开始重复时，才新增轻量 normalizer；不提前设计统一 DSL。

### 2.3 显式记录降级

对于无法完全等价转换的协议行为，必须：

- 明确写入文档
- 通过测试固定当前降级行为
- 避免静默丢字段、静默改语义

---

## 3. 对比结论与借鉴范围

对比 CLIProxyAPI 后，Phase 2 采纳以下结论：

### 3.1 当前项目应保留的优势

当前项目的优势在于：

- translator 逻辑是对象级、可读性高
- normalizer 已经把 `thinking`、多模态、tool id、usage、stop reason 做了拆分
- 主链路测试已经覆盖关键场景

这些都是 Phase 2 不应丢失的结构性收益。

### 3.2 CLIProxyAPI 值得借鉴的内容

只借鉴以下规则，不借鉴整体写法：

- `thinking budget/adaptive` 与 `reasoning effort` 的双向映射
- `response.completed` / final response 中对原请求字段的回填
- `input_file/document` 与文件类内容的处理
- tool 调用、tool result 与消息邻接规则的更严格处理

### 3.3 明确不借鉴的内容

- 不照搬 `gjson/sjson` 风格的逐字段 JSON 改写
- 不把 normalizer 职责重新并回 translator
- 不为了协议镜像牺牲当前代码可维护性

---

## 4. 第二阶段目标

第二阶段拆成四个里程碑。

### M1 请求侧协议补强

目标：

- 补齐 Anthropic -> OpenAI Responses 的主要请求参数映射
- 建立统一的 `requestEcho` 上下文，供响应阶段回填
- 建立 `thinking/tool_choice` 的统一请求归一

### M2 多模态与文件支持补强

目标：

- 从图片扩展到文件/文档类内容
- 补齐 `tool_result` 富内容中的文件、图片、文本混合场景

### M3 响应侧回填与流式一致性

目标：

- 让流式与非流式的 `thinking/tool_use/text/usage/stop_reason` 行为一致
- 回填必要的请求字段，提升协议保真度

### M4 测试矩阵与回归固化

目标：

- 补 translator fixture corpus
- 增 round-trip 测试
- 固定已知降级与边界行为

---

## 5. Phase 2 工作清单

## 5.1 请求参数映射补强

当前第一阶段主链路只映射了部分字段。第二阶段需要补齐：

- `max_tokens -> max_output_tokens`
- `metadata -> metadata`
- `temperature -> temperature`
- `top_p -> top_p`
- `stop_sequences -> stop`
- `user -> user`
- `thinking -> reasoning`
- `tool_choice` 更完整映射

说明：

- `stream/store/include` 继续显式控制
- `parallel_tool_calls` 继续由 bridge 显式管理
- 对暂不支持的字段，要么保留进 `requestEcho`，要么显式降级，不允许静默吞掉

## 5.2 requestEcho 回填机制

第二阶段新增 `requestEcho` 机制，用于保留协议保真度。

建议保留的字段：

- `model`
- `instructions`
- `max_output_tokens`
- `metadata`
- `temperature`
- `top_p`
- `tool_choice`
- `tools`
- `reasoning`
- `user`
- `parallel_tool_calls`
- `store`

要求：

- `requestEcho` 不直接发往上游 provider
- 只在 translator 内部上下文中流转
- 供非流式响应与流式完成事件回填使用

## 5.3 thinking / reasoning 统一层

第二阶段要把 `thinking` 的处理从“只处理 signature”扩展到“处理配置 + 输出”。

需要覆盖：

- `thinking.type=disabled`
- `thinking.type=enabled + budget_tokens`
- `thinking.type=adaptive/auto`
- `output_config.effort`
- OpenAI Responses `reasoning.effort`
- Responses `reasoning` output item -> Anthropic `thinking`

要求：

- 继续保留现有 signature cache 机制
- 对不支持高级 reasoning 的上游做稳定降级
- 不让 user 侧输入伪造 assistant thinking 语义

## 5.4 tool_choice 与工具协议补强

当前只覆盖了基础 `auto/any/none/tool(name)` 映射，第二阶段补强目标：

- 统一 `tool_choice` normalizer
- 支持 future-compatible tool choice 结构扩展
- 保留工具定义中的 `name/description/schema`
- 为 hosted/builtin tools 预留兼容入口，但不在 M1 强行实现所有类型

要求：

- 继续保持 `sanitizeToolSchema`
- 新规则必须能覆盖当前 Claude Code / OpenClaw 主路径

## 5.5 多模态文件补强

第二阶段需要新增文件/文档类内容支持：

- Anthropic `document` / file-like block 归一
- OpenAI Responses `input_file` 支持
- `tool_result` 中的 document/image/text 混合内容保留

要求：

- 优先结构化保留
- 无法结构化时才退化为文本说明
- 不允许直接丢弃文件类内容

## 5.6 SSE / final response 一致性补强

第二阶段需要统一以下行为：

- reasoning-only 响应
- tool-only 响应
- text + tool_use 混合响应
- usage 迟到的流式事件
- `response.completed` / final response 的字段回填

要求：

- 流式与非流式输出的 `stop_reason` 要一致
- block 顺序在主要场景下保持一致
- 不因为空内容或 partial JSON 导致结构错位

---

## 6. 实施顺序

按以下顺序实施，避免回归面过早扩大。

### 第一步：文档与里程碑固化

- 新增本文件
- 后续在 `TRANSLATOR_CAPABILITY_MATRIX.md` 中补 Phase 2 能力状态

### 第二步：M1 请求侧增强

修改重点文件：

- `src/translators/request/anthropic-to-openai-responses.js`
- `src/translators/normalizers/thinking.js`
- `src/translators/normalizers/anthropic-messages.js`
- 新增 `src/translators/normalizers/responses-request.js`

### 第三步：M2 多模态文件增强

修改重点文件：

- `src/translators/normalizers/multimodal.js`
- `src/translators/shared/content-blocks.js`

### 第四步：M3 响应与 SSE 一致性增强

修改重点文件：

- `src/translators/response/openai-responses-to-anthropic.js`
- `src/translators/response/openai-responses-sse-to-anthropic-sse.js`
- 新增 `src/translators/normalizers/responses-events.js`

### 第五步：M4 回归测试收口

重点测试：

- `tests/unit/format-converter.test.js`
- `tests/unit/translator-normalizers.test.js`
- `tests/unit/translator-sse.test.js`
- `tests/unit/direct-api-translator.test.js`

---

## 7. 开发步骤

## 7.1 M1 开发步骤

1. 新增请求选项 normalizer，统一映射 request-level options
2. 在 request translator 中接入 `max_output_tokens`、`temperature`、`top_p`、`stop`、`metadata`、`user`
3. 新增 `thinking -> reasoning` 归一
4. 新增 `requestEcho`
5. 让 direct-api / provider 在响应翻译阶段带上 `requestEcho`
6. 补测试并验证

## 7.2 M2 开发步骤

1. 扩展 multimodal normalizer 支持 `document/input_file`
2. 扩展 `tool_result` 富内容处理
3. 扩展 output -> Anthropc content 的文件恢复策略
4. 补测试并验证

## 7.3 M3 开发步骤

1. 抽离 responses event normalizer
2. 统一 reasoning / function_call / text 的 streaming 聚合
3. 在 final response 中回填 requestEcho 字段
4. 统一 stop reason 与 usage 输出
5. 补测试并验证

---

## 8. 验收标准

第二阶段完成时，至少需要满足：

- 请求参数映射比 Phase 1 更完整，且有测试覆盖
- `thinking/reasoning` 在请求与响应两侧都有明确规则
- `requestEcho` 能在响应阶段拿到，并用于协议回填
- 多模态图片能力不回归
- 文件类输入开始有明确支持
- 流式与非流式 stop reason / usage / block 顺序更一致

以下任一项未满足，则不能视为完成：

- `tool_choice` 回归
- `thinking` 回归
- `tool_result` 富内容回归
- SSE `tool_use` 或 usage 回归

---

## 9. 已知风险

第二阶段的主要风险：

- `thinking` 配置映射过早做复杂化，导致 provider 行为漂移
- `requestEcho` 若误发到上游，可能触发兼容问题
- 文件类输入若设计过度，会引入 provider-specific 分叉

对应策略：

- 先做最小兼容映射，再逐步加能力探测
- `requestEcho` 只允许存在于 translator 上下文，不进入网络 payload
- 文件类内容先统一成内部 canonical 形态，再分别映射

---

## 10. 当前执行决策

当前执行顺序固定为：

1. 先写文档
2. 先实现 M1
3. M1 验证通过后再进入 M2

当前轮次不做：

- 大规模 provider 重构
- 统一 capability registry
- 全量 future protocol 抽象

本轮只做高收益、低入侵的协议层补强。

---

## 11. 当前进度（2026-04-03）

截至当前，Phase 2 进度如下：

- `M1` 已完成
  - 请求侧新增 `max_output_tokens / metadata / temperature / top_p / stop / user`
  - 新增 `thinking -> reasoning.effort`
  - 新增 `requestEcho`
- `M2` 已完成
  - 新增 `document/file -> input_file`
  - 新增 `tool_result` 中 `text + image + document` 混合内容保留
  - 新增 `input_file -> document` 的最小恢复
- `M3` 已完成第一轮
  - 新增 `responses-events` normalizer
  - 统一流式与非流式 `stop_reason / usage / model` 主要来源
  - 支持 `response.status=incomplete -> max_tokens`
- `M4` 正在进行
  - 已补能力矩阵
  - 已新增 round-trip 回归测试，固定 `tool_use / document / incomplete / requestEcho reasoning`

当前 Phase 2 仍未完成的事项：

- 将 `requestEcho` 用于更丰富的 northbound 回填策略
- 扩展更多 provider 对文件输入的明确验证
- 增加更多 fixture corpus，而不只依赖 hand-written unit tests

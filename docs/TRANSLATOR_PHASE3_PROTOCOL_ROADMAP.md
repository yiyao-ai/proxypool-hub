# 协议转换层 Phase 3 路线图

## 状态

Phase 3 已完成。

完成日期：

- 2026-04-03

完成说明：

- `M1 requestEcho` 已集中到共享 helper，并接入请求构造与响应回填链路
- `M2 hosted / builtin tools` 已建立 canonical shape，并为不支持的目标提供显式降级元数据
- `M3 fixture corpus` 已建立 request / response / SSE / round-trip 四类 translator fixtures
- `M4 provider capability registry` 已建立最小共享 capability profile，并用于 Gemini Anthropic bridge

当前 Phase 3 的定位已从“待实施路线图”转为“完成记录与后续扩展参考”。

## 1. 目的

本文档用于记录协议转换层第三阶段的目标、范围、设计方向、里程碑与验收标准。

Phase 1 已完成：

- 新 translator 架构与主链路落地

Phase 2 已完成：

- 请求参数补强
- `thinking/reasoning` 最小统一
- 文件类多模态接入
- 流式 / 非流式 `stop_reason` 一致性
- round-trip 与 provider 级回归固化

Phase 3 的目标不再是“补齐基础能力”，而是把当前主链路从“功能可用”推进到“协议建模更完整、扩展更稳、验证更系统”。

---

## 2. 目标

Phase 3 聚焦四个方向：

### 2.1 更丰富的 `requestEcho` northbound 回填策略

当前 `requestEcho` 已能在 translator 上下文中流转，但仍主要用于内部保真和模型回退。

Phase 3 目标：

- 明确哪些字段应回填到 northbound 语义层
- 统一流式与非流式完成态的回填策略
- 避免不同 provider 返回不一致的 response metadata

### 2.2 hosted / builtin tools 协议兼容

当前主要覆盖自定义 function tools，缺少对 hosted / builtin tool 形态的明确兼容建模。

Phase 3 目标：

- 为 builtin / hosted tools 建立 canonical shape
- 支持更完整的 `tool_choice` 结构
- 显式区分 function tool 与 provider-native tool

### 2.3 fixture corpus 体系化

Phase 2 主要依赖 hand-written unit tests，已经够用，但扩展性一般。

Phase 3 目标：

- 建立协议样例 corpus
- 让 request / response / SSE / round-trip 共享 fixture
- 降低新增 provider / translator 时的回归成本

### 2.4 provider capability registry

当前很多限制还分散在 translator / provider 判断里。

Phase 3 目标：

- 显式建模 provider / model 的协议能力
- 明确谁支持 `thinking + tools`
- 明确谁支持 `document/file`
- 明确谁支持 `structured tool_result`

---

## 3. 设计原则

### 3.1 继续沿用 Phase 2 架构

不引入新的大框架，继续沿用：

- `normalizers/`
- `request/response/`
- `shared/`
- provider 内最小适配

### 3.2 抽象必须服务于复用，不为抽象而抽象

Phase 3 可以引入比 Phase 2 更明确的抽象，但前提是：

- 至少被两个以上链路复用
- 能减少 provider-specific if/else
- 能让测试更系统

### 3.3 能力不对等要显式建模

不能再把这类差异藏在零散逻辑里：

- `Gemini/Vertex` 是否支持 thinking + tools
- `OpenAI Chat` 和 `Responses` 的多模态差异
- hosted tools 是否能原样 passthrough

Phase 3 要让这些能力成为显式配置，而不是隐式经验。

---

## 4. 范围

Phase 3 只处理协议层与协议相关验证，不做：

- 大规模 route 重写
- provider 重新分层
- 价格、账户、路由策略重构
- UI 改动

本阶段的落点仍然应该集中在：

- `src/translators/`
- `src/providers/` 中与协议桥接直接相关的部分
- `tests/unit/` 与新增 fixture 目录
- `docs/`

---

## 5. 里程碑

当前状态：

- `M1` 已完成
- `M2` 已完成
- `M3` 已完成
- `M4` 已完成

## M1 `requestEcho` 回填体系

目标：

- 明确 northbound 响应层的回填白名单
- 建立统一 helper，而不是在各 translator/route 中各自判断

已落地：

- `src/translators/normalizers/request-echo.js`

建议职责：

- `buildRequestEcho(...)`
- `mergeRequestEchoIntoResponseContext(...)`
- `pickNorthboundEchoFields(...)`

优先字段：

- `model`
- `instructions`
- `reasoning`
- `tool_choice`
- `tools`
- `max_output_tokens`
- `metadata`
- `user`

完成结果：

- 非流式与流式完成态对相同字段的回填语义一致
- provider 不会把 `requestEcho` 误发给上游

## M2 hosted / builtin tools

目标：

- 对 function tool 之外的工具形态建立兼容入口

已落地：

- `src/translators/normalizers/tools.js`

建议职责：

- 区分 `function`
- 区分 builtin / hosted / provider-native
- 统一 `tool_choice` canonical shape

建议规则：

- function tools 继续走现有 schema sanitize
- builtin / hosted tools 先保留最小元数据，不强行伪装成 function schema
- 不支持的 provider 必须显式降级或拒绝，不得静默吞掉

完成结果：

- tool shape 判断逻辑从 translator 主文件中抽离
- `tool_choice` 兼容不再只靠 `auto/any/tool(name)`

## M3 fixture corpus

目标：

- 用数据驱动测试替代一部分手写 case

已落地目录：

```text
tests/
  fixtures/
    translators/
      request/
      response/
      sse/
      roundtrip/
```

建议内容：

- text only
- tool_use / tool_result
- thinking
- multimodal image
- multimodal document
- incomplete response
- provider-specific degraded cases

完成结果：

- 至少有一组 request fixtures
- 至少有一组 response fixtures
- 至少有一组 SSE fixtures
- 至少有一组 round-trip fixtures

## M4 provider capability registry

目标：

- 把“某 provider / model 支不支持某协议能力”的判断从散落逻辑收拢为数据

已落地：

- `src/translators/normalizers/capabilities.js`
  或
- `src/translators/capability-registry.js`

当前实现说明：

- 当前能力注册表以 `src/translators/registry.js` 中的 capability profile 形式落地
- 先从 Gemini Anthropic bridge 中已存在的真实差异开始建模
- 保持最小字段集，避免过度设计

建议建模字段：

- `supportsReasoning`
- `supportsThinkingWithTools`
- `supportsInputImage`
- `supportsInputFile`
- `supportsStructuredToolResult`
- `supportsHostedTools`
- `supportsResponseCompletedEcho`

完成结果：

- Gemini / Vertex 的 thinking+tools 限制改为 capability 判断
- 文件输入支持不再靠 provider 文件里的隐式分支

---

## 6. 实施顺序

Phase 3 建议按以下顺序推进：

1. 先做 `M1 requestEcho` 统一
2. 再做 `M4 capability registry`
3. 再做 `M2 hosted/builtin tools`
4. 最后做 `M3 fixture corpus`

这个顺序的原因：

- `requestEcho` 和 capability registry 会先稳定协议模型
- hosted/builtin tools 依赖 capability 建模
- fixture corpus 最适合在规则基本稳定后再批量沉淀

---

## 7. 具体改造建议

第一批建议落地的文件：

- `src/translators/normalizers/request-echo.js`
- `src/translators/normalizers/capabilities.js`
- `src/translators/request/anthropic-to-openai-responses.js`
- `src/translators/response/openai-responses-to-anthropic.js`
- `src/translators/response/openai-responses-sse-to-anthropic-sse.js`

第二批建议落地的文件：

- `src/translators/normalizers/tools.js`
- `src/translators/normalizers/responses-request.js`
- `src/translators/normalizers/responses-events.js`

测试与基线：

- `tests/unit/translator-normalizers.test.js`
- `tests/unit/translator-sse.test.js`
- `tests/unit/translator-roundtrip.test.js`
- 新增 fixture-driven tests

---

## 8. 验收标准

Phase 3 完成时，至少需要满足：

- `requestEcho` 回填策略有统一 helper
- capability 判断从零散 if/else 收拢为共享逻辑
- hosted / builtin tools 有明确 canonical shape 与降级策略
- fixture corpus 覆盖 request / response / SSE / round-trip
- 新增 provider / model 能力时，不需要在多个文件里重复写同类判断

当前状态：

- 上述验收标准已满足，Phase 3 视为完成

若以下任一项未满足，则不应视为完成：

- capability 仍分散在 provider 文件中难以追踪
- `tool_choice` 与 builtin tools 仍只能靠局部特判
- fixture corpus 仍未建立，只能继续靠堆手写 case

---

## 9. 风险

### 9.1 `requestEcho` 过度回填

风险：

- 把不应暴露给 northbound 的字段也带回去

策略：

- 用白名单回填，不做“全量 echo”

### 9.2 capability registry 过度设计

风险：

- 抽象太早，字段太多，结果没人真正用

策略：

- 从当前已出现的真实差异开始建模，只加用得上的字段

### 9.3 hosted tools 兼容不统一

风险：

- 某些 provider 被强行套进 function tool，反而破坏语义

策略：

- 保持 canonical shape 与 provider-specific 映射分离

---

## 10. 实际落地摘要

第一批已落地文件：

- `src/translators/normalizers/request-echo.js`
- `src/translators/normalizers/tools.js`
- `src/translators/request/anthropic-to-openai-responses.js`
- `src/translators/request/anthropic-to-gemini.js`
- `src/translators/response/openai-responses-to-anthropic.js`
- `src/translators/response/openai-responses-sse-to-anthropic-sse.js`
- `src/translators/registry.js`

测试与 fixture 基线：

- `tests/unit/translator-normalizers.test.js`
- `tests/unit/translator-sse.test.js`
- `tests/unit/translator-roundtrip.test.js`
- `tests/unit/translator-registry.test.js`
- `tests/unit/translator-fixtures.test.js`
- `tests/fixtures/translators/request/`
- `tests/fixtures/translators/response/`
- `tests/fixtures/translators/sse/`
- `tests/fixtures/translators/roundtrip/`

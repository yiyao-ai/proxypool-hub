# 协议转换层重构 Phase 1 实施清单

## 1. 目的

本文档用于把第一阶段重构从“方向”落实为“执行清单”。

目标不是立即全量替换旧链路，而是完成以下事情：

- 建立新的转换层目录骨架
- 抽离公共 normalizer
- 锁定第一条迁移主链路
- 明确哪些文件暂时不动
- 明确哪些测试必须先补齐

---

## 2. 第一阶段目标

第一阶段只做一件核心工作：

**为 `Anthropic Messages <-> OpenAI Responses` 主链路建立新的 translator 内核。**

这条主链路当前承载：

- Claude Code / OpenClaw 兼容
- ChatGPT account 路由
- tool_use / tool_result
- thinking / signature
- 多模态图片输入
- Responses SSE -> Anthropic SSE

如果这条主链路可以平稳迁入新架构，后续其他 provider 和 route 才值得继续迁移。

---

## 3. 本阶段新增目录

第一阶段建议新增以下目录：

```text
src/
  translators/
    registry.js
    request/
      anthropic-to-openai-responses.js
    response/
      openai-responses-to-anthropic.js
      openai-responses-sse-to-anthropic-sse.js
    normalizers/
      anthropic-messages.js
      tool-ids.js
      schemas.js
      thinking.js
      multimodal.js
      usage.js
      stop-reasons.js
    shared/
      content-blocks.js
      sse.js
  executors/
    chatgpt-responses-executor.js
```

第一阶段不要新增过多抽象层，不要一开始引入过大的统一 DSL。

---

## 4. 本阶段要抽离的公共能力

## 4.1 message normalizer

来源：

- `src/claude-api.js`
- `src/thinking-utils.js`

需要抽离的能力：

- 过滤不允许的 body 字段
- 修正首条 `user`
- 合并连续同 role message
- `system` 文本抽取
- Anthropic assistant content 重排

## 4.2 tool id normalizer

来源：

- 历史 Responses wrapper / 旧转换实现
- `src/kilo-format-converter.js`

需要抽离的能力：

- `toolu_*` <-> `fc_*`
- `call_*` <-> `toolu_*`
- 缺失 id 时的生成策略

要求：

- 所有转换链路统一使用这一套函数
- 后续不允许各文件再私自发明映射规则

## 4.3 schema normalizer

来源：

- `src/claude-api.js`
- `src/json-schema-normalizer.js`
- `src/providers/azure-openai.js`
- `src/providers/gemini.js`

需要抽离的能力：

- 顶层 `oneOf/anyOf/allOf/$ref` 归一化
- `const -> enum`
- 数组 type 降维
- provider 不兼容字段移除
- 保留 Claude Code 工具约束需要的字段

## 4.4 thinking/signature normalizer

来源：

- `src/thinking-utils.js`
- `src/signature-cache.js`
- 历史 Responses wrapper / 旧 SSE wrapper

需要抽离的能力：

- 签名缓存
- thinking block 清洗
- trailing unsigned thinking 删除
- content block 排序
- tool_use signature 恢复
- OpenAI reasoning -> Anthropic thinking

## 4.5 multimodal normalizer

来源：

- 历史 Responses wrapper / 旧转换实现
- `src/providers/azure-openai.js`
- `src/providers/gemini.js`
- `src/providers/vertex-ai.js`
- `src/routes/codex-route.js`
- `src/routes/responses-route.js`

需要抽离的能力：

- Anthropic `image` -> Responses `input_image`
- Anthropic `image` -> Gemini/Vertex `inlineData` / `fileData`
- `tool_result` 富内容统一抽象
- base64 / url 图像统一处理
- 文档类内容统一处理入口

## 4.6 usage / stop_reason normalizer

来源：

- 历史 SSE wrapper
- 历史 Responses wrapper / 旧转换实现
- `src/kilo-format-converter.js`
- `src/providers/format-bridge.js`
- `src/providers/gemini.js`
- `src/providers/vertex-ai.js`

需要抽离的能力：

- OpenAI -> Anthropic usage 映射
- Gemini -> Anthropic usage 映射
- cache token 字段统一
- `tool_calls/function_call -> tool_use`
- `length -> max_tokens`

---

## 5. 第一阶段要迁移的主链路

## 5.1 请求路径

旧链路：

- `messages-route.js`
- `direct-api.js`
- 历史 Responses wrapper

第一阶段新链路目标：

- route 仍然调用 `direct-api.js`
- `direct-api.js` 不再自己依赖旧 converter 实现细节
- 由新 request translator 负责：
  - Anthropic body -> OpenAI Responses request body

## 5.2 非流式响应路径

旧链路：

- `direct-api.js`
- 历史 Responses wrapper

第一阶段新链路目标：

- 由新 response translator 负责：
  - OpenAI Responses `output[]` -> Anthropic `content[]`
  - usage -> Anthropic usage
  - stop_reason -> Anthropic stop_reason

## 5.3 流式响应路径

旧链路：

- 历史 SSE wrapper
- `messages-route.js`

第一阶段新链路目标：

- 由新 SSE response translator 负责：
  - `response.output_item.added`
  - `response.output_text.delta`
  - `response.function_call_arguments.delta`
  - `response.completed`
  - 转换为标准 Anthropic SSE events

要求：

- route 不负责流式 chunk 语义组装
- route 只负责把 translator 输出写回响应

---

## 6. 第一阶段明确不动的文件

以下文件第一阶段不做大改，只允许最小接线修改：

- `src/routes/messages-route.js`
- `src/routes/responses-route.js`
- `src/routes/codex-route.js`
- `src/providers/openai.js`
- `src/providers/azure-openai.js`
- `src/providers/gemini.js`
- `src/providers/vertex-ai.js`
- `src/kilo-format-converter.js`

原因：

- 第一阶段目标是建立新内核，而不是同时迁移所有 provider/route
- 避免把回归面扩散到整个项目

---

## 7. 第一阶段必须补齐/复用的测试

## 7.1 直接复用为基线的现有测试

以下测试可直接作为第一阶段迁移基线：

- `tests/unit/format-converter.test.js`（当前作为 Phase 1 translator kernel 的历史命名回归测试保留）
- `tests/unit/azure-openai-provider.test.js`
- `tests/unit/gemini-provider.test.js`
- `tests/unit/vertex-ai-provider.test.js`
- `tests/unit/kilo-format-converter.test.js`
- `tests/unit/responses-route.test.js`
- `tests/unit/responses-sse.test.js`

## 7.2 第一阶段必须新增的测试

### A. normalizer 纯函数测试

至少新增：

- `anthropic-messages normalizer`
- `tool-ids normalizer`
- `schemas normalizer`
- `multimodal normalizer`
- `usage normalizer`
- `stop-reasons normalizer`

### B. translator 纯函数测试

至少新增：

- `anthropic-to-openai-responses`
- `openai-responses-to-anthropic`
- `openai-responses-sse-to-anthropic-sse`

### C. 行为等价测试

要求验证：

- 新 translator 对同一输入与旧逻辑结果一致
- 至少覆盖：
  - text
  - tool_use
  - tool_result
  - image input
  - multimodal tool_result
  - reasoning/thinking

---

## 8. 第一阶段验收门槛

本阶段完成的最低标准：

- 新目录结构已建立
- 新 translator registry 可用
- Anthropic <-> OpenAI Responses 主链路已接入新 translator
- 旧入口仍保留
- 现有主链路行为不退化
- 多模态图片输入不退化
- `tool_result` 富内容不退化
- thinking / signature 不退化

若以下任一项未满足，则第一阶段不能视为完成：

- Claude Code 经 ChatGPT Responses 路径回归
- 流式 SSE 回归
- tool call 回归
- 图片路径回归
- `tool_result` 图像内容回归

---

## 8.1 当前验收状态（2026-04-03）

当前代码与测试状态如下：

- 已完成：
  - 新目录结构已建立
  - translator registry 已接入
  - `direct-api.js` 主链路已切换到新 translator
  - OpenAI / Azure 的 Anthropic bridge 已复用新 translator
  - text / tool_use / tool_result / 图片输入 / multimodal tool_result / SSE 已有测试覆盖
  - thinking / signature 关键路径已补充回归测试
  - 历史 Responses/SSE wrapper 文件已删除

- 剩余收尾：
  - 将所有残余测试命名与文档表述从旧 converter 术语切换到 translator kernel 术语

结论：

- Phase 1 已可视为“架构完成 + 验证通过”
- 后续工作应以清理与扩展为主，而不是重新建设第一阶段能力

---

## 9. 第一阶段回滚方式

如果第一阶段接线后出现问题，回滚方式应为：

- 让 `direct-api.js` 暂时重新调用旧 converter
- 保留新增 `src/translators/` 目录不删
- 修复后再次切换

不建议：

- 删除新目录
- 通过大规模 git 回滚抹掉第一阶段成果

因为第一阶段的目标就是先把新内核搭起来，即使接线需要短暂回切，目录和纯函数也应保留。

---

## 10. 本阶段结束后应更新的文档

第一阶段完成后，至少需要更新：

- `docs/TRANSLATOR_REFACTOR_PLAN.md`
- `docs/TRANSLATOR_CAPABILITY_MATRIX.md`
- `docs/ARCHITECTURE.md`

并补充：

- 新目录说明
- 已迁移链路说明
- 已知未迁移链路说明

---

## 11. 下一阶段预告

第一阶段完成后，第二阶段优先处理：

1. OpenAI / Azure OpenAI provider 从协议拼装中退出
2. Gemini / Vertex provider 的 multimodal / reasoning 降级策略收敛
3. `messages-route.js` 瘦身

在第一阶段没有稳定前，不进入第二阶段。

# 协议转换层下一阶段路线图

## 1. 目标

基于最近几轮的协议转换优化，下一阶段不再以“继续抽象内部结构”为主，而转向：

- 以新增 northbound 功能为主
- 以小步、可验证的方式补齐 capability 语义
- 在每一步实现前先核对现有代码，避免重复开发

原则：

- 先查已有实现，再写代码
- 优先复用现有 normalizer / translator / capability registry
- 只在 northbound 语义确实缺失时新增逻辑

---

## 2. 当前状态

已完成并可复用：

- chat bridge 共享化
- translator metadata 透传与日志接通
- capability registry 最小落地
- hosted tools `web_search_*` 试点

当前仍值得继续推进的，不是内部重构，而是：

- strict compatibility 行为
- capability-aware route 行为
- hosted tools 从试点走向产品化
- 多模态 capability 从“可转换”走向“可解释”

---

## 3. 后续迭代顺序

### Iteration 1: Strict Translator Compatibility

目标：

- 把 translator downgrade 从“只记录日志”升级为“可配置的显式拒绝”
- 先覆盖 `/v1/messages` 的 compatible provider bridge

实施前核对：

- 是否已有 strict translator 设置
- 是否已有 route 级 downgrade 拒绝
- 是否已有统一 translator metadata helper 可复用

完成定义：

- 新增独立设置项
- strict 模式下，translator downgrade 返回显式 `400`
- 保持默认兼容行为不变

当前状态：

- 已完成首版实现
- 已新增 `strictTranslatorCompatibility`
- 已接入 `/v1/messages` compatible provider bridge
- 尚未扩展到 `/responses`

### Iteration 2: Capability-aware Routing

目标：

- 在 routing 决策阶段尽量避开必然 downgrade 的 provider
- 优先把“可支持 hosted tools / multimodal”纳入候选选择

实施前核对：

- 是否已有 provider capability matrix 可直接复用
- 是否已有 routing preview / runtime routing state 可扩展
- 是否已有 provider/model 能力判断散落在 route 中

完成定义：

- 至少一条 route 在选择 compatible provider 时会参考 capability
- 明显不兼容的 provider 不再优先尝试

当前状态：

- 已完成首版实现
- `/v1/messages` compatible provider 选择已改为 capability-aware ranking
- 当前会优先考虑 hosted tools / image / file / structured tool_result 需求

### Iteration 3: Hosted Tools Productization

目标：

- 把 `web_search_*` 从试点规则推进为稳定的 northbound 功能
- 明确支持矩阵、错误语义与日志语义

实施前核对：

- 是否已有 provider 显式拒绝
- 是否已有 passthrough 链路
- 是否已有结果透传或事件映射可复用

完成定义：

- 支持链路、拒绝链路、降级链路都有稳定行为
- 文档和测试覆盖对外语义

当前状态：

- `web_search_*` 试点已进入稳定规则阶段
- Anthropic / Vertex Claude rawPredict 视为支持链路
- OpenAI / Azure OpenAI / Gemini / Vertex Gemini 视为显式拒绝链路

### Iteration 4: Multimodal Contract Hardening

目标：

- 把 `input_image` / `input_file` / structured tool result 的 capability 变成明确 northbound 契约

实施前核对：

- 是否已有 capability 字段
- 是否已有 translator 降级逻辑
- 是否已有 provider 原生 passthrough 能力

完成定义：

- 每类输入在主要 bridge 上都有明确的 passthrough / downgrade / reject 规则

当前状态：

- 文本 / image / file / structured tool_result 的 capability 字段已存在
- `messages` 路由已开始按请求特征做 provider 排序
- 文档矩阵已更新为 northbound 契约基线

---

## 4. 本轮实施范围

本轮只做：

- `Iteration 1: Strict Translator Compatibility`

本轮不做：

- 自动重路由
- dashboard 配置页面改造
- 新 hosted tool 类型支持
- `/responses` 路由 strict translator 行为

---

## 5. 执行约束

后续每个迭代都遵循以下步骤：

1. 先检索现有计划和代码实现
2. 只补当前缺失的一层，不重复实现共享逻辑
3. 优先新增最小 helper，而不是大规模重构
4. 先补单测，再扩范围

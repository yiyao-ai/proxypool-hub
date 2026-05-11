# CliGate Assistant 双模会话主权与审批治理重构方案

> **版本**：v2  
> **日期**：2026-05-11  
> **状态**：Phase 1-4 已完成最小闭环实现，待继续扩大测试覆盖与场景验证  
> **适用范围**：钉钉 / 飞书 / Telegram / Chat UI 等所有会话型入口  
> **优先级**：优先完成 assistant mode；direct-runtime mode 本轮仅做隔离，不做大改  
> **关联文档**：
> - [`cligate-assistant-architecture.md`](./cligate-assistant-architecture.md)
> - [`channel-supervisor-agent-design.md`](./channel-supervisor-agent-design.md)
> - [`cligate-assistant-requirements.md`](./cligate-assistant-requirements.md)
> - [`agent-runtime-session-continuity.md`](./agent-runtime-session-continuity.md)

---

## 0. TL;DR

当前系统的主要问题，不是 assistant 缺少理解能力，而是：

- assistant 已具备较强的记忆、引用解析、任务视图、工具调用能力；
- 但 **assistant mode 下 assistant 还没有真正拥有会话主权**；
- runtime 事件和 assistant 后台结果都可能直接向渠道出站；
- 结果就是同一会话里会出现多发言人、旧任务插话、当前问题被打断、文案来源不一致。

本次重构的最终目标非常明确：

1. **direct-runtime mode = runtime-owned conversation**
   - assistant 完全不参与；
   - 用户直接和 runtime / application 对话；
   - 当前链路尽量保持现状，本轮只做隔离，不做大改。

2. **assistant mode = assistant-owned conversation**
   - 所有入站都先进入 assistant；
   - 所有用户可见出站都必须先经过 assistant；
   - runtime 只负责执行、产生日志、状态、审批、问题、结果这些事实；
   - assistant 作为“数字人分身”，负责理解、记忆、规划、审批治理、任务协作和最终表达。

3. **assistant mode 下，assistant 同时拥有消息控制权和审批治理权**
   - 用户说“以后给 Codex 这个仓库读权限”；
   - assistant 应记住并落为策略；
   - 后续同类低风险审批应自动通过；
   - 超出授权边界或高风险操作时，再来问用户。

这不是重写 assistant，而是一次：

- **会话主权重构**
- **消息控制权收口**
- **审批治理权上收**
- **assistant mode 产品语义兑现**

---

## 1. 背景与问题定义

### 1.1 用户实际感受到的问题

在渠道对话中，用户提出一个明确问题时，系统可能先返回几条不相干消息，随后才返回相关答案。

这类现象通常不是：

- 渠道重复推送；
- 用户消息被重复消费；
- assistant 能力本身失效。

真正的问题是：

- **同一 conversation 内存在多个直接出站源**
- 旧任务结果、runtime terminal event、assistant background result 都可能绕过统一治理直接发给用户。

### 1.2 当前问题的本质

当前 assistant mode 的真实语义更接近：

- assistant 参与了入站理解；
- runtime 仍保留直接出站能力。

因此它还是：

- **assistant-aware conversation**

而不是：

- **assistant-owned conversation**

这会直接导致：

1. 旧任务完成结果打断当前问题；
2. assistant 和 runtime 都在向用户说话；
3. 消息来源、语气、相关性不一致；
4. 用户无法判断当前到底是谁在和自己对话；
5. “像人一样协作”的体验无法成立。

### 1.3 当前不是能力缺失，而是控制边界错误

从现有实现看，assistant 其实已经具备很多关键能力：

- 任务空间视图；
- workspace / cwd 理解；
- 引用解析；
- recall / memory / preference / policy；
- ReAct 工具调用；
- runtime delegation；
- pending approval / question / clarification 识别。

问题在于：

> assistant 已经能理解上下文，但还没有拿到 conversation 的最终发言权，也还没有真正接管审批治理。

---

## 2. 产品目标

### 2.1 双模产品语义

CliGate Assistant 必须明确分成两种模式，并长期共存。

### A. direct-runtime mode

用户直接面对 runtime。

- assistant 不参与；
- runtime 直接接收用户输入；
- runtime 直接返回结果、审批、问题；
- 保持链路轻量、透明、低延迟。

### B. assistant mode

用户面对的是 assistant 本人，而不是 runtime。

- assistant 是唯一对话主人；
- assistant 像人类协作者一样理解上下文；
- assistant 能记忆项目、任务、偏好和历史约定；
- assistant 能决定是否继续、发起、取消、澄清、规划；
- assistant 能查看 runtime 事实并决定是否、何时、如何告知用户；
- assistant 能基于记忆和策略治理审批，而不是每次都机械询问用户。

### 2.2 assistant mode 的数字人目标

assistant mode 下，assistant 应表现得像用户的数字人分身：

- 记得前文，不是每轮失忆；
- 知道当前主线任务，不被旧任务轻易打断；
- 能理解“刚才那个”“另一个任务”“继续这个项目”；
- 能管理项目、制定计划、推进实施；
- 能代替用户做部分低风险决策；
- 只在必要时打扰用户；
- 输出保持统一人格和统一口吻。

---

## 3. 本次重构必须满足的架构不变量

### 3.1 direct-runtime mode 的不变量

1. assistant 不参与入站处理。
2. assistant 不参与出站处理。
3. runtime 仍可直接向渠道发消息。
4. 本轮尽量复用当前实现，不做大改。

### 3.2 assistant mode 的不变量

1. 所有入站必须先进入 assistant。
2. 所有用户可见出站必须先经过 assistant 决策。
3. runtime event 是事实源，不是天然文案源。
4. runtime 在 assistant mode 下不再直接对用户说话。
5. assistant 不仅拥有消息控制权，也拥有审批治理权。

### 3.3 安全与授权的不变量

1. assistant 必须能记住用户的授权偏好。
2. assistant 应优先复用已有授权，不要重复询问同类审批。
3. assistant 可自动批准低风险、已授权、在作用域内的操作。
4. assistant 对超出授权范围或高风险操作，仍应保留询问用户的能力。

---

## 4. 当前实现盘点

## 4.1 已经具备的基础

### assistant 智能与上下文层

- `src/assistant-agent/prompt-builder.js`
- `src/assistant-agent/reference-resolver.js`
- `src/assistant-agent/react-engine.js`
- `src/assistant-agent/dialogue-service.js`

现状：

- 已能构建较强上下文；
- 已能解析“这个/那个/另一个”；
- 已能执行多轮工具调用；
- 已具备 assistant run 和 background callback 机制。

### assistant 核心能力层

- `src/assistant-core/mode-service.js`
- `src/assistant-core/task-view-service.js`
- `src/assistant-core/observation-service.js`
- `src/assistant-core/memory-service.js`
- `src/assistant-core/policy-service.js`
- `src/assistant-core/tool-registry.js`

现状：

- assistant mode 的入站主流程已经基本建立；
- task space / supervisor brief / runtime observation 已有较好基础；
- memory / policy 已存在，但尚未完整承接审批治理职责。

### runtime 与会话层

- `src/agent-orchestrator/message-service.js`
- `src/agent-orchestrator/supervisor-task-sync.js`
- `src/agent-runtime/*`
- `src/agent-channels/router.js`
- `src/chat-ui/conversation-service.js`

现状：

- 会话、runtime session、task memory、supervisor task 已能关联；
- assistant mode 与 direct-runtime mode 的入站语义已部分区分；
- Chat UI 侧已经存在“只观察 runtime 事实、不直接出站”的思路。

## 4.2 当前真正的缺口

### 缺口 A：assistant mode 下没有单一 speaker of record

当前存在两个直接出站源：

1. assistant background result 直发；
2. runtime event dispatcher 直发。

这意味着 assistant mode 下仍然是多发言人架构。

### 缺口 B：审批治理仍偏 runtime-owned

当前 approval request 的处理更多仍停留在：

- runtime 产生审批；
- 系统询问用户；
- 用户回复；
- runtime 继续。

而不是：

- runtime 产生审批事实；
- assistant 结合记忆、策略、作用域和风险等级作出是否自动批准的决策；
- 只有超界或高风险时才询问用户。

### 缺口 C：conversation 语义还不够收敛

当前 conversation 上混合了多组概念：

- `conversation.mode`
- `metadata.assistantCore.mode`
- `activeRuntimeSessionId`
- `trackedRuntimeSessionIds`
- `activeTaskId`
- `trackedTaskIds`

这会导致“控制模式”和“谁拥有发言权”继续混淆。

---

## 5. 目标架构

## 5.1 direct-runtime mode

```text
User inbound
  -> Router / ConversationService
  -> MessageService
  -> Runtime
  -> Runtime direct outbound
  -> Channel
```

特点：

- assistant 不参与；
- 审批维持当前直连实现；
- 本轮只做代码边界隔离，不重构其核心行为。

## 5.2 assistant mode

```text
User inbound
  -> Router / ConversationService
  -> Assistant
  -> (observe / recall / resolve / plan / delegate / approve / ask)
  -> Runtime(s) as execution backends
  -> Runtime events become facts
  -> Assistant decides whether / when / how to speak
  -> Channel outbound
```

特点：

- assistant 是唯一对话主人；
- runtime 只是执行器和事实源；
- 渠道层只负责传输和持久化，不做文案决策；
- assistant 同时管理消息表达和审批策略。

---

## 6. 会话模型收敛方案

建议将 conversation 语义整理为三层。

### 6.1 controlMode

表示当前这段会话由谁掌控。

- `assistant`
- `direct-runtime`

### 6.2 runtimeBinding

表示当前 conversation 关联了哪些 runtime / task。

- `activeRuntimeSessionId`
- `trackedRuntimeSessionIds`
- `activeTaskId`
- `trackedTaskIds`

### 6.3 deliveryOwnership

表示谁拥有用户可见出站的决策权。

- `assistant-owned`
- `runtime-owned`

### 6.4 约束关系

- `controlMode=assistant` => `deliveryOwnership=assistant-owned`
- `controlMode=direct-runtime` => `deliveryOwnership=runtime-owned`

说明：

- 后续不应再用 `conversation.mode` 判断“谁负责发消息”；
- `conversation.mode` 如继续保留，只用于兼容或运行态绑定语义。

---

## 7. assistant mode 下的审批治理目标

这是本次方案新增且必须明确的一部分。

### 7.1 目标

assistant mode 下，assistant 不应把每个 approval request 都原样抛给用户。

assistant 应像一个成熟的人类代理一样处理审批：

- 记住用户之前给出的授权偏好；
- 结合 provider、工具、目录、工作区、任务上下文与风险等级；
- 判断是否可自动批准；
- 判断是否应自动拒绝；
- 无法确定时才询问用户。

### 7.2 用户表达示例

assistant 应能理解并记住这类授权表达：

- “以后给 Codex 这个仓库的读权限”
- “后续给 Codex 所有权限”
- “允许看日志，但修改文件前先问我”
- “Claude Code 可以读，不能写”
- “这个任务里安装依赖先别自动过”

### 7.3 授权作用域模型

授权策略建议至少支持三层作用域：

1. `task/session`
   - 当前任务 / 当前会话临时授权

2. `workspace`
   - 当前仓库 / 当前工作区授权

3. `global`
   - 用户级长期偏好

优先级：

- `task/session > workspace > global`

### 7.4 风险分级建议

assistant 不应把“全部允许”理解为对任何操作无脑放行。

建议至少区分：

#### 低风险

- 读取工作区文件；
- 查看 git log / git status；
- 列目录；
- 查询构建信息；
- 查看测试结果。

#### 中风险

- 修改工作区代码；
- 运行测试；
- 安装当前项目依赖；
- 写入工作区内生成文件。

#### 高风险

- 删除大量文件；
- 访问工作区外敏感目录；
- 执行明显破坏性命令；
- 外发敏感信息；
- 超出已授权边界的高危操作。

### 7.5 assistant mode 下的审批处理顺序

1. runtime 产出 approval fact
2. assistant 读取 policy / memory / workspace / task context
3. assistant 判断：
   - `approve`
   - `deny`
   - `ask_user`
4. 若需询问用户，再由 assistant 以统一人格向用户表达

---

## 8. 重构方案

## 8.1 总体策略

本轮不做“大一统重写”，而是采用：

- **assistant mode 优先实现**
- **direct-runtime mode 尽量少动**
- **先收口会话主权，再强化 assistant 治理能力**

## 8.2 方案核心

### A. 将 assistant mode 彻底变成 assistant-owned conversation

在 assistant mode 下：

- 所有用户消息先进入 assistant；
- runtime 事件只作为事实写入 observation / task-view / memory；
- 所有用户可见消息都必须先经过 assistant 决策；
- approval governance 由 assistant 接手。

### B. 保持 direct-runtime mode 基本稳定

在 direct-runtime mode 下：

- 保留当前 runtime 直连、直发、直审批链路；
- 本轮只做边界隔离，避免和 assistant mode 共享出站控制权；
- 暂不做大幅度行为变更。

---

## 9. 模块级实施方案

## 9.1 新增统一出站裁判层

建议新增：

- `src/agent-channels/conversation-delivery-arbiter.js`

职责：

- 统一接收所有候选出站事件；
- 根据 `controlMode + deliveryOwnership + source + payload` 判断：
  - `send_now`
  - `store_only`
  - `forward_to_assistant`

候选 source 至少包括：

- `assistant_run_result`
- `runtime_event`
- `system_notification`

目标：

- 任何渠道出站都必须先经过 arbiter；
- 不再允许 runtime 和 assistant 各自绕过对方直接发送。

## 9.2 收口渠道 runtime 事件出站

重点改造：

- `src/agent-channels/outbound-dispatcher.js`

当前问题：

- runtime event 到来后会直接格式化并 `sendMessage()`。

目标行为：

- direct-runtime mode：保留现有直发；
- assistant mode：runtime event 不再直接发给用户，只同步事实并交给 assistant 处理。

## 9.3 收口 assistant background result 出站

重点改造：

- `src/agent-channels/router.js`
- `src/chat-ui/conversation-service.js`

当前问题：

- assistant background result 在 callback 中直接发消息。

目标行为：

- background result 也必须经过 arbiter；
- 渠道发送逻辑统一收口。

## 9.4 新增 assistant 事件摄取与会话治理入口

建议新增：

- `src/assistant-core/event-ingest-service.js`

职责：

- 接收 runtime fact；
- 写入 observation / memory / task-view；
- 判断是否触发 assistant 主动发言；
- 将需要用户可见的事件交回 assistant 决策链。

第一版建议只覆盖：

- `approval_request`
- `question`
- `completed`
- `failed`

默认静默：

- `started`
- `running`
- `progress`

## 9.5 新增 assistant 审批治理模块

建议新增：

- `src/assistant-core/approval-governor.js`

职责：

- 接收 approval fact；
- 读取 memory / policy / workspace / task / provider / tool scope；
- 输出：
  - `approve`
  - `deny`
  - `ask_user`

该模块应复用现有基础：

- `assistant-core/memory-service.js`
- `assistant-core/policy-service.js`
- `agent-runtime/approval-service.js`
- `agent-runtime/approval-policy-store.js`

## 9.6 assistant 工具与策略存取能力补强

建议补充或显式化以下能力：

- 保存授权偏好；
- 读取当前授权策略；
- 撤销或修改已有授权；
- 解释为什么这次自动批准或要求确认。

建议优先挂在：

- `src/assistant-core/tool-registry.js`

这样 assistant 才能真正把用户的授权表达沉淀成长期治理能力。

---

## 10. 分阶段实施计划

## Phase 0：文档与边界收敛

状态：**已完成**

目标：

- 明确双模语义；
- 明确 assistant mode 的消息主权和审批治理目标；
- 明确本轮优先级是 assistant mode；
- 明确 direct-runtime mode 本轮只做隔离。

交付：

- 本文档。

## Phase 1：建立会话主权与统一出站仲裁

状态：**已完成（最小闭环）**

目标：

- assistant mode 下不再存在多个直接出站源；
- 所有出站统一经过 arbiter。

必须完成：

1. 引入 `conversation-delivery-arbiter`
2. 改造 `agent-channels/outbound-dispatcher.js`
3. 改造 `agent-channels/router.js`
4. 改造 `chat-ui/conversation-service.js`
5. conversation 上补清晰的 `controlMode / deliveryOwnership`

完成标准：

- assistant mode 下 runtime 不再直接对用户发最终消息；
- assistant background result 也不再旁路发送；
- direct-runtime mode 下现有行为保持基本不变。

## Phase 2：assistant runtime fact 摄取与最小会话治理

状态：**已完成（最小闭环）**

目标：

- assistant mode 下，runtime event 能真正进入 assistant 决策链。

必须完成：

1. 引入 `event-ingest-service`
2. 让 approval / question / failed / relevant completed 进入 assistant 决策
3. started / running / progress 默认只记录不打断

完成标准：

- 当前问题不会被无关旧任务结果打断；
- assistant 能在必要时主动同步真正重要的信息。

## Phase 3：assistant 审批治理与授权记忆

状态：**已完成（最小闭环）**

目标：

- assistant 记住用户授权偏好；
- assistant 可自动决策一部分审批。

必须完成：

1. 引入 `approval-governor`
2. 支持 task/workspace/global 三层授权作用域
3. 支持低/中/高风险分类
4. assistant 可解析并记住“后续给 Codex 权限”这类表达

完成标准：

- 同类低风险审批不再每次都问用户；
- assistant 能解释为什么自动批准或为什么仍需确认。

## Phase 4：模型与测试收口

状态：**已完成（第一轮收口）**

目标：

- 清理 conversation 语义重叠；
- 补齐回归测试；
- 确保新会话和旧会话都能稳定工作。

必须完成：

1. 收敛会话模型字段语义
2. 补充渠道 / Chat UI / assistant / approval 的单测
3. 补充“旧任务打断当前问题”的事故回归测试

---

## 11. 当前进度判断

截至 **2026-05-11**，当前进度判断如下：

### 已有进展

- assistant mode 入站主流程已建立；
- assistant mode 出站主权已收口到 arbiter；
- runtime event 在 assistant mode 下已不再直接对用户发言；
- approval / question / failed / current completed 已能走 assistant 统一表达；
- remembered approval policy 已能驱动 assistant mode 下的自动审批；
- `controlMode / deliveryOwnership` 已进入 conversation 状态模型；
- 已补充一组针对 Phase 1-4 的最小单测闭环。

### 尚未完成

- 还未将 Phase 1-4 的最小测试并入更完整的大型回归集；
- 还未完成更复杂授权表达的自然语言提取与持久化；
- 还未完成 workspace / conversation / global 三层授权作用域的完整用户交互闭环；
- 还未覆盖更多真实渠道 provider 的端到端场景验证；
- 还需要继续更新相关设计文档与实施记录。

### 当前结论

这次工作不应被视为轻量 bugfix。  
它是一次：

- **中等规模架构收口改造**

重点影响：

- `agent-channels`
- `assistant-core`
- `chat-ui conversation service`
- 审批相关治理链
- 对应 unit tests

### 当前已实现模块

- `src/agent-channels/conversation-delivery-arbiter.js`
- `src/agent-channels/delivery-sender.js`
- `src/assistant-core/event-ingest-service.js`
- `src/assistant-core/approval-governor.js`
- `src/assistant-core/assistant-state.js`

### 当前已补充测试

- `tests/unit/assistant-delivery-arbiter.test.js`
- `tests/unit/assistant-event-ingest.test.js`
- `tests/unit/assistant-approval-governor.test.js`
- `tests/unit/assistant-state-model.test.js`

---

## 12. 本轮实施清单

## 12.0 进度面板

### 已完成

- 文档与目标语义收敛
- 双模边界定义
- assistant mode 的消息主权目标定义
- assistant mode 的审批治理目标定义
- 本轮优先级与范围冻结
- Phase 1：统一出站仲裁与 assistant-owned delivery
- Phase 2：runtime fact -> assistant 统一表达
- Phase 3：remembered approval policy -> 自动审批最小闭环
- Phase 4：controlMode / deliveryOwnership 第一轮模型收敛与最小测试闭环

### 待开始

- 更大范围单测/集成回归整合
- 更复杂授权表达解析
- 多作用域授权策略的用户交互闭环
- 文档与实现状态的持续同步

以下清单按优先级排列。

### 12.1 必须做

1. 明确 conversation 的 `controlMode` 与 `deliveryOwnership`
2. 新增统一 `conversation-delivery-arbiter`
3. 让 `agent-channels/outbound-dispatcher.js` 在 assistant mode 下停止 runtime 直发
4. 让 `router.js` / `chat-ui/conversation-service.js` 的 assistant background result 统一走 arbiter
5. 新增 `event-ingest-service`，让 runtime fact 进入 assistant 决策链
6. 新增 `approval-governor`，实现 assistant mode 的审批治理
7. 支持授权偏好的记忆与持久化
8. 补齐事故回归测试与模式分离测试

### 12.2 本轮建议完成

1. assistant 能解释自动批准 / 需确认的原因
2. assistant 能区分 task/workspace/global 授权作用域
3. assistant 能对“查看目录 / 读取仓库 / 修改代码 / 安装依赖”做风险分级
4. assistant mode 下对无关旧任务完成默认静默

### 12.3 本轮不优先做

1. 重写 runtime provider
2. 重写 message-service 主逻辑
3. 重写 assistant LLM client / ReAct engine
4. 对 direct-runtime mode 做大规模行为调整

---

## 13. 验收标准

当以下条件同时满足时，可认为本次双模重构基本成功。

### 13.1 模式边界

1. direct-runtime mode 下，assistant 不参与对话。
2. assistant mode 下，assistant 成为唯一对话主人。
3. 两种模式的出站路径完全分离，不再共享模糊的发言权。

### 13.2 assistant mode 的消息控制权

1. runtime 不再直接向用户发最终消息。
2. 所有用户可见回复都可追溯到 assistant 决策。
3. 无关旧任务不会打断当前问题。
4. assistant 能基于 memory / task space / reference resolution 处理：
   - “刚才那个”
   - “另一个任务”
   - “看看进展”
   - “继续这个项目”

### 13.3 assistant mode 的审批治理

1. runtime 审批不会直接原样抛给用户。
2. assistant 能记住“后续给 Codex 权限”这类授权偏好。
3. assistant 能在已授权、低风险、作用域命中的情况下自动批准。
4. assistant 对超界或高风险操作仍会保留人工确认。
5. assistant 能说明为什么自动批准或为什么要求确认。

### 13.4 direct-runtime mode 的稳定性

1. 当前直连交互能力保持可用。
2. 本轮重构不会破坏其已有审批与会话流程。

### 13.5 测试与回归

1. 单元测试能清晰区分两种 mode 的入站与出站行为。
2. 存在“旧任务结果打断当前问题”的明确回归测试。
3. 存在“assistant 授权记忆后自动审批”的明确回归测试。

---

## 14. 结论

当前问题暴露出来的，不是 assistant 路线错误，而是：

> assistant 的智能能力已经具备基础，但 conversation ownership 和 approval governance 还没有真正上收给 assistant。

因此正确方向不是削弱 assistant，也不是退回纯 runtime，而是：

1. 明确双模架构；
2. 保持 direct-runtime mode 稳定且独立；
3. 让 assistant mode 下 assistant 成为唯一对话主人；
4. 让 assistant 接管审批治理与授权记忆；
5. 让现有记忆、引用解析、任务空间、工具调用能力真正服务于“数字人式协作”。

这才是让 CliGate Assistant 真正像“用户分身”一样工作的关键一步。

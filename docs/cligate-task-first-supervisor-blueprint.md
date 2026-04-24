# CliGate Task-First Supervisor 工程化实施蓝图

## 1. 文档目的

这份文档用于固定当前已经确认的产品目标、架构方向、改造边界、风险点和验收标准，作为后续实现与回归核对基线。

本文件解决的问题只有一个：

- **把 CliGate 从“围绕单 runtime/session 的消息转发器”升级成“独立的会话级 supervisor assistant”**

本文不直接落代码，但会明确：

1. 产品目标是什么
2. 当前实现哪里不满足目标
3. 目标架构应该长什么样
4. 分阶段怎么改
5. 实现时哪些约束不能破
6. 最终怎么验收

---

## 2. 北极星目标

CliGate 的目标不是成为 Codex、Claude Code 或 Gemini CLI 的壳，而是成为一个独立的上层助手。

### 2.1 产品定义

CliGate Assistant 应当是：

- 一个独立的会话级 supervisor
- 一个能管理多条任务线路的助手
- 一个可以自己回答、也可以调度底层执行器的中枢

底层执行器应当只是执行层，包括但不限于：

- `codex`
- `claude-code`
- `gemini-cli`
- 后续自有工具
- 后续其他 runtime / executor

### 2.2 用户体验目标

当用户在钉钉或其他渠道启用 `/cligate` 后，理想体验应为：

1. 用户面对的是同一个 CliGate 助手，而不是某个具体 provider
2. 一个会话里可以同时存在多个任务
3. 每个任务都可以独立推进、独立等待、独立完成、独立失败
4. 谁先有结果谁先通知，不要求所有任务全部结束才回复
5. 同一条任务线的连续修改应尽量沿用同一个底层执行上下文
6. 多任务存在歧义时，CliGate 应主动澄清，而不是猜测
7. 绝不能把 A 会话的结果发到 B 会话

### 2.3 系统级硬约束

以下约束优先级高于“自动化程度”：

1. **不跨会话串消息**
2. **不在多任务歧义时盲目路由**
3. **不依赖硬编码关键词强制路由**
4. **不把 `active` 焦点误当成唯一被监听对象**

---

## 3. 当前实现现状

### 3.1 已经具备的能力

当前项目已经不是“没有 assistant 能力”，而是已有以下基础设施：

- `assistant-core` + `assistant-agent` 主链
- `conversation.metadata.supervisor.taskMemory`
- `conversation.metadata.supervisor.brief`
- `conversation.metadata.assistantCore`
- runtime observation / task view / policy / memory
- channel outbound dispatcher
- assistant prompt 中的 conversation / workspace context 注入

这意味着：

- 当前系统已经有 supervisor 雏形
- 当前系统已经有记忆层
- 当前系统已经有 runtime 事件到渠道消息的基础派发能力

### 3.2 记忆是否在使用

答案是：**在使用，而且已经进入传给大模型的上下文。**

当前记忆主要包括：

- preference memory
- workspace memory
- runtime session memory
- supervisor brief / taskMemory
- remembered policies

这些内容已经通过 `observation-service` 聚合后进入 `conversationContext` / `workspaceContext`，并在 assistant prompt 中注入给 LLM。

### 3.3 当前最核心的问题

当前系统的主要问题不是“完全没有监听器”或“完全没有记忆”，而是：

1. 顶层抽象仍偏向 `runtime session`
2. 一个 conversation 仍偏向只围绕单个 `activeRuntimeSessionId`
3. 多任务时通知路由和续聊路由都不够稳定
4. 当前记忆中心对象仍偏向 `session`，而不是 `CliGate task`
5. 多任务 supervisor 能力没有真正成为系统中心

---

## 4. 当前问题定性

### 4.1 架构层面的根因

当前系统更接近：

- conversation 绑定一个“当前 runtime”
- assistant 可以发起多个 runtime
- 但通知、状态解释、后续续聊仍主要围绕单一 session 设计

这会导致以下典型问题：

1. 并发任务中只有一条线路容易被持续看见
2. 后续自然语言输入容易被吸附到“最后那个 active runtime”
3. 多个 provider 并行时，系统能启动多个任务，但不能稳定像“助手”一样持续管理它们

### 4.2 产品层面的偏差

用户期望的是：

- “我在和 CliGate 说话”

当前系统更像：

- “我通过 CliGate 在控制一个当前 runtime”

这两者不是同一个产品形态。

---

## 5. 目标架构

目标架构必须改成 **task-first**，而不是继续以 session-first 叠功能。

### 5.1 四层模型

建议最终采用四层：

1. **Channel Layer**
   - 钉钉 / 飞书 / Telegram 等渠道接入
   - 负责收消息、发消息、会话身份

2. **CliGate Supervisor Layer**
   - 顶层独立助手
   - 负责理解用户意图、任务管理、澄清、汇总、调度

3. **Execution Orchestrator Layer**
   - 把 task 映射成一个或多个 execution
   - 选择 `codex` / `claude-code` / `gemini-cli` / `cligate-native`

4. **Executor Layer**
   - 底层执行器或工具能力

### 5.2 核心对象

#### Conversation

表示一个渠道线程，是任务容器和回信地址持有者。

建议最小字段：

- `id`
- `channel`
- `accountId`
- `externalConversationId`
- `externalUserId`
- `externalThreadId`
- `assistantMode`
- `activeTaskId`
- `trackedTaskIds`
- `replyEndpoint`
- `updatedAt`

关键语义：

- `activeTaskId` 只表示默认焦点
- `trackedTaskIds` 表示该会话当前托管的全部任务

#### SupervisorTask

表示用户视角的一条持续工作线，是顶层主对象。

建议最小字段：

- `taskId`
- `conversationId`
- `title`
- `goal`
- `status`
- `owner = cligate`
- `executorStrategy`
- `primaryExecutionId`
- `executionIds`
- `summary`
- `result`
- `error`
- `awaitingKind`
- `awaitingPayload`
- `startedAt`
- `lastUpdateAt`
- `lastUserTurnAt`
- `lastAssistantTurnAt`
- `sourceTaskId`

#### Execution

表示某个 task 的一次执行实例。

建议最小字段：

- `executionId`
- `taskId`
- `executor`
- `runtimeSessionId`
- `role`
- `status`
- `summary`
- `result`
- `error`
- `createdAt`
- `updatedAt`

#### SupervisorMemory

表示 CliGate 用来理解和延续任务的记忆层。

建议拆成：

- preference memory
- task memory
- execution memory
- conversation brief

---

## 6. 关键行为语义

### 6.1 不再把任务等同于 session

未来必须明确：

- 用户在和 `SupervisorTask` 交互
- `Execution / runtime session` 只是 task 的执行上下文

一个 task 可以：

- 不经过 runtime，由 CliGate 自己完成
- 由一个 executor 完成
- 由多个 executor 并行完成

### 6.2 同一工作线如何持续复用同一个 Codex session

正确做法不是关键词绑定，而是：

1. 先判断用户新消息属于哪个 `SupervisorTask`
2. 如果命中某个 task：
   - 默认走该 task 的 `primaryExecutionId`
   - 若其 runtime session 仍可继续，则继续投递到同一个 session
3. 只有在以下情况才新建 execution：
   - 用户明确开启新任务
   - 当前 execution 已失效
   - 当前上下文污染严重
   - supervisor 明确决定切换执行器或重建上下文

也就是说：

- 连续性来自 `task identity`
- 不是来自关键词
- 也不是来自 conversation 只绑定一个 active runtime

### 6.3 多任务并行时的续聊策略

对同一 conversation 中的多任务，CliGate 应当：

- 高置信命中某个 task 时，自动续聊
- 有多个接近候选时，主动澄清
- 当前只有一个待审批/待提问任务时，可优先自动命中
- 对整体进展类问题，应优先由 supervisor 直接回答

---

## 7. 记忆设计

### 7.1 当前记忆保留什么

当前已有的这些记忆能力应继续保留：

- scoped preference memory
- workspace memory
- runtime session memory
- remembered policy / authorization
- conversation supervisor brief

### 7.2 需要升级的方向

现有记忆要从“session-aware”升级成“task-first”。

建议目标：

1. `taskMemory` 从按 `session` 组织逐步演进为按 `task` 组织
2. session 记忆继续保留，但降为 execution memory
3. prompt 中的核心摘要从“当前 runtime”升级成“当前任务空间”

### 7.3 LLM 上下文里应包含什么

未来传给 LLM 的关键上下文应以 task 为中心，至少包括：

- 当前 conversation 基本信息
- 当前 focus task
- 当前活跃 tasks
- 当前等待中的 tasks
- 最近完成 / 最近失败 tasks
- 每个关键 task 的 summary / result / waitingReason
- 相关 preference / policy
- 少量最近用户可见消息

不应再把大量原始 session / transcript 直接堆入 prompt。

---

## 8. 路由与通知设计

### 8.1 对话路由

所有新消息先进入 CliGate Supervisor。

决策流程：

1. 先判断消息类型：
   - 状态查询
   - 对等待任务的回应
   - 已有 task 的续聊
   - 新 task
   - 需要澄清
2. 再在 tracked tasks 中评估候选任务
3. 高置信自动命中，低置信要求澄清
4. 命中 task 后，再决定是否复用现有 primary execution

### 8.2 严禁关键词硬绑定

不允许设计成：

- 看到某个词就强制路由到某个 task
- 看到某种命令形式就直接绑定某个 session

原因：

- 容易误判
- 会污染执行上下文
- 会导致错误执行不可见

### 8.3 通知路由

通知路由必须是强确定性的。

要求：

1. execution 创建时就显式绑定 `taskId`
2. task 创建时显式绑定 `conversationId`
3. outbound dispatcher 必须通过 `execution -> task -> conversation` 显式归属回推
4. 绝不通过“当前 active 对象是谁”进行模糊回推

### 8.4 推荐推送策略

必须推送：

- `waiting_approval`
- `waiting_user`
- `completed`
- `failed`

可选推送：

- `accepted`
- `started`

默认不推送：

- 高频 progress

---

## 9. 分阶段实施蓝图

## Phase 0：文档冻结与边界确认

目标：

- 固定 task-first / independent supervisor 方向
- 后续实现不再围绕 session-first 临时补丁继续扩张

交付：

- 本文档
- 后续各子改造任务都以本文件为校对基线

## Phase 1：先修稳“多任务通知 + 会话安全归属”

目标：

- 不串会话
- 并行任务都能独立回消息
- 不再只靠 `activeRuntimeSessionId` 作为唯一通知入口

修改重点：

1. 建立 conversation 到 tracked work items 的显式归属关系
2. assistant 发起多个 runtime 时，所有相关 execution 都要登记
3. outbound 派发改为基于显式归属，而不是只认 active session
4. 单 session async 完成结果必须能正常回推
5. fan-in 聚合不再作为唯一的最终回执机制

验收：

1. 同一会话中同时起 `codex` 和 `claude-code`，两边完成结果都能回同一会话
2. 两个不同会话并发任务，绝不串消息

## Phase 2：引入 Task 作为一等对象

目标：

- 从 session-first 演进为 task-first

修改重点：

1. 增加 `SupervisorTask` store / view / lifecycle
2. 现有 supervisor task memory 从 `bySession` 逐步演进为 `byTask`
3. session 变成 execution 语义
4. task 持有 `primaryExecutionId`

验收：

1. 同一个任务多轮补充输入会复用同一条执行上下文
2. 同一 conversation 中可以并行存在多个同 provider 任务

## Phase 3：升级 supervisor 决策与 prompt 记忆

目标：

- 让 LLM 基于任务空间决策，而不是围绕单 runtime 决策

修改重点：

1. prompt 以 task summaries / focus task / waiting tasks 为中心
2. task 记忆进入 observation / task-view / prompt
3. 会话级状态回复由 supervisor 直接生成
4. 含糊输入时返回澄清，而不是误投

验收：

1. “进展如何”返回会话级总览
2. 多任务下“继续刚才那个”在低置信时要求澄清

## Phase 4：扩执行器能力

目标：

- 把 `gemini-cli`、自有工具、native abilities 纳入统一执行层

修改重点：

1. 抽象统一 executor 接口
2. 允许 task 不经过 runtime、直接由 CliGate 完成
3. 支持单 task 多 execution 并行

验收：

1. CliGate 可以自己完成部分任务
2. 同一 task 可以调度多个不同 execution

---

## 10. 需要修改的核心模块

以下模块是后续主要改造面。

### 10.1 `assistant-core`

需要调整：

- `mode-service`
- `task-view-service`
- `observation-service`
- `memory-service`

方向：

- 从“以 runtime 为主的 assistant state”升级到“以 task 为主的 supervisor state”

### 10.2 `agent-channels`

需要调整：

- `router`
- `outbound-dispatcher`
- `conversation-store`

方向：

- 从“active runtime 绑定 + per session 回推”升级到“task/execution 显式归属回推”

### 10.3 `agent-orchestrator`

需要调整：

- `conversation-supervisor-state`
- `supervisor-task-memory`
- `supervisor-brief`

方向：

- 从 `bySession` 演进为 `byTask`
- brief 以 task 视角汇总

### 10.4 `assistant-agent`

需要调整：

- `prompt-builder`
- `react-engine`
- tool registry / memory search 入口

方向：

- prompt 以 task-first 为中心
- LLM 使用 task context 做决策

---

## 11. 注意事项

### 11.1 绝不跨会话串消息

这是最高优先级约束。

所有通知必须按显式归属：

- `execution -> task -> conversation`

### 11.2 不要让 `activeTask` 变成新的单点锁

`activeTask` 只是默认焦点，不是唯一通知对象，也不是唯一可路由对象。

### 11.3 不要把 task 生命周期和 execution 生命周期混为一谈

execution 可以结束，但 task 仍可以继续存在、恢复、扩展、总结。

### 11.4 不要让 prompt 无限膨胀

记忆是必须的，但必须摘要化和选择性注入。

### 11.5 不要把低置信自动化当成功能亮点

真正的可用性来自：

- 高置信自动化
- 低置信保守澄清

### 11.6 不要直接推翻现有 memory/policy/observation 基础设施

当前已有基础能力应尽量复用，重点是升级抽象中心，而不是全量重写。

---

## 12. 风险清单

### 风险 1：多任务下误投到错误 task

风险来源：

- 任务归属判断不稳

缓解：

- 低置信澄清
- 不做关键词硬绑定

### 风险 2：会话间串消息

风险来源：

- 仍然依赖 active session 或模糊匹配回推

缓解：

- 显式归属链
- 强约束测试

### 风险 3：旧 session-first 逻辑继续扩张

风险来源：

- 临时修 bug 时继续以单 session 思维打补丁

缓解：

- 所有新改动按本文档校对
- 先做归属和对象层升级，再做体验优化

### 风险 4：prompt 记忆过重

风险来源：

- 把太多 session 细节直接塞给 LLM

缓解：

- task summaries + waiting tasks + recent visible messages

---

## 13. 验收标准

以下标准用于后续回归核对。

### 13.1 并发与通知

1. 同一 conversation 可并行托管多个任务
2. 每个任务完成后都能独立回推
3. 不要求所有任务都完成才通知

### 13.2 连续性

1. 同一任务的连续修改默认复用同一个 primary execution
2. 同 provider 的多个任务可同时存在，但互不污染

### 13.3 路由正确性

1. 两个不同会话并发运行时，绝不串消息
2. 多任务歧义输入时，系统会主动澄清
3. 单个等待审批任务存在时，“同意/拒绝”可自动命中

### 13.4 助手独立性

1. CliGate 可以直接回答不需要 runtime 的问题
2. CliGate 可以调度多个不同 executor
3. 用户始终面对的是 CliGate，而不是底层 provider

### 13.5 记忆有效性

1. 任务记忆进入 prompt 并影响决策
2. 会话级状态查询返回任务总览
3. 已完成任务在短期内仍可被追问和总结

---

## 14. 一句话结论

后续所有改造都应围绕一个核心方向推进：

**把 CliGate 做成独立的 task-first 会话级 supervisor assistant；Codex、Claude Code、Gemini CLI 和后续工具都只是其下层执行器，而不是产品本体。**

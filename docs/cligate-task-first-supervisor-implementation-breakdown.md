# CliGate Task-First Supervisor 工程拆解

## 1. 目的

这份文档是在 `docs/cligate-task-first-supervisor-blueprint.md` 基础上的下层工程拆解。

目标不是重复讲产品愿景，而是把后续开发工作拆成：

- 分阶段目标
- 涉及模块
- 具体文件
- 每个文件的修改职责
- 测试补充点
- 风险与回滚关注项

本文件是正式进入代码开发前的实施清单。

---

## 2. 总体实施原则

### 2.1 不一次性重写

当前代码已经存在：

- assistant 主链
- channel 路由
- runtime dispatcher
- memory / observation / task-view

因此本次改造不应一次性推翻现有结构，而应按以下顺序推进：

1. 先把显式归属关系补稳
2. 再把 `task` 抬成一等对象
3. 再升级 prompt / memory / routing
4. 最后扩 execution / executor 模型

### 2.2 两类问题分开处理

必须严格分开：

1. **通知归属问题**
   - 哪个 execution 的事件该回哪个 conversation
   - 这部分必须完全确定性

2. **对话归属问题**
   - 用户这句话是在继续哪个 task
   - 这部分允许有智能判断，但低置信必须澄清

### 2.3 当前实现中的主要阻塞点

从现有代码看，当前最大的阻塞点有三个：

1. `conversation` 的核心绑定仍是 `activeRuntimeSessionId`
2. `outbound-dispatcher` 仍按 `listByRuntimeSessionId(sessionId)` 查 conversation
3. `supervisor.taskMemory` 的组织中心仍是 `session`

所以工程顺序必须是：

- 先解决归属关系
- 再解决对象模型

---

## 3. 当前代码影响面

## 3.1 Channel 层

主要文件：

- [src/agent-channels/router.js](D:/proxypool-hub/src/agent-channels/router.js)
- [src/agent-channels/outbound-dispatcher.js](D:/proxypool-hub/src/agent-channels/outbound-dispatcher.js)
- [src/agent-channels/conversation-store.js](D:/proxypool-hub/src/agent-channels/conversation-store.js)
- [src/agent-channels/models.js](D:/proxypool-hub/src/agent-channels/models.js)

当前问题：

- `router` 在 assistant background 回调里只绑定 `relatedRuntimeSessionIds[0]`
- `conversation-store` 查 conversation 仍只按 `activeRuntimeSessionId`
- `outbound-dispatcher` 回推范围只看当前 active runtime

## 3.2 Assistant 主链

主要文件：

- [src/assistant-core/mode-service.js](D:/proxypool-hub/src/assistant-core/mode-service.js)
- [src/assistant-core/task-view-service.js](D:/proxypool-hub/src/assistant-core/task-view-service.js)
- [src/assistant-core/observation-service.js](D:/proxypool-hub/src/assistant-core/observation-service.js)
- [src/assistant-core/memory-service.js](D:/proxypool-hub/src/assistant-core/memory-service.js)
- [src/assistant-core/tool-registry.js](D:/proxypool-hub/src/assistant-core/tool-registry.js)

当前问题：

- `mode-service` 的多任务语义仍是 `relatedRuntimeSessionIds`
- async closure 仍偏 fan-in 聚合
- `task-view-service` 仍以 runtime candidates 拼“任务视图”
- `observation-service` 的 conversation summary 仍围绕 active runtime / tracked session

## 3.3 Orchestrator 层

主要文件：

- [src/agent-orchestrator/message-service.js](D:/proxypool-hub/src/agent-orchestrator/message-service.js)
- [src/agent-orchestrator/conversation-supervisor-state.js](D:/proxypool-hub/src/agent-orchestrator/conversation-supervisor-state.js)
- [src/agent-orchestrator/supervisor-task-memory.js](D:/proxypool-hub/src/agent-orchestrator/supervisor-task-memory.js)
- [src/agent-orchestrator/supervisor-brief.js](D:/proxypool-hub/src/agent-orchestrator/supervisor-brief.js)

当前问题：

- runtime 入口与续聊入口仍主要围绕 session
- supervisor state 主要写回 `bySession`
- brief 更接近“当前 runtime 摘要”，不是“当前 task 空间摘要”

## 3.4 Assistant Agent 层

主要文件：

- [src/assistant-agent/dialogue-service.js](D:/proxypool-hub/src/assistant-agent/dialogue-service.js)
- [src/assistant-agent/react-engine.js](D:/proxypool-hub/src/assistant-agent/react-engine.js)
- [src/assistant-agent/prompt-builder.js](D:/proxypool-hub/src/assistant-agent/prompt-builder.js)

当前问题：

- prompt 中虽然已有 memory/context，但主体还是 `conversation + activeRuntime + latestTask`
- 还没有一个稳定的 task-space prompt 结构

---

## 4. 分阶段实施方案

## Phase 1：显式归属与多线路通知修正

### 4.1 阶段目标

在不全面引入 task store 之前，先修稳以下行为：

1. 同一 conversation 中多个 runtime/execution 都能独立回推
2. 不同 conversation 之间绝不串消息
3. 单个 async runtime 的完成结果不会丢
4. `fan-in 聚合` 不再是唯一通知路径

### 4.2 本阶段不做什么

本阶段不要求：

- 完整重写成 task-first store
- 完整引入新的多对象 schema
- 一次性替换全部 prompt 和记忆模型

### 4.3 主要修改点

#### A. `conversation-store.js`

目标：

- 从“单 active runtime 绑定”升级为“active + tracked runtime bindings”

建议改动：

1. 新增 conversation 级 tracked bindings 结构
2. 保留 `activeRuntimeSessionId` 作为兼容字段
3. 新增按 tracked session 查询 conversation 的能力
4. 为后续 `trackedTaskIds` 演化留接口

建议新增能力：

- `addTrackedRuntimeSession(conversationId, sessionId, metadata?)`
- `removeTrackedRuntimeSession(conversationId, sessionId)`
- `listByTrackedRuntimeSessionId(sessionId)`
- `setActiveRuntimeSession(conversationId, sessionId)`

#### B. `router.js`

目标：

- assistant background 回调不再只登记第一条 runtime

建议改动：

1. `onBackgroundResult` 中把全部 `relatedRuntimeSessionIds` 写入 tracked 集合
2. 仅把 primary runtime 写入 active runtime
3. assistant result outbound 继续保留，但与 runtime event outbound 解耦
4. direct runtime 启动时也要同时写 tracked bindings

#### C. `outbound-dispatcher.js`

目标：

- runtime 事件回推按 tracked bindings 查 conversation，而不是只按 active session

建议改动：

1. `listByRuntimeSessionId` 切换为 `listByTrackedRuntimeSessionId`
2. 回推后同步 supervisor memory 时，不再假设该 session 就是 active session
3. 增加去重策略，避免 assistant aggregation 和 runtime event 双重轰炸

#### D. `mode-service.js`

目标：

- 修正 async closure 逻辑，让单 session async 结果不丢

建议改动：

1. 放宽 `shouldDeferBackgroundCallback`
2. 但不要把最终目标继续定义成“等所有 session 聚合完再发一条”
3. background callback 应区分：
   - accepted assistant message
   - assistant final summary
   - runtime execution results
4. 多 execution 结果最终交给 dispatcher 逐条回推

### 4.4 Phase 1 测试清单

重点补以下测试：

1. 单 session async assistant 委派完成后，结果会回到渠道
2. 同一 conversation 中两条 runtime 都完成后，两条结果都能收到
3. 两个 conversation 同时跑不同任务时不串消息
4. assistant aggregation 开启时，不会和 runtime dispatcher 形成重复推送风暴

建议重点修改测试文件：

- [tests/unit/agent-channels.test.js](D:/proxypool-hub/tests/unit/agent-channels.test.js)
- [tests/unit/assistant-react-agent.test.js](D:/proxypool-hub/tests/unit/assistant-react-agent.test.js)
- 新增或扩展 conversation-store / dispatcher 单测

### 4.5 Phase 1 风险

1. 旧逻辑仍假设一个 conversation 只有一个 runtime
2. tracked bindings 与 active runtime 可能短期并存，容易出现状态同步遗漏
3. 需要明确 outbound 去重策略，否则会重复通知

---

## Phase 2：引入 Task 作为一等对象

### 5.1 阶段目标

把顶层对象从 runtime/session-first 升级为 task-first。

### 5.2 本阶段新增对象

建议新增：

- `SupervisorTaskStore`
- `TaskExecutionIndex` 或等价归属索引

建议位置：

- `src/agent-orchestrator/supervisor-task-store.js`
- `src/agent-orchestrator/task-execution-index.js`

### 5.3 主要修改点

#### A. 新增 Task Store

目标：

- 明确 `taskId -> conversationId`
- 明确 `taskId -> primaryExecutionId`
- 明确 `taskId -> executionIds`

建议能力：

- create task
- patch task
- find task by execution/runtime session
- list tasks by conversation
- set active task
- mark waiting/completed/failed

#### B. `supervisor-task-memory.js`

目标：

- 从 `bySession` 过渡到 `byTask`

建议改法：

1. 先做兼容层，不立即删除 `bySession`
2. 新增 `byTask`、`activeTaskId`、`lastCompletedTask`、`lastFailedTask`
3. 提供 session 到 task 的映射支持

#### C. `conversation-supervisor-state.js`

目标：

- 由 runtime event 驱动 task state，而不是直接写 session state

建议改法：

1. session event 先找到 task
2. 再写回 task memory
3. brief 构建时以 active task / waiting tasks / recent completed tasks 为中心

#### D. `task-view-service.js`

目标：

- 统一任务视图真正以 task 为主

建议改法：

1. `listTasks()` 改为优先读 task store
2. runtime / assistant run 作为 task detail 补充信息
3. focus task 与 active runtime 分离

### 5.4 Phase 2 测试清单

1. 同一 conversation 内两个 codex task 并行存在
2. 同一 task 多轮 follow-up 仍命中同一个 primary execution
3. session 完成后 task 仍保留可追问状态
4. runtime event 能正确更新 task state 而不是只更新 session state

---

## Phase 3：Task-first 路由与 Prompt 升级

### 6.1 阶段目标

让 CliGate 先理解“当前消息属于哪个 task”，再决定是否使用某个 execution。

### 6.2 主要修改点

#### A. `message-service.js`

目标：

- 从 session-first 入口升级为 task-first routing entry

建议改法：

1. 增加“任务解释”步骤
2. 消息类型分类：
   - status query
   - approval/question reply
   - continue existing task
   - start new task
   - needs clarification
3. 低置信返回 supervisor clarification，而不是误送 runtime

重要说明：

- 这里不能用硬编码关键词直接强路由
- 可以有规则优先级，但最终要以状态、连贯性和置信度为主

#### B. `tool-registry.js`

目标：

- 让 assistant tools 面向 task，而不是只面向 runtime

建议新增工具方向：

- `list_supervisor_tasks`
- `get_supervisor_task`
- `continue_supervisor_task`
- `delegate_task_execution`
- `search_supervisor_memory`

#### C. `prompt-builder.js`

目标：

- 将 prompt 核心摘要从 runtime-first 升级为 task-space-first

建议改法：

1. 增加 `<task_space_summary>`
2. 注入：
   - active task
   - waiting tasks
   - top active tasks
   - recent completed/failed tasks
3. conversation summary 中淡化 active runtime 的地位

#### D. `dialogue-service.js` / `react-engine.js`

目标：

- taskRecord 由单个 latest task 升级为 task-space context

建议改法：

1. 不再只传 `taskRecord`
2. 传 `taskSpace` / `taskCandidates` / `focusTask`
3. assistant 在做 delegate / continue 时，显式带 task 归属

### 6.3 Phase 3 测试清单

1. “进展如何”返回任务总览，而不是转发给 runtime
2. 多任务下模糊 follow-up 返回澄清
3. 单个等待审批任务存在时，“同意”正确命中
4. 同一 task 的后续修改会走 primary execution，而不是每次新建 session

---

## Phase 4：Execution 抽象与多执行器统一

### 7.1 阶段目标

让 task 可由不同 execution 方式完成，而不是默认等同于 runtime session。

### 7.2 主要修改点

#### A. 新增 Execution 抽象

建议新增：

- `src/agent-orchestrator/task-execution-service.js`

职责：

- create execution
- bind executor/runtime session
- set primary / secondary execution
- update execution lifecycle

#### B. `message-service.js` 与 `tool-registry.js`

目标：

- 从“start runtime task”升级成“start task execution”

兼容策略：

- 保留 runtime tools 作为兼容层
- 内部逐步统一到 execution service

#### C. 执行器扩展

目标：

- 支持 `gemini-cli`
- 支持 `cligate-native`
- 支持未来自有工具

### 7.3 Phase 4 测试清单

1. 同一 task 可同时拥有 primary codex execution 和 secondary claude review execution
2. CliGate 可直接完成无需 runtime 的任务
3. executor 扩展不会破坏既有 codex/claude 路径

---

## 8. 文件级修改建议

以下为更工程化的文件级建议。

## 8.1 第一批必须动的文件

### [src/agent-channels/conversation-store.js](D:/proxypool-hub/src/agent-channels/conversation-store.js)

职责：

- 增加 tracked runtime bindings
- 保留 active runtime 兼容语义
- 提供按 tracked runtime 查 conversation 的能力

### [src/agent-channels/router.js](D:/proxypool-hub/src/agent-channels/router.js)

职责：

- assistant background 回调注册全部相关 runtime
- direct runtime 启动与 continued runtime 都同步 tracked bindings
- 逐步为 future task tracking 预留入口

### [src/agent-channels/outbound-dispatcher.js](D:/proxypool-hub/src/agent-channels/outbound-dispatcher.js)

职责：

- 改为按 tracked bindings 查 conversation
- 处理 runtime event -> conversation reply
- 增加 outbound 去重机制

### [src/assistant-core/mode-service.js](D:/proxypool-hub/src/assistant-core/mode-service.js)

职责：

- 修正 async defer 逻辑
- 不再把 fan-in 作为多任务唯一结果路径
- 写回 assistant-side tracked runtime/task memory

## 8.2 第二批核心文件

### [src/agent-orchestrator/supervisor-task-memory.js](D:/proxypool-hub/src/agent-orchestrator/supervisor-task-memory.js)

职责：

- 从 `bySession` 过渡到 `byTask`
- 提供兼容迁移层

### [src/agent-orchestrator/conversation-supervisor-state.js](D:/proxypool-hub/src/agent-orchestrator/conversation-supervisor-state.js)

职责：

- event 驱动的 task memory 写回
- 统一生成 task-first brief

### [src/assistant-core/task-view-service.js](D:/proxypool-hub/src/assistant-core/task-view-service.js)

职责：

- 产出真正的 task 视图

### [src/assistant-core/observation-service.js](D:/proxypool-hub/src/assistant-core/observation-service.js)

职责：

- 产出 task-space conversation context
- 为 prompt / supervisor routing 提供稳定观察数据

## 8.3 第三批文件

### [src/agent-orchestrator/message-service.js](D:/proxypool-hub/src/agent-orchestrator/message-service.js)

职责：

- 从 session-first 路由入口升级为 task-first 路由入口

### [src/assistant-agent/prompt-builder.js](D:/proxypool-hub/src/assistant-agent/prompt-builder.js)

职责：

- 将注入上下文改为 task-space-first

### [src/assistant-agent/dialogue-service.js](D:/proxypool-hub/src/assistant-agent/dialogue-service.js)

职责：

- 不再只拉 latest task，而是拉 task-space

### [src/assistant-core/tool-registry.js](D:/proxypool-hub/src/assistant-core/tool-registry.js)

职责：

- 新增 task-first tools
- 保留 runtime tools 兼容

---

## 9. 测试与回归策略

## 9.1 必测用例

### 并发归属

1. 同一 conversation 同时启动 `codex` 和 `claude-code`
2. 两条线路完成结果都回同一 conversation

### 会话隔离

1. A / B 两个会话并发跑任务
2. A 的结果绝不出现在 B

### 连续性

1. 同一 task 多轮 follow-up 命中同一 primary execution
2. 新 task 不污染旧 task execution

### 澄清

1. 同会话两个活跃 task 存在时，模糊 follow-up 返回澄清

### 状态问答

1. “进展如何”返回 task summary
2. 单一待审批 task 时，“同意”自动命中

## 9.2 建议补充的测试文件

- [tests/unit/agent-channels.test.js](D:/proxypool-hub/tests/unit/agent-channels.test.js)
- [tests/unit/assistant-react-agent.test.js](D:/proxypool-hub/tests/unit/assistant-react-agent.test.js)
- 新增 `tests/unit/supervisor-task-memory.test.js`
- 新增 `tests/unit/supervisor-routing.test.js`
- 新增 `tests/unit/task-execution-index.test.js`

---

## 10. 开发顺序建议

建议严格按以下顺序动手，不要跳阶段：

1. `conversation-store` / `router` / `outbound-dispatcher`
2. `mode-service` async closure 修正
3. `supervisor-task-memory` / `conversation-supervisor-state`
4. `task-view-service` / `observation-service`
5. `message-service` task-first routing
6. `prompt-builder` / `dialogue-service` / `tool-registry`
7. execution 抽象与多执行器扩展

原因：

- 先修归属关系，能立即止住“多任务通知丢失/串线”
- 再抬高抽象层，避免带着错误归属模型继续扩展

---

## 11. 开发前确认项

正式开始代码开发前，应确认以下三点：

1. 第一阶段是否只追求“通知正确 + 多线路可见”，暂不一次性完成完整 task store
2. 第一阶段是否接受保留 `activeRuntimeSessionId` 作为兼容字段
3. 第二阶段是否允许新增独立 task store / execution index，而不是继续挤进现有 session memory 结构

---

## 12. 一句话实施结论

后续开发必须按“先修显式归属，再抬升 task 对象，再升级 routing 和记忆，再统一 execution”的顺序推进；任何继续围绕单 `activeRuntimeSessionId` 打补丁的方案，都应视为偏离本项目目标。

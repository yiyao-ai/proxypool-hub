# CliGate Assistant 最终执行清单

## 1. 目的

这份文档只保留最终可执行结论，用于后续排期、校对和实施。

不再重复争论过程，只回答三件事：

1. 哪些问题已经确认存在
2. 哪些点当前不建议立即改
3. 接下来按什么优先级推进

---

## 2. 最终确认的问题

以下问题已经可以视为当前阶段的确定结论：

1. **Assistant Agent 默认主路径没有真正打开**
   - `assistantAgent.enabled` 默认关闭
   - 默认配置下容易落入 deterministic fallback

2. **Web Chat async 没有形成真正的对话闭环**
   - chat-ui 会收到 `assistant_run_accepted`
   - 但后台完成结果不会自然回流到当前 chat transcript

3. **Planner 仍然承担了过多 fallback 交互职责**
   - 当前 fallback 仍以规则匹配为主
   - 容易造成 `/cligate` 体验在 agent path 与 planner path 之间分裂

4. **`search_project_memory` 的名字大于实现**
   - 当前只搜 task / conversation 摘要
   - 还不是真正的 project memory

5. **Workspace 抽象过浅**
   - 当前主要还是基于 `cwd` / `workspaceId` 字符串
   - 缺少真正的 workspace object / metadata 层

6. **Policy 模型不够细**
   - 只有 allow / deny
   - 缺少 risk level、require confirmation、scope expansion 检测

7. **Stop policy 语义过浅**
   - 当前主要是 `waiting_user / waiting_runtime / completed`
   - 不能很好表达 partial、awaiting_summary、executor_done vs assistant_done

8. **runtime_session scope 已存在，但还不是完整 session memory**
   - 已能承载 preference
   - 但还未统一承载 approval / question / turn / 临时授权等运行态语义

9. **旧 `src/assistant/*` 与新 assistant 主链路并存**
   - 当前仍存在双体系
   - 长期会增加维护和认知成本

10. **task-view / store / run lifecycle 仍有工程债**
   - task-view 存在线性扫描
   - JSON 持久化无并发保护
   - assistant run 无 checkpoint / resume

---

## 3. 当前不建议立即改的点

以下事项不是“不改”，而是**当前不建议作为第一批动作**：

1. **不要把“默认启用 agent”直接等同于“默认打开所有账号类 source”**
   - 先打开 agent 主路径
   - 账号类 source 是否默认开启，单独作为运行策略决定

2. **不要第一步就重写 conversation store 的消息模型**
   - Web Chat async 闭环可先用前端 transcript 注入验证
   - 等体验跑通后，再决定是否做 store 级持久消息模型

3. **不要直接硬删除 `search_project_memory`**
   - 先做兼容别名迁移或语义修正
   - 避免 prompt / tool schema / 文档一次性断裂

4. **不要在 workspace-store 和 policy 未到位前急着扩大量 supervisor 语义工具**
   - 否则工具语义会继续绑定到底层存储结构

5. **不要把 Runtime Turn 表述成“从零开始补”**
   - runtime 层已有 turn 能力
   - 这里要做的是演化成 assistant-side operational model

---

## 4. P0：下一迭代必须完成

### P0-1 默认启用 Assistant Agent 主路径

目标：

- 让 `/cligate` 默认优先走 agent path，而不是默认落到 deterministic fallback

实施方向：

- 打开 `assistantAgent.enabled`
- 保留现有 source 解析链
- 不强制同时默认打开所有账号源
- 继续保留 `resolvedSource` / `fallbackReason`

验收标准：

- 默认配置下，`/cligate 你是谁` 返回自然语言 assistant 回复
- 用户可见当前是真 agent 还是 degraded fallback

### P0-2 补 Web Chat async 对话闭环

目标：

- 用户在 Web Chat 中发起 `/cligate` 后，后台完成结果能自动回到当前对话

实施方向：

- chat-ui 路径接上 `onBackgroundResult`
- accepted 后以前端短轮询 `assistantRunId` 为最小实现
- run 完成后把结果注入当前 transcript

验收标准：

- `/cligate 帮我检查登录流程` 返回 accepted 后，完成结果会自动显示在当前 chat

### P0-3 把 Planner 明确降级为 fallback safety rail

目标：

- 避免 planner 与 agent 双轨并存造成产品体验分裂

实施方向：

- planner 只保留高确定性控制类命令
- 对 planner 不覆盖的普通意图，不再伪装成“正常 assistant 能力”
- degraded 提示按真实原因区分：
  - agent disabled
  - no available source
  - agent execution failed

验收标准：

- fallback 行为可解释
- 用户不会误以为规则 planner 就是真正的 `/cligate` 主体验

### P0-4 修正 `search_project_memory` 的语义误导

目标：

- 让工具名、prompt 语义、真实实现保持一致

实施方向：

- 新增真实语义名称
- 保留旧名称作为 deprecated alias
- 后续再决定是否补真实 project memory

验收标准：

- assistant 不再被误导为“可以搜索项目知识库”
- 旧调用不立即断裂

---

## 5. P1：下一阶段架构补齐

### P1-1 引入 workspace-store

目标：

- 把 workspace 从字符串 ref 升级为真正对象层

实施方向：

- 落地 workspace metadata
- 支撑默认 provider、名称、边界、最近任务等信息

### P1-2 扩 Policy 模型

目标：

- 把授权原则从静态 allow/deny 升级成可执行机制

实施方向：

- 增加 `riskLevel`
- 增加 `require_confirmation`
- 增加 scope expansion 检测

### P1-3 扩 Stop Policy 语义

目标：

- 让 assistant run 的终态更贴近真实执行语义

实施方向：

- 区分 `executor_done` 与 `assistant_done`
- 增加 `partial`
- 增加 `awaiting_summary`

### P1-4 扩 runtime_session scope 的承载能力

目标：

- 让 runtime_session 真正成为 session-memory 层

实施方向：

- 不只保存 preference
- 逐步纳入 approval / question / 临时授权 / 当前 turn 等运行态信息

### P1-5 把 degraded mode 可观测性带到运行体验中

目标：

- 不是只在 settings 页面可见，而是在 `/cligate` 实际运行链路中可见

实施方向：

- 在 run metadata、UI、必要时 channel reply 中展示 resolved source / fallback reason

---

## 6. P2：持续治理与演进

### P2-1 收敛旧 assistant 与新 assistant 主链路

目标：

- 降低双体系并存的长期维护成本

实施方向：

- 先明确 ownership 与兼容边界
- 再逐步减少新逻辑继续落到旧目录

### P2-2 演化 Runtime Turn 为 assistant-side operational model

目标：

- 让 turn 不只存在于 runtime 层，而能成为 assistant-side 的主读模型之一

实施方向：

- 补 replay / recovery / turn lifecycle 语义

### P2-3 补 task-view 索引与持久化并发保护

目标：

- 提升数据量增长后的可扩展性和稳定性

实施方向：

- task-view 建索引
- store 写入增加并发保护

### P2-4 为 assistant run 增加 checkpoint / resume

目标：

- 让 run 失败后不只能整轮重跑

实施方向：

- 在 stop policy 语义扩充后，再做 run checkpoint
- 支持按 tool step 恢复

### P2-5 谨慎扩展 supervisor 语义工具

目标：

- 提升 supervisor 层判断能力，但避免工具爆炸

实施方向：

- 先定义“什么动作值得升级成工具”的判据
- 再逐步增加 blocker / progress / next-action 一类高层工具

### P2-6 如产品坚持 project memory，再补 workspace artifact 检索

目标：

- 让 project memory 从概念变成真实能力

实施方向：

- 结合 workspace-store
- 增加 README / docs / artifact / workspace-level index 检索

---

## 7. 最终执行顺序

推荐按以下顺序推进：

1. 默认启用 agent 主路径
2. 补 Web Chat async 闭环
3. planner 降级为 fallback safety rail
4. 修正 `search_project_memory` 语义
5. 引入 workspace-store
6. 扩 policy 模型
7. 扩 stop policy 与 session memory
8. 再处理 turn、checkpoint、索引、双体系收敛

---

## 8. 最终一句话结论

当前 `CliGate Assistant` 已经具备 supervisor assistant 的主要骨架，但要真正达到“默认自然、闭环可用、可持续演进”的状态，下一步应先完成 **agent 主路径启用、Web Chat async 闭环、planner 降级、project memory 语义修正** 这四项。

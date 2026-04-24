# CliGate Assistant 收敛校准

## 1. 北极星目标

后续所有优化都必须继续服务这三个目标：

1. **默认自然**
   - `/cligate` 默认优先走真正的 assistant supervisor 主路径
   - 用户不需要理解底层 provider / planner / fallback 才能得到正确体验

2. **闭环可用**
   - 任务可以被发起、观察、等待、审批、继续、恢复
   - 异步结果能回到用户当前工作流
   - 降级、暂停、失败、恢复都有明确可见语义

3. **可持续演进**
   - 新能力继续落到统一主链，而不是扩大双体系
   - 底层存储、run lifecycle、task view 可以承接后续增长

如果某项优化同时不明显改善以上三点之一，就不应优先推进。

---

## 2. 当前两条 assistant 路径

### 2.1 新主链：`assistant-core` + `assistant-agent`

这条链路已经承担了 `CliGate Assistant` 的主体职责：

- `src/assistant-core/*`
  - mode / runner / planner / policy / memory / observation / task-view / workspace / run-store
- `src/assistant-agent/*`
  - llm-client / react-engine / stop-policy / response-composer / prompt-builder

它的职责是：

- `/cligate` supervisor 能力
- runtime delegation / observation / control
- task-centric 视图
- run lifecycle / checkpoint / resume
- degraded observability

**结论**：这是未来唯一允许继续承接“新 assistant 能力”的主链。

### 2.2 旧链：`src/assistant/*`

旧目录并不是废代码，它当前仍承接一条**不同产品路径**：

- `prepareAssistantRequest()`
  - 普通 chat 的 manual QA / 偏好注入 / manual context 拼装
- `tool-executor.js`
  - chat assistant 模式下的 pending confirm action（如 Claude Code proxy 切换）

它今天服务的是：

- `/api/chat/complete`
- `/api/chat/stream`
- `/api/chat/tool-confirm`
- chat 页签里的 `assistantMode === true`

**结论**：旧链当前应被视为“普通 chat assistant / manual helper 兼容层”，不是 `/cligate` supervisor 主链。

---

## 3. 收敛后的目标边界

### 3.1 新链负责什么

以下能力以后只允许继续落到新链：

- `/cligate` 入口
- assistant run / step / checkpoint / resume
- runtime session memory
- workspace / policy / stop policy
- task / conversation / runtime 统一观测
- degraded observability
- supervisor tool semantics

### 3.2 旧链保留什么

旧链暂时只保留：

- 普通 chat 的 manual QA / manual context
- 普通 chat 的偏好注入
- pending assistant action / confirm action

### 3.3 明确禁止事项

从本文件起，以下事情应视为禁止：

1. **不要把新的 `/cligate` 语义继续实现到 `src/assistant/*`**
2. **不要把新的 runtime / task / run lifecycle 能力接到旧 chat assistant helper 中**
3. **不要再让 planner / manual intent / old assistant prompt 参与 `/cligate` 主能力定义**
4. **不要把“旧 assistant 兼容层”误称为 assistant 主链**

---

## 4. 对现状的判断

### 4.1 没有偏航的部分

最近完成的这些优化仍然符合北极星目标：

- agent 默认主路径
- async 闭环
- fallback safety rail
- workspace / policy / stop policy / session memory
- checkpoint / resume 最小闭环
- task-view 热路径优化

### 4.2 已经开始出现的偏航风险

如果继续无约束演进，最容易偏向两件事：

1. **继续深挖底层 store / 缓存 / 索引，却没有改善用户任务闭环**
2. **继续让旧链和新链同时承接 assistant 新语义**

因此下一阶段不应优先继续扩大技术面，而应优先做**边界收敛**。

---

## 5. 建议的下一阶段实现顺序

### Phase A：边界文档与命名收敛

先完成最小治理动作：

1. 在代码注释和文档中明确：
   - `src/assistant/*` = chat assistant compatibility layer
   - `assistant-core` + `assistant-agent` = CliGate Assistant mainline
2. 对外文案里减少把旧链称为“assistant 主能力”

### Phase B：停止新逻辑继续落旧链

后续新需求若属于以下范围，必须只走新链：

- `/cligate`
- assistant run / resume
- task/runtime supervision
- runtime memory / policy / degraded observability

### Phase C：评估旧链迁移，而不是立刻删除

只有当以下条件满足后，才考虑进一步收敛旧目录：

1. chat 普通 assistant 模式已有替代实现
2. pending confirm action 已迁到统一 action framework
3. manual QA / manual context 是否仍有产品价值已经明确

在此之前，不建议激进删除 `src/assistant/*`。

---

## 6. 后续工作的选择标准

从现在开始，每项优化前都要先问三个问题：

1. 它是否让 `/cligate` 更自然？
2. 它是否让任务闭环更稳？
3. 它是否减少双体系继续扩张？

如果三者都不是，优先级应明显下降。

---

## 7. 一句话校准结论

`CliGate Assistant` 的未来主链已经明确是 **`assistant-core` + `assistant-agent`**；`src/assistant/*` 当前应被限制为 **普通 chat assistant 兼容层**。  
下一阶段最重要的不是再堆新能力，而是**防止新的 assistant 语义继续落到旧链**，让后续优化持续围绕“默认自然、闭环可用、可持续演进”这三项目标推进。

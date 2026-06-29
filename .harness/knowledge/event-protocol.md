# SSE 事件协议

## 为什么需要这份文档

前后端通过 SSE（Server-Sent Events）实现实时通信，后端 Domain 层发布 16 种事件，前端 EventSource 订阅并响应式渲染。事件类型、payload 结构、顺序约束构成**前后端契约**，任何变更都会影响双方。本文档是 R-20（跨仓契约）与 R-45（事件发布）的详细展开，作为**16 种事件的唯一权威说明**。

## 现状

### 权威定义位置

- **后端事件常量**：`mooc-manus/internal/domains/models/events/constants.go`
- **后端事件结构体**：`mooc-manus/internal/domains/models/events/events.go`
- **前端事件类型**：`mooc-manus-web/src/api/sse.ts` 的 `EventType` 枚举
- **契约校验**：`.harness/scripts/validate-contracts.sh`（CI 执行）

### 16 种事件分组

```
消息事件（3种）
  ├─ title           : 对话标题生成
  ├─ message         : LLM 流式文本片段
  └─ message_end     : 单轮文本结束

工具事件（3种）
  ├─ tool_call_start    : LLM 决定调用工具
  ├─ tool_call_complete : 工具调用成功
  └─ tool_call_fail     : 工具调用失败

计划事件（4种）
  ├─ plan_create_success : Plan 创建成功
  ├─ plan_update_success : Plan 更新成功
  ├─ plan_update_failed  : Plan 更新失败
  └─ plan_completed      : Plan 全部完成

步骤事件（3种）
  ├─ step_start     : Step 开始执行
  ├─ step_complete  : Step 完成
  └─ step_fail      : Step 失败

系统事件（3种）
  ├─ wait   : 等待用户输入
  ├─ error  : 异常
  └─ done   : 流结束
```

## 事件详解

### 1. title（对话标题生成）

**触发条件**：BaseAgent / ReActAgent 首次响应后，根据对话内容生成摘要标题。

**payload 必填字段**：
```go
type TitleEvent struct {
    BaseEvent                    // ConversationID, MessageID, EventType, Timestamp
    Title         string         // 生成的标题（20字以内）
}
```

**前端处理**：更新 conversation 列表中该会话的标题。

**顺序约束**：通常在第一个 `message_end` 之后、`done` 之前。

**例子**（SSE 流格式）：
```
event: title
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"title","timestamp":"2026-06-28T10:00:00Z","title":"如何部署 Kubernetes"}
```

---

### 2. message（LLM 流式文本片段）

**触发条件**：LLM 返回流式文本时，每个 token 或小批次 tokens 触发一次。

**payload 必填字段**：
```go
type MessageEvent struct {
    BaseEvent
    Message   string         // 增量文本片段
    Role      string         // "assistant"（LLM 响应）
}
```

**前端处理**：追加到当前消息气泡，实现打字机效果。

**顺序约束**：多个 `message` 事件连续发送，最后以 `message_end` 结束。

**例子**：
```
event: message
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"message","timestamp":"2026-06-28T10:00:01Z","message":"根据您的需求","role":"assistant"}

event: message
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"message","timestamp":"2026-06-28T10:00:02Z","message":"，我建议使用","role":"assistant"}
```

---

### 3. message_end（单轮文本结束）

**触发条件**：LLM 单轮响应的文本部分完整结束（不包括 tool_call）。

**payload 必填字段**：
```go
type MessageEndEvent struct {
    BaseEvent
    Message   string         // 完整文本（可选，前端通常已累积）
    Role      string         // "assistant"
}
```

**前端处理**：停止打字机动画，标记该消息为"完成"状态。

**顺序约束**：必在所有 `message` 事件之后，可能在 `tool_call_start` 之前（若 LLM 既输出文本又调用工具）。

**例子**：
```
event: message_end
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"message_end","timestamp":"2026-06-28T10:00:03Z","message":"根据您的需求，我建议使用 Helm 部署。","role":"assistant"}
```

---

### 4. tool_call_start（LLM 决定调用工具）

**触发条件**：LLM 返回 `tool_call` 请求，Agent 准备调用工具。

**payload 必填字段**：
```go
type ToolEvent struct {
    BaseEvent
    ToolCallID   string                   // 工具调用唯一 ID
    ToolName     string                   // 工具名（如 "executeSkill"）
    FunctionName string                   // 函数名（同 ToolName，兼容性保留）
    Arguments    map[string]interface{}   // 调用参数
    Status       ToolEventStatus          // "calling"
}
```

**前端处理**：显示"正在调用工具 X..."状态，展开参数详情（可折叠）。

**顺序约束**：必在 `tool_call_complete` / `tool_call_fail` 之前（同一 ToolCallID）。

**例子**：
```
event: tool_call_start
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"tool_call_start","timestamp":"2026-06-28T10:00:04Z","toolCallId":"tool-789","toolName":"executeSkill","functionName":"executeSkill","arguments":{"skillName":"deploy-k8s","version":"1.0"},"status":"calling"}
```

---

### 5. tool_call_complete（工具调用成功）

**触发条件**：工具执行成功返回结果。

**payload 必填字段**：
```go
type ToolEvent struct {
    BaseEvent
    ToolCallID   string
    ToolName     string
    FunctionName string
    Result       string                   // 工具返回的文本结果
    Status       ToolEventStatus          // "completed"
}
```

**前端处理**：显示"工具 X 完成"，展示结果（可折叠），标记为成功（绿色图标）。

**顺序约束**：必有先行的 `tool_call_start`（同一 ToolCallID）。

**例子**：
```
event: tool_call_complete
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"tool_call_complete","timestamp":"2026-06-28T10:00:10Z","toolCallId":"tool-789","toolName":"executeSkill","functionName":"executeSkill","result":"部署成功，服务已启动在 http://10.0.0.1:8080","status":"completed"}
```

---

### 6. tool_call_fail（工具调用失败）

**触发条件**：工具执行异常或超时。

**payload 必填字段**：
```go
type ToolEvent struct {
    BaseEvent
    ToolCallID   string
    ToolName     string
    FunctionName string
    Error        string                   // 错误信息
    Status       ToolEventStatus          // "failed"
}
```

**前端处理**：显示"工具 X 失败"，展示错误信息（红色图标），提示用户重试或调整参数。

**顺序约束**：必有先行的 `tool_call_start`（同一 ToolCallID）。

**例子**：
```
event: tool_call_fail
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"tool_call_fail","timestamp":"2026-06-28T10:00:08Z","toolCallId":"tool-789","toolName":"executeSkill","functionName":"executeSkill","error":"Docker 容器启动超时","status":"failed"}
```

---

### 7. plan_create_success（Plan 创建成功）

**触发条件**：PlanAgent 调用 LLM 生成 Plan 并解析成功。

**payload 必填字段**：
```go
type PlanEvent struct {
    BaseEvent
    Plan         Plan                     // Plan 结构体（含 PlanID, Title, Steps）
    Status       PlanEventStatus          // "created"
}
```

**前端处理**：渲染 Plan 卡片，展示标题与步骤列表（所有 Step 初始状态为 pending）。

**顺序约束**：必在任何 `step_start` 之前。

**例子**：
```
event: plan_create_success
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"plan_create_success","timestamp":"2026-06-28T10:01:00Z","plan":{"planId":"plan-abc","title":"Kubernetes 部署计划","steps":[{"stepId":"step-1","description":"检查集群状态","status":"pending"},{"stepId":"step-2","description":"部署应用","status":"pending"}],"status":"created"},"status":"created"}
```

---

### 8. plan_update_success（Plan 更新成功）

**触发条件**：Plan 执行过程中，某个 Step 完成导致整体进度更新。

**payload 必填字段**：
```go
type PlanEvent struct {
    BaseEvent
    Plan         Plan                     // 更新后的 Plan（部分 Step 状态变为 completed）
    Status       PlanEventStatus          // "updated"
}
```

**前端处理**：更新 Plan 卡片的进度条与 Step 状态。

**顺序约束**：必在 `plan_create_success` 之后、`plan_completed` / `plan_update_failed` 之前。

**例子**：
```
event: plan_update_success
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"plan_update_success","timestamp":"2026-06-28T10:02:00Z","plan":{"planId":"plan-abc","title":"Kubernetes 部署计划","steps":[{"stepId":"step-1","description":"检查集群状态","status":"completed"},{"stepId":"step-2","description":"部署应用","status":"started"}],"status":"updated"},"status":"updated"}
```

---

### 9. plan_update_failed（Plan 更新失败）

**触发条件**：Plan 执行过程中，某个 Step 失败且无法继续。

**payload 必填字段**：
```go
type PlanEvent struct {
    BaseEvent
    Plan         Plan                     // 失败时的 Plan 状态
    Status       PlanEventStatus          // "failed"
    Error        string                   // 失败原因
}
```

**前端处理**：标记 Plan 为失败状态（红色），显示错误信息，提示用户修改 Plan 或重试。

**顺序约束**：必在 `plan_create_success` 之后，是 Plan 流程的终止事件（之后不再有 `step_*` / `plan_*` 事件）。

**例子**：
```
event: plan_update_failed
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"plan_update_failed","timestamp":"2026-06-28T10:03:00Z","plan":{"planId":"plan-abc","title":"Kubernetes 部署计划","steps":[{"stepId":"step-1","description":"检查集群状态","status":"completed"},{"stepId":"step-2","description":"部署应用","status":"failed"}],"status":"failed"},"status":"failed","error":"部署镜像拉取失败"}
```

---

### 10. plan_completed（Plan 全部完成）

**触发条件**：Plan 中所有 Step 都成功完成。

**payload 必填字段**：
```go
type PlanEvent struct {
    BaseEvent
    Plan         Plan                     // 完成后的 Plan（所有 Step 状态为 completed）
    Status       PlanEventStatus          // "completed"
}
```

**前端处理**：标记 Plan 为成功完成（绿色），显示完成时间，可收起详情。

**顺序约束**：必在 `plan_create_success` 与所有 `step_complete` 之后，是 Plan 流程的终止事件。

**例子**：
```
event: plan_completed
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"plan_completed","timestamp":"2026-06-28T10:05:00Z","plan":{"planId":"plan-abc","title":"Kubernetes 部署计划","steps":[{"stepId":"step-1","description":"检查集群状态","status":"completed"},{"stepId":"step-2","description":"部署应用","status":"completed"}],"status":"completed"},"status":"completed"}
```

---

### 11. step_start（Step 开始执行）

**触发条件**：PlanAgent 开始执行某个 Step。

**payload 必填字段**：
```go
type StepEvent struct {
    BaseEvent
    Step         Step                     // Step 结构体（含 StepID, Description, ToolCalls）
    Status       StepEventStatus          // "started"
}
```

**前端处理**：高亮当前执行的 Step，显示"执行中..."状态。

**顺序约束**：必在 `plan_create_success` 之后，必在对应 `step_complete` / `step_fail` 之前。

**例子**：
```
event: step_start
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"step_start","timestamp":"2026-06-28T10:01:30Z","step":{"stepId":"step-1","description":"检查集群状态","status":"started"},"status":"started"}
```

---

### 12. step_complete（Step 完成）

**触发条件**：Step 关联的所有 ToolCall 成功执行。

**payload 必填字段**：
```go
type StepEvent struct {
    BaseEvent
    Step         Step                     // 完成后的 Step（含 Output）
    Status       StepEventStatus          // "completed"
}
```

**前端处理**：标记 Step 为完成（绿色勾），显示输出结果。

**顺序约束**：必有先行的 `step_start`（同一 StepID）。

**例子**：
```
event: step_complete
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"step_complete","timestamp":"2026-06-28T10:02:00Z","step":{"stepId":"step-1","description":"检查集群状态","output":"集群健康，节点数 3","status":"completed"},"status":"completed"}
```

---

### 13. step_fail（Step 失败）

**触发条件**：Step 关联的 ToolCall 失败或超时。

**payload 必填字段**：
```go
type StepEvent struct {
    BaseEvent
    Step         Step                     // 失败时的 Step
    Status       StepEventStatus          // "failed"
    Error        string                   // 失败原因
}
```

**前端处理**：标记 Step 为失败（红色叉），显示错误信息。

**顺序约束**：必有先行的 `step_start`（同一 StepID）。

**例子**：
```
event: step_fail
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"step_fail","timestamp":"2026-06-28T10:03:00Z","step":{"stepId":"step-2","description":"部署应用","status":"failed"},"status":"failed","error":"镜像拉取失败"}
```

---

### 14. wait（等待用户输入）

**触发条件**：Agent 需要用户提供额外信息才能继续（如多轮澄清、确认风险操作）。

**payload 必填字段**：
```go
type WaitEvent struct {
    BaseEvent
    Prompt       string                   // 提示用户输入的文本
}
```

**前端处理**：显示输入框，引导用户回复。

**顺序约束**：通常在 `message_end` 之后、`done` 之前。

**例子**：
```
event: wait
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"wait","timestamp":"2026-06-28T10:04:00Z","prompt":"请确认是否删除生产数据库？（输入 yes 确认）"}
```

---

### 15. error（异常）

**触发条件**：任何阶段的不可恢复错误（如 LLM 调用失败、内部服务异常）。

**payload 必填字段**：
```go
type ErrorEvent struct {
    BaseEvent
    Error        string                   // 错误信息
    Code         string                   // 错误码（可选，如 "LLM_TIMEOUT"）
}
```

**前端处理**：显示错误提示（红色横幅），记录到日志，提示用户重试或联系支持。

**顺序约束**：可在任何阶段发送，之后必跟 `done` 事件。

**例子**：
```
event: error
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"error","timestamp":"2026-06-28T10:05:00Z","error":"LLM 调用超时，请稍后重试","code":"LLM_TIMEOUT"}
```

---

### 16. done（流结束）

**触发条件**：所有处理完成（成功或失败），SSE 流关闭前的最后一个事件。

**payload 必填字段**：
```go
type DoneEvent struct {
    BaseEvent
}
```

**前端处理**：关闭 EventSource 连接，标记会话为"已结束"，停止 loading 动画。

**顺序约束**：必定是 SSE 流的最后一个事件，之后连接关闭。

**例子**：
```
event: done
data: {"conversationId":"conv-123","messageId":"msg-456","eventType":"done","timestamp":"2026-06-28T10:06:00Z"}
```

---

## 顺序约束总结

### 强制顺序（违反则契约失效）

1. **Plan 流程**：`plan_create_success` → 0~N 个 `step_*` → `plan_completed` / `plan_update_failed`
2. **Step 流程**：`step_start` → 0~N 个 `tool_call_*` → `step_complete` / `step_fail`
3. **Tool 流程**：`tool_call_start` → `tool_call_complete` / `tool_call_fail`（同一 ToolCallID）
4. **流结束**：任何失败路径（`error` / `plan_update_failed` / `step_fail`）之后必发 `done`

### 可并发（无依赖）

- 多个 `message` 事件可连续发送（流式文本）
- 多个 `tool_call_*` 事件可交错（不同 ToolCallID）
- `title` 事件可在任意阶段发送（通常在 `message_end` 后）

## 新增事件类型的流程

（参见 architecture-overview.md § 新增 SSE 事件类型的跨仓影响）

1. **后端**：修改 `constants.go` + `events.go` + 发布点 + 单测
2. **前端**：修改 `EventType` 枚举 + TS 类型 + 订阅逻辑
3. **文档**：写 ADR 说明用途、payload、向后兼容
4. **验证**：CI 跑 `validate-contracts.sh` 检查前端 EventType ⊆ 后端定义

## 验证方式

```bash
# 后端事件定义
grep "EventType" mooc-manus/internal/domains/models/events/constants.go

# 前端事件枚举
grep "EventType" mooc-manus-web/src/api/sse.ts

# 契约校验
.harness/scripts/validate-contracts.sh
```

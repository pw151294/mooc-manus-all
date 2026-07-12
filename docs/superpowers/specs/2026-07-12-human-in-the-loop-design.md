# 智能体高危工具人工审批（Human in the Loop）- 设计规范

**文档版本**：v1.0
**创建日期**：2026-07-12
**设计状态**：待评审
**目标项目**：mooc-manus / mooc-manus-web
**影响范围**：`/api/agent/chat` SSE 事件流、`/api/agent/resume`（新增）、`BaseAgent.InvokeToolCalls`、`bashExec` 工具、前端对话窗渲染

---

## 文档摘要

本文档定义了 mooc-manus 智能体的 **高危工具人工审批（Human in the Loop, HITL）** 完整设计方案。核心策略：主 LLM 在 `bashExec` 的 tool schema 里必须显式给出 `risk_level`（`safe`/`dangerous`）与 `risk_reason`，`BaseAgent.InvokeToolCalls` 在真正执行前读到 `dangerous` 便抛出 `tool_call_interrupt` 事件、park 当前 goroutine，前端渲染审批卡片；用户通过新增 `POST /api/agent/resume` 回投决策（`approve` / `reject` + 可选 `feedback`），Agent 恢复运行。5 分钟未决按拒绝处理。

**关键设计决策（brainstorming 阶段确认）**：

| 编号 | 决策项 | 结果 |
|---|---|---|
| D1 | 风险判定由谁做 | 主 LLM 自评（tool schema 扩展 `risk_level`/`risk_reason`） |
| D2 | 阻塞与恢复形态 | SSE 保持连接、Agent goroutine 在 `chan Decision` 上 park |
| D3 | 超时策略 | 5 分钟无决策 → 视为拒绝 |
| D4 | 拒绝携带信息 | resume payload = `{messageId, toolCallId, decision, feedback?}`，前端拒绝时可选反馈 |
| D5 | 中断触发条件 | 仅 `risk_level=dangerous` 中断，safe 直接放行 |
| D6 | 单轮多 dangerous | 串行逐个中断（同 messageId 同时最多 1 条 pending） |
| D7 | 拒绝后剩余 tool_calls 处理 | 直接 abort 剩余，均以固定文案回传给 LLM 重规划 |
| D8 | 中断期间 memory 处理 | 不动 memory；Stop 路径补齐孤儿 `assistant.tool_calls` |
| D9 | pending 状态归属 | 挂在 `BaseAgentApplicationServiceImpl`；Agent 层通过窄接口 `PendingSink` 反查 |
| D10 | Resume 幂等与鉴权 | 无用户鉴权（对齐现状）+ atomic CAS 单次生效 + 重复 409 + 不存在 404 |
| D11 | 机制作用面 | `Tool` 接口新增 `SupportsRiskAssessment()`，本次仅 `bashExec` 实现 |

---

## 一、需求边界与不做事项

### 1.1 生效范围

- `BaseAgent` / `ReActAgent` / `PlanAgent` 三种 Agent 走同一 `BaseAgent.InvokeToolCalls` 路径，均生效。
- 仅对 `Tool.SupportsRiskAssessment() == true` 的工具启用；本次交付仅 `bashExec` 实现。
- 仅在单个 `messageId` 生命周期内维持 pending；Agent goroutine 退出后 pending 状态自动清理。

### 1.2 排除场景

- ❌ **A2A Agent**：工具在远端执行，本地进不到 `InvokeToolCalls` 判定，不涵盖。
- ❌ **参数解析失败降级**：`risk_level` 字段缺失 / 非法 JSON / 枚举外值 → 不拦截、Warn 日志（宽默认，避免误拦截）。
- ❌ **跨 messageId 恢复**：pending 状态不持久化；页面刷新 / 用户切 tab 且不 resume → 5 分钟后按拒绝处理。
- ❌ **风险规则硬编码**：不维护黑名单/白名单，完全依赖 LLM 自评（prompt 里给示例清单提高召回）。

### 1.3 不做事项

- 不做工具自动降级或参数改写，只把决策权交回 LLM。
- 不做用户级鉴权（对齐现有 `/api/agent/chat` 和 `/message/stop` 的现状）；此次目标是"引入 HITL 机制"，鉴权改造另立议题。
- 不做审批历史持久化（不写 DB）；仅内存态、随会话生命周期回收。
- 不做前端"批量审批"UI；一次一条卡片。
- 不做偏好设置（"全部信任 / 仅危险 / 全部确认"），本次仅"仅危险"一档。

---

## 二、架构总览

### 2.1 分层职责

```
┌─────────────────────────────────────────────────────────────────┐
│ API 层     api/handlers/agent.go                                │
│           - Chat / StopMessage / StopConversation（现有）        │
│           - Resume                              【本次新增】     │
├─────────────────────────────────────────────────────────────────┤
│ 应用层     internal/applications/services/agent.go              │
│           - BaseAgentApplicationServiceImpl                     │
│             · cancelFuncs        map[messageId]CancelFunc（现有）│
│             · pendingInterrupts  map[messageId]*Slot【本次新增】 │
│           - Resume(...)                         【本次新增】     │
│           - stopMessageInternal → 增补孤儿 tool_call 清理【改造】│
│           implements agents.PendingSink                          │
├─────────────────────────────────────────────────────────────────┤
│ 领域层     internal/domains/services/agents/base.go             │
│           - BaseAgent.InvokeToolCalls → 增中断分支【改造】       │
│           - BaseAgent 新增字段：pendingSink、messageId 【改造】   │
│                                                                 │
│           internal/domains/models/events/                       │
│           - EventTypeToolCallInterrupt / ToolInterruptEvent【新增】│
│                                                                 │
│           internal/domains/models/tools/                        │
│           - Tool.SupportsRiskAssessment() bool  【接口新增】     │
│           - bashExec 实现该方法 + schema 新增两字段【改造】      │
│                                                                 │
│           internal/domains/models/interrupt/                    │
│           - 固定文案常量 + parseRiskFromArgs      【新包】       │
├─────────────────────────────────────────────────────────────────┤
│ 前端      mooc-manus-web/src/api/sse.ts                         │
│           - 订阅 tool_call_interrupt 事件       【本次新增】     │
│           - 对话窗渲染 InterruptCard 组件       【本次新增】     │
│           - approve/reject 调 POST /api/agent/resume【本次新增】 │
└─────────────────────────────────────────────────────────────────┘
```

关键决策：**Agent 层不直接持有 pending 状态**。所有 pending 生命周期（Register / Resume / Timer / Stop 联动）都在 app service 层完成，Agent 层仅通过窄接口 `PendingSink` 反查。这样：

1. `stopMessageInternal` 与 pending 清理在同一把锁下协作，孤儿 `assistant.tool_calls` 补齐最短路径；
2. 与现有 `cancelFuncs`、`skillExecutor.CleanupMessage`、`nativeToolsProvider.Cleanup` 的所有权模式对齐；
3. Agent 层测试可注入 mock `PendingSink`，不必启动完整 app service。

### 2.2 数据流

**主路径（approve）**：

```
Frontend            Handler        AppService              Agent goroutine
   │                  │                │                       │
   │ POST /chat       │                │                       │
   ├─────────────────►│───Chat(req)───►│                       │
   │                  │                │──StartChat→messageId─►│
   │                  │                │──go domainSvc.Chat──►│
   │                  │                │                       │ StreamingInvokeLLM
   │                  │                │                       │ ← assistant.tool_calls[bashExec risk=dangerous]
   │                  │                │                       │ InvokeToolCalls:
   │                  │                │◄─RegisterInterrupt────┤ (通过 PendingSink)
   │                  │                │                       │ ← chan Decision
   │                  │                │◄─eventCh<-OnToolCallInterrupt
   │◄── SSE tool_call_interrupt ──────────────────────────────────┤
   │  [render InterruptCard]                                       │
   │  用户点 approve                                                 │
   │ POST /resume {mid,tcid,approve}                                │
   ├─────────────────►│──Resume──────►│                       │
   │                  │                │──slot.resolve(approve)│
   │                  │◄── 200 accepted│                       │
   │                  │                │                       │ ← decision (approve)
   │                  │                │                       │ 走原 InvokeTool
   │                  │                │◄─eventCh<-tool_call_start/complete
   │◄── SSE tool_call_start / complete ──────────────────────────  ┤
   │                  │                │                       │ 下一轮 LLM ...
```

**拒绝路径**：Resume 携带 `decision=reject` + 可选 `feedback` → `slot.resolve(Reject)` → Agent 收到 → 生成 reject tool result（含 feedback）追加到 `toolMessages` → **同一轮内后续所有 tool_calls 生成 `sibling_skipped` tool result** → return toolMessages → 下一轮 LLM 拿到"用户拒绝 + 反馈 + 其他未执行"，自主重规划。

**超时路径**：5 分钟 Timer fire → `slot.resolve(Timeout)` → Agent 收到 → 生成 timeout tool result + 后续 sibling_skipped → 送 LLM。Timer 由 `time.AfterFunc` 一次性触发；resolve 内的 atomic CAS 保证与 Resume/Stop 互斥。

**Stop 路径**：`stopMessageInternal` 触发时若发现 `pendingInterrupts[messageId]` 存在，先向 chan 注入 `Decision{Kind: Cancel}` → Agent goroutine 从 `select` 退出 → app service 层直接对 memory 追加"用户中止操作"tool result 补齐孤儿 `assistant.tool_calls` → 再走原有的 cancel context、SSE close、skill/native 清理。

顺序：**注入 cancel → 200ms sleep 兜底 → 补齐 memory → 原三段清理**。

---

## 三、数据结构定义

### 3.1 事件常量

`internal/domains/models/events/constants.go` 增补：

```go
EventTypeToolCallInterrupt = "tool_call_interrupt"

// ToolEventStatus 增补
ToolEventStatusInterrupted ToolEventStatus = "interrupted"
```

命名对齐现有 `tool_call_start` / `tool_call_complete` / `tool_call_fail`。

### 3.2 中断事件结构

新增文件 `internal/domains/models/events/interrupt.go`：

```go
package events

import (
    "time"
    "github.com/google/uuid"
    "mooc-manus/internal/domains/models/llm"
)

// ToolInterruptEvent 抛出于工具调用被判定为高危、需要用户决策时。
// 与 ToolEvent 平级独立结构体：字段差异较大，避免污染 ToolEvent。
type ToolInterruptEvent struct {
    BaseEvent
    Timestamp    time.Time       `json:"timestamp"`
    ToolCallID   string          `json:"tool_call_id"`
    ToolName     string          `json:"tool_name"`      // provider 名，如 "native"
    FunctionName string          `json:"function_name"`  // 如 "bashExec"
    FunctionArgs string          `json:"function_args"`  // 原始 arguments JSON
    RiskLevel    string          `json:"risk_level"`     // 当前恒为 "dangerous"
    RiskReason   string          `json:"risk_reason"`    // LLM 给出的风险说明
    Status       ToolEventStatus `json:"status"`         // 恒为 "interrupted"
}

func OnToolCallInterrupt(toolCall llm.ToolCall, toolName, riskLevel, riskReason string) AgentEvent {
    ev := ToolInterruptEvent{
        Timestamp:    time.Now(),
        ToolCallID:   toolCall.ID,
        ToolName:     toolName,
        FunctionName: toolCall.Name,
        FunctionArgs: toolCall.Arguments,
        RiskLevel:    riskLevel,
        RiskReason:   riskReason,
        Status:       ToolEventStatusInterrupted,
    }
    ev.ID = uuid.New().String()
    ev.CreatedAt = time.Now()
    ev.Type = EventTypeToolCallInterrupt
    return &ev
}
```

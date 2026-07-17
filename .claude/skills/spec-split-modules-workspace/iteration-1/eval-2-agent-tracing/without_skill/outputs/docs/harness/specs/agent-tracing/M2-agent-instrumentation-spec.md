# M2 Agent 链路埋点设计文档

**日期**：2026-07-17
**父 spec**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块状态**：设计评审中
**关联仓库**：mooc-manus

---

## 一、模块目标

在 `/api/agent/chat` 主链路上完成 6 类 Span 的埋点，产出结构正确、tags/logs 齐全的 Span 数据流。本模块**只做埋点动作**，Span 提交后由 M1 的桩 `commit`（或 M3 上线后的真正缓冲）处理。

### 1.1 交付范围

1. Application 层 `internal/applications/services/agent.go` `Chat()` 埋点 AGENT_ROOT
2. Domain 层 `internal/domains/services/agents/base.go`：
   - `StreamingInvoke` / `Invoke` 循环体：AGENT_ROUND
   - `StreamingInvokeLLM` / `InvokeLLM`（**新增 ctx 参数**）：LLM_CALL
   - `InvokeToolCalls` 函数入口：TOOL_BATCH
   - `InvokeToolCalls` 循环体：TOOL_CALL 或 SUBAGENT_CALL（动态选择）
3. 所有 tags/logs 采集清单落地
4. Application 集成测试验证 span 结构与父子关系

### 1.2 非目标

- Span 的落盘由 M3 负责
- 查询 API 由 M4 负责
- 敏感字段打码规则的扩展 hook 由 M5 负责（本模块使用 M1 内置规则）
- Plan / A2A Agent 埋点、错误冒泡

---

## 二、依赖关系

- **前置**：M1 已交付（Span / Tracer / StartSpanFromContext / SpanFromContext 可用）
- **建议同期完成 M3**：否则 span 产生后被丢弃，只能靠 Application 集成测试注入的 in-memory Repository 验证

---

## 三、埋点位置

### 3.1 埋点点位表

| 位置 | 埋点动作 | Span 类型 |
|------|---------|-----------|
| `applications/services/agent.go` `Chat()` 进入时 | `ctx, root := tracer.StartRootSpan(ctx, messageId)` + `defer root.End()` | `AGENT_ROOT` |
| `domains/services/agents/base.go` `StreamingInvoke` 循环体（匿名函数隔离） | 见 §3.2 循环模板 | `AGENT_ROUND` |
| `base.go` `StreamingInvokeLLM` 函数入口（**签名新增 ctx**） | `_, llmSpan := tracing.StartSpanFromContext(ctx, LLM_CALL, "")` + `defer llmSpan.End()` | `LLM_CALL` |
| `base.go` `InvokeToolCalls` 函数入口 | `ctx, batchSpan := tracing.StartSpanFromContext(ctx, TOOL_BATCH, "")` + `defer batchSpan.End()` | `TOOL_BATCH` |
| `base.go` `InvokeToolCalls` for 循环体（匿名函数隔离） | 见 §3.2 循环模板 | `TOOL_CALL` |
| 同上，`SubagentTool` 类型 | `SpanType` 换为 `SUBAGENT_CALL` | `SUBAGENT_CALL` |

**`Invoke`（非流式）同步覆盖**：位置在同一文件，测试聚焦 `StreamingInvoke`。

### 3.2 循环埋点模板（必读，避免 defer 陷阱）

Go `defer` 是函数级作用域，直接在 for 循环里写 `defer span.End()` 会让所有 span 延迟到外层函数返回，`EndTime` / `LatencyMs` 完全失真。

**修复模板**：每轮循环体用匿名函数包裹，且循环内 ctx 用独立变量名。

**AGENT_ROUND（`StreamingInvoke` 循环体，`base.go:466-499`）**：

```go
for round < a.agentConfig.MaxIterations {
    select {
    case <-ctx.Done():
        // 保持现有逻辑
    default:
    }
    round++

    shouldContinue := func() bool {
        roundCtx, roundSpan := tracing.StartSpanFromContext(ctx, tracing.SpanTypeAgentRound, "")
        defer roundSpan.End()
        roundSpan.SetTag("round.index", round)
        roundSpan.SetTag("round.messages_count", len(a.GetMessages()))
        // 原有循环体逻辑，把 ctx 替换为 roundCtx 传给下游
        return !shouldEnd.Load()
    }()
    if !shouldContinue {
        close(eventCh)
        return
    }
}
```

**TOOL_CALL（`InvokeToolCalls` for 循环体，`base.go:111-256`）**：

```go
for _, toolCall := range toolCalls {
    func() {
        spanType := tracing.SpanTypeToolCall
        if tool := a.GetTool(toolCall.Name); tool != nil {
            if _, ok := tool.(*tools.SubagentTool); ok {
                spanType = tracing.SpanTypeSubagentCall
            }
        }
        toolCtx, toolSpan := tracing.StartSpanFromContext(ctx, spanType, toolCall.Name)
        defer toolSpan.End()
        toolSpan.SetTag("tool.name", toolCall.Name)
        toolSpan.SetTag("tool.tool_call_id", toolCall.ID)
        // ... 更多 tags / logs 见 §4
        _ = toolCtx
    }()
}
```

**关键约束**：
- 循环内 ctx 用**新变量名**（`roundCtx` / `toolCtx`），不要覆盖外层 `ctx`
- `AGENT_ROUND` 的 parent 永远是 root（外层 ctx）
- 循环外的 ctx 保持指向 root

### 3.3 函数签名改造清单

| 函数 | 现签名 | 目标签名 | 原因 |
|------|--------|----------|------|
| `BaseAgent.StreamingInvokeLLM` | `(messages, eventCh)` | `(ctx, messages, eventCh)` | 内部创建 LLM_CALL span |
| `BaseAgent.InvokeLLM` | `(messages)` | `(ctx, messages)` | 同上（非流式） |

**同步改造调用点**：`Invoke` / `StreamingInvoke` 循环内调用这两个函数时传入 `roundCtx`。

`InvokeTool` / `InvokeToolCalls`：`InvokeToolCalls` 已收 ctx；`InvokeTool` 不改签名，TOOL_CALL span 在循环体内闭环。

---

## 四、tags / logs 采集清单

### 4.1 AGENT_ROOT

**独立列**（Application 层 `StartRootSpan` 时填入）：
- `ConversationID`（`request.ConversationId`）
- `AgentName`（先占位 `"base"`，Domain 层入口覆盖）

**Application 层 tags**：
- `user.query`（`request.Query`，截断 1KB，敏感字段打码）
- `agent.max_iterations`（`request.MaxIterations`）

**Domain 层 tags 补齐**（在 `BaseAgent.StreamingInvoke` / `Invoke` 入口）：
```go
rootSpan := tracing.SpanFromContext(ctx)
rootSpan.SetTag("agent.name", a.name)
rootSpan.SetTag("agent.model", a.agentConfig.Model)
rootSpan.SetTag("agent.max_iterations", a.agentConfig.MaxIterations)
rootSpan.SetTag("agent.tools_count", len(a.GetAvailableTools()))
rootSpan.SetTag("system_prompt.hash", tracing.Sha256Prefix(a.systemPrompt, 16))
rootSpan.SetAgentName(a.name)  // 独立列覆盖
```

**Logs**：
- `agent.context_cancelled`（Application 60s 超时兜底 + Domain `<-ctx.Done()`）
- `agent.max_iterations_exceeded`（超阈值时同时 `SetError`）

### 4.2 AGENT_ROUND

**Tags**：
- `round.index`（1-based）
- `round.messages_count`
- `round.status`（`llm_only` / `with_tools` / `finished`）

### 4.3 LLM_CALL

**Tags**：
- `llm.model`（`a.agentConfig.Model`）
- `llm.messages_count`
- `llm.tools_count`（可用工具数）
- `llm.finish_reason`（`stop` / `tool_calls` / `length`）
- `llm.tool_calls_count`（本次响应触发的 tool call 数）

**Logs**：
- `llm.request.sent`（Start 时）
- `llm.stream.first_token`
- `llm.stream.completed`
- `llm.error`（异常时 `SetError`）

**Span 创建位置示例**：

```go
func (a *BaseAgent) StreamingInvokeLLM(ctx context.Context, messages []llm.Message, eventCh chan<- events.AgentEvent) llm.Message {
    _, llmSpan := tracing.StartSpanFromContext(ctx, tracing.SpanTypeLLMCall, "")
    defer llmSpan.End()
    llmSpan.SetTag("llm.model", a.agentConfig.Model)
    llmSpan.SetTag("llm.messages_count", len(a.GetMessages()))
    llmSpan.SetTag("llm.tools_count", len(a.GetAvailableTools()))
    llmSpan.AddLog("INFO", "llm.request.sent", nil)

    // 原有 go func { invoker.StreamingInvoke(...) } 逻辑
    firstTokenSeen := false
    for event := range llmEventCh {
        if !firstTokenSeen && event.EventType() == events.EventTypeMessage {
            llmSpan.AddLog("INFO", "llm.stream.first_token", nil)
            firstTokenSeen = true
        }
        eventCh <- event
    }
    wg.Wait()

    llmSpan.SetTag("llm.finish_reason", deriveFinishReason(message))
    llmSpan.SetTag("llm.tool_calls_count", len(message.ToolCalls))
    llmSpan.AddLog("INFO", "llm.stream.completed", nil)
    return message
}
```

**关键点**：
- span 生命周期与函数一致（`defer llmSpan.End()`），不跨 goroutine 传 span 引用
- 所有 log 在外层监听 goroutine 内采集
- `Span.AddLog` 内部 `mu` 保护，跨 goroutine 也安全
- 非流式 `InvokeLLM` 同理，重试循环内 log `llm.retry`

### 4.4 TOOL_BATCH

**Tags**：
- `batch.tool_calls_count`
- `batch.parallel`（bool，目前串行为 false，后续改并行沿用）
- `batch.success_count`
- `batch.fail_count`

### 4.5 TOOL_CALL / SUBAGENT_CALL

**Tags**（TOOL_CALL）：
- `tool.name`（同 operation_name）
- `tool.type`（skill / mcp / a2a / native）
- `tool.tool_call_id`
- `tool.arguments`（截断 2KB，打码）
- `tool.result_size`（bytes 全量结果大小）
- `tool.result_preview`（截断 512B，打码）
- `tool.circuit_breaker.trigger`（bool）
- `tool.retry_count`
- `tool.hitl.required`（bool）
- `tool.hitl.decision`（approve / reject / timeout / cancel）

**Tags 附加**（SUBAGENT_CALL）：
- `subagent.name`
- `subagent.iterations`

**Logs**：
- `tool.invoke.start`
- `tool.retry`
- `tool.circuit_breaker.open`
- `tool.hitl.requested`
- `tool.hitl.decided`
- `tool.error`（`SetError`）

---

## 五、调用序列示例

```
时刻  ctx-Stack                              Span 事件
────  ─────────────────────────────────────  ────────────────────────────────
t0    []                                     Chat() 收到请求
t1    [root]                                 StartRootSpan → span_id=0
t2    [root, round#1]                          StartSpan(ROUND) → span_id=1
t3    [root, round#1, llm#1]                    StartSpan(LLM) → span_id=2
t4    [root, round#1, llm#1]                    LLM 首 token → AddLog
t5    [root, round#1]                            llm#1.End() → 提交
t6    [root, round#1, batch#1]                 StartSpan(TOOL_BATCH) → span_id=3
t7    [root, round#1, batch#1, tool#1]           StartSpan(TOOL_CALL) → span_id=4
t8    [root, round#1, batch#1]                   tool#1.End() → 提交
...
tN    []                                     root.End() → span_id=0 提交
```

**关键点**：
- `span_id` **创建顺序**单调递增，提交顺序是叶子先 root 后
- 查询按 `span_id ASC` 恢复创建顺序
- `defer root.End()` 保证 panic / ctx cancel / max iterations 收尾

---

## 六、集成测试

**位置**：`internal/applications/services/agent_tracing_integration_test.go`

**Mock 策略**：
- Mock LLM Invoker（预设 tool_calls 序列）
- Mock Tool Invoker（预设结果）
- **Real Tracer + In-memory SpanRepository**：真实跑 tracer

**用例**：

1. `TestChat_HappyPath_SpanStructure`：1 轮 LLM → 2 tool → 1 轮结束
   - Span 数 = 1 root + 2 round + 2 llm + 1 batch + 2 tool = 8
   - 父子关系与创建顺序断言
   - Tags 完整、`ConversationID` / `AgentName` 独立列填充

2. `TestChat_ToolError_IsErrorFlag`：某 tool 返回 error
   - 该 tool span `is_error=true`
   - 父 span 全 `is_error=false`（不冒泡）

3. `TestChat_ContextCancel_RootSpanClosed`：mock 长 tool，中途 cancel
   - root span 被 End、logs 含 `agent.context_cancelled`

4. `TestChat_MaxIterationsExceeded_RootIsError`：死循环 tool
   - root span `is_error=true`、logs 含 `agent.max_iterations_exceeded`

5. `TestChat_HITLDangerousTool_SpanTags`：dangerous 风险 tool + Approve
   - tool span tags `tool.hitl.required=true` / `tool.hitl.decision="approve"`

6. `TestChat_SubagentCall_SpanType`：子智能体 tool
   - `span_type=SUBAGENT_CALL` + `subagent.name` tag

7. `TestChat_LoopContextPropagation_RoundParentIsRoot`：mock 2 轮 ReAct
   - 两个 AGENT_ROUND 的 `parent_span_id` 都等于 root 的 `span_id`（= 0）
   - 防止「轮次埋点 ctx 误覆盖」回归

---

## 七、侵入性控制

- Tracer 用**包级单例**（`tracing.Global()`），Domain 层无需接口注入
- ctx 传递父子关系，`base.go` 现有函数已收 ctx，天然兼容
- 埋点是「包围式」defer 结构，不改主逻辑控制流
- 敏感字段打码在 `SetTag` 内部完成，业务代码零感知

---

## 八、验收清单

- [ ] 6 类 span 全部实现并可从集成测试观察到
- [ ] `StreamingInvokeLLM` / `InvokeLLM` 签名新增 `ctx`，调用点同步改造
- [ ] tags / logs 采集清单齐全（AGENT_ROOT 8 项、AGENT_ROUND 3 项、LLM 5 项、TOOL_BATCH 4 项、TOOL_CALL 12 项）
- [ ] 循环埋点用匿名函数隔离，`LatencyMs` 反映真实单轮耗时
- [ ] 集成测试 7 个用例全部通过
- [ ] 主链路无阻塞：埋点异常路径不影响 chat 正常返回

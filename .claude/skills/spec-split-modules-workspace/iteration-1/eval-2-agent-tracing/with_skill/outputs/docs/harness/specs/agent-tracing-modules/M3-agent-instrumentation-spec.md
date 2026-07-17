# M3 埋点注入模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块编号**：M3
**依赖**：M1（Span/SpanRepository 接口）、M2（Tracer 服务 + StartSpanFromContext）
**被依赖**：无（M4 通过查询 span 消费本模块产出）

---

## 1. 模块范围

把 M2 的 Tracer 真正接入 `/api/agent/chat` 主链路，让每次 chat 产生 26 条左右完整 span。涉及
Application 层入口埋点、BaseAgent 循环内埋点、LLM/Tool/Subagent 调用点埋点、tags/logs 采集、
以及部分函数签名的 ctx 参数改造。**这是让 tracing 系统"活起来"的关键模块**。

### 1.1 交付物

- Application 层埋点：
  - `internal/applications/services/agent.go`：`Chat()` 入口处
    - `ctx, root := tracing.Global().StartRootSpan(ctx, messageId)`
    - `defer root.End()`
    - Application 侧 tag：`user.query`（1KB 截断）、`agent.max_iterations`
    - 独立列：`ConversationID`、`AgentName`（占位空串或 `"base"`）
- Domain 层 root span 补 tag：
  - `internal/domains/services/agents/base.go`：`StreamingInvoke` / `Invoke` 入口
    - `rootSpan := tracing.SpanFromContext(ctx)`
    - 补 tag：`agent.name` / `agent.model` / `agent.max_iterations` / `agent.tools_count` / `system_prompt.hash`
    - `rootSpan.SetAgentName(a.name)`（覆盖 Application 层占位）
- ReAct 轮次埋点（循环体内匿名函数模板，见父规格 §4.1.1）：
  - `base.go` `StreamingInvoke` / `Invoke` 循环体
    - 每轮 `StartSpanFromContext(ctx, AGENT_ROUND, "")` + `roundSpan.End()` 立即闭合
    - Tags：`round.index`、`round.messages_count`
    - Logs：`round.iteration_start`、`round.finish_reason`
    - **关键**：`ctx` 使用循环内局部变量，避免 Go defer 陷阱与 ctx 覆盖回归
- LLM 调用埋点：
  - `base.go` `StreamingInvokeLLM` 函数签名新增 `ctx context.Context`（父规格 §4.1.2）
    - 函数体首行：`ctx, llmSpan := tracing.StartSpanFromContext(ctx, LLM_CALL, "")` + `defer llmSpan.End()`
    - Tags：`llm.model` / `llm.messages_count` / `llm.tools_count` / `llm.finish_reason` / `llm.tool_calls_count`（+ 可选 tokens）
    - Logs：`llm.request.sent` / `llm.stream.first_token` / `llm.stream.completed` / `llm.error`
  - `base.go` `InvokeLLM`（非流式）同样加 `ctx context.Context` 参数
  - 调用点同步改造：`Invoke` / `StreamingInvoke` 循环内传入 `roundCtx`
- Tool Batch / Tool Call / Subagent 埋点：
  - `base.go` `InvokeToolCalls` 函数入口
    - `ctx, batchSpan := tracing.StartSpanFromContext(ctx, TOOL_BATCH, "")` + `defer batchSpan.End()`
  - `InvokeToolCalls` for 循环体（匿名函数模板）
    - 每个 tool 调用前 `StartSpanFromContext(ctx, TOOL_CALL, toolName)` + `End()` 立即闭合
    - 子智能体分支（判断 tool 类型）：改用 `SUBAGENT_CALL` + `subagent.name` tag
    - Tags：`tool.name` / `tool.arguments`（2KB 截断）/ `tool.result_preview`（512B 截断）/ `tool.hitl.required` / `tool.hitl.decision` / `tool.is_error`
- 里程碑日志：
  - Application 层 60s 超时兜底路径：`root.AddLog("WARN", "agent.context_cancelled", ...)`
  - Domain 层 `<-ctx.Done()` 分支：`SpanFromContext(ctx).AddLog(...)`
  - Domain 层超过 `MaxIterations` 时：`root.SetError` + `agent.max_iterations_exceeded` log

### 1.2 非目标

- 不做 Tracer 缓冲/落盘（属 M2）
- 不做查询 API（属 M4）
- 不覆盖 PlanAgent / A2AAgent（父规格 §1.4 明确本期不做）
- 不做 `InvokeTool`（单 tool 内部）下钻埋点（父规格 §4.1.2）
- 不做采样（100% 采集）

---

## 2. 核心设计切片

### 2.1 循环体埋点匿名函数模板（必读，避免 defer 陷阱）

严格遵循父规格 §4.1.1。伪代码：

```go
for i := 0; i < maxIterations; i++ {
    func() {
        roundCtx, roundSpan := tracing.StartSpanFromContext(ctx, tracing.SpanTypeAgentRound, "")
        defer roundSpan.End()
        roundSpan.SetTag("round.index", i+1)
        roundSpan.SetTag("round.messages_count", len(a.GetMessages()))
        // ...
        // 用 roundCtx 传给 llm / tool 层
        _ = a.StreamingInvokeLLM(roundCtx, ...)
        _ = a.InvokeToolCalls(roundCtx, ...)
    }()
}
```

**必须点**：
1. 匿名函数隔离 defer 时机，避免所有 `roundSpan.End()` 等到函数返回才触发
2. 循环外用 `ctx`（root），循环内用 `roundCtx`；不能污染 `ctx`
3. 调用下游 llm / tool 时**必须传 `roundCtx`**，否则 llm span/tool span 会挂到 root 而不是本轮

### 2.2 函数签名改造清单（父规格 §4.1.2）

| 函数 | 原签名 | 新签名 | 影响面 |
|---|---|---|---|
| `BaseAgent.StreamingInvokeLLM` | `(messages, eventCh) llm.Message` | `(ctx, messages, eventCh) llm.Message` | 内部循环调用点 |
| `BaseAgent.InvokeLLM` | `(messages) (llm.Message, error)` | `(ctx, messages) (llm.Message, error)` | 内部循环调用点 |
| `BaseAgent.InvokeToolCalls` | 已收 ctx | 不变 | — |
| `BaseAgent.InvokeTool` | 三方 tool 执行 | 不变（本期不下钻） | — |

### 2.3 tags/logs 采集清单

严格对齐父规格 §4.3，5 类 span 的 tag/log 全量清单：AGENT_ROOT / AGENT_ROUND / LLM_CALL /
TOOL_BATCH / TOOL_CALL / SUBAGENT_CALL。参见父规格 §4.3。

### 2.4 侵入性控制

- 除 `StreamingInvokeLLM` / `InvokeLLM` 的 ctx 参数外，其他函数签名保持不变
- 依赖 `SpanFromContext` 从 ctx 取 span，避免每个函数都传 span 对象
- Application 层单测未来只需 `SetGlobal(nil)` 或用 no-op tracer，即可无副作用运行

---

## 3. 数据流

```
HTTP 请求 → agent handler → Application.Chat
                              │
                              ▼  StartRootSpan → root span (span_id=0)
                              │  defer root.End()
                              │
                              ▼  BaseAgent.StreamingInvoke(ctx)
                              │    补 tag: agent.name / model / ...
                              │
                              ▼  for loop:
                                   ┌─────────────────────────────┐
                                   │ func() {                    │
                                   │   roundCtx, span=AGENT_ROUND│
                                   │   defer span.End()          │
                                   │   StreamingInvokeLLM(roundCtx)│  ← LLM_CALL span
                                   │   InvokeToolCalls(roundCtx) │  ← TOOL_BATCH + N TOOL_CALL
                                   │ }()                         │
                                   └─────────────────────────────┘
```

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 循环内用匿名函数 + defer | 避免 defer 累积到函数返回 | §4.1.1 |
| ctx 局部变量（roundCtx） | 防止跨轮次 span 挂错 parent | §4.1、§8.3 用例 8 |
| 只改 2 个函数签名 | 侵入性最小 | §4.4 |
| Application 层设占位，Domain 层补齐 | 各层看得到的信息不同 | §4.3 AGENT_ROOT |
| 错误不冒泡 | 只标叶子 | §5.2 |

---

## 5. 验证边界

**技术验证**：编译通过、单测通过（Application 集成测试用例见父规格 §8.3 用例 1–8）
**功能验证**：真实发 `/api/agent/chat`，DB `ai_span` 表看到 26 条左右 span 结构正确

详见 `docs/harness/e2e/agent-tracing-modules/M3-agent-instrumentation-e2e.md`

---

## 6. 交付验收

- [ ] 所有埋点点位已插入
- [ ] `StreamingInvokeLLM` / `InvokeLLM` 签名改造完成、所有调用点同步更新、`go build ./...` 通过
- [ ] Application 层集成测试用例 1–8（父规格 §8.3）全部通过
- [ ] `go test -race` 无并发问题、`goleak` 无 goroutine 泄漏
- [ ] 真实发一次 chat 请求，通过 SQL 查 `ai_span` 表能验证 span 数、父子关系、独立列填充
- [ ] E2E 文档所有检查项通过
- [ ] Chat 端到端延时增长 ≤ 5%（对比 M3 合入前 vs 合入后）

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4、§5

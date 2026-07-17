# M2 Agent 链路埋点 E2E 验证文档

**日期**：2026-07-17
**关联 spec**：`docs/harness/specs/agent-tracing/M2-agent-instrumentation-spec.md`

---

## 一、验证目标

在真实 `/api/agent/chat` 调用中确认：
- 6 类 span 全部产生
- 父子关系正确、`span_id` 单调递增
- Tags / Logs 采集齐全、`ConversationID` / `AgentName` 独立列填充
- `is_error` 不冒泡
- SUBAGENT_CALL 类型识别正确
- 循环埋点用匿名函数隔离，`LatencyMs` 反映单轮真实耗时
- 埋点异常路径不影响 chat 正常返回

---

## 二、前置条件

- M1 已完成、`ai_span` 表存在
- M3 已完成或至少配置了 in-memory Repository（供 e2e 断言用）
- 后端服务可启动、LLM 网关可通（真实 or mock）
- MySQL 客户端可查询 `ai_span`

---

## 三、验证步骤

### 3.1 集成测试路径（首选）

**位置**：`internal/applications/services/agent_tracing_integration_test.go`

用 real Tracer + in-memory SpanRepository 跑一遍完整 Chat：

```bash
cd mooc-manus
go test -race -v -run TestChat_.*Span ./internal/applications/services/
```

**通过标准**：7 个用例（对应 spec §六）全通过。

### 3.2 用例一：Happy Path Span 结构

**场景**：1 轮 LLM → 2 tool → 1 轮结束

**mock 序列**：
- 第 1 次 LLM 返回：`tool_calls=[fileRead, bashExec]`
- 第 2 次 LLM 返回：`finish_reason=stop`

**断言**：

| 项 | 期望值 |
|----|-------|
| 落盘 span 数 | 8（1 root + 2 round + 2 llm + 1 batch + 2 tool） |
| root.SpanID | 0 |
| root.ParentSpanID | -1 |
| root.SpanType | AGENT_ROOT |
| root.ConversationID | 请求携带值 |
| root.AgentName | agent.name（Domain 层覆盖后）|
| root.tags["agent.model"] | 存在且等于 config.Model |
| round#1.ParentSpanID | 0 |
| round#2.ParentSpanID | 0 |（**关键：不是 round#1 的 id**） |
| llm#1.ParentSpanID | round#1.SpanID |
| batch#1.ParentSpanID | round#1.SpanID |
| tool#1.ParentSpanID | batch#1.SpanID |
| tool#1.tags["tool.name"] | fileRead |
| tool#1.LatencyMs | > 0 |
| span_id 序列 | 严格单调递增 0..7 |

### 3.3 用例二：Tool Error 不冒泡

**mock**：`bashExec` 返回 `errors.New("cmd not found")`

**断言**：
- `tool#2.IsError == true`
- `tool#2.logs` 含 Level=ERROR entry
- `batch#1.IsError == false`
- `round#1.IsError == false`
- `root.IsError == false`

### 3.4 用例三：Context Cancel 关闭 root

**mock**：`bashExec` sleep 100s；主 goroutine 5s 后 `cancel()`

**断言**：
- root span 被 End（有 EndTime）
- root.logs 含 `agent.context_cancelled`
- Chat 返回错误但服务不 crash

### 3.5 用例四：Max Iterations 超阈值

**mock**：LLM 一直返回 `tool_calls` 不停

**断言**：
- 达到 `MaxIterations` 后 root.IsError=true
- root.logs 含 `agent.max_iterations_exceeded`

### 3.6 用例五：HITL 审批

**mock**：dangerous 风险 tool，模拟前端 Approve 决策

**断言**：
- tool span tags `tool.hitl.required=true`
- tool span tags `tool.hitl.decision="approve"`
- tool span logs 顺序：`tool.hitl.requested` → `tool.hitl.decided`

### 3.7 用例六：Subagent Call 类型识别

**mock**：`tool_calls` 中含 `SubagentTool` 类型的 tool

**断言**：
- 对应 span `SpanType=SUBAGENT_CALL`
- tags 含 `subagent.name`
- tags 含 `subagent.iterations`

### 3.8 用例七：循环 ctx 传播

**mock**：2 轮 ReAct（第一轮 tool_calls，第二轮 stop）

**断言**：
- round#1.ParentSpanID == root.SpanID
- round#2.ParentSpanID == root.SpanID（**不是 round#1**）
- 每个 llm / batch / tool 的 parent 都指向对应轮次的 round，不跨轮次

### 3.9 端到端 HTTP 冒烟

启动服务后：

```bash
curl -X POST http://localhost:8080/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-conv-1","query":"帮我 ls 当前目录","messageId":"e2e-msg-1"}'
```

查询 DB：

```sql
SELECT span_id, parent_span_id, span_type, operation_name, latency_ms, is_error
FROM ai_span
WHERE trace_id = 'e2e-msg-1'
ORDER BY span_id ASC;
```

**通过标准**：
- 有 ≥ 1 条 root（span_id=0, parent=-1）
- 有 AGENT_ROUND / LLM_CALL 至少各 1 条
- 若 LLM 触发 tool，有 TOOL_BATCH + TOOL_CALL
- `latency_ms` 每行都 > 0
- 相邻 span 时间戳合理（root.start < child.start < child.end < root.end）

### 3.10 循环 defer 陷阱回归

对比测试：如果误把 `defer span.End()` 直接写在 for 循环里：

- 每个 round 的 `LatencyMs` 都会近似等于总时延（错误）
- 正确实现下每个 round 的 `LatencyMs` 应远小于总时延（≈单轮耗时）

用 `LatencyMs.Sum > total_root.LatencyMs * 3` 作为 sanity check（正确情况下 sum≈total）。

---

## 四、失败判定

| 场景 | 说明 |
|------|------|
| Span 数量与预期不符 | 埋点缺失或多打 |
| round#N.ParentSpanID ≠ root.SpanID | ctx 循环覆盖 bug |
| LatencyMs 全部近似等于 root.LatencyMs | defer 陷阱未修复 |
| SUBAGENT_CALL 未识别 | tool 类型检测漏了 SubagentTool |
| 敏感 tag 未打码 | M1 打码规则被跳过 |
| Chat 返回 5xx | 埋点异常影响到主链路 |

---

## 五、观测点

- 一次典型 5 轮 chat：应产生约 26 条 span（1 + 5 + 5 + 5 + 10）
- 端到端 chat 时延：埋点前后对比 < 5% 增长
- 内存：单次 chat 结束后 span 应从 Tracer 内存释放（root End 后 traceCounter 清理）

---

## 六、回归红线

- 埋点 goroutine 内发生 panic 时业务不受影响（依赖 M5 recovery 兜底）
- 若 SUBAGENT_CALL 内部再发起 chat（未来场景），本期不下钻，产生 span_type=TOOL_CALL 而非 SUBAGENT_CALL 属于已知遗留

---

## 七、通过标准（Gate）

- [ ] 集成测试 7 个用例全通过
- [ ] HTTP 冒烟：DB 里能观察到完整链路
- [ ] 循环 ctx 传播断言通过（防陷阱）
- [ ] `LatencyMs` 反映真实单轮耗时（sum 与 root 相近）
- [ ] 敏感字段打码在 tool.arguments 中生效
- [ ] `is_error` 不冒泡：叶子红、父白

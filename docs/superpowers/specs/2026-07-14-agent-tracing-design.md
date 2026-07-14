# mooc-manus 智能体对话链路追踪（Agent Tracing）设计文档

**日期**：2026-07-14
**状态**：设计评审中
**作者**：Claude (Opus 4.7)
**关联仓库**：mooc-manus（后端 Go 服务，本期仅后端）

---

## 一、背景与动机

### 1.1 问题陈述

当前 mooc-manus 智能体已具备常规问答、工具调用、容错恢复、熔断降级、HITL 审批与子智能体功能，逐渐向工程化的编程工具靠齐。但在生产环境中，一次 `/api/agent/chat` 调用背后是一条包含多次 LLM 推理、多轮工具执行、可能嵌套子智能体的复杂链路。当故障出现时（如响应超时、结果错误、工具失败），当前仅依赖 zap 日志难以：

- 快速判断故障出现在**哪一轮 ReAct 迭代**
- 精确定位故障子环节（LLM 调用 / 具体某个 tool / 熔断触发 / HITL 超时）
- 度量各子环节的**耗时占比**，识别性能瓶颈
- 追溯**跨请求**的历史失败模式（同一 tool 反复失败、某 model 慢查询占比高等）

### 1.2 解决方案概述

借鉴分布式链路追踪（OpenTracing / OpenTelemetry）的核心思想：

- 用 **Trace** 抽象一次完整的 `/api/agent/chat` 调用
- 用 **Span** 抽象 Trace 内的每个可观测子环节
- 通过 Span 的 `parent_span_id` 表达调用嵌套关系，通过 `span_id` 单调递增表达时序关系
- 采用 **内存缓冲 + 异步批量落盘** 到 MySQL 独立表 `ai_span`
- 暴露 **HTTP 查询 API** 供后续可视化或人工排障使用

本期不做前端可视化瀑布图，仅完成后端数据模型 / 埋点 / 采集 / 存储 / 查询 API 五件事。

### 1.3 核心原则

1. **业务永不阻塞 tracing**：埋点、缓冲、落盘任何一环出问题都不影响 `/api/agent/chat` 的正常返回
2. **不冗余存储**：`system_prompt` 只存 hash，tool 大结果只存 size + preview
3. **敏感字段自动打码**：`api_key` / `token` / `password` / `secret` / `authorization` 等 key 的 value 一律替换为 `***`
4. **架构对齐 DDD 分层**：追踪相关的业务模型进 domain 层、落盘走 Repository、Application 层负责协调

### 1.4 非目标（本期不做）

- 前端可视化瀑布图 / 甘特图
- 完整 OpenTelemetry 协议兼容（后续可迁移）
- 采样策略（本期 100% 采集）
- 分区表 / 归档（生产量超过阈值后再迭代）
- LLM token 用量硬性上报（SDK 顺手返回时才记）
- PlanAgent / A2AAgent 的埋点覆盖（本期只覆盖 `/api/agent/chat` 主链路）
- 错误向父级 span 冒泡（本期只标红当事人 span）

---

## 二、架构设计

### 2.1 整体架构图

```
                              /api/agent/chat
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │   Handler (agent.go)  │
                        └───────────┬───────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  Application.Chat                                    │
        │  ① tracing.StartRootSpan(ctx, messageId, ...)        │
        │     → 生成 rootSpan（trace_id=messageId, span_id=0）  │
        │     → 注入 ctx                                       │
        │  ② defer root.End()                                  │
        └────────────────────────┬─────────────────────────────┘
                                 │ ctx（携 rootSpan）
                                 ▼
        ┌──────────────────────────────────────────────────────┐
        │  BaseAgent.StreamingInvoke                           │
        │  循环 N 轮迭代：                                      │
        │    roundSpan = tracing.StartSpanFromContext(...)     │
        │      ├─ llmSpan   = StartSpanFromContext(LLM_CALL)   │
        │      │   StreamingInvokeLLM(...) → llmSpan.End()     │
        │      └─ batchSpan = StartSpanFromContext(TOOL_BATCH) │
        │            InvokeToolCalls:                          │
        │              toolSpan_1 = StartSpanFromContext(...)  │
        │              toolSpan_2 = StartSpanFromContext(...)  │
        └──────────────────────────────────────────────────────┘

                     ┌────────────────────┐
                     │  内存缓冲队列      │  ← span.End() 提交
                     │  chan cap=10000    │
                     └─────────┬──────────┘
                               │
                               ▼
                   ┌────────────────────────┐
                   │  BatchProcessor        │
                   │  goroutine             │
                   │  batch=100 or 5s tick  │
                   └───────────┬────────────┘
                               │
                               ▼
                   ┌────────────────────────┐
                   │  ai_span_repository    │
                   │  (batch INSERT)        │
                   └───────────┬────────────┘
                               │
                               ▼
                          MySQL ai_span
                               │
                               ▼
                   ┌────────────────────────┐
                   │  查询 API              │
                   │  GET /api/trace/:id    │
                   │  GET /api/traces?...   │
                   └────────────────────────┘
```

### 2.2 分层落位

严格遵循 `.harness/rules/40-ddd-layering.md` 四层架构：

| 层级 | 新增文件 | 职责 |
|------|---------|------|
| Handler | `api/handlers/trace.go` | 参数绑定、Application 调用、序列化 |
| Application | `internal/applications/services/trace.go` | 查询协调、DTO 组装、扁平→树转换调用 |
| Domain / Model | `internal/domains/models/tracing/` | Span/Tracer/SpanNode 值对象、BuildSpanTree 算法、SpanRepository 接口 |
| Repository | `internal/infra/repositories/ai_span_repository.go` | SpanRepository 实现（批量 INSERT / 查询） |

Domain 层的 `tracing` 与现有 `memory` / `events` / `invoker` / `interrupt` / `prompts` 平级，符合项目一致的模型组织方式。

### 2.3 Tracer 生命周期

- **初始化**：`api/routers/route.go` 的 `InitRouter` 中，按 Repository → Tracer → Application → Handler 顺序初始化，Tracer 通过 `tracing.SetGlobal(tracer)` 设置为**包级单例**
- **访问方式**：Domain 层通过 `tracing.StartSpanFromContext(ctx, spanType, opName)` 包级函数使用单例，避免函数签名侵入
- **优雅退出**：gin server graceful shutdown 时调用 `tracer.Shutdown(ctx)`，flush 剩余 span 后关闭 goroutine

---

## 三、数据模型

### 3.1 Span 值对象（Domain 内存表示）

**位置**：`internal/domains/models/tracing/span.go`

```go
package tracing

type SpanType string

const (
    SpanTypeAgentRoot    SpanType = "AGENT_ROOT"
    SpanTypeAgentRound   SpanType = "AGENT_ROUND"
    SpanTypeLLMCall      SpanType = "LLM_CALL"
    SpanTypeToolBatch    SpanType = "TOOL_BATCH"
    SpanTypeToolCall     SpanType = "TOOL_CALL"
    SpanTypeSubagentCall SpanType = "SUBAGENT_CALL"
)

type LogEntry struct {
    Ts    int64                  `json:"ts"`    // 纳秒时间戳
    Level string                 `json:"level"` // INFO / WARN / ERROR
    Msg   string                 `json:"msg"`   // 里程碑事件名
    Extra map[string]interface{} `json:"extra,omitempty"`
}

type Span struct {
    TraceID        string
    SpanID         int32
    ParentSpanID   int32
    SpanType       SpanType
    OperationName  string
    ConversationID string
    AgentName      string
    StartTime      int64 // 纳秒
    EndTime        int64 // 纳秒
    LatencyMs      int32
    IsError        bool

    tags   map[string]interface{}
    logs   []LogEntry
    mu     sync.Mutex
    ended  atomic.Bool
    tracer *Tracer
}

func (s *Span) SetTag(key string, val interface{})
func (s *Span) AddLog(level, msg string, extra map[string]interface{})
func (s *Span) SetError(err error)
func (s *Span) End()
```

**关键规则**：

- `tags` 私有，`SetTag` 内做**敏感字段打码**（key 匹配正则 `(?i)(api_?key|token|password|secret|authorization)` → value 覆盖为 `***`）
- `SetTag` 对 string value 做长度截断：`user.query` 1KB / `tool.arguments` 2KB / `tool.result_preview` 512B
- `End()` 幂等（`ended.CompareAndSwap(false, true)` 保护，多次调用只生效一次）
- 并发安全：`SetTag` / `AddLog` 走 `s.mu`；父子 span 归属不同 goroutine 时各自持有各自 Span

### 3.2 SpanNode（查询响应专用 DO）

**位置**：`internal/domains/models/tracing/tree.go`

```go
// SpanNode 专用于 GET /api/trace/:trace_id 返回的树状结构
// 与运行时 Span 解耦：不含锁、tracer 反向引用等运行时字段
type SpanNode struct {
    SpanID        int32                  `json:"span_id"`
    ParentSpanID  int32                  `json:"parent_span_id"`
    SpanType      string                 `json:"span_type"`
    OperationName string                 `json:"operation_name"`
    StartTime     int64                  `json:"start_time"`
    EndTime       int64                  `json:"end_time"`
    LatencyMs     int32                  `json:"latency_ms"`
    IsError       bool                   `json:"is_error"`
    Tags          map[string]interface{} `json:"tags"`
    Logs          []LogEntry             `json:"logs"`
    Children      []*SpanNode            `json:"children"`
}
```

**为什么与 Span 分开**：
- Span 是内存实时对象（含并发锁、Tracer 反向引用、ended 标志），不适合直接序列化
- SpanNode 是查询响应 DO，独立演进不影响运行时结构
- 转换发生在 Application Service：`Span/PO → SpanNode`

### 3.3 Tracer 服务

**位置**：`internal/domains/models/tracing/tracer.go`

```go
type Tracer struct {
    repo          SpanRepository
    buffer        chan *Span             // cap 默认 10000
    batchSize     int                    // 默认 100
    flushInterval time.Duration          // 默认 5s
    dropCounter   atomic.Int64           // 缓冲区满时的丢弃计数
    shutdown      chan struct{}
    wg            sync.WaitGroup

    // 每个 trace 独立的 span_id 生成器
    traceCounters sync.Map               // traceID -> *atomic.Int32
}

func NewTracer(repo SpanRepository, opts ...Option) *Tracer

// 由 Application 层入口调用一次，返回携带 rootSpan 的 ctx
func (t *Tracer) StartRootSpan(ctx context.Context, traceID string) (context.Context, *Span)

// Domain 层内部使用，从 ctx 取 parent，创建子 span
func (t *Tracer) StartSpan(ctx context.Context, spanType SpanType, opName string) (context.Context, *Span)

// 优雅退出：flush 剩余 span
func (t *Tracer) Shutdown(ctx context.Context) error

// Span.End() 内部调用；缓冲区满时 drop + 计数，永不阻塞
func (t *Tracer) commit(s *Span)
```

**包级单例便利函数**：

```go
var globalTracer atomic.Pointer[Tracer]

func SetGlobal(t *Tracer)
func Global() *Tracer

// Domain 层埋点使用
func StartSpanFromContext(ctx context.Context, spanType SpanType, opName string) (context.Context, *Span)
```

**关键规则**：

- ctx 存 parent span 用私有 key：`type ctxKey struct{}`，避免与其他 middleware 冲突
- `StartSpan` 内部：从 ctx 取 parent → 复用 parent 的 `TraceID` → 从 `traceCounters[TraceID]` 原子递增取新 `SpanID`
- **traceCounters 清理**：root span End 时把对应 counter 从 map 删除，防止内存泄漏
- **无 parent 时**（异常路径）：返回 no-op Span（所有方法空实现），业务不 panic
- **未初始化 tracer**（`SetGlobal` 未调用）：`StartSpanFromContext` 返回 no-op Span

### 3.4 SpanRepository 接口

**位置**：`internal/domains/models/tracing/repository.go`

```go
type SpanRepository interface {
    BatchInsert(ctx context.Context, spans []*Span) error
    FindByTraceID(ctx context.Context, traceID string) ([]*SpanNode, error)
    ListTraces(ctx context.Context, filter TraceFilter, page, pageSize int) ([]*TraceSummary, int64, error)
}

type TraceFilter struct {
    ConversationID string
    AgentName      string
    IsError        *bool
    StartTimeFrom  int64
    StartTimeTo    int64
}

type TraceSummary struct {
    TraceID          string
    ConversationID   string
    AgentName        string
    StartTime        int64
    DurationMs       int32
    SpanCount        int32
    IsError          bool // 该 trace 内任意 span.is_error=true
    UserQueryPreview string
}
```

### 3.5 Repository 实现

**位置**：`internal/infra/repositories/ai_span_repository.go`

参考 `.harness/rules/40-ddd-layering.md` 三态转换规范（DO ↔ PO）：

```go
type AiSpanPO struct {
    ID             uint64    `gorm:"primaryKey"`
    TraceID        string    `gorm:"column:trace_id;index"`
    SpanID         int32     `gorm:"column:span_id"`
    ParentSpanID   int32     `gorm:"column:parent_span_id"`
    SpanType       string    `gorm:"column:span_type"`
    OperationName  string    `gorm:"column:operation_name"`
    ConversationID string    `gorm:"column:conversation_id;index"`
    AgentName      string    `gorm:"column:agent_name"`
    StartTime      int64     `gorm:"column:start_time"`
    EndTime        int64     `gorm:"column:end_time"`
    LatencyMs      int32     `gorm:"column:latency_ms"`
    IsError        bool      `gorm:"column:is_error"`
    Tags           string    `gorm:"column:tags;type:json"`
    Logs           string    `gorm:"column:logs;type:json"`
    CreatedAt      time.Time `gorm:"column:created_at"`
}

func (r *aiSpanRepository) BatchInsert(ctx context.Context, spans []*tracing.Span) error {
    pos := make([]*AiSpanPO, 0, len(spans))
    for _, s := range spans {
        pos = append(pos, spanToPO(s))
    }
    return r.db.WithContext(ctx).CreateInBatches(pos, 100).Error
}
```

### 3.6 建表 DDL

```sql
CREATE TABLE ai_span (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  trace_id        VARCHAR(64)  NOT NULL COMMENT '链路 ID = messageId',
  span_id         INT          NOT NULL COMMENT 'trace 内自增，root=0',
  parent_span_id  INT          NOT NULL COMMENT 'root=-1',
  span_type       VARCHAR(32)  NOT NULL COMMENT 'AGENT_ROOT/AGENT_ROUND/LLM_CALL/TOOL_BATCH/TOOL_CALL/SUBAGENT_CALL',
  operation_name  VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'tool 名（其他类型为空）',
  conversation_id VARCHAR(64)  NOT NULL DEFAULT '',
  agent_name      VARCHAR(64)  NOT NULL DEFAULT '',
  start_time      BIGINT       NOT NULL COMMENT '纳秒时间戳',
  end_time        BIGINT       NOT NULL DEFAULT 0,
  latency_ms      INT          NOT NULL DEFAULT 0,
  is_error        TINYINT(1)   NOT NULL DEFAULT 0,
  tags            JSON         COMMENT '扩展 kv',
  logs            JSON         COMMENT '过程日志 [{ts, level, msg, extra}]',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_trace_span (trace_id, span_id),
  KEY idx_trace (trace_id),
  KEY idx_conv (conversation_id, created_at),
  KEY idx_error (is_error, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='智能体链路 span';
```

**说明**：
- `tags` / `logs` 用 MySQL 5.7+ `JSON` 类型；若目标环境低于 5.7 需降级为 `LONGTEXT`
- `uk_trace_span` 联合唯一：防重复；同时天然覆盖"按 trace_id 查全链路"
- 生产量估算：100 QPS × 26 span × 1KB ≈ 220GB/天。**本期不做分区，遗留归档策略到后续迭代**

---

## 四、埋点位置与调用序列

### 4.1 埋点点位清单

| 位置 | 埋点动作 | Span 类型 |
|------|---------|-----------|
| `applications/services/agent.go` `Chat()` 进入时 | `ctx, root := tracer.StartRootSpan(ctx, messageId)` + `defer root.End()` | `AGENT_ROOT` |
| `domains/services/agents/base.go` `StreamingInvoke` 循环内每轮迭代开始 | `ctx, round := tracing.StartSpanFromContext(ctx, AGENT_ROUND, "")` + `defer round.End()` | `AGENT_ROUND` |
| `base.go` `StreamingInvokeLLM` 调用前 | `ctx, llm := tracing.StartSpanFromContext(ctx, LLM_CALL, "")` + `defer llm.End()` | `LLM_CALL` |
| `base.go` `InvokeToolCalls` 进入时 | `ctx, batch := tracing.StartSpanFromContext(ctx, TOOL_BATCH, "")` + `defer batch.End()` | `TOOL_BATCH` |
| `base.go` `InvokeToolCalls` 内每次进入 tool 执行分支 | `ctx, ts := tracing.StartSpanFromContext(ctx, TOOL_CALL, funcName)` + `defer ts.End()` | `TOOL_CALL` |
| 同上，但工具为子智能体（`SubagentTool`）时 | `SpanType` 替换为 `SUBAGENT_CALL` | `SUBAGENT_CALL` |

**注意**：本期 `Invoke`（非流式）也需要同步覆盖（对应逻辑一致，位置在同一文件），但主链路测试聚焦 `StreamingInvoke`。

### 4.2 调用序列示例

```
时刻  ctx-Stack                              Span 事件
────  ─────────────────────────────────────  ────────────────────────────────
t0    []                                     Chat() 收到请求
t1    [root]                                 StartRootSpan → span_id=0, parent=-1
t2    [root, round#1]                          StartSpan(ROUND) → span_id=1
t3    [root, round#1, llm#1]                    StartSpan(LLM) → span_id=2
t4    [root, round#1, llm#1]                    LLM 首 token → AddLog
t5    [root, round#1]                            llm#1.End() → span_id=2 提交
t6    [root, round#1, batch#1]                 StartSpan(TOOL_BATCH) → span_id=3
t7    [root, round#1, batch#1, tool#1]           StartSpan(TOOL_CALL, "fileRead") → span_id=4
t8    [root, round#1, batch#1]                   tool#1.End() → span_id=4 提交
t9    [root, round#1, batch#1, tool#2]           StartSpan(TOOL_CALL, "bashExec") → span_id=5
t10   [root, round#1, batch#1]                   tool#2.End() → span_id=5 提交
t11   [root, round#1]                            batch#1.End() → span_id=3 提交
t12   [root]                                   round#1.End() → span_id=1 提交
t13   [root, round#2]                          StartSpan(ROUND) → span_id=6
...
tN    []                                     root.End() → span_id=0 提交
```

**关键点**：
- span_id **创建顺序**单调递增，但**提交顺序**是叶子先 root 后（叶子先 End）
- 查询时按 `ORDER BY span_id ASC` 排序即恢复创建顺序
- `defer root.End()` 保证 panic / context cancel / max iterations 都能收尾

### 4.3 tags/logs 采集清单

#### AGENT_ROOT

**独立列**：`ConversationID`、`AgentName`
**Tags**：
- `agent.name`
- `agent.max_iterations`
- `agent.model`
- `agent.tools_count`
- `user.query`（截断到 1KB，敏感字段打码）
- `system_prompt.hash`（sha256，前 16 字符）

**Logs**（里程碑）：
- `agent.context_cancelled`（ctx 被 cancel 时）
- `agent.max_iterations_exceeded`（超过阈值时，同时 `SetError`）

#### AGENT_ROUND

**Tags**：
- `round.index`（从 1 开始）
- `round.messages_count`（进入本轮时 memory 消息数）

**Logs**：
- `round.iteration_start`
- `round.finish_reason`（无 tool_calls / 继续下一轮 / cancelled）

#### LLM_CALL

**Tags**：
- `llm.model`
- `llm.messages_count`
- `llm.tools_count`（可用工具数）
- `llm.finish_reason`（stop / tool_calls / length）
- `llm.tool_calls_count`（本次返回的 tool_calls 数）
- `llm.prompt_tokens` / `llm.completion_tokens`（若 SDK 返回；不硬性要求）

**Logs**：
- `llm.request.sent`（Start 时）
- `llm.stream.first_token`
- `llm.stream.completed`
- `llm.error`（异常时 `SetError`）

#### TOOL_BATCH

**Tags**：
- `batch.tool_calls_count`
- `batch.parallel`（bool；目前实现为串行，则记 false，后续改并行时字段沿用）
- `batch.success_count`
- `batch.fail_count`

#### TOOL_CALL / SUBAGENT_CALL

**Tags**（TOOL_CALL）：
- `tool.name`（同 operation_name）
- `tool.type`（skill / mcp / a2a / native）
- `tool.tool_call_id`（LLM 返回的 tool_call_id）
- `tool.arguments`（截断到 2KB，敏感字段打码）
- `tool.result_size`（bytes，全量结果大小）
- `tool.result_preview`（截断到 512B，敏感字段打码）
- `tool.circuit_breaker.trigger`（bool，是否本次触发熔断）
- `tool.retry_count`
- `tool.hitl.required`（bool）
- `tool.hitl.decision`（approve / reject / timeout / cancel）

**Tags 附加**（SUBAGENT_CALL）：
- `subagent.name`
- `subagent.iterations`（子智能体实际迭代轮次）

**Logs**：
- `tool.invoke.start`
- `tool.retry`
- `tool.circuit_breaker.open`
- `tool.hitl.requested`
- `tool.hitl.decided`
- `tool.error`（`SetError`）

### 4.4 侵入性控制

- Tracer 用**包级单例**（`tracing.Global()`），Domain 层无需修改函数签名
- ctx 传递父子关系，`base.go` 现有函数已经收 ctx，天然兼容
- 埋点是"包围式" defer 结构，不改变主逻辑控制流
- 敏感字段打码在 `SetTag` 内部完成，业务代码零感知

---

## 五、错误处理与降级

### 5.1 埋点侧铁律：业务永不阻塞

| 场景 | 处理 |
|------|------|
| `StartSpan` 时 ctx 里没有 parent | 返回 no-op Span（所有方法空实现），不 panic |
| `SetTag` / `AddLog` 参数非法（如 nil map） | 静默忽略 + zap.Warn（限流） |
| 缓冲区满 | `dropCounter++` + zap.Warn（每分钟至多一次） |
| BatchProcessor 落盘 SQL 失败 | zap.Error 记录、**丢弃该批**，不重试；错误计数可暴露 metric |
| Tracer 未初始化 | `StartSpanFromContext` 返回 no-op Span |
| `Span.End()` 多次调用 | 幂等，第二次开始直接 return |
| panic 发生在 span 未 End 之前 | Application 层 `defer root.End()` 兜底；建议在 Recovery middleware 里追加 `root.SetError(recovered)` |

### 5.2 `is_error` 判定规则（不冒泡）

- 仅当**当前 span 内部**捕获到 error 时才标 `is_error=true`
- **不向父级冒泡**：某 tool 失败只标该 `TOOL_CALL`，`TOOL_BATCH` / `AGENT_ROUND` / `AGENT_ROOT` 都保持 `is_error=false`
- 顶层"这条 trace 是否有异常"由查询侧聚合：`SELECT SUM(is_error) FROM ai_span WHERE trace_id = ?`
- 前端可基于该聚合值展示"红色 trace"标记

### 5.3 查询侧错误响应

- `GET /api/trace/:trace_id` 无数据 → `404 {"code": "TRACE_NOT_FOUND"}`
- 参数不合法 → `400 {"code": "INVALID_PARAM", "message": "..."}`
- DB 查询失败 → `500 {"code": "INTERNAL_ERROR"}`（不暴露内部详情）
- `BuildSpanTree` 返回 `ErrNoRoot` / `ErrMultipleRoots` → `500 {"code": "TRACE_CORRUPTED", "trace_id": "..."}`

---

## 六、查询 API 契约

### 6.1 GET /api/trace/:trace_id

返回该 trace 完整链路，**嵌套树结构**。

**响应示例**：

```json
{
  "trace_id": "msg-abc-123",
  "conversation_id": "conv-xyz",
  "agent_name": "manus-react",
  "start_time": 1734100000000000000,
  "end_time": 1734100015234000000,
  "duration_ms": 15234,
  "is_error": false,
  "span_count": 12,
  "root": {
    "span_id": 0,
    "parent_span_id": -1,
    "span_type": "AGENT_ROOT",
    "operation_name": "",
    "start_time": 1734100000000000000,
    "end_time": 1734100015234000000,
    "latency_ms": 15234,
    "is_error": false,
    "tags": { "agent.name": "manus-react", "user.query": "帮我..." },
    "logs": [],
    "children": [
      {
        "span_id": 1,
        "parent_span_id": 0,
        "span_type": "AGENT_ROUND",
        "children": [
          { "span_id": 2, "parent_span_id": 1, "span_type": "LLM_CALL", "children": [] },
          {
            "span_id": 3,
            "parent_span_id": 1,
            "span_type": "TOOL_BATCH",
            "children": [
              { "span_id": 4, "parent_span_id": 3, "span_type": "TOOL_CALL", "children": [] },
              { "span_id": 5, "parent_span_id": 3, "span_type": "TOOL_CALL", "children": [] }
            ]
          }
        ]
      }
    ]
  }
}
```

- `root` 单节点入口，每层 `children` 按 `span_id ASC` 排序
- 顶层元信息（`conversation_id` / `agent_name` / `duration_ms` / `is_error` / `span_count`）由 Application Service 从 root span + 全表聚合派生

### 6.2 扁平 → 树的构建算法

**位置**：`internal/domains/models/tracing/tree.go`

```go
var (
    ErrEmptyTrace     = errors.New("empty trace")
    ErrNoRoot         = errors.New("no root span")
    ErrMultipleRoots  = errors.New("multiple root spans")
)

// BuildSpanTree 把从 DB 查出的扁平 SpanNode 数组还原成树
// 前置：nodes 已按 span_id ASC 排序
func BuildSpanTree(nodes []*SpanNode) (*SpanNode, error) {
    if len(nodes) == 0 {
        return nil, ErrEmptyTrace
    }

    idx := make(map[int32]*SpanNode, len(nodes))
    for _, n := range nodes {
        n.Children = make([]*SpanNode, 0)
        idx[n.SpanID] = n
    }

    var root *SpanNode
    var orphans []*SpanNode
    for _, n := range nodes {
        if n.ParentSpanID == -1 {
            if root != nil {
                return nil, ErrMultipleRoots
            }
            root = n
            continue
        }
        parent, ok := idx[n.ParentSpanID]
        if !ok {
            // 孤儿节点：parent 落盘丢失或数据损坏
            if n.Tags == nil {
                n.Tags = make(map[string]interface{})
            }
            n.Tags["_orphan"] = true
            n.Tags["_original_parent"] = n.ParentSpanID
            orphans = append(orphans, n)
            continue
        }
        parent.Children = append(parent.Children, n)
    }

    if root == nil {
        return nil, ErrNoRoot
    }
    for _, o := range orphans {
        root.Children = append(root.Children, o)
    }
    return root, nil
}
```

**关键点**：
- 两遍扫描 + map 索引，O(N) 时间 / O(N) 空间
- 孤儿节点降级到 root 下 + `_orphan=true` 标记，避免"tracing 有洞时数据不可见"
- `children` 无需额外排序：输入已 `span_id ASC`，append 顺序即升序

### 6.3 GET /api/traces

分页列表，供后续可视化/排障使用。

**查询参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | string | 可选 |
| `agent_name` | string | 可选 |
| `is_error` | bool | 可选，只看错误 trace |
| `start_time_from` / `start_time_to` | int64（纳秒） | 可选 |
| `page` | int | 默认 1 |
| `page_size` | int | 默认 20，最大 100 |

**响应示例**：

```json
{
  "total": 1234,
  "page": 1,
  "page_size": 20,
  "traces": [
    {
      "trace_id": "msg-abc-123",
      "conversation_id": "conv-xyz",
      "agent_name": "manus-react",
      "start_time": 1734100000000000000,
      "duration_ms": 15234,
      "span_count": 12,
      "is_error": false,
      "user_query_preview": "帮我查一下..."
    }
  ]
}
```

- 每行只返回 root span 摘要 + 全 trace 聚合信息
- 底层 SQL 从 `WHERE parent_span_id = -1` 的 root 行出发，配合 group-by 或子查询获取聚合

---

## 七、性能与容量估算

### 7.1 典型对话 span 数量

一次 5 轮 ReAct、每轮 2 个 tool 的 chat：

```
1 AGENT_ROOT
+ 5 AGENT_ROUND
+ 5 LLM_CALL
+ 5 TOOL_BATCH
+ 10 TOOL_CALL
= 26 span / 次
```

### 7.2 单 span 大小

平均 ~1KB（tags/logs JSON 序列化后）。

### 7.3 吞吐估算

- 峰值 100 QPS chat → 2600 span/s 生成
- 落盘：batch=100 → 26 batch/s，MySQL 批量 INSERT 完全可扛
- 缓冲区 10000 容量 → 可吸收 ~3.8 秒峰值抖动

### 7.4 存储估算

- 峰值 100 QPS × 86400 = 864 万 chat/天
- span 数：864 万 × 26 ≈ 2.2 亿/天
- 存储量：~220GB/天

**遗留项**：生产日均实际量在超过阈值时需要引入分区表 / 定时归档，本期不实现。

### 7.5 Tracing 自身开销

- SetTag / AddLog：O(1) map 写入 + 敏感字段正则匹配（编译一次的 `sync.Once` 保护）
- Span.End：一次 channel 非阻塞发送 + 计算 latency
- 埋点整体 CPU 开销预计 < 1%（无 profiling 数据前的经验估算）

---

## 八、测试策略

### 8.1 测试层次

| 层级 | 测试类型 | 覆盖内容 |
|------|---------|---------|
| Domain 单元 | `tracing/*_test.go` | Span/Tracer/BuildSpanTree |
| Application 集成 | `agent_tracing_integration_test.go` | 完整 Chat 流程 span 结构 |
| E2E | HTTP + DB 双验证 | 真实发 `/api/agent/chat` 验证落盘和查询 API |

### 8.2 Domain 单元测试用例

**`tracer_test.go`**：

1. `TestSpan_LifecycleBasic`：创建 → SetTag → AddLog → End，断言 LatencyMs > 0 及内容
2. `TestSpan_EndIdempotent`：End 调两次，第二次不重复提交
3. `TestSpan_ConcurrentSetTag`：10 goroutine 并发，`go test -race` 无 race
4. `TestSpan_SensitiveTagMasking`：`api_key` / `authorization` value 被替换为 `***`
5. `TestSpan_LongValueTruncation`：`user.query` 超 1KB 被截断
6. `TestSpan_SetError`：IsError=true + logs 追加 ERROR 级 entry
7. `TestTracer_StartRootSpan`：ctx 含 rootSpan、TraceID / SpanID=0 / ParentSpanID=-1
8. `TestTracer_StartSpan_FromContext`：连续 StartSpan，span_id 单调递增、parent 正确
9. `TestTracer_StartSpan_NoParent`：ctx 无 parent → no-op Span
10. `TestTracer_BufferFullDrop`：容量 5 提交 10 → dropCounter ≥ 5、无阻塞
11. `TestTracer_BatchFlushBySize`：batch=3 提交 3 → BatchInsert 调一次
12. `TestTracer_BatchFlushByTimer`：batch=100 提 2 个等 5.5s → BatchInsert 调一次
13. `TestTracer_Shutdown`：Shutdown 前提 10 → 全部 flush、无 goroutine 泄漏
14. `TestTracer_ConcurrentSpanIDGen`：并发 100 span → span_id 唯一且落 [1,100]

**`tree_test.go`**：

15. `TestBuildSpanTree_HappyPath`：12 span 三级嵌套构建成功
16. `TestBuildSpanTree_EmptyInput`：返回 ErrEmptyTrace
17. `TestBuildSpanTree_NoRoot`：返回 ErrNoRoot
18. `TestBuildSpanTree_MultipleRoots`：返回 ErrMultipleRoots
19. `TestBuildSpanTree_OrphanNode`：孤儿挂到 root + `_orphan=true`

### 8.3 Application 集成测试

**位置**：`internal/applications/services/agent_tracing_integration_test.go`

**Mock 策略**（参考 `agent_hitl_integration_test.go`）：
- Mock LLM Invoker（预设 tool_calls 序列）
- Mock Tool Invoker（预设结果）
- **Real Tracer + In-memory SpanRepository**：真实跑 tracer

**用例**：

1. `TestChat_HappyPath_SpanStructure`：1 轮 LLM → 2 tool → 1 轮结束
   - 断言 span 数 = 1 root + 2 round + 2 llm + 1 batch + 2 tool = 8
   - 断言父子关系与创建顺序
   - 断言 tags 采集齐全、`ConversationID` / `AgentName` 独立列填充

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
   - span_type=`SUBAGENT_CALL` + `subagent.name` tag 存在

### 8.4 Repository 测试

**位置**：`internal/infra/repositories/ai_span_repository_test.go`（有 testcontainers 或本地 MySQL 时启用）

- `TestBatchInsert`：批量插 100 条 → SELECT 回验
- `TestFindByTraceID`：按 trace_id 查回，断言 `span_id ASC`

### 8.5 Handler 单元测试

**位置**：`api/handlers/trace_test.go`

- `TestGetTraceDetail_200`：返回嵌套树
- `TestGetTraceDetail_404`：trace_id 不存在
- `TestListTraces_Pagination`：分页参数

### 8.6 测试原则

- `go test -race` 必开
- Tracer 单测用 `batch=3` / `flushInterval=100ms` 避免等 5 秒
- goroutine 泄漏用 `goleak` 或手动 goroutine 数比对
- 不 mock Tracer 自身，只 mock SpanRepository

### 8.7 覆盖率目标

- Domain（`tracing` 包）：行覆盖 ≥ 85%（`BuildSpanTree` 全分支）
- Application 层新增：关键路径 100%
- 不追求 100% 总覆盖

---

## 九、E2E 验证要点（详细步骤见配套 plan 文档）

- 启动服务 → 发一次典型 `/api/agent/chat`（Streaming） → 观察 DB `ai_span` 表数据
- 断言 26 条左右的 span 全落盘、结构正确、`is_error` 分布合理
- 调用 `GET /api/trace/:messageId` 验证嵌套树响应
- 触发工具错误场景 → 验证叶子 span 标红、父 span 不冒泡
- 触发 HITL 场景 → 验证 tool span tags 里的审批状态
- 触发子智能体调用 → 验证 SUBAGENT_CALL 类型 span

---

## 十、约束与遗留

### 10.1 遵循的护栏

- **DDD 分层**（`.harness/rules/40-ddd-layering.md`）：新增文件按四层各就各位
- **敏感信息处理**（`.harness/rules/32-secrets-handling.md`）：自动打码
- **子模块协作纪律**（`.harness/rules/10-submodule-discipline.md`）：本期仅涉及 mooc-manus 子仓，不动 mooc-manus-web
- **Go 编码规范**（`.harness/rules/41-go-conventions.md`）：错误处理、日志、命名、测试

### 10.2 遗留项

1. **分区 / 归档**：生产量超过阈值后引入
2. **前端可视化**：下一期迭代
3. **OpenTelemetry 协议对齐**：本期数据模型接近但未严格对齐
4. **Plan / A2A Agent 埋点**：仅覆盖 `/api/agent/chat`
5. **采样策略**：本期 100% 采集，未来接大流量时考虑

### 10.3 与既有事件系统的关系

现有 `events.AgentEvent`（SSE 推送前端）与本期 tracing 是**互补关系**：
- `AgentEvent` 面向**前端实时消费**（in-flight 状态推送）
- `Span` 面向**事后追溯**（落盘后按 trace_id 全量查询）
- 两者可以共享一些"事件时刻"的埋点点位，但数据流独立、不改事件系统

---

## 十一、验收标准

设计文档验收通过条件：

- [x] 覆盖 6 类 span 定义与父子关系
- [x] 明确埋点位置与调用序列
- [x] 明确 tags/logs 采集清单
- [x] 明确异步落盘策略与 tracing 自身开销边界
- [x] 明确查询 API 契约（含嵌套树 + 扁平→树算法）
- [x] 明确错误处理与降级
- [x] 明确测试策略与覆盖率目标
- [x] 明确遗留项与后续迭代方向

实施验收标准见配套 plan 文档。

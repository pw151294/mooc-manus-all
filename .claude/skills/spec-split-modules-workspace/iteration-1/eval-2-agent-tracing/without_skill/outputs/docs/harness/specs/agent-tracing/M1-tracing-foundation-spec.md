# M1 数据模型与 Tracer 基础设施设计文档

**日期**：2026-07-17
**父 spec**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块状态**：设计评审中
**关联仓库**：mooc-manus

---

## 一、模块目标

搭建 Agent Tracing 的最底层基础设施，为其他模块提供 Span 值对象、Tracer 单例、SpanRepository 接口与底层数据表。本模块**只搭骨架**：不包含埋点（M2）、不包含批量落盘（M3）、不包含查询 API（M4），但暴露的接口能让所有后续模块顺畅接入。

### 1.1 交付范围（in-scope）

1. `internal/domains/models/tracing/span.go`：Span 值对象、SpanType 枚举、LogEntry、ctxKey 定义
2. `internal/domains/models/tracing/tracer.go`：Tracer 结构体骨架（StartRootSpan / StartSpan / commit / Shutdown 空实现或最小实现）
3. `internal/domains/models/tracing/context.go`：ctx 私有 key + SpanFromContext / StartSpanFromContext / SetGlobal / Global 包级函数
4. `internal/domains/models/tracing/repository.go`：SpanRepository 接口 + TraceFilter / TraceSummary DTO
5. `internal/infra/repositories/ai_span_repository.go`：Repository 骨架（BatchInsert / FindByTraceID / ListTraces 方法签名，可先空实现）
6. `internal/infra/repositories/ai_span_po.go`：AiSpanPO GORM 结构体 + spanToPO / poToNode 转换函数
7. MySQL `ai_span` 表 DDL（migration 脚本）
8. Domain 层单元测试：Span 生命周期 / 敏感字段打码 / 长值截断 / SetError / SpanID 并发生成

### 1.2 非目标（本模块不做）

- 埋点调用（AGENT_ROOT / ROUND / LLM / TOOL 等）→ 见 M2
- 缓冲队列消费与批量 INSERT 的实际逻辑 → 见 M3（本模块只留 chan 声明和 commit 入口）
- 查询 API Handler → 见 M4
- 打码规则的运行时接线到全局配置 → 见 M5

---

## 二、依赖关系

- **本模块无前置依赖**，是所有其他模块的基础
- 后续模块的接入方式：
  - M2 通过 `tracing.StartSpanFromContext(ctx, ...)` 获取 Span
  - M3 通过 `Tracer.commit(*Span)` 接入缓冲队列
  - M4 通过 `SpanRepository` 接口查询落盘数据

---

## 三、数据模型

### 3.1 Span 值对象

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

// 公开方法（其他模块使用）
func (s *Span) SetTag(key string, val interface{})
func (s *Span) AddLog(level, msg string, extra map[string]interface{})
func (s *Span) SetError(err error)
func (s *Span) SetAgentName(name string)  // 独立列专用 setter
func (s *Span) End()
```

### 3.2 关键规则

- **敏感字段打码**（M1 内首次实现，M5 会扩展 hook 点）：
  - `SetTag` 内正则匹配 `(?i)(api_?key|token|password|secret|authorization)` → value 覆盖为 `***`
  - 正则用 `sync.Once` 编译一次
- **长值截断**：`user.query` 1KB / `tool.arguments` 2KB / `tool.result_preview` 512B
- **幂等 End**：`ended.CompareAndSwap(false, true)` 保护，第二次调用 return
- **并发安全**：`SetTag` / `AddLog` 走 `s.mu`
- **no-op Span**：私有构造 `newNoopSpan()`，所有方法空实现，ctx 无 span / Tracer 未初始化时返回

### 3.3 SpanNode（查询响应专用 DO）

**位置**：`internal/domains/models/tracing/tree.go`（本模块只定义类型，构建算法留给 M4）

```go
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

### 3.4 Tracer 结构

**位置**：`internal/domains/models/tracing/tracer.go`

```go
type Tracer struct {
    repo          SpanRepository
    buffer        chan *Span      // cap 默认 10000
    batchSize     int             // 默认 100
    flushInterval time.Duration   // 默认 5s
    dropCounter   atomic.Int64
    shutdown      chan struct{}
    wg            sync.WaitGroup
    traceCounters sync.Map        // traceID -> *atomic.Int32
}

type Option func(*Tracer)
func WithBufferSize(n int) Option
func WithBatchSize(n int) Option
func WithFlushInterval(d time.Duration) Option

func NewTracer(repo SpanRepository, opts ...Option) *Tracer

func (t *Tracer) StartRootSpan(ctx context.Context, traceID string) (context.Context, *Span)
func (t *Tracer) StartSpan(ctx context.Context, spanType SpanType, opName string) (context.Context, *Span)
func (t *Tracer) Shutdown(ctx context.Context) error
func (t *Tracer) commit(s *Span)  // Span.End() 内部调用；本模块内为空实现或直接丢弃
```

**M1 交付边界**：`commit` 本期可先做「直接丢弃 + 计数」的桩实现，M3 补齐真正的缓冲消费逻辑。这允许 M2 埋点先自测运行时行为。

### 3.5 包级单例与 ctx key

**位置**：`internal/domains/models/tracing/context.go`

```go
type ctxKey struct{}
var spanCtxKey = ctxKey{}

var globalTracer atomic.Pointer[Tracer]

func SetGlobal(t *Tracer)
func Global() *Tracer

func StartSpanFromContext(ctx context.Context, spanType SpanType, opName string) (context.Context, *Span)
func SpanFromContext(ctx context.Context) *Span

// 工具函数
func Sha256Prefix(s string, n int) string
```

**规则**：
- ctx 存 parent span 用私有 key
- traceCounters 清理：root span End 时把对应 counter 从 map 删除
- 无 parent / 未初始化 tracer → 返回 no-op Span

### 3.6 SpanRepository 接口

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
    IsError          bool
    UserQueryPreview string
}
```

### 3.7 Repository 实现骨架

**位置**：`internal/infra/repositories/ai_span_repository.go`

- AiSpanPO GORM 定义（见 3.8）
- `BatchInsert`：`db.WithContext(ctx).CreateInBatches(pos, 100)`
- `FindByTraceID`：`WHERE trace_id = ? ORDER BY span_id ASC`
- `ListTraces`：`WHERE parent_span_id = -1 AND ...`，配合 count 子查询
- spanToPO / poToNode 双向转换：tags/logs JSON marshal / unmarshal

### 3.8 建表 DDL

```sql
CREATE TABLE ai_span (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  trace_id        VARCHAR(64)  NOT NULL COMMENT '链路 ID = messageId',
  span_id         INT          NOT NULL COMMENT 'trace 内自增，root=0',
  parent_span_id  INT          NOT NULL COMMENT 'root=-1',
  span_type       VARCHAR(32)  NOT NULL,
  operation_name  VARCHAR(128) NOT NULL DEFAULT '',
  conversation_id VARCHAR(64)  NOT NULL DEFAULT '',
  agent_name      VARCHAR(64)  NOT NULL DEFAULT '',
  start_time      BIGINT       NOT NULL,
  end_time        BIGINT       NOT NULL DEFAULT 0,
  latency_ms      INT          NOT NULL DEFAULT 0,
  is_error        TINYINT(1)   NOT NULL DEFAULT 0,
  tags            JSON         COMMENT '扩展 kv',
  logs            JSON         COMMENT '过程日志',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_trace_span (trace_id, span_id),
  KEY idx_trace (trace_id),
  KEY idx_conv (conversation_id, created_at),
  KEY idx_error (is_error, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='智能体链路 span';
```

---

## 四、生命周期

- **初始化**：`api/routers/route.go` 的 `InitRouter` 中按顺序：Repository → Tracer → `tracing.SetGlobal(tracer)`
- **优雅退出**：gin server graceful shutdown 调 `tracer.Shutdown(ctx)`（M3 完成后真正 flush，M1 仅关闭 shutdown chan + wg.Wait 空跑）

---

## 五、单元测试清单

**位置**：`internal/domains/models/tracing/*_test.go`

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestSpan_LifecycleBasic` | 创建→SetTag→AddLog→End 后字段完整、LatencyMs > 0 |
| 2 | `TestSpan_EndIdempotent` | 二次 End 不重复 commit |
| 3 | `TestSpan_ConcurrentSetTag` | 10 goroutine 并发写 tag，`go test -race` 通过 |
| 4 | `TestSpan_SensitiveTagMasking` | `api_key` / `authorization` value 被打码为 `***` |
| 5 | `TestSpan_LongValueTruncation` | `user.query` 超 1KB 被截断 |
| 6 | `TestSpan_SetError` | `IsError=true` 且 logs 追加 ERROR 级 entry |
| 7 | `TestTracer_StartRootSpan` | ctx 含 rootSpan，`SpanID=0` / `ParentSpanID=-1` |
| 8 | `TestTracer_StartSpan_FromContext` | 连续 StartSpan，`span_id` 单调递增、parent 正确 |
| 9 | `TestTracer_StartSpan_NoParent` | ctx 无 parent → no-op Span，业务不 panic |
| 10 | `TestTracer_ConcurrentSpanIDGen` | 100 goroutine 并发生成 span → 唯一且落在 [1,100] |
| 11 | `TestSpanFromContext_NoTracer` | Tracer 未初始化，SpanFromContext 返回 no-op |

覆盖率目标：`tracing` 包 ≥ 85%。

---

## 六、错误处理

| 场景 | 处理 |
|------|------|
| `StartSpan` ctx 无 parent | 返回 no-op Span |
| `SetTag` 参数非法（nil map） | 静默忽略 + `zap.Warn`（限流） |
| `Span.End()` 多次调用 | 幂等，第二次 return |
| Tracer 未初始化 | `StartSpanFromContext` 返回 no-op |

---

## 七、验收清单

- [ ] `internal/domains/models/tracing/` 目录下 5 个 Go 文件按 3.x 节结构就位
- [ ] `internal/infra/repositories/ai_span_repository.go` 编译通过
- [ ] MySQL `ai_span` 表创建成功、索引齐全
- [ ] Domain 单测 11 个用例全部通过、`go test -race` 无 race
- [ ] `tracing.SetGlobal` / `tracing.Global` 单例语义正确
- [ ] no-op Span 在 6 种降级路径下不 panic

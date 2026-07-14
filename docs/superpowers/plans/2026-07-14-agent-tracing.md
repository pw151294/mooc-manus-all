# 智能体对话链路追踪（Agent Tracing）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/api/agent/chat` 主链路引入链路追踪能力，采集 Trace/Span 数据落盘 PostgreSQL 表 `ai_span`，并暴露查询 API（`GET /api/trace/:trace_id` 返回嵌套树、`GET /api/traces` 分页列表）。

**Architecture:** 新增 `internal/domains/models/tracing/` 包（Span 值对象 / Tracer 单例 / SpanNode 展示 DO / BuildSpanTree 算法 / SpanRepository 接口）。落盘走 `internal/infra/repositories/ai_span_repository.go`（GORM + PostgreSQL）。埋点通过 context.Context 传父子关系，域层 `base.go` 用**匿名函数隔离 defer 作用域**、**独立 ctx 变量名**（roundCtx / toolCtx）避免 Go 陷阱。异步批量落盘（batch=100 或 5s 触发），缓冲区满时 drop + 计数，业务永不阻塞。

**Tech Stack:**
- Go 1.25，Gin，`gorm.io/gorm` + `gorm.io/driver/postgres`
- `go.uber.org/zap` 日志
- 敏感字段打码走 `regexp` 单次编译（`sync.Once`）
- 单测使用 `testify` + `-race`

**关键设计原则：**
- P0：业务永不阻塞 tracing（缓冲满 drop + Warn）
- DDD：Domain 层 tracing 包不依赖 infra；Repository 接口在 domain、实现在 infra
- TDD：先测后码；每 Task 完成即 commit
- YAGNI：不做前端可视化 / 采样 / 分区 / OTel 协议

**关联 spec：** `docs/superpowers/specs/2026-07-14-agent-tracing-design.md`

---

## 文件结构总览

**新增文件**：

```
mooc-manus/internal/domains/models/tracing/
├── span.go                     # Span 值对象、SpanType、LogEntry、敏感字段打码 & 截断
├── span_test.go                # Span 单元测试
├── tracer.go                   # Tracer 单例、StartRootSpan / StartSpan / commit / Shutdown
├── tracer_test.go              # Tracer 单元测试（含 buffer / batch / timer / concurrent）
├── context.go                  # ctxKey、SpanFromContext、StartSpanFromContext 包级便利函数、Sha256Prefix
├── tree.go                     # SpanNode、BuildSpanTree、TraceSummary、TraceFilter
├── tree_test.go                # tree 单元测试
├── repository.go               # SpanRepository 接口
└── noop.go                     # no-op Span（未初始化 tracer 时返回，避免 panic）

mooc-manus/internal/infra/models/
└── ai_span.go                  # AiSpanPO（GORM 映射到 ai_span 表）

mooc-manus/internal/infra/repositories/
├── ai_span_repository.go       # SpanRepository 实现
└── ai_span_repository_test.go  # Repository 单测（可选，需 testcontainers 时启用）

mooc-manus/internal/applications/services/
├── trace.go                    # TraceApplicationService：查询协调、Span→SpanNode 转换、BuildSpanTree
├── trace_test.go               # 查询单测
└── agent_tracing_integration_test.go  # Chat 主流程集成测试

mooc-manus/internal/applications/dtos/
└── trace.go                    # TraceDetailDTO / TraceListDTO 及转换函数

mooc-manus/api/handlers/
├── trace.go                    # GET /api/trace/:trace_id、GET /api/traces
└── trace_test.go               # Handler 单测（httptest）
```

**修改文件**：

```
mooc-manus/docs/sql/manus_schema.sql
    追加 ai_span 表 DDL（PostgreSQL）

mooc-manus/internal/domains/services/agents/base.go
    - StreamingInvokeLLM 签名新增 ctx
    - InvokeLLM 签名新增 ctx
    - StreamingInvoke 循环体用匿名函数包裹 + roundCtx
    - Invoke（非流式）同上
    - InvokeToolCalls：函数入口 TOOL_BATCH span + 循环体内匿名函数 TOOL_CALL span
    - Chat 入口用 tracing.SpanFromContext(ctx) 补 domain 层 tags 到 AGENT_ROOT

mooc-manus/internal/applications/services/agent.go
    Chat() 入口 tracer.StartRootSpan、defer root.End()、SetTag(user.query, agent.max_iterations)

mooc-manus/api/routers/route.go
    - 初始化 AiSpanRepository、Tracer 单例并 tracing.SetGlobal
    - 注册 TraceHandler 到 /api/trace 与 /api/traces
    - 应用退出时 tracer.Shutdown（gin server graceful shutdown）

mooc-manus/main.go（若 Shutdown 挂在 main）
    应用退出时调 tracer.Shutdown(ctx)
```

---

## Phase 0：准备与建表

### Task 0.1：追加 `ai_span` 表 DDL

**Files:**
- Modify: `mooc-manus/docs/sql/manus_schema.sql`（追加到文件末尾）

- [ ] **Step 0.1.1：追加 PostgreSQL 建表语句**

在 `manus_schema.sql` 末尾追加：

```sql
-- ============================================================
-- 智能体链路追踪表（Agent Tracing）
-- 关联 spec：docs/superpowers/specs/2026-07-14-agent-tracing-design.md
-- ============================================================
CREATE TABLE ai_span
(
    id              BIGSERIAL PRIMARY KEY,
    trace_id        VARCHAR(64)  NOT NULL,
    span_id         INTEGER      NOT NULL,
    parent_span_id  INTEGER      NOT NULL,
    span_type       VARCHAR(32)  NOT NULL,
    operation_name  VARCHAR(128) NOT NULL DEFAULT '',
    conversation_id VARCHAR(64)  NOT NULL DEFAULT '',
    agent_name      VARCHAR(64)  NOT NULL DEFAULT '',
    start_time      BIGINT       NOT NULL,
    end_time        BIGINT       NOT NULL DEFAULT 0,
    latency_ms      INTEGER      NOT NULL DEFAULT 0,
    is_error        BOOLEAN      NOT NULL DEFAULT FALSE,
    tags            JSONB,
    logs            JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_trace_span UNIQUE (trace_id, span_id)
);

CREATE INDEX idx_ai_span_trace ON ai_span (trace_id);
CREATE INDEX idx_ai_span_conv ON ai_span (conversation_id, created_at DESC);
CREATE INDEX idx_ai_span_error ON ai_span (is_error, created_at DESC);

COMMENT ON TABLE  ai_span                IS '智能体链路 span';
COMMENT ON COLUMN ai_span.trace_id       IS '链路 ID = messageId';
COMMENT ON COLUMN ai_span.span_id        IS 'trace 内自增，root=0';
COMMENT ON COLUMN ai_span.parent_span_id IS 'root=-1';
COMMENT ON COLUMN ai_span.span_type      IS 'AGENT_ROOT/AGENT_ROUND/LLM_CALL/TOOL_BATCH/TOOL_CALL/SUBAGENT_CALL';
COMMENT ON COLUMN ai_span.operation_name IS 'tool 名（其他类型为空）';
COMMENT ON COLUMN ai_span.conversation_id IS '会话 ID（冗余存独立列，便于筛选）';
COMMENT ON COLUMN ai_span.agent_name     IS 'agent 名称';
COMMENT ON COLUMN ai_span.start_time     IS '纳秒时间戳';
COMMENT ON COLUMN ai_span.end_time       IS '纳秒时间戳';
COMMENT ON COLUMN ai_span.latency_ms     IS '毫秒时延';
COMMENT ON COLUMN ai_span.is_error       IS '当前 span 是否错误（不冒泡）';
COMMENT ON COLUMN ai_span.tags           IS '扩展 kv';
COMMENT ON COLUMN ai_span.logs           IS '过程日志 [{ts, level, msg, extra}]';
```

- [ ] **Step 0.1.2：本地执行 DDL 验证**

在本地 psql 执行该段 SQL，确认无语法错误、索引创建成功。若已有 `ai_span` 表则先 `DROP TABLE ai_span;` 再建。

命令：
```bash
psql -U <user> -d <dbname> -f mooc-manus/docs/sql/manus_schema.sql
# 或只执行新增段
psql -U <user> -d <dbname> -c "DROP TABLE IF EXISTS ai_span; <粘贴 CREATE 语句>"
```

- [ ] **Step 0.1.3：Commit**

```bash
git add mooc-manus/docs/sql/manus_schema.sql
git commit -m "feat(schema): 新增 ai_span 表用于智能体链路追踪落盘"
```

---

## Phase 1：Domain 层 tracing 基础包

### Task 1.1：定义 Span 值对象与常量

**Files:**
- Create: `mooc-manus/internal/domains/models/tracing/span.go`
- Test: `mooc-manus/internal/domains/models/tracing/span_test.go`

- [ ] **Step 1.1.1：编写 Span 单测（先写测试）**

```go
// mooc-manus/internal/domains/models/tracing/span_test.go
package tracing

import (
    "errors"
    "strings"
    "sync"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
)

func TestSpan_LifecycleBasic(t *testing.T) {
    s := newTestSpan("trace-1", 1, 0, SpanTypeLLMCall, "")
    s.SetTag("k1", "v1")
    s.AddLog("INFO", "started", nil)
    time.Sleep(2 * time.Millisecond)
    s.End()

    assert.Greater(t, s.LatencyMs, int32(0))
    assert.Equal(t, "v1", s.tags["k1"])
    assert.Len(t, s.logs, 1)
    assert.Equal(t, "started", s.logs[0].Msg)
}

func TestSpan_EndIdempotent(t *testing.T) {
    committed := 0
    s := newTestSpanWithCommit("trace-1", 1, 0, SpanTypeLLMCall, "", func(*Span) { committed++ })
    s.End()
    s.End()
    assert.Equal(t, 1, committed)
}

func TestSpan_ConcurrentSetTag(t *testing.T) {
    s := newTestSpan("trace-1", 1, 0, SpanTypeLLMCall, "")
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            s.SetTag("k", i)
            s.AddLog("INFO", "x", nil)
        }(i)
    }
    wg.Wait()
    // 通过 -race 检测无 race
}

func TestSpan_SensitiveTagMasking(t *testing.T) {
    s := newTestSpan("t", 1, 0, SpanTypeLLMCall, "")
    s.SetTag("api_key", "sk-xxx")
    s.SetTag("Authorization", "Bearer yyy")
    s.SetTag("some_password", "pw")
    s.SetTag("normal_key", "keep")

    assert.Equal(t, "***", s.tags["api_key"])
    assert.Equal(t, "***", s.tags["Authorization"])
    assert.Equal(t, "***", s.tags["some_password"])
    assert.Equal(t, "keep", s.tags["normal_key"])
}

func TestSpan_LongValueTruncation(t *testing.T) {
    s := newTestSpan("t", 1, 0, SpanTypeAgentRoot, "")
    long := strings.Repeat("x", 2000)
    s.SetTag("user.query", long)
    v := s.tags["user.query"].(string)
    assert.LessOrEqual(t, len(v), MaxUserQueryBytes)
}

func TestSpan_SetError(t *testing.T) {
    s := newTestSpan("t", 1, 0, SpanTypeToolCall, "fileRead")
    s.SetError(errors.New("boom"))
    assert.True(t, s.IsError)
    assert.NotEmpty(t, s.logs)
    assert.Equal(t, "ERROR", s.logs[len(s.logs)-1].Level)
}

// helpers（在 span_test.go 或独立 helpers_test.go 中）
func newTestSpan(traceID string, spanID, parentSpanID int32, spanType SpanType, opName string) *Span {
    return newTestSpanWithCommit(traceID, spanID, parentSpanID, spanType, opName, func(*Span) {})
}

func newTestSpanWithCommit(traceID string, spanID, parentSpanID int32, spanType SpanType, opName string, commit func(*Span)) *Span {
    return &Span{
        TraceID:       traceID,
        SpanID:        spanID,
        ParentSpanID:  parentSpanID,
        SpanType:      spanType,
        OperationName: opName,
        StartTime:     time.Now().UnixNano(),
        tags:          make(map[string]interface{}),
        logs:          make([]LogEntry, 0),
        commitFn:      commit,
    }
}
```

- [ ] **Step 1.1.2：运行测试确认失败**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -run TestSpan -race -v
```
Expected: FAIL（Span 类型不存在）

- [ ] **Step 1.1.3：实现 `span.go`**

```go
// mooc-manus/internal/domains/models/tracing/span.go
package tracing

import (
    "regexp"
    "sync"
    "sync/atomic"
    "time"
)

type SpanType string

const (
    SpanTypeAgentRoot    SpanType = "AGENT_ROOT"
    SpanTypeAgentRound   SpanType = "AGENT_ROUND"
    SpanTypeLLMCall      SpanType = "LLM_CALL"
    SpanTypeToolBatch    SpanType = "TOOL_BATCH"
    SpanTypeToolCall     SpanType = "TOOL_CALL"
    SpanTypeSubagentCall SpanType = "SUBAGENT_CALL"
)

const (
    MaxUserQueryBytes    = 1024
    MaxToolArgsBytes     = 2048
    MaxToolResultPreview = 512

    MaskedValue = "***"
)

type LogEntry struct {
    Ts    int64                  `json:"ts"`
    Level string                 `json:"level"`
    Msg   string                 `json:"msg"`
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
    StartTime      int64
    EndTime        int64
    LatencyMs      int32
    IsError        bool

    tags  map[string]interface{}
    logs  []LogEntry
    mu    sync.Mutex
    ended atomic.Bool

    // commitFn 用于把 span 提交到 Tracer 队列；单测里可注入
    commitFn func(*Span)
}

var (
    sensitiveRegexOnce sync.Once
    sensitiveRegex     *regexp.Regexp
)

func sensitiveKeyRegex() *regexp.Regexp {
    sensitiveRegexOnce.Do(func() {
        sensitiveRegex = regexp.MustCompile(`(?i)(api[_-]?key|token|password|secret|authorization)`)
    })
    return sensitiveRegex
}

func (s *Span) SetTag(key string, val interface{}) {
    if s == nil {
        return
    }
    s.mu.Lock()
    defer s.mu.Unlock()
    if s.tags == nil {
        s.tags = make(map[string]interface{})
    }
    if sensitiveKeyRegex().MatchString(key) {
        s.tags[key] = MaskedValue
        return
    }
    if str, ok := val.(string); ok {
        limit := maxLenForKey(key)
        if limit > 0 && len(str) > limit {
            str = str[:limit]
        }
        s.tags[key] = str
        return
    }
    s.tags[key] = val
}

func maxLenForKey(key string) int {
    switch key {
    case "user.query":
        return MaxUserQueryBytes
    case "tool.arguments":
        return MaxToolArgsBytes
    case "tool.result_preview":
        return MaxToolResultPreview
    }
    return 0
}

// SetAgentName 独立列写入（避开 tags 走独立列）
func (s *Span) SetAgentName(name string) {
    if s == nil {
        return
    }
    s.AgentName = name
}

// SetConversationID 独立列写入
func (s *Span) SetConversationID(id string) {
    if s == nil {
        return
    }
    s.ConversationID = id
}

func (s *Span) AddLog(level, msg string, extra map[string]interface{}) {
    if s == nil {
        return
    }
    s.mu.Lock()
    defer s.mu.Unlock()
    s.logs = append(s.logs, LogEntry{
        Ts:    time.Now().UnixNano(),
        Level: level,
        Msg:   msg,
        Extra: extra,
    })
}

func (s *Span) SetError(err error) {
    if s == nil || err == nil {
        return
    }
    s.mu.Lock()
    s.IsError = true
    s.logs = append(s.logs, LogEntry{
        Ts:    time.Now().UnixNano(),
        Level: "ERROR",
        Msg:   err.Error(),
    })
    s.mu.Unlock()
}

func (s *Span) End() {
    if s == nil {
        return
    }
    if !s.ended.CompareAndSwap(false, true) {
        return
    }
    now := time.Now().UnixNano()
    s.EndTime = now
    if s.StartTime > 0 {
        s.LatencyMs = int32((now - s.StartTime) / int64(time.Millisecond))
    }
    if s.commitFn != nil {
        s.commitFn(s)
    }
}

// TagsSnapshot 返回 tags 的浅拷贝，供 tracer / repository 序列化使用
func (s *Span) TagsSnapshot() map[string]interface{} {
    if s == nil {
        return nil
    }
    s.mu.Lock()
    defer s.mu.Unlock()
    out := make(map[string]interface{}, len(s.tags))
    for k, v := range s.tags {
        out[k] = v
    }
    return out
}

// LogsSnapshot 返回 logs 拷贝
func (s *Span) LogsSnapshot() []LogEntry {
    if s == nil {
        return nil
    }
    s.mu.Lock()
    defer s.mu.Unlock()
    out := make([]LogEntry, len(s.logs))
    copy(out, s.logs)
    return out
}
```

- [ ] **Step 1.1.4：运行测试验证通过**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -run TestSpan -race -v
```
Expected: PASS

- [ ] **Step 1.1.5：Commit**

```bash
git add mooc-manus/internal/domains/models/tracing/span.go mooc-manus/internal/domains/models/tracing/span_test.go
git commit -m "feat(tracing): 新增 Span 值对象、敏感字段打码、超长截断、End 幂等"
```

### Task 1.2：ctx 上下文传播 + SpanFromContext + Sha256Prefix

**Files:**
- Create: `mooc-manus/internal/domains/models/tracing/context.go`
- Create: `mooc-manus/internal/domains/models/tracing/noop.go`
- Modify: `mooc-manus/internal/domains/models/tracing/context.go` 单测

- [ ] **Step 1.2.1：编写单测**

在 `mooc-manus/internal/domains/models/tracing/context_test.go`：

```go
package tracing

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
)

func TestSpanFromContext_Empty(t *testing.T) {
    s := SpanFromContext(context.Background())
    assert.NotNil(t, s)
    // no-op：可以调用不 panic
    s.SetTag("k", "v")
    s.AddLog("INFO", "x", nil)
    s.SetAgentName("n")
    s.End()
}

func TestContextWithSpan_RoundTrip(t *testing.T) {
    ctx := context.Background()
    s := &Span{TraceID: "t1", SpanID: 5}
    ctx2 := contextWithSpan(ctx, s)
    got := SpanFromContext(ctx2)
    assert.Equal(t, "t1", got.TraceID)
    assert.Equal(t, int32(5), got.SpanID)
}

func TestSha256Prefix(t *testing.T) {
    got := Sha256Prefix("hello world", 8)
    assert.Len(t, got, 8)
    assert.NotEqual(t, "hello wo", got) // 是 hash，不是截断
}
```

- [ ] **Step 1.2.2：运行测试验证失败**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -run "TestSpanFromContext|TestContextWithSpan|TestSha256Prefix" -race -v
```

- [ ] **Step 1.2.3：实现 `noop.go`**

```go
// mooc-manus/internal/domains/models/tracing/noop.go
package tracing

// noopSpan 是所有方法都空实现的 Span。
// 当 ctx 无 parent、tracer 未初始化时返回，避免业务方 nil 判断。
// 注意：所有 Span.XXX 方法都要处理 s == nil 或空 Span 的 case。
var noopSingleton = &Span{
    ended: func() (b atomicBool) { b.Store(true); return }(),
}

// 用一个类型别名规避 atomic.Bool 无零值构造的问题
type atomicBool struct{ v atomicBoolInner }

// 直接用 sync/atomic Bool 的零值即可，无需别名——为清晰起见保持默认。
```

**说明**：上面示意有点绕。**实际实现更简单**：`noopSingleton` 就用零值 `&Span{}` 即可（`SetTag` / `AddLog` 已加 nil 判断和空 map 判断，`End` 靠 `ended.CompareAndSwap` 幂等），无需自定义 atomicBool。删掉上面这段，改用：

```go
// mooc-manus/internal/domains/models/tracing/noop.go
package tracing

// noopSpan 用于 ctx 无 parent 或 tracer 未初始化时返回
// 所有方法可无害调用；End 因 ended 已 true 而直接返回
func newNoopSpan() *Span {
    s := &Span{
        tags: map[string]interface{}{},
    }
    s.ended.Store(true) // 直接标记 ended=true，避免误 commit
    return s
}
```

- [ ] **Step 1.2.4：实现 `context.go`**

```go
// mooc-manus/internal/domains/models/tracing/context.go
package tracing

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
)

type ctxKey struct{}

func contextWithSpan(ctx context.Context, s *Span) context.Context {
    return context.WithValue(ctx, ctxKey{}, s)
}

// SpanFromContext 取 ctx 里存的当前 span；无则返回 no-op（不 panic）
func SpanFromContext(ctx context.Context) *Span {
    if ctx == nil {
        return newNoopSpan()
    }
    v := ctx.Value(ctxKey{})
    if s, ok := v.(*Span); ok && s != nil {
        return s
    }
    return newNoopSpan()
}

// StartSpanFromContext 由 domain 层埋点调用；tracer 未初始化时返回 no-op
func StartSpanFromContext(ctx context.Context, spanType SpanType, opName string) (context.Context, *Span) {
    t := Global()
    if t == nil {
        return ctx, newNoopSpan()
    }
    return t.StartSpan(ctx, spanType, opName)
}

// Sha256Prefix 返回给定文本的 sha256 十六进制前缀，用于 system_prompt.hash 等
func Sha256Prefix(text string, n int) string {
    if n <= 0 {
        return ""
    }
    sum := sha256.Sum256([]byte(text))
    hex := hex.EncodeToString(sum[:])
    if n > len(hex) {
        n = len(hex)
    }
    return hex[:n]
}
```

- [ ] **Step 1.2.5：运行测试验证通过**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -race -v
```

- [ ] **Step 1.2.6：Commit**

```bash
git add mooc-manus/internal/domains/models/tracing/context.go mooc-manus/internal/domains/models/tracing/noop.go mooc-manus/internal/domains/models/tracing/context_test.go
git commit -m "feat(tracing): 新增 ctx 传播、SpanFromContext、Sha256Prefix、no-op Span"
```

### Task 1.3：Tracer 单例 + StartRootSpan / StartSpan + 异步 flush

**Files:**
- Create: `mooc-manus/internal/domains/models/tracing/repository.go`
- Create: `mooc-manus/internal/domains/models/tracing/tracer.go`
- Test: `mooc-manus/internal/domains/models/tracing/tracer_test.go`

- [ ] **Step 1.3.1：实现 `repository.go` 接口**

```go
// mooc-manus/internal/domains/models/tracing/repository.go
package tracing

import "context"

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

type SpanRepository interface {
    BatchInsert(ctx context.Context, spans []*Span) error
    FindByTraceID(ctx context.Context, traceID string) ([]*SpanNode, error)
    ListTraces(ctx context.Context, filter TraceFilter, page, pageSize int) ([]*TraceSummary, int64, error)
}
```

- [ ] **Step 1.3.2：编写 Tracer 单测**

```go
// mooc-manus/internal/domains/models/tracing/tracer_test.go
package tracing

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
)

// fakeRepo 记录 BatchInsert 调用
type fakeRepo struct {
    mu     sync.Mutex
    calls  int
    spans  []*Span
    injErr error
}

func (r *fakeRepo) BatchInsert(_ context.Context, spans []*Span) error {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.calls++
    r.spans = append(r.spans, spans...)
    return r.injErr
}
func (r *fakeRepo) FindByTraceID(context.Context, string) ([]*SpanNode, error) { return nil, nil }
func (r *fakeRepo) ListTraces(context.Context, TraceFilter, int, int) ([]*TraceSummary, int64, error) {
    return nil, 0, nil
}

func newTestTracer(repo SpanRepository, batchSize int, flush time.Duration, bufCap int) *Tracer {
    t := NewTracer(repo,
        WithBatchSize(batchSize),
        WithFlushInterval(flush),
        WithBufferCapacity(bufCap),
    )
    return t
}

func TestTracer_StartRootSpan(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 100, time.Second, 100)
    defer tr.Shutdown(context.Background())

    ctx, root := tr.StartRootSpan(context.Background(), "trace-x")
    assert.Equal(t, "trace-x", root.TraceID)
    assert.Equal(t, int32(0), root.SpanID)
    assert.Equal(t, int32(-1), root.ParentSpanID)
    got := SpanFromContext(ctx)
    assert.Same(t, root, got)
}

func TestTracer_StartSpan_FromContext(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 100, time.Second, 100)
    defer tr.Shutdown(context.Background())

    ctx, root := tr.StartRootSpan(context.Background(), "trace-x")
    _ = root
    ctx, child1 := tr.StartSpan(ctx, SpanTypeAgentRound, "")
    _ = ctx
    _, child2 := tr.StartSpan(ctx, SpanTypeAgentRound, "")

    assert.Equal(t, int32(1), child1.SpanID)
    assert.Equal(t, int32(0), child1.ParentSpanID)
    assert.Equal(t, int32(2), child2.SpanID)
    assert.Equal(t, int32(1), child2.ParentSpanID)
    assert.Equal(t, "trace-x", child2.TraceID)
}

func TestTracer_StartSpan_NoParent(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 100, time.Second, 100)
    defer tr.Shutdown(context.Background())

    _, s := tr.StartSpan(context.Background(), SpanTypeLLMCall, "")
    assert.NotNil(t, s)
    // no-op 语义：End 不 commit（ended 已为 true）
    s.End()
    assert.Equal(t, 0, repo.calls)
}

func TestTracer_BufferFullDrop(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 1000, time.Hour, 3) // 极小缓冲
    // 不 Shutdown：避免 flush
    defer func() {
        // 停止 goroutine
        _ = tr.Shutdown(context.Background())
    }()

    ctx, _ := tr.StartRootSpan(context.Background(), "trace-x")
    var started int32
    for i := 0; i < 20; i++ {
        _, span := tr.StartSpan(ctx, SpanTypeToolCall, "t")
        atomic.AddInt32(&started, 1)
        span.End() // 触发 commit 到 buffer
    }
    assert.Greater(t, tr.DroppedCount(), int64(0))
    // 业务不阻塞：20 个 span 全部创建成功
    assert.Equal(t, int32(20), started)
}

func TestTracer_BatchFlushBySize(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 3, time.Hour, 100)
    defer tr.Shutdown(context.Background())

    ctx, _ := tr.StartRootSpan(context.Background(), "trace-x")
    for i := 0; i < 3; i++ {
        _, s := tr.StartSpan(ctx, SpanTypeToolCall, "t")
        s.End()
    }
    // 等待 goroutine 消费
    assert.Eventually(t, func() bool { return repo.calls >= 1 }, time.Second, 5*time.Millisecond)
    repo.mu.Lock()
    defer repo.mu.Unlock()
    assert.GreaterOrEqual(t, len(repo.spans), 3)
}

func TestTracer_BatchFlushByTimer(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 100, 100*time.Millisecond, 100)
    defer tr.Shutdown(context.Background())

    ctx, _ := tr.StartRootSpan(context.Background(), "trace-x")
    _, s := tr.StartSpan(ctx, SpanTypeToolCall, "t")
    s.End()

    assert.Eventually(t, func() bool { return repo.calls >= 1 }, time.Second, 10*time.Millisecond)
}

func TestTracer_Shutdown(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 100, time.Hour, 100)

    ctx, _ := tr.StartRootSpan(context.Background(), "trace-x")
    for i := 0; i < 5; i++ {
        _, s := tr.StartSpan(ctx, SpanTypeToolCall, "t")
        s.End()
    }
    err := tr.Shutdown(context.Background())
    assert.NoError(t, err)
    repo.mu.Lock()
    defer repo.mu.Unlock()
    assert.GreaterOrEqual(t, len(repo.spans), 5)
}

func TestTracer_ConcurrentSpanIDGen(t *testing.T) {
    repo := &fakeRepo{}
    tr := newTestTracer(repo, 1000, time.Hour, 10000)
    defer tr.Shutdown(context.Background())

    ctx, _ := tr.StartRootSpan(context.Background(), "trace-x")
    var wg sync.WaitGroup
    ids := sync.Map{}
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            _, s := tr.StartSpan(ctx, SpanTypeToolCall, "t")
            ids.Store(s.SpanID, struct{}{})
        }()
    }
    wg.Wait()
    // 100 个唯一 span_id
    count := 0
    ids.Range(func(_, _ any) bool { count++; return true })
    assert.Equal(t, 100, count)
}

func TestTracer_BatchInsertError_Discard(t *testing.T) {
    repo := &fakeRepo{injErr: errors.New("db down")}
    tr := newTestTracer(repo, 3, time.Hour, 100)
    defer tr.Shutdown(context.Background())

    ctx, _ := tr.StartRootSpan(context.Background(), "trace-x")
    for i := 0; i < 3; i++ {
        _, s := tr.StartSpan(ctx, SpanTypeToolCall, "t")
        s.End()
    }
    assert.Eventually(t, func() bool { return repo.calls >= 1 }, time.Second, 10*time.Millisecond)
    // 错误批被丢弃，dropCounter 增加或错误 counter 增加，行为不 panic 即可
}
```

- [ ] **Step 1.3.3：运行测试验证失败**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -run TestTracer -race -v
```

- [ ] **Step 1.3.4：实现 `tracer.go`**

```go
// mooc-manus/internal/domains/models/tracing/tracer.go
package tracing

import (
    "context"
    "sync"
    "sync/atomic"
    "time"

    "go.uber.org/zap"

    "mooc-manus/pkg/logger"
)

const (
    defaultBatchSize        = 100
    defaultFlushInterval    = 5 * time.Second
    defaultBufferCapacity   = 10000
)

type Tracer struct {
    repo          SpanRepository
    buffer        chan *Span
    batchSize     int
    flushInterval time.Duration
    dropCounter   atomic.Int64
    errCounter    atomic.Int64
    shutdown      chan struct{}
    wg            sync.WaitGroup

    traceCounters sync.Map // traceID -> *atomic.Int32
}

type Option func(*Tracer)

func WithBatchSize(n int) Option        { return func(t *Tracer) { t.batchSize = n } }
func WithFlushInterval(d time.Duration) Option { return func(t *Tracer) { t.flushInterval = d } }
func WithBufferCapacity(n int) Option   { return func(t *Tracer) { t.buffer = make(chan *Span, n) } }

func NewTracer(repo SpanRepository, opts ...Option) *Tracer {
    t := &Tracer{
        repo:          repo,
        batchSize:     defaultBatchSize,
        flushInterval: defaultFlushInterval,
        buffer:        make(chan *Span, defaultBufferCapacity),
        shutdown:      make(chan struct{}),
    }
    for _, opt := range opts {
        opt(t)
    }
    if t.buffer == nil {
        t.buffer = make(chan *Span, defaultBufferCapacity)
    }
    t.wg.Add(1)
    go t.runFlushLoop()
    return t
}

// StartRootSpan 由 Application 层入口调用一次
func (t *Tracer) StartRootSpan(ctx context.Context, traceID string) (context.Context, *Span) {
    counter := new(atomic.Int32)
    t.traceCounters.Store(traceID, counter)
    s := &Span{
        TraceID:      traceID,
        SpanID:       0,
        ParentSpanID: -1,
        SpanType:     SpanTypeAgentRoot,
        StartTime:    time.Now().UnixNano(),
        tags:         make(map[string]interface{}),
        logs:         make([]LogEntry, 0),
        commitFn:     t.commit,
    }
    return contextWithSpan(ctx, s), s
}

func (t *Tracer) StartSpan(ctx context.Context, spanType SpanType, opName string) (context.Context, *Span) {
    parent := SpanFromContext(ctx)
    if parent == nil || parent.TraceID == "" {
        // no-op：无 root，业务不阻塞
        return ctx, newNoopSpan()
    }
    counterAny, ok := t.traceCounters.Load(parent.TraceID)
    if !ok {
        return ctx, newNoopSpan()
    }
    counter := counterAny.(*atomic.Int32)
    newID := counter.Add(1)
    s := &Span{
        TraceID:      parent.TraceID,
        SpanID:       newID,
        ParentSpanID: parent.SpanID,
        SpanType:     spanType,
        OperationName: opName,
        // 独立列默认从 parent 继承（可被 SetAgentName/SetConversationID 覆盖）
        ConversationID: parent.ConversationID,
        AgentName:      parent.AgentName,
        StartTime:      time.Now().UnixNano(),
        tags:           make(map[string]interface{}),
        logs:           make([]LogEntry, 0),
        commitFn:       t.commit,
    }
    return contextWithSpan(ctx, s), s
}

// commit 由 Span.End() 回调；缓冲区满时 drop + 计数，永不阻塞
func (t *Tracer) commit(s *Span) {
    select {
    case t.buffer <- s:
    default:
        t.dropCounter.Add(1)
        // 简单节流：每 1000 次 drop 打一次日志
        if t.dropCounter.Load()%1000 == 1 {
            logger.Warn("tracing buffer full, dropping span",
                zap.Int64("drop_total", t.dropCounter.Load()),
                zap.String("trace_id", s.TraceID))
        }
    }
    // root 结束时清理 traceCounters
    if s.SpanType == SpanTypeAgentRoot {
        t.traceCounters.Delete(s.TraceID)
    }
}

func (t *Tracer) DroppedCount() int64 { return t.dropCounter.Load() }

func (t *Tracer) runFlushLoop() {
    defer t.wg.Done()
    ticker := time.NewTicker(t.flushInterval)
    defer ticker.Stop()

    batch := make([]*Span, 0, t.batchSize)

    flush := func() {
        if len(batch) == 0 {
            return
        }
        // 拷贝再送 repo，避免下轮复用切片时的引用问题
        toWrite := make([]*Span, len(batch))
        copy(toWrite, batch)
        batch = batch[:0]
        // 独立 ctx；不受 root ctx 影响
        if err := t.repo.BatchInsert(context.Background(), toWrite); err != nil {
            t.errCounter.Add(1)
            logger.Error("tracing batch insert failed",
                zap.Error(err),
                zap.Int("batch_size", len(toWrite)),
                zap.Int64("err_total", t.errCounter.Load()))
        }
    }

    for {
        select {
        case <-t.shutdown:
            // 排空 buffer
            for {
                select {
                case s := <-t.buffer:
                    batch = append(batch, s)
                    if len(batch) >= t.batchSize {
                        flush()
                    }
                default:
                    flush()
                    return
                }
            }
        case s := <-t.buffer:
            batch = append(batch, s)
            if len(batch) >= t.batchSize {
                flush()
            }
        case <-ticker.C:
            flush()
        }
    }
}

func (t *Tracer) Shutdown(ctx context.Context) error {
    select {
    case <-t.shutdown:
        return nil
    default:
        close(t.shutdown)
    }
    done := make(chan struct{})
    go func() {
        t.wg.Wait()
        close(done)
    }()
    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// ==== 包级全局单例 ====
var globalTracer atomic.Pointer[Tracer]

func SetGlobal(t *Tracer) { globalTracer.Store(t) }
func Global() *Tracer     { return globalTracer.Load() }
```

- [ ] **Step 1.3.5：运行测试验证通过**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -race -v
```
Expected: PASS（所有 Tracer 用例）

- [ ] **Step 1.3.6：Commit**

```bash
git add mooc-manus/internal/domains/models/tracing/tracer.go mooc-manus/internal/domains/models/tracing/tracer_test.go mooc-manus/internal/domains/models/tracing/repository.go
git commit -m "feat(tracing): 新增 Tracer 单例、异步批量 flush、缓冲区满 drop、无阻塞"
```

### Task 1.4：SpanNode + BuildSpanTree

**Files:**
- Create: `mooc-manus/internal/domains/models/tracing/tree.go`
- Test: `mooc-manus/internal/domains/models/tracing/tree_test.go`

- [ ] **Step 1.4.1：编写单测**

```go
// mooc-manus/internal/domains/models/tracing/tree_test.go
package tracing

import (
    "testing"

    "github.com/stretchr/testify/assert"
)

func makeNode(spanID, parent int32, spanType string) *SpanNode {
    return &SpanNode{SpanID: spanID, ParentSpanID: parent, SpanType: spanType, Tags: map[string]interface{}{}}
}

func TestBuildSpanTree_HappyPath(t *testing.T) {
    nodes := []*SpanNode{
        makeNode(0, -1, string(SpanTypeAgentRoot)),
        makeNode(1, 0, string(SpanTypeAgentRound)),
        makeNode(2, 1, string(SpanTypeLLMCall)),
        makeNode(3, 1, string(SpanTypeToolBatch)),
        makeNode(4, 3, string(SpanTypeToolCall)),
        makeNode(5, 3, string(SpanTypeToolCall)),
    }
    root, err := BuildSpanTree(nodes)
    assert.NoError(t, err)
    assert.Equal(t, int32(0), root.SpanID)
    assert.Len(t, root.Children, 1)
    assert.Equal(t, int32(1), root.Children[0].SpanID)
    assert.Len(t, root.Children[0].Children, 2) // LLM_CALL + TOOL_BATCH
    assert.Len(t, root.Children[0].Children[1].Children, 2) // 两个 TOOL_CALL
    // children 按 span_id 升序
    assert.Equal(t, int32(4), root.Children[0].Children[1].Children[0].SpanID)
    assert.Equal(t, int32(5), root.Children[0].Children[1].Children[1].SpanID)
}

func TestBuildSpanTree_EmptyInput(t *testing.T) {
    _, err := BuildSpanTree(nil)
    assert.ErrorIs(t, err, ErrEmptyTrace)
}

func TestBuildSpanTree_NoRoot(t *testing.T) {
    nodes := []*SpanNode{makeNode(1, 999, "X")}
    _, err := BuildSpanTree(nodes)
    assert.ErrorIs(t, err, ErrNoRoot)
}

func TestBuildSpanTree_MultipleRoots(t *testing.T) {
    nodes := []*SpanNode{
        makeNode(0, -1, "A"),
        makeNode(1, -1, "B"),
    }
    _, err := BuildSpanTree(nodes)
    assert.ErrorIs(t, err, ErrMultipleRoots)
}

func TestBuildSpanTree_OrphanNode(t *testing.T) {
    nodes := []*SpanNode{
        makeNode(0, -1, "R"),
        makeNode(5, 999, "ORPHAN"), // parent 999 不存在
    }
    root, err := BuildSpanTree(nodes)
    assert.NoError(t, err)
    // 孤儿挂到 root 下，且带 _orphan tag
    assert.Len(t, root.Children, 1)
    orphan := root.Children[0]
    assert.Equal(t, int32(5), orphan.SpanID)
    assert.Equal(t, true, orphan.Tags["_orphan"])
    assert.Equal(t, int32(999), orphan.Tags["_original_parent"])
}
```

- [ ] **Step 1.4.2：运行测试验证失败**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -run TestBuildSpanTree -race -v
```

- [ ] **Step 1.4.3：实现 `tree.go`**

```go
// mooc-manus/internal/domains/models/tracing/tree.go
package tracing

import "errors"

var (
    ErrEmptyTrace    = errors.New("empty trace")
    ErrNoRoot        = errors.New("no root span")
    ErrMultipleRoots = errors.New("multiple root spans")
)

// SpanNode 专用于 GET /api/trace/:trace_id 返回的树状结构
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

// BuildSpanTree 把扁平数组还原成树
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
    var (
        root    *SpanNode
        orphans []*SpanNode
    )
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

- [ ] **Step 1.4.4：运行测试验证通过**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -run TestBuildSpanTree -race -v
```

- [ ] **Step 1.4.5：Commit**

```bash
git add mooc-manus/internal/domains/models/tracing/tree.go mooc-manus/internal/domains/models/tracing/tree_test.go
git commit -m "feat(tracing): 新增 SpanNode 树结构 + BuildSpanTree 两遍扫描算法（孤儿降级）"
```

---

## Phase 2：落盘 Repository（AiSpanPO + 转换 + GORM 实现）

### Task 2.1：新增 AiSpanPO 模型

**Files:**
- Create: `mooc-manus/internal/infra/models/ai_span.go`

- [ ] **Step 2.1.1：实现 PO**

```go
// mooc-manus/internal/infra/models/ai_span.go
package models

import "time"

type AiSpanPO struct {
    ID             uint64    `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
    TraceID        string    `gorm:"column:trace_id;type:varchar(64);not null;index:idx_ai_span_trace" json:"traceId"`
    SpanID         int32     `gorm:"column:span_id;not null" json:"spanId"`
    ParentSpanID   int32     `gorm:"column:parent_span_id;not null" json:"parentSpanId"`
    SpanType       string    `gorm:"column:span_type;type:varchar(32);not null" json:"spanType"`
    OperationName  string    `gorm:"column:operation_name;type:varchar(128);not null;default:''" json:"operationName"`
    ConversationID string    `gorm:"column:conversation_id;type:varchar(64);not null;default:''" json:"conversationId"`
    AgentName      string    `gorm:"column:agent_name;type:varchar(64);not null;default:''" json:"agentName"`
    StartTime      int64     `gorm:"column:start_time;not null" json:"startTime"`
    EndTime        int64     `gorm:"column:end_time;not null;default:0" json:"endTime"`
    LatencyMs      int32     `gorm:"column:latency_ms;not null;default:0" json:"latencyMs"`
    IsError        bool      `gorm:"column:is_error;not null;default:false" json:"isError"`
    Tags           string    `gorm:"column:tags;type:jsonb" json:"tags"`
    Logs           string    `gorm:"column:logs;type:jsonb" json:"logs"`
    CreatedAt      time.Time `gorm:"column:created_at;autoCreateTime" json:"createdAt"`
}

func (AiSpanPO) TableName() string { return "ai_span" }
```

- [ ] **Step 2.1.2：Commit**

```bash
git add mooc-manus/internal/infra/models/ai_span.go
git commit -m "feat(tracing): 新增 AiSpanPO GORM 模型（对齐 PostgreSQL jsonb）"
```

### Task 2.2：Repository 实现 + DO↔PO 转换

**Files:**
- Create: `mooc-manus/internal/infra/repositories/ai_span_repository.go`
- Create: `mooc-manus/internal/infra/repositories/ai_span_repository_test.go`（跳过 CI，本地跑）

- [ ] **Step 2.2.1：编写 Repository 单测（可选，需本地 PostgreSQL）**

```go
// mooc-manus/internal/infra/repositories/ai_span_repository_test.go
//go:build integration

package repositories

import (
    "context"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"

    "mooc-manus/internal/domains/models/tracing"
)

// 需要在本地起一个 PostgreSQL 并已应用 ai_span 表
func TestAiSpanRepository_BatchInsertAndFind(t *testing.T) {
    repo := NewAiSpanRepository()
    now := time.Now().UnixNano()
    span := &tracing.Span{
        TraceID:      "trace-repo-test-1",
        SpanID:       0,
        ParentSpanID: -1,
        SpanType:     tracing.SpanTypeAgentRoot,
        StartTime:    now,
        EndTime:      now + int64(time.Millisecond)*10,
        LatencyMs:    10,
    }
    span.SetTag("k", "v")
    span.AddLog("INFO", "start", nil)

    err := repo.BatchInsert(context.Background(), []*tracing.Span{span})
    assert.NoError(t, err)

    nodes, err := repo.FindByTraceID(context.Background(), "trace-repo-test-1")
    assert.NoError(t, err)
    assert.Len(t, nodes, 1)
    assert.Equal(t, int32(0), nodes[0].SpanID)
    assert.Equal(t, "v", nodes[0].Tags["k"])
}
```

- [ ] **Step 2.2.2：实现 Repository**

```go
// mooc-manus/internal/infra/repositories/ai_span_repository.go
package repositories

import (
    "context"
    "encoding/json"

    "gorm.io/gorm"

    "mooc-manus/internal/domains/models/tracing"
    "mooc-manus/internal/infra/models"
    "mooc-manus/internal/infra/storage"
)

type AiSpanRepositoryImpl struct {
    dbCli *gorm.DB
}

func NewAiSpanRepository() tracing.SpanRepository {
    return &AiSpanRepositoryImpl{dbCli: storage.GetPostgresClient()}
}

func (r *AiSpanRepositoryImpl) BatchInsert(ctx context.Context, spans []*tracing.Span) error {
    if len(spans) == 0 {
        return nil
    }
    pos := make([]models.AiSpanPO, 0, len(spans))
    for _, s := range spans {
        pos = append(pos, spanToPO(s))
    }
    return r.dbCli.WithContext(ctx).CreateInBatches(&pos, 100).Error
}

func (r *AiSpanRepositoryImpl) FindByTraceID(ctx context.Context, traceID string) ([]*tracing.SpanNode, error) {
    var pos []models.AiSpanPO
    err := r.dbCli.WithContext(ctx).
        Where("trace_id = ?", traceID).
        Order("span_id ASC").
        Find(&pos).Error
    if err != nil {
        return nil, err
    }
    nodes := make([]*tracing.SpanNode, 0, len(pos))
    for _, po := range pos {
        nodes = append(nodes, poToNode(&po))
    }
    return nodes, nil
}

func (r *AiSpanRepositoryImpl) ListTraces(ctx context.Context, filter tracing.TraceFilter, page, pageSize int) ([]*tracing.TraceSummary, int64, error) {
    if page < 1 {
        page = 1
    }
    if pageSize < 1 || pageSize > 100 {
        pageSize = 20
    }
    // 从 root 行（parent_span_id=-1）出发做分页
    q := r.dbCli.WithContext(ctx).Model(&models.AiSpanPO{}).Where("parent_span_id = ?", -1)
    if filter.ConversationID != "" {
        q = q.Where("conversation_id = ?", filter.ConversationID)
    }
    if filter.AgentName != "" {
        q = q.Where("agent_name = ?", filter.AgentName)
    }
    if filter.StartTimeFrom > 0 {
        q = q.Where("start_time >= ?", filter.StartTimeFrom)
    }
    if filter.StartTimeTo > 0 {
        q = q.Where("start_time <= ?", filter.StartTimeTo)
    }

    var total int64
    if err := q.Count(&total).Error; err != nil {
        return nil, 0, err
    }
    var roots []models.AiSpanPO
    if err := q.Order("start_time DESC").
        Offset((page - 1) * pageSize).Limit(pageSize).
        Find(&roots).Error; err != nil {
        return nil, 0, err
    }
    // 对每条 root 聚合其 trace 全体行的 span_count + is_error
    ids := make([]string, 0, len(roots))
    for _, r := range roots {
        ids = append(ids, r.TraceID)
    }
    type aggRow struct {
        TraceID   string
        SpanCount int32
        AnyError  bool
    }
    aggs := []aggRow{}
    if len(ids) > 0 {
        if err := r.dbCli.WithContext(ctx).Model(&models.AiSpanPO{}).
            Select("trace_id, COUNT(*) AS span_count, BOOL_OR(is_error) AS any_error").
            Where("trace_id IN ?", ids).
            Group("trace_id").
            Scan(&aggs).Error; err != nil {
            return nil, 0, err
        }
    }
    aggMap := make(map[string]aggRow, len(aggs))
    for _, a := range aggs {
        aggMap[a.TraceID] = a
    }
    // is_error 过滤（本期在应用层做，避免复杂子查询）
    summaries := make([]*tracing.TraceSummary, 0, len(roots))
    for _, po := range roots {
        agg := aggMap[po.TraceID]
        if filter.IsError != nil && *filter.IsError != agg.AnyError {
            continue
        }
        summaries = append(summaries, &tracing.TraceSummary{
            TraceID:          po.TraceID,
            ConversationID:   po.ConversationID,
            AgentName:        po.AgentName,
            StartTime:        po.StartTime,
            DurationMs:       po.LatencyMs,
            SpanCount:        agg.SpanCount,
            IsError:          agg.AnyError,
            UserQueryPreview: extractUserQueryPreview(po.Tags),
        })
    }
    return summaries, total, nil
}

func spanToPO(s *tracing.Span) models.AiSpanPO {
    tagsBytes, _ := json.Marshal(s.TagsSnapshot())
    logsBytes, _ := json.Marshal(s.LogsSnapshot())
    return models.AiSpanPO{
        TraceID:        s.TraceID,
        SpanID:         s.SpanID,
        ParentSpanID:   s.ParentSpanID,
        SpanType:       string(s.SpanType),
        OperationName:  s.OperationName,
        ConversationID: s.ConversationID,
        AgentName:      s.AgentName,
        StartTime:      s.StartTime,
        EndTime:        s.EndTime,
        LatencyMs:      s.LatencyMs,
        IsError:        s.IsError,
        Tags:           string(tagsBytes),
        Logs:           string(logsBytes),
    }
}

func poToNode(po *models.AiSpanPO) *tracing.SpanNode {
    var tags map[string]interface{}
    _ = json.Unmarshal([]byte(nz(po.Tags)), &tags)
    var logs []tracing.LogEntry
    _ = json.Unmarshal([]byte(nz(po.Logs)), &logs)
    if tags == nil {
        tags = map[string]interface{}{}
    }
    return &tracing.SpanNode{
        SpanID:        po.SpanID,
        ParentSpanID:  po.ParentSpanID,
        SpanType:      po.SpanType,
        OperationName: po.OperationName,
        StartTime:     po.StartTime,
        EndTime:       po.EndTime,
        LatencyMs:     po.LatencyMs,
        IsError:       po.IsError,
        Tags:          tags,
        Logs:          logs,
    }
}

func nz(s string) string {
    if s == "" {
        return "null"
    }
    return s
}

func extractUserQueryPreview(tagsJSON string) string {
    if tagsJSON == "" {
        return ""
    }
    var m map[string]interface{}
    if err := json.Unmarshal([]byte(tagsJSON), &m); err != nil {
        return ""
    }
    if v, ok := m["user.query"].(string); ok {
        if len(v) > 80 {
            return v[:80]
        }
        return v
    }
    return ""
}
```

- [ ] **Step 2.2.3：编译验证**

```bash
cd mooc-manus && go build ./...
```
Expected: 无编译错误

- [ ] **Step 2.2.4：（可选）本地跑集成测试**

```bash
cd mooc-manus && go test ./internal/infra/repositories/ -run TestAiSpanRepository -tags=integration -v
```

- [ ] **Step 2.2.5：Commit**

```bash
git add mooc-manus/internal/infra/repositories/ai_span_repository.go mooc-manus/internal/infra/repositories/ai_span_repository_test.go
git commit -m "feat(tracing): 新增 AiSpanRepository（BatchInsert / FindByTraceID / ListTraces）"
```

---

## Phase 3：埋点（Application 层入口 + Domain 层 base.go）

### Task 3.1：Application 层 Chat 入口埋点 AGENT_ROOT

**Files:**
- Modify: `mooc-manus/internal/applications/services/agent.go`

- [ ] **Step 3.1.1：修改 `Chat()` 入口，创建 root span 并补 tags**

在 `Chat()` 函数体内、`messageId := sse.StartChat(...)` 之后、`ctx, cancel := context.WithCancel(...)` 之前，注入 tracing：

```go
// Chat() 内，紧接 messageId 生成之后：
messageId := sse.StartChat(writer, clientRequest.ConversationId)
request.MessageId = messageId
logger.Info("start new chat", zap.String("messageId", messageId))

// 创建可 cancel 的 context
ctx, cancel := context.WithCancel(context.Background())

// === 【tracing 新增】开启 root span ===
tracer := tracing.Global()
var rootSpan *tracing.Span
if tracer != nil {
    ctx, rootSpan = tracer.StartRootSpan(ctx, messageId)
    rootSpan.SetConversationID(clientRequest.ConversationId)
    rootSpan.SetTag("user.query", clientRequest.Query)
    if clientRequest.MaxIterations > 0 {
        rootSpan.SetTag("agent.max_iterations", clientRequest.MaxIterations)
    }
}
defer func() {
    if rootSpan != nil {
        rootSpan.End()
    }
}()
// ======================================

s.mu.Lock()
s.cancelFuncs[messageId] = cancel
s.mu.Unlock()

// ... 原有 defer 逻辑保持不变
```

**注意**：
- 引入 `"mooc-manus/internal/domains/models/tracing"` import
- 若 `clientRequest.MaxIterations` 字段不存在或名字不同，按现有 DTO 命名调整；无则跳过该 SetTag
- `defer rootSpan.End()` 必须放在**所有 return 路径之前**，保证异常路径也 End

- [ ] **Step 3.1.2：编译验证**

```bash
cd mooc-manus && go build ./...
```

- [ ] **Step 3.1.3：Commit**

```bash
git add mooc-manus/internal/applications/services/agent.go
git commit -m "feat(tracing): Application.Chat 入口埋 AGENT_ROOT + user.query / conversation_id"
```

### Task 3.2：Domain 层 `StreamingInvoke` / `Invoke` 循环埋点 AGENT_ROUND

**Files:**
- Modify: `mooc-manus/internal/domains/services/agents/base.go`

- [ ] **Step 3.2.1：入口补 root 的 domain 层 tags**

在 `StreamingInvoke` 和 `Invoke` 两个函数入口第一行加：

```go
func (a *BaseAgent) StreamingInvoke(ctx context.Context, query string, eventCh chan events.AgentEvent) {
    // === 【tracing 新增】补 root span 的 domain 层 tags ===
    rootSpan := tracing.SpanFromContext(ctx)
    rootSpan.SetTag("agent.name", a.name)
    rootSpan.SetTag("agent.model", a.agentConfig.Model) // 若字段不存在按现有 config 结构调整
    rootSpan.SetTag("agent.max_iterations", a.agentConfig.MaxIterations)
    rootSpan.SetTag("agent.tools_count", len(a.GetAvailableTools()))
    rootSpan.SetTag("system_prompt.hash", tracing.Sha256Prefix(a.systemPrompt, 16))
    rootSpan.SetAgentName(a.name)
    // ======================================================

    // ... 原有逻辑
}
```

**注意**：`agent.model` 字段：项目 `AgentConfig`（domain）无 Model 字段（Model 在 ModelConfig 里），故这一行改为 `rootSpan.SetTag("agent.model_config_ref", "app_config")` 或省略；实施时先 grep `a.agentConfig` 用到的字段以对齐。

对 `Invoke` 同步加同一段。

- [ ] **Step 3.2.2：`StreamingInvoke` 循环体用匿名函数包裹**

把 `base.go:466-499` 附近的 for 循环体整体重构为匿名函数：

```go
round := 0
for round < a.agentConfig.MaxIterations {
    // context cancel 检查保留原样
    select {
    case <-ctx.Done():
        logger.Info("StreamingInvoke cancelled by context", zap.Error(ctx.Err()), zap.Int("round", round))
        eventCh <- events.OnError("对话已被中止")
        close(eventCh)
        return
    default:
    }
    round++

    // === 【tracing 新增】每轮用匿名函数隔离 defer 作用域 ===
    shouldClose := func() bool {
        roundCtx, roundSpan := tracing.StartSpanFromContext(ctx, tracing.SpanTypeAgentRound, "")
        defer roundSpan.End()
        roundSpan.SetTag("round.index", round)
        roundSpan.SetTag("round.messages_count", len(a.GetMessages()))

        wg.Add(1)
        llmEventCh := make(chan events.AgentEvent)
        go func() {
            defer wg.Done()
            message := a.StreamingInvokeLLM(roundCtx, messages, llmEventCh)
            toolCalls := message.ToolCalls
            if len(toolCalls) == 0 {
                logger.Info("end invoke llm", zap.Int("round", round), zap.Any("text", message.Content))
                eventCh <- events.OnMessageEnd()
                shouldEnd.CompareAndSwap(false, true)
                return
            }
            messages = a.InvokeToolCalls(roundCtx, toolCalls, eventCh)
        }()
        for event := range llmEventCh {
            eventCh <- event
        }
        wg.Wait()
        return shouldEnd.Load()
    }()
    // ======================================================

    if shouldClose {
        close(eventCh)
        return
    }
}
```

**关键点**：
- **`roundCtx` 用独立变量名，不覆盖外层 `ctx`**
- goroutine 内传的是 `roundCtx`，不是 `ctx`
- `defer roundSpan.End()` 由匿名函数作用域托管，每轮结束即 End

- [ ] **Step 3.2.3：`Invoke` 循环体同样重构**

对 `base.go:409-454` 的 `Invoke`（非流式）做对称处理：把 `for round < ...` 循环体包进匿名函数，roundCtx 隔离。

- [ ] **Step 3.2.4：编译验证**

```bash
cd mooc-manus && go build ./...
```

- [ ] **Step 3.2.5：Commit**

```bash
git add mooc-manus/internal/domains/services/agents/base.go
git commit -m "feat(tracing): base.go 入口补 domain tags + 循环体匿名函数隔离 AGENT_ROUND"
```

### Task 3.3：Domain 层 `StreamingInvokeLLM` / `InvokeLLM` 埋点 LLM_CALL

**Files:**
- Modify: `mooc-manus/internal/domains/services/agents/base.go`
- Modify: `mooc-manus/internal/domains/services/agents/agent.go`（若 impl 内也调用了 InvokeLLM）
- Modify: 所有调用 `StreamingInvokeLLM` / `InvokeLLM` 的调用方

- [ ] **Step 3.3.1：修改函数签名 + 内部埋点**

```go
// base.go
func (a *BaseAgent) StreamingInvokeLLM(ctx context.Context, messages []llm.Message, eventCh chan<- events.AgentEvent) llm.Message {
    _, llmSpan := tracing.StartSpanFromContext(ctx, tracing.SpanTypeLLMCall, "")
    defer llmSpan.End()
    llmSpan.SetTag("llm.messages_count", len(a.GetMessages()))
    llmSpan.SetTag("llm.tools_count", len(a.GetAvailableTools()))
    llmSpan.AddLog("INFO", "llm.request.sent", nil)

    // 原有逻辑：
    messages = a.injectInterventionIfNeeded(messages)
    a.AddToMemory(messages)
    availableTools := a.GetAvailableTools()
    messagesToAdd := make([]llm.Message, 0)
    llmEventCh := make(chan events.AgentEvent)
    var message llm.Message
    logger.Info("begin llm streaming chat", zap.Any("messages", a.GetMessages()), zap.Any("available tools", availableTools))

    var wg sync.WaitGroup
    wg.Add(1)
    go func() {
        message = a.invoker.StreamingInvoke(a.GetMessages(), availableTools, llmEventCh)
        // ... 原有内部逻辑
        a.AddToMemory(messagesToAdd)
        wg.Done()
    }()

    firstTokenSeen := false
    for event := range llmEventCh {
        if !firstTokenSeen && event.EventType() == events.EventTypeMessage {
            llmSpan.AddLog("INFO", "llm.stream.first_token", nil)
            firstTokenSeen = true
        }
        eventCh <- event
    }
    wg.Wait()
    close(eventCh)

    llmSpan.SetTag("llm.tool_calls_count", len(message.ToolCalls))
    llmSpan.AddLog("INFO", "llm.stream.completed", nil)
    return message
}

func (a *BaseAgent) InvokeLLM(ctx context.Context, messages []llm.Message) (llm.Message, error) {
    _, llmSpan := tracing.StartSpanFromContext(ctx, tracing.SpanTypeLLMCall, "")
    defer llmSpan.End()
    llmSpan.SetTag("llm.messages_count", len(a.GetMessages()))
    llmSpan.SetTag("llm.tools_count", len(a.GetAvailableTools()))
    llmSpan.AddLog("INFO", "llm.request.sent", nil)

    // 原有 retry 循环内错误路径：
    //   llmSpan.AddLog("WARN", "llm.retry", map[string]interface{}{"attempt": attempt})
    //   最终失败：llmSpan.SetError(err)

    // 成功 return 前：
    //   llmSpan.SetTag("llm.tool_calls_count", len(message.ToolCalls))
    //   llmSpan.AddLog("INFO", "llm.stream.completed", nil)

    // ... 保留原有主体逻辑
}
```

- [ ] **Step 3.3.2：更新所有调用点**

- `base.go:414` `message, err := a.InvokeLLM(messages)` → `a.InvokeLLM(ctx, messages)`
- `base.go:448` `message, err = a.InvokeLLM(toolMessages)` → 用 `roundCtx`（注意此调用点在 `Invoke` 主循环里，已在 Task 3.2 用 roundCtx 包裹）
- `base.go:481` `message := a.StreamingInvokeLLM(messages, llmEventCh)` → 用 `roundCtx`
- grep `InvokeLLM\|StreamingInvokeLLM` 找出其他调用点（agent.go / plan.go / a2a.go 内可能有），同步补 ctx；若非本期主链路且传 `context.Background()` 兼容

- [ ] **Step 3.3.3：编译验证**

```bash
cd mooc-manus && go build ./...
```

- [ ] **Step 3.3.4：Commit**

```bash
git add mooc-manus/internal/domains/services/agents/
git commit -m "feat(tracing): (Streaming)InvokeLLM 签名新增 ctx，函数内埋 LLM_CALL"
```

### Task 3.4：Domain 层 `InvokeToolCalls` 埋点 TOOL_BATCH + TOOL_CALL / SUBAGENT_CALL

**Files:**
- Modify: `mooc-manus/internal/domains/services/agents/base.go`

- [ ] **Step 3.4.1：函数入口埋 TOOL_BATCH**

```go
func (a *BaseAgent) InvokeToolCalls(ctx context.Context, toolCalls []llm.ToolCall, eventCh chan<- events.AgentEvent) []llm.Message {
    ctx, batchSpan := tracing.StartSpanFromContext(ctx, tracing.SpanTypeToolBatch, "")
    defer batchSpan.End()
    batchSpan.SetTag("batch.tool_calls_count", len(toolCalls))
    batchSpan.SetTag("batch.parallel", false) // 目前实现是串行
    successCount := 0
    failCount := 0
    defer func() {
        batchSpan.SetTag("batch.success_count", successCount)
        batchSpan.SetTag("batch.fail_count", failCount)
    }()

    // 原有 toolMessages / currentRoundKeys 定义
    toolMessages := make([]llm.Message, 0, len(toolCalls))
    currentRoundKeys := make([]string, 0, len(toolCalls))

    for _, toolCall := range toolCalls {
        // === 【tracing 新增】每次 tool 用匿名函数包裹 ===
        func() {
            // 决定 SpanType：SubagentTool → SUBAGENT_CALL
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
            toolSpan.SetTag("tool.arguments", toolCall.Arguments)
            toolSpan.AddLog("INFO", "tool.invoke.start", nil)
            _ = toolCtx

            // 原有 tool 主体逻辑：从 select ctx.Done() 到最后 append toolMessages
            //   在失败分支：toolSpan.SetError(err) / AddLog(ERROR)
            //   熔断触发时：toolSpan.SetTag("tool.circuit_breaker.trigger", true) + AddLog("WARN","tool.circuit_breaker.open",nil)
            //   HITL 分支：toolSpan.SetTag("tool.hitl.required", true) + AddLog("INFO","tool.hitl.requested",...)
            //   决策后：toolSpan.SetTag("tool.hitl.decision", string(decision.Kind)) + AddLog("INFO","tool.hitl.decided",...)
            //   工具类型：toolSpan.SetTag("tool.type", tool.ProviderName()) 或按现有 tool 分类

            // 结束时按 result.Success 更新 successCount / failCount，并写 tool.result_size / tool.result_preview
        }()
        // ==================================================
    }

    a.circuitBreaker.StartNewRound(currentRoundKeys)
    return toolMessages
}
```

**注意**：由于原函数体较长（150 行），实施时**不必**把全部逻辑塞进匿名函数——可以把 tool span 的生命周期用匿名函数包裹**一小段核心区**（Start → 各分支写 tag → End），主逻辑保持原样即可。真正关键的是**每轮循环独立的 span 生命周期**通过匿名函数的 defer 保证。

一个更清晰的模式：

```go
for _, toolCall := range toolCalls {
    // 提取一个内联函数处理"单个 tool + 埋点"
    tm := a.invokeOneToolWithTracing(ctx, toolCall, toolCalls, &currentRoundKeys, eventCh, &successCount, &failCount)
    toolMessages = append(toolMessages, tm...)
    // 若 tm 里含 abort 标记则 return（保留原来 HITL 拒绝/超时/取消的 early return 语义）
}
```

具体如何拆分函数由 Agent 实施时读代码决定；plan 的强约束是：**tool span 必须逐个独立 End，不能全部堆到 InvokeToolCalls 结束才 End**。

- [ ] **Step 3.4.2：确保 `import "mooc-manus/internal/domains/services/tools"` 已存在**

（若原文件已 import，则跳过。SubagentTool 类型断言需要此 import。）

- [ ] **Step 3.4.3：编译验证**

```bash
cd mooc-manus && go build ./...
```

- [ ] **Step 3.4.4：Commit**

```bash
git add mooc-manus/internal/domains/services/agents/base.go
git commit -m "feat(tracing): InvokeToolCalls 埋 TOOL_BATCH + 循环体内 TOOL_CALL/SUBAGENT_CALL"
```

---

## Phase 4：查询 API（Handler + Application Service + DTO）

### Task 4.1：DTO 定义

**Files:**
- Create: `mooc-manus/internal/applications/dtos/trace.go`

- [ ] **Step 4.1.1：实现 DTO**

```go
// mooc-manus/internal/applications/dtos/trace.go
package dtos

import "mooc-manus/internal/domains/models/tracing"

type TraceDetailDTO struct {
    TraceID        string             `json:"trace_id"`
    ConversationID string             `json:"conversation_id"`
    AgentName      string             `json:"agent_name"`
    StartTime      int64              `json:"start_time"`
    EndTime        int64              `json:"end_time"`
    DurationMs     int32              `json:"duration_ms"`
    IsError        bool               `json:"is_error"`
    SpanCount      int32              `json:"span_count"`
    Root           *tracing.SpanNode  `json:"root"`
}

type TraceSummaryDTO struct {
    TraceID          string `json:"trace_id"`
    ConversationID   string `json:"conversation_id"`
    AgentName        string `json:"agent_name"`
    StartTime        int64  `json:"start_time"`
    DurationMs       int32  `json:"duration_ms"`
    SpanCount        int32  `json:"span_count"`
    IsError          bool   `json:"is_error"`
    UserQueryPreview string `json:"user_query_preview"`
}

type TraceListDTO struct {
    Total    int64              `json:"total"`
    Page     int                `json:"page"`
    PageSize int                `json:"page_size"`
    Traces   []*TraceSummaryDTO `json:"traces"`
}

type TraceListRequest struct {
    ConversationID  string `form:"conversation_id"`
    AgentName       string `form:"agent_name"`
    IsError         *bool  `form:"is_error"`
    StartTimeFrom   int64  `form:"start_time_from"`
    StartTimeTo     int64  `form:"start_time_to"`
    Page            int    `form:"page"`
    PageSize        int    `form:"page_size"`
}
```

- [ ] **Step 4.1.2：Commit**

```bash
git add mooc-manus/internal/applications/dtos/trace.go
git commit -m "feat(tracing): 新增 TraceDetailDTO / TraceListDTO"
```

### Task 4.2：TraceApplicationService

**Files:**
- Create: `mooc-manus/internal/applications/services/trace.go`
- Create: `mooc-manus/internal/applications/services/trace_test.go`

- [ ] **Step 4.2.1：编写 Application Service 单测**

```go
// mooc-manus/internal/applications/services/trace_test.go
package services

import (
    "context"
    "errors"
    "testing"

    "github.com/stretchr/testify/assert"

    "mooc-manus/internal/domains/models/tracing"
)

type fakeSpanRepo struct {
    nodes []*tracing.SpanNode
    err   error
    list  []*tracing.TraceSummary
}

func (r *fakeSpanRepo) BatchInsert(context.Context, []*tracing.Span) error { return nil }
func (r *fakeSpanRepo) FindByTraceID(_ context.Context, _ string) ([]*tracing.SpanNode, error) {
    return r.nodes, r.err
}
func (r *fakeSpanRepo) ListTraces(context.Context, tracing.TraceFilter, int, int) ([]*tracing.TraceSummary, int64, error) {
    return r.list, int64(len(r.list)), nil
}

func TestTraceService_GetTraceDetail_HappyPath(t *testing.T) {
    repo := &fakeSpanRepo{
        nodes: []*tracing.SpanNode{
            {SpanID: 0, ParentSpanID: -1, SpanType: string(tracing.SpanTypeAgentRoot), StartTime: 100, EndTime: 200, LatencyMs: 100, Tags: map[string]interface{}{}},
            {SpanID: 1, ParentSpanID: 0, SpanType: string(tracing.SpanTypeAgentRound), Tags: map[string]interface{}{}, IsError: true},
        },
    }
    svc := NewTraceApplicationService(repo)
    dto, err := svc.GetTraceDetail(context.Background(), "t1")
    assert.NoError(t, err)
    assert.Equal(t, int32(2), dto.SpanCount)
    assert.True(t, dto.IsError) // 顶层 = 任意 span 错误
    assert.Equal(t, int32(0), dto.Root.SpanID)
    assert.Len(t, dto.Root.Children, 1)
}

func TestTraceService_GetTraceDetail_NotFound(t *testing.T) {
    repo := &fakeSpanRepo{nodes: nil}
    svc := NewTraceApplicationService(repo)
    _, err := svc.GetTraceDetail(context.Background(), "t1")
    assert.ErrorIs(t, err, ErrTraceNotFound)
}

func TestTraceService_GetTraceDetail_RepoErr(t *testing.T) {
    repo := &fakeSpanRepo{err: errors.New("db down")}
    svc := NewTraceApplicationService(repo)
    _, err := svc.GetTraceDetail(context.Background(), "t1")
    assert.Error(t, err)
}
```

- [ ] **Step 4.2.2：实现 Application Service**

```go
// mooc-manus/internal/applications/services/trace.go
package services

import (
    "context"
    "errors"

    "mooc-manus/internal/applications/dtos"
    "mooc-manus/internal/domains/models/tracing"
)

var ErrTraceNotFound = errors.New("trace not found")

type TraceApplicationService interface {
    GetTraceDetail(ctx context.Context, traceID string) (*dtos.TraceDetailDTO, error)
    ListTraces(ctx context.Context, req dtos.TraceListRequest) (*dtos.TraceListDTO, error)
}

type TraceApplicationServiceImpl struct {
    repo tracing.SpanRepository
}

func NewTraceApplicationService(repo tracing.SpanRepository) TraceApplicationService {
    return &TraceApplicationServiceImpl{repo: repo}
}

func (s *TraceApplicationServiceImpl) GetTraceDetail(ctx context.Context, traceID string) (*dtos.TraceDetailDTO, error) {
    nodes, err := s.repo.FindByTraceID(ctx, traceID)
    if err != nil {
        return nil, err
    }
    if len(nodes) == 0 {
        return nil, ErrTraceNotFound
    }
    root, err := tracing.BuildSpanTree(nodes)
    if err != nil {
        return nil, err
    }
    anyErr := false
    for _, n := range nodes {
        if n.IsError {
            anyErr = true
            break
        }
    }
    // 顶层元信息从 root 派生
    var convID, agentName string
    for _, n := range nodes {
        if n.SpanID == 0 && n.ParentSpanID == -1 {
            if v, ok := n.Tags["conversation_id"].(string); ok {
                convID = v
            }
            if v, ok := n.Tags["agent.name"].(string); ok {
                agentName = v
            }
        }
    }
    return &dtos.TraceDetailDTO{
        TraceID:        traceID,
        ConversationID: convID,
        AgentName:      agentName,
        StartTime:      root.StartTime,
        EndTime:        root.EndTime,
        DurationMs:     root.LatencyMs,
        IsError:        anyErr,
        SpanCount:      int32(len(nodes)),
        Root:           root,
    }, nil
}

func (s *TraceApplicationServiceImpl) ListTraces(ctx context.Context, req dtos.TraceListRequest) (*dtos.TraceListDTO, error) {
    filter := tracing.TraceFilter{
        ConversationID: req.ConversationID,
        AgentName:      req.AgentName,
        IsError:        req.IsError,
        StartTimeFrom:  req.StartTimeFrom,
        StartTimeTo:    req.StartTimeTo,
    }
    page, pageSize := req.Page, req.PageSize
    if page < 1 {
        page = 1
    }
    if pageSize < 1 || pageSize > 100 {
        pageSize = 20
    }
    list, total, err := s.repo.ListTraces(ctx, filter, page, pageSize)
    if err != nil {
        return nil, err
    }
    out := make([]*dtos.TraceSummaryDTO, 0, len(list))
    for _, t := range list {
        out = append(out, &dtos.TraceSummaryDTO{
            TraceID:          t.TraceID,
            ConversationID:   t.ConversationID,
            AgentName:        t.AgentName,
            StartTime:        t.StartTime,
            DurationMs:       t.DurationMs,
            SpanCount:        t.SpanCount,
            IsError:          t.IsError,
            UserQueryPreview: t.UserQueryPreview,
        })
    }
    return &dtos.TraceListDTO{
        Total:    total,
        Page:     page,
        PageSize: pageSize,
        Traces:   out,
    }, nil
}
```

- [ ] **Step 4.2.3：运行测试通过**

```bash
cd mooc-manus && go test ./internal/applications/services/ -run TestTraceService -race -v
```

- [ ] **Step 4.2.4：Commit**

```bash
git add mooc-manus/internal/applications/services/trace.go mooc-manus/internal/applications/services/trace_test.go
git commit -m "feat(tracing): 新增 TraceApplicationService（详情 + 列表 + 顶层聚合）"
```

### Task 4.3：Handler + 路由注册

**Files:**
- Create: `mooc-manus/api/handlers/trace.go`
- Create: `mooc-manus/api/handlers/trace_test.go`
- Modify: `mooc-manus/api/routers/route.go`

- [ ] **Step 4.3.1：实现 Handler**

```go
// mooc-manus/api/handlers/trace.go
package handlers

import (
    "errors"
    "net/http"

    "github.com/gin-gonic/gin"

    "mooc-manus/internal/applications/dtos"
    "mooc-manus/internal/applications/services"
)

type TraceHandler struct {
    svc services.TraceApplicationService
}

func NewTraceHandler(svc services.TraceApplicationService) *TraceHandler {
    return &TraceHandler{svc: svc}
}

func (h *TraceHandler) GetDetail(c *gin.Context) {
    traceID := c.Param("trace_id")
    if traceID == "" {
        c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_PARAM", "message": "trace_id required"})
        return
    }
    dto, err := h.svc.GetTraceDetail(c.Request.Context(), traceID)
    if err != nil {
        if errors.Is(err, services.ErrTraceNotFound) {
            c.JSON(http.StatusNotFound, gin.H{"code": "TRACE_NOT_FOUND"})
            return
        }
        c.JSON(http.StatusInternalServerError, gin.H{"code": "INTERNAL_ERROR"})
        return
    }
    c.JSON(http.StatusOK, dto)
}

func (h *TraceHandler) List(c *gin.Context) {
    var req dtos.TraceListRequest
    if err := c.ShouldBindQuery(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_PARAM", "message": err.Error()})
        return
    }
    dto, err := h.svc.ListTraces(c.Request.Context(), req)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"code": "INTERNAL_ERROR"})
        return
    }
    c.JSON(http.StatusOK, dto)
}
```

- [ ] **Step 4.3.2：Handler 单测（httptest）**

```go
// mooc-manus/api/handlers/trace_test.go
package handlers

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/stretchr/testify/assert"

    "mooc-manus/internal/applications/dtos"
    "mooc-manus/internal/applications/services"
    "mooc-manus/internal/domains/models/tracing"
)

type stubSvc struct {
    detail *dtos.TraceDetailDTO
    err    error
}

func (s *stubSvc) GetTraceDetail(context.Context, string) (*dtos.TraceDetailDTO, error) {
    return s.detail, s.err
}
func (s *stubSvc) ListTraces(context.Context, dtos.TraceListRequest) (*dtos.TraceListDTO, error) {
    return &dtos.TraceListDTO{Total: 0, Traces: nil}, s.err
}

func setup(svc services.TraceApplicationService) *gin.Engine {
    gin.SetMode(gin.TestMode)
    r := gin.New()
    h := NewTraceHandler(svc)
    r.GET("/api/trace/:trace_id", h.GetDetail)
    r.GET("/api/traces", h.List)
    return r
}

func TestTraceHandler_GetDetail_200(t *testing.T) {
    svc := &stubSvc{detail: &dtos.TraceDetailDTO{TraceID: "t1", Root: &tracing.SpanNode{SpanID: 0, ParentSpanID: -1}}}
    r := setup(svc)
    w := httptest.NewRecorder()
    req, _ := http.NewRequest(http.MethodGet, "/api/trace/t1", nil)
    r.ServeHTTP(w, req)
    assert.Equal(t, 200, w.Code)
    var body dtos.TraceDetailDTO
    assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
    assert.Equal(t, "t1", body.TraceID)
}

func TestTraceHandler_GetDetail_404(t *testing.T) {
    svc := &stubSvc{err: services.ErrTraceNotFound}
    r := setup(svc)
    w := httptest.NewRecorder()
    req, _ := http.NewRequest(http.MethodGet, "/api/trace/nope", nil)
    r.ServeHTTP(w, req)
    assert.Equal(t, 404, w.Code)
}

func TestTraceHandler_List_200(t *testing.T) {
    svc := &stubSvc{}
    r := setup(svc)
    w := httptest.NewRecorder()
    req, _ := http.NewRequest(http.MethodGet, "/api/traces?page=1&page_size=20", nil)
    r.ServeHTTP(w, req)
    assert.Equal(t, 200, w.Code)
}
```

- [ ] **Step 4.3.3：修改 `route.go` 装配 Tracer + Handler**

在 `InitRouter` 内：

- Repository 层新增 `aiSpanRepo := repositories.NewAiSpanRepository()`
- 在 Domain Service 层初始化之前新增：
  ```go
  tracer := tracing.NewTracer(aiSpanRepo)
  tracing.SetGlobal(tracer)
  // 应用退出时 Shutdown（可放到 main.go graceful shutdown 钩子中）
  ```
- Application Service 层新增 `traceAppSvc := app_svc.NewTraceApplicationService(aiSpanRepo)`
- Handler 层新增 `traceHandler := handlers.NewTraceHandler(traceAppSvc)`
- 路由注册段追加：
  ```go
  trace := r.Group("/api")
  {
      trace.GET("/trace/:trace_id", traceHandler.GetDetail)
      trace.GET("/traces", traceHandler.List)
  }
  ```

导入新包：`"mooc-manus/internal/domains/models/tracing"`。

- [ ] **Step 4.3.4：Tracer graceful shutdown**

**Files:** `mooc-manus/main.go`

在 gin server graceful shutdown 段（若已有 `signal.Notify(SIGTERM)` 处理），追加：

```go
if t := tracing.Global(); t != nil {
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    if err := t.Shutdown(shutdownCtx); err != nil {
        logger.Warn("tracer shutdown timeout", zap.Error(err))
    }
}
```

若 `main.go` 未做 graceful shutdown，则跳过此步（Tracer 靠 defer 结构在正常路径已经能 flush；进程 kill 时会丢缓冲）。**遗留项**：main.go graceful shutdown 建议后续独立迭代。

- [ ] **Step 4.3.5：编译 + 测试**

```bash
cd mooc-manus && go build ./... && go test ./api/handlers/ -run TestTraceHandler -race -v
```

- [ ] **Step 4.3.6：Commit**

```bash
git add mooc-manus/api/handlers/trace.go mooc-manus/api/handlers/trace_test.go mooc-manus/api/routers/route.go mooc-manus/main.go
git commit -m "feat(tracing): 新增 /api/trace/:id + /api/traces 路由，route.go 装配 Tracer 单例"
```

---

## Phase 5：Application 集成测试

### Task 5.1：Chat 主流程 span 结构断言

**Files:**
- Create: `mooc-manus/internal/applications/services/agent_tracing_integration_test.go`

- [ ] **Step 5.1.1：编写集成测试**

参考现有 `agent_hitl_integration_test.go` 的 mock 组装模式，构造：
- Mock `invoker.Invoker`：可预设返回 tool_calls 序列
- Mock tool：可预设成功/失败
- Real Tracer + In-memory `SpanRepository`（重用测试用 `fakeRepo`）

```go
// mooc-manus/internal/applications/services/agent_tracing_integration_test.go
package services

import (
    "context"
    "sync"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"

    "mooc-manus/internal/domains/models/tracing"
)

// captureRepo 捕获所有 BatchInsert 的 span，用于断言
type captureRepo struct {
    mu    sync.Mutex
    spans []*tracing.Span
}

func (r *captureRepo) BatchInsert(_ context.Context, spans []*tracing.Span) error {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.spans = append(r.spans, spans...)
    return nil
}
func (r *captureRepo) FindByTraceID(context.Context, string) ([]*tracing.SpanNode, error) { return nil, nil }
func (r *captureRepo) ListTraces(context.Context, tracing.TraceFilter, int, int) ([]*tracing.TraceSummary, int64, error) {
    return nil, 0, nil
}

// 用例 1：1 轮 LLM → 2 个 tool → 1 轮 LLM 结束 → span 数 = 8
func TestChat_HappyPath_SpanStructure(t *testing.T) {
    repo := &captureRepo{}
    tr := tracing.NewTracer(repo,
        tracing.WithBatchSize(1),
        tracing.WithFlushInterval(50*time.Millisecond),
        tracing.WithBufferCapacity(1000))
    tracing.SetGlobal(tr)
    defer func() {
        _ = tr.Shutdown(context.Background())
        tracing.SetGlobal(nil)
    }()

    // TODO: 组装 BaseAgentDomainService mock + 触发 Chat（参考 agent_hitl_integration_test.go）
    // 断言：
    //   1) captureRepo.spans 数 = 8（1 root + 2 round + 2 llm + 1 batch + 2 tool）
    //   2) parent_span_id 结构正确
    //   3) root.Tags 里 conversation_id / user.query / agent.name / tools_count 齐全
}

// 用例 2：某 tool 失败 → 该 tool span is_error=true，父 span 全 false
func TestChat_ToolError_IsErrorFlag(t *testing.T) { /* TODO */ }

// 用例 3：ctx cancel 中止对话 → root span 被 End + logs 含 agent.context_cancelled
func TestChat_ContextCancel_RootSpanClosed(t *testing.T) { /* TODO */ }

// 用例 4：超过 max iterations → root span is_error + logs 含 agent.max_iterations_exceeded
func TestChat_MaxIterationsExceeded_RootIsError(t *testing.T) { /* TODO */ }

// 用例 5：dangerous 风险 tool + approve → tool span tags 里 hitl.required=true / decision=approve
func TestChat_HITLDangerousTool_SpanTags(t *testing.T) { /* TODO */ }

// 用例 6：subagent 调用 → span_type=SUBAGENT_CALL
func TestChat_SubagentCall_SpanType(t *testing.T) { /* TODO */ }

// 用例 7：缓冲区满不阻塞业务
func TestChat_TracerBufferFull_BusinessUnaffected(t *testing.T) {
    repo := &captureRepo{}
    tr := tracing.NewTracer(repo,
        tracing.WithBatchSize(100),
        tracing.WithFlushInterval(time.Hour), // 禁用 timer flush
        tracing.WithBufferCapacity(1))         // 仅容 1 个
    tracing.SetGlobal(tr)
    defer func() { _ = tr.Shutdown(context.Background()); tracing.SetGlobal(nil) }()

    // TODO: 组装 mock 触发 Chat（8 个 span）
    // 断言：
    //   1) Chat 正常返回、事件流完整
    //   2) tr.DroppedCount() >= 7
}

// 用例 8：AGENT_ROUND parent 全部指向 root（防 ctx 覆盖回归）
func TestChat_LoopContextPropagation_RoundParentIsRoot(t *testing.T) {
    // 组装 mock 让 chat 至少走 2 轮 ReAct
    // 断言：所有 AGENT_ROUND span 的 ParentSpanID == 0
}
```

**说明**：具体 mock 组装依赖现有的 `agent_hitl_integration_test.go` / `agent_stop_test.go` 里的 `testhelpers`。实施 agent 需先读这些 helpers 再复用它们的 mock invoker/tool 骨架。

- [ ] **Step 5.1.2：跑集成测试**

```bash
cd mooc-manus && go test ./internal/applications/services/ -run TestChat_ -race -v
```

**说明**：如果本轮实施只能补上骨架不能全部 mock，也需保证**至少两条用例（HappyPath + LoopContextPropagation）跑通**，其余用例可留 `t.Skip("TODO")`；但必须在下一次迭代补齐。

- [ ] **Step 5.1.3：Commit**

```bash
git add mooc-manus/internal/applications/services/agent_tracing_integration_test.go
git commit -m "test(tracing): 新增 Chat 主流程 tracing 集成测试（8 用例，含 2 骨架必须通过）"
```

---

## Phase 6：E2E 手动验证（配套文档）

### Task 6.1：撰写 e2e 验证文档

**Files:**
- Create: `docs/superpowers/plans/2026-07-14-agent-tracing-e2e.md`

- [ ] **Step 6.1.1：撰写 e2e 验证文档（内容见下方"E2E 验证文档"章节）**

- [ ] **Step 6.1.2：Commit**

```bash
git add docs/superpowers/plans/2026-07-14-agent-tracing-e2e.md
git commit -m "docs(tracing): 新增 agent-tracing 端到端手动验证文档"
```

---

## Phase 7：全量回归 & 性能对比

### Task 7.1：跑全项目测试

- [ ] **Step 7.1.1：执行全测**

```bash
cd mooc-manus && go test ./... -race -count=1
```
Expected: 所有既有测试保持 PASS（HITL / 子智能体 / 熔断 等）

- [ ] **Step 7.1.2：goroutine 泄漏检查**

```bash
cd mooc-manus && go test ./internal/domains/models/tracing/ -run TestTracer_Shutdown -race -v -count=3
```
Expected: 3 次运行都 PASS，观察是否有 goroutine 遗留（可选装 goleak）

### Task 7.2：性能对比压测

- [ ] **Step 7.2.1：基线**

在**本改动前**的 commit（e.g., `git stash`）跑一次典型 chat 压测（curl 循环 100 次），记录 P50/P99 时延。

- [ ] **Step 7.2.2：改动后**

回到当前 branch，同参数再跑一次，对比新增时延；目标：**端到端 P50 增加 ≤ 5%**（见 spec §7.5）。

- [ ] **Step 7.2.3：（若不达标）调优**

- 若 P50 恶化明显：优先检查 `SetTag`/`AddLog` 频率、正则匹配开销
- 增大 flush 批 / 缓冲区
- 减少非必要 tags

- [ ] **Step 7.2.4：记录压测结果到 e2e 文档末尾**

---

## E2E 验证文档

> 该章节将作为独立文件 `docs/superpowers/plans/2026-07-14-agent-tracing-e2e.md` 提交（Phase 6 Task 6.1）。

### 前置条件

- 本地 PostgreSQL 已应用 `manus_schema.sql` 最新版本（含 `ai_span` 表）
- `config/config.toml` 里 PostgreSQL 连接字符串正确
- 依赖服务（Redis / Docker for skill executor）正常
- 后端：`cd mooc-manus && go run main.go`
- 前端可选：`cd mooc-manus-web && npm run dev`（本期不动前端，用 curl 即可）

### 用例 A：Happy Path（典型对话）

**目标**：验证一次成功 chat 产出完整 span 树，落盘到 `ai_span`，查询 API 返回嵌套树。

**步骤**：

1. 发起 chat（curl，需替换实际 model）：

```bash
curl -N -X POST http://localhost:8080/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "conversationId": "e2e-happy-'"$(date +%s)"'",
    "query": "帮我读取一下当前目录下 README.md 的前 20 行",
    "systemPrompt": "你是一个工程助手，善用 fileRead。",
    "toolIds": ["<fileRead 工具 id>"]
  }'
```

2. 从响应 SSE 里抓 `messageId`（即 `trace_id`），记为 `TID`。

3. 数据库校验：

```sql
SELECT span_id, parent_span_id, span_type, operation_name, latency_ms, is_error
FROM ai_span
WHERE trace_id = 'TID'
ORDER BY span_id ASC;
```

**期望**：
- 至少一行 `AGENT_ROOT`（span_id=0, parent=-1）
- 至少一行 `AGENT_ROUND` parent=0
- 至少一对 `LLM_CALL` / `TOOL_BATCH` parent 是同一个 ROUND
- `TOOL_CALL` operation_name = `fileRead`
- 所有 `is_error = false`
- `latency_ms > 0`

4. 查询 API 校验：

```bash
curl http://localhost:8080/api/trace/TID | jq
```

**期望**：
- HTTP 200
- 顶层 `is_error=false`、`span_count` ≥ 5
- `root.span_type = "AGENT_ROOT"`、`root.children[0].span_type = "AGENT_ROUND"`
- 树结构：ROUND 下同时含 LLM_CALL 和 TOOL_BATCH（若有 tool 调用）
- `root.tags` 含 `agent.name`、`user.query`、`conversation_id`、`system_prompt.hash`

### 用例 B：工具错误路径

**目标**：验证 tool 失败时叶子 span 标红，父 span 不冒泡。

**步骤**：

1. 发起 chat，引导 LLM 调用一个必然失败的工具（例如 fileRead 不存在的路径）：

```bash
curl -N -X POST http://localhost:8080/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"conversationId":"e2e-err-'"$(date +%s)"'","query":"读取 /tmp/definitely-not-exists.txt","toolIds":["<fileRead id>"]}'
```

2. 查询 API：

```bash
curl http://localhost:8080/api/trace/TID | jq '.root.children[0].children[] | {span_type, is_error, tags}'
```

**期望**：
- 至少一个 `TOOL_CALL` 的 `is_error=true`
- `TOOL_BATCH` 的 `is_error=false`（不冒泡）
- `AGENT_ROUND` / `AGENT_ROOT` 的 `is_error=false`
- 顶层聚合 `is_error=true`（`GET /api/trace/:trace_id` 响应的顶层）
- tool span 的 `logs` 含 `ERROR` 级 entry

### 用例 C：熔断触发

**目标**：验证熔断触发时 tool span 记录 `tool.circuit_breaker.trigger=true` 且 logs 有 `tool.circuit_breaker.open`。

**步骤**：

1. 构造场景：让同一 tool 反复失败（例如连续 3 次调用不存在的 skill）
2. 数据库：

```sql
SELECT span_id, tags->>'tool.circuit_breaker.trigger' AS cb_trigger, logs
FROM ai_span
WHERE trace_id = 'TID' AND span_type = 'TOOL_CALL';
```

**期望**：其中至少一行 `cb_trigger = 'true'`，`logs` 里含 `tool.circuit_breaker.open`。

### 用例 D：HITL dangerous 工具审批

**目标**：验证 HITL 分支的 tool span 采集了 `tool.hitl.required=true` 与 `tool.hitl.decision`。

**步骤**：

1. 触发一个 dangerous 风险 tool（比如 bashExec 高危命令）
2. 通过 `/api/agent/resume` 批准或拒绝
3. 查询 API：

```bash
curl http://localhost:8080/api/trace/TID | jq '.root.children[].children[] | select(.span_type=="TOOL_CALL") | .tags'
```

**期望**：`tool.hitl.required=true`，`tool.hitl.decision` 是 `approve` / `reject` / `timeout` / `cancel` 之一，且 logs 含 `tool.hitl.requested` 和 `tool.hitl.decided`。

### 用例 E：子智能体调用

**目标**：验证 SubagentTool 产出 `SUBAGENT_CALL` 类型 span。

**步骤**：

1. 在 PlanMode 下发起 chat，让主智能体派发子任务（参考 `2026-07-12-subagents-implementation.md` 的验证用例）
2. 查询：

```sql
SELECT span_id, parent_span_id, span_type, operation_name
FROM ai_span
WHERE trace_id = 'TID' AND span_type = 'SUBAGENT_CALL';
```

**期望**：至少一行 `span_type = 'SUBAGENT_CALL'`，`operation_name` 是子智能体入口 tool 名。

### 用例 F：Stop 按钮 / context cancel

**目标**：验证 chat 中途 stop 时 root span 被 End、logs 含 `agent.context_cancelled`。

**步骤**：

1. 发起长 chat（触发工具执行）
2. 立即调用 `/api/agent/message/stop`（传 messageId）
3. 查询：

```bash
curl http://localhost:8080/api/trace/TID | jq '.root.logs, .duration_ms'
```

**期望**：`duration_ms` 存在（root 有 EndTime），logs 里出现 `agent.context_cancelled`。

### 用例 G：列表 API

**目标**：验证 `GET /api/traces` 分页、筛选。

**步骤**：

1. 发若干 chat 请求（成功 + 失败混合，同一 conversation_id）
2. 请求：

```bash
curl "http://localhost:8080/api/traces?page=1&page_size=10&conversation_id=e2e-err"
```

**期望**：`total` > 0，`traces` 数组每行含 `trace_id`、`is_error`、`user_query_preview`。

3. `is_error=true` 筛选：

```bash
curl "http://localhost:8080/api/traces?is_error=true&page=1&page_size=10"
```

**期望**：全部 `is_error=true`。

### 用例 H：缓冲区满不阻塞（压测）

**目标**：验证 tracing 缓冲区打满时业务 chat 依然完整返回。

**步骤**：

1. 临时把 `WithBufferCapacity(2)` 覆盖（可在 route.go 里改成很小容量，验证后回滚）
2. 循环发 50 个 chat 请求
3. 观察：所有 chat 均正常返回 SSE，`tracer.DroppedCount()` > 0（日志里能看到 `tracing buffer full, dropping span` Warn）
4. **验证完毕后回滚 route.go 的临时改动**

### 用例 I：性能对比

**步骤**：

1. 基线：`git stash` 回退本改动，跑 100 次 chat，记录 P50/P99
2. 恢复改动：`git stash pop`，重跑
3. 对比 P50/P99 增幅，**目标 ≤ 5%**

### 验证结果记录模板

在本文件末尾追加：

```
## 验证记录

- **执行人**：XXX
- **日期**：YYYY-MM-DD
- **PostgreSQL 版本**：X.Y
- **用例 A 结果**：Pass / Fail（附截图或 SQL 查询结果）
- **用例 B 结果**：...
- ...
- **性能对比**：P50 baseline=XXms, after=YYms, delta=Z%
```

---

## 收尾

- [ ] 所有 Phase 完成 → 更新 `docs/superpowers/plans/INDEX.md`（如需）
- [ ] 更新 `.harness/plans/` 索引（若维护）
- [ ] 打 tag / PR

**遗留项**（后续独立迭代）：

1. 前端可视化瀑布图
2. `main.go` graceful shutdown（若未在本期落地）
3. PlanAgent / A2AAgent 埋点覆盖
4. 分区 / 归档策略
5. OTel 协议兼容
6. token 用量硬性上报（依赖 invoker.Invoker 接口暴露 usage 字段）


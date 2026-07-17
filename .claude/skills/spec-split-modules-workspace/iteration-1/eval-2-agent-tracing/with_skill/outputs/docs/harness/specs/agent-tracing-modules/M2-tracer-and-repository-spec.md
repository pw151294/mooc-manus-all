# M2 Tracer 与批量落盘模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块编号**：M2
**依赖**：M1（Span/LogEntry/SpanRepository 接口 + DDL）
**被依赖**：M3、M4

---

## 1. 模块范围

实现 Tracer 服务本身与 MySQL 版本的 SpanRepository。交付后系统具备"若有人往 Tracer 提交 span，
Tracer 会做缓冲 → 批量 flush → 落到 `ai_span` 表"的完整能力；同时提供 Domain 层埋点入口
（`StartSpanFromContext` / `SpanFromContext` 等包级函数）。本模块自身不产 span，只提供工具。

### 1.1 交付物

- Tracer 服务：
  - `internal/domains/models/tracing/tracer.go`
    - `Tracer` 结构体：`repo` / `buffer chan *Span` / `batchSize` / `flushInterval` / `dropCounter atomic.Int64` / `shutdown chan struct{}` / `wg sync.WaitGroup` / `traceCounters sync.Map`
    - 构造函数 `NewTracer(repo SpanRepository, opts ...Option) *Tracer`
    - Option 函数：`WithBufferSize`、`WithBatchSize`、`WithFlushInterval`
    - `StartRootSpan(ctx, traceID) (context.Context, *Span)`：span_id=0、parent=-1
    - `StartSpan(ctx, spanType, opName) (context.Context, *Span)`：从 ctx 取 parent 派生
    - `Shutdown(ctx) error`：flush 剩余 span + close goroutine
    - `commit(s *Span)`：非阻塞写 buffer，满则 `dropCounter++`
    - 后台 flush goroutine：`batchSize` 达阈值 or `flushInterval` 到期 → `repo.BatchInsert`
  - Span 方法补齐（承接 M1 的骨架）：`End()` 内部 `ended.CompareAndSwap` 幂等 + 计算 LatencyMs + `tracer.commit(s)`；`SetError(err)` 内部 `IsError=true` + `AddLog("ERROR", err.Error(), ...)`
- 包级单例便利函数：
  - `internal/domains/models/tracing/global.go`
    - `SetGlobal(t *Tracer)` / `Global() *Tracer`
    - `StartSpanFromContext(ctx, spanType, opName) (context.Context, *Span)`：委托 `Global()`；`Global()` 为 nil 时返回 no-op Span
    - `SpanFromContext(ctx) *Span`：ctx 无 span 返回 no-op（不 panic）
    - ctx key 类型：`type spanCtxKey struct{}`
- Repository 实现：
  - `internal/infra/repositories/ai_span_repository.go`
    - `AISpanRepository` 结构体（持有 `*gorm.DB` 或对齐项目现有 DB 抽象）
    - `PO`（`AISpan`）与 domain `Span`/`SpanNode` 的转换（tags/logs JSON marshal/unmarshal）
    - `BatchInsert`：单条 `INSERT ... VALUES (...), (...), ...`；失败落 zap warn 日志，不上抛
    - `FindByTraceID`：`SELECT ... WHERE trace_id = ? ORDER BY span_id ASC`
    - `List`：分页 + 过滤条件 + `COUNT` 聚合 total
- 路由生命周期接线：
  - `api/routers/route.go` `InitRouter` 内新增：
    - 初始化 `AISpanRepository`
    - 初始化 `tracing.NewTracer(repo, ...)`
    - `tracing.SetGlobal(tracer)`
    - 注册 graceful shutdown hook：`tracer.Shutdown(ctx)`
- 单元测试：
  - `internal/domains/models/tracing/tracer_test.go`（父规格 §8.2 用例 1–14 全量）
  - `internal/infra/repositories/ai_span_repository_test.go`（用例见父规格 §8.4，无 MySQL 环境时用 sqlmock 或跳过）

### 1.2 非目标

- 不做埋点（属 M3）
- 不做查询 API（属 M4）
- 不做树构建（`BuildSpanTree` 属 M4）
- 不做 profiling / 压测（M3 e2e 阶段做）

---

## 2. 核心设计切片

### 2.1 Tracer 生命周期

见父规格 §2.3、§4.1。关键 API：

```go
func NewTracer(repo SpanRepository, opts ...Option) *Tracer
func (t *Tracer) StartRootSpan(ctx context.Context, traceID string) (context.Context, *Span)
func (t *Tracer) StartSpan(ctx context.Context, spanType SpanType, opName string) (context.Context, *Span)
func (t *Tracer) Shutdown(ctx context.Context) error
func (t *Tracer) commit(s *Span)
```

`StartRootSpan` 初始化 `traceCounters` 中的 counter；`StartSpan` 通过 `sync.Map.Load` 拿到 counter 并 `Add(1)`
获取新 span_id。commit 走 `select { case buf <- s: default: dropCounter.Add(1) }`。

### 2.2 缓冲区与 flush 策略

- 缓冲区默认容量 10000
- batch 默认 100
- flush 触发条件：`len(pending) >= batchSize` 或 `<-time.After(flushInterval)`（5s）
- flush goroutine 收到 `<-shutdown` → drain 剩余 + `repo.BatchInsert` → 退出

### 2.3 Shutdown 契约

- `Shutdown` 内部 `close(t.shutdown)` + `t.wg.Wait()` + `traceCounters` 清理
- 确保不 leak goroutine（`goleak` 用例覆盖）

### 2.4 包级单例与 ctx 传递

- ctx key 用私有 struct：`type spanCtxKey struct{}` → 防止跨包冲突
- `StartSpanFromContext` 依赖 `Global()` 单例；未 `SetGlobal` 时所有埋点返回 no-op（**保证 Application 层单测不必初始化 Tracer**）

### 2.5 Repository 实现

- 表名：`ai_span`（DDL 由 M1 交付）
- Tags/Logs 序列化：`json.Marshal(m map[string]interface{}) → []byte → string`；反序列化对称
- BatchInsert 使用一条多 VALUES 的 INSERT；避免逐条 INSERT
- 失败降级：日志记录、drop 计数（不影响业务链路 —— 落盘失败不上抛给 Tracer commit 侧）

---

## 3. 数据流

```
埋点侧（M3 未来接入）
      │
      ▼  StartSpanFromContext(...) / span.End()
   Tracer.commit(s)                        ← 非阻塞、满则 drop
      │
      ▼  buffer chan
   flush goroutine（每 5s 或达 100 条触发）
      │
      ▼  SpanRepository.BatchInsert
   MySQL ai_span 表
```

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 内存缓冲 + 异步批量 | 业务永不阻塞 | §1.3、§2.1 |
| 缓冲区满 drop + 计数 | 优先保证业务 | §5.1、§7.5 |
| Tracer 包级单例 | 避免函数签名侵入 domain | §2.3 |
| ctx 承载 parent span | 与 OpenTelemetry 惯例一致 | §4.1 |
| Repository 接口下沉到 domain | DDD 依赖倒置 | §2.2 |

---

## 5. 验证边界

**技术验证**：见 e2e 文档章节 1–3（编译、单元测试、Repository 联调）
**功能验证**：M2 无 UI，通过发一次伪造的 span 提交（手写测试脚本）验证落盘

详见 `docs/harness/e2e/agent-tracing-modules/M2-tracer-and-repository-e2e.md`

---

## 6. 交付验收

- [ ] 所有交付物文件创建完毕
- [ ] `go test -race ./internal/domains/models/tracing/...` 全绿
- [ ] `go test ./internal/infra/repositories/...` 全绿（无 MySQL 时 skip）
- [ ] `go build ./...` 无错、`route.go` 内 Tracer 初始化链路可 lint 通过
- [ ] `curl` 手动发一次 `/api/agent/chat` 应仍正常返回（本模块不该影响业务，即便 Tracer 未被调用）
- [ ] E2E 文档所有检查项通过
- [ ] M3 可以直接引用 `tracing.StartSpanFromContext` 而不必再改 M2 代码

---

**文档版本**：v1.0  |  **拆分自**：父规格 §2.3、§3.3–§3.5、§5.1

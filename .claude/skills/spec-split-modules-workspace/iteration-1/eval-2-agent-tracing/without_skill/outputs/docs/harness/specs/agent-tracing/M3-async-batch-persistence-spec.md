# M3 异步缓冲与批量落盘设计文档

**日期**：2026-07-17
**父 spec**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块状态**：设计评审中
**关联仓库**：mooc-manus

---

## 一、模块目标

把 M2 埋点产出的 Span 通过内存 chan 缓冲、后台 goroutine 批量 INSERT 到 MySQL `ai_span` 表。核心目标是**吞吐可扛 + 业务永不阻塞**。

### 1.1 交付范围

1. `Tracer.buffer chan *Span`（容量默认 10000）
2. `Tracer.commit(*Span)` 真实实现：非阻塞发送 + 缓冲区满时 dropCounter++
3. BatchProcessor goroutine：满 batchSize（默认 100）或 flushInterval（默认 5s）触发一次批量 INSERT
4. `Tracer.Shutdown(ctx)` 优雅退出：关闭 shutdown chan、goroutine flush 剩余 span、`wg.Wait`
5. Repository 层 `BatchInsert` 真实 GORM 实现
6. 观测埋点：dropCounter、flush error 日志（zap.Warn / zap.Error）
7. Tracer 单元测试：缓冲区满 drop / batch by size / batch by timer / Shutdown flush

### 1.2 非目标

- 埋点点位（由 M2 提供）
- 查询 API（M4）
- 缓冲区改无锁 ring buffer / 增大 flush 批（放到 profiling 未达标时才动手）

---

## 二、依赖关系

- **前置**：M1（Tracer / Span / SpanRepository 骨架已就位）
- **建议同期完成 M2**：M3 消费的是 M2 产生的 Span 数据；单独完成 M3 时可通过单测手工构造 Span 验证

---

## 三、缓冲队列设计

### 3.1 数据结构

```go
type Tracer struct {
    repo          SpanRepository
    buffer        chan *Span      // cap 默认 10000
    batchSize     int             // 默认 100
    flushInterval time.Duration   // 默认 5s
    dropCounter   atomic.Int64
    shutdown      chan struct{}
    wg            sync.WaitGroup
    // ...
}
```

### 3.2 非阻塞提交

`Span.End()` 内部调用 `tracer.commit(s)`：

```go
func (t *Tracer) commit(s *Span) {
    select {
    case t.buffer <- s:
    default:
        // 缓冲区满：丢弃 + 计数 + 限流告警
        t.dropCounter.Add(1)
        warnDropRateLimited()  // 每分钟至多一次 zap.Warn
    }
}
```

**关键**：`select-default` 非阻塞是核心红线。业务链路（Chat）绝不能因为 tracing 满而卡住。

### 3.3 缓冲区容量选择

- 10000 * 1KB ≈ 10MB 内存驻留上限
- 峰值 100 QPS × 26 span/次 = 2600 span/s → 可吸收 ~3.8 秒峰值抖动
- Repository 出错时（比如 DB 短暂故障）也能撑几秒不丢

---

## 四、BatchProcessor 设计

### 4.1 核心循环

```go
func (t *Tracer) processLoop() {
    defer t.wg.Done()
    batch := make([]*Span, 0, t.batchSize)
    ticker := time.NewTicker(t.flushInterval)
    defer ticker.Stop()

    flush := func(reason string) {
        if len(batch) == 0 {
            return
        }
        ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
        defer cancel()
        if err := t.repo.BatchInsert(ctx, batch); err != nil {
            zap.L().Error("tracing.batch_insert_failed",
                zap.String("reason", reason),
                zap.Int("size", len(batch)),
                zap.Error(err))
            // 丢弃该批，不重试
        }
        batch = batch[:0]
    }

    for {
        select {
        case s, ok := <-t.buffer:
            if !ok {
                flush("channel_closed")
                return
            }
            batch = append(batch, s)
            if len(batch) >= t.batchSize {
                flush("batch_full")
            }
        case <-ticker.C:
            flush("timer")
        case <-t.shutdown:
            // drain buffer
            for {
                select {
                case s := <-t.buffer:
                    batch = append(batch, s)
                    if len(batch) >= t.batchSize {
                        flush("shutdown_batch_full")
                    }
                default:
                    flush("shutdown_final")
                    return
                }
            }
        }
    }
}
```

### 4.2 触发条件

| 条件 | 说明 |
|------|------|
| 满 `batchSize`（100） | 写满立即 flush，减少延迟 |
| 满 `flushInterval`（5s） | 低流量时也能及时落盘，避免久留内存 |
| Shutdown | drain 缓冲区、最后一次 flush |

### 4.3 落盘失败策略

- 记 `zap.Error` + 丢弃该批，不重试
- 原因：重试会阻塞下一批消费，缓冲区继续积压反而放大问题
- 生产可暴露 `tracing_batch_insert_failed_total` 计数器

---

## 五、Repository 实现

### 5.1 GORM 批量插入

**位置**:  `internal/infra/repositories/ai_span_repository.go`

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

### 5.2 转换函数

- `spanToPO(*tracing.Span) *AiSpanPO`：tags/logs `json.Marshal`
- `poToNode(*AiSpanPO) *tracing.SpanNode`（M4 查询用；本模块内测就绪即可）

---

## 六、生命周期

### 6.1 初始化

```go
// api/routers/route.go InitRouter
repo := repositories.NewAiSpanRepository(db)
tracer := tracing.NewTracer(repo,
    tracing.WithBufferSize(10000),
    tracing.WithBatchSize(100),
    tracing.WithFlushInterval(5*time.Second),
)
tracing.SetGlobal(tracer)
tracer.Start()  // 启动 processLoop goroutine
```

### 6.2 优雅退出

- gin server graceful shutdown 触发时调 `tracer.Shutdown(ctx)`
- 内部关闭 `shutdown` chan → processLoop 感知并 drain buffer 最终 flush
- `wg.Wait()` 确保 goroutine 收尾

---

## 七、观测与告警

| 指标 | 类型 | 用途 |
|------|------|------|
| `tracing.buffer.drop_total` | Counter (dropCounter) | 缓冲区满丢弃数 |
| `tracing.batch.insert.error_total` | Counter | 落盘失败次数 |
| `tracing.batch.insert.duration_ms` | Histogram（可选） | 落盘耗时分布 |

日志限流：`zap.Warn("tracing.buffer.full")` 每分钟至多一条，避免刷屏。

---

## 八、单元测试清单

**位置**：`internal/domains/models/tracing/tracer_test.go`

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestTracer_BufferFullDrop` | cap=5，提交 10 → dropCounter ≥ 5，无阻塞 |
| 2 | `TestTracer_BatchFlushBySize` | batch=3，提交 3 → BatchInsert 调 1 次 |
| 3 | `TestTracer_BatchFlushByTimer` | batch=100，提 2 个等 flushInterval+500ms → BatchInsert 调 1 次 |
| 4 | `TestTracer_Shutdown` | Shutdown 前提 10 → 全部 flush、无 goroutine 泄漏 |
| 5 | `TestTracer_ShutdownFlushOrdering` | Shutdown 后 commit 不 panic（no-op） |
| 6 | `TestBatchInsert_Error_DoesNotBlock` | mock repo 返回 error → 后续提交仍能进入下一轮 |

**测试基线**：
- `batch=3` / `flushInterval=100ms` 缩短等待
- `goleak` 检 goroutine 泄漏
- `go test -race` 必开

Repository 集成测试（testcontainers 或本地 MySQL）：
- `TestBatchInsert_100Records`：插 100 条 → SELECT 回验
- `TestBatchInsert_JSONColumn`：tags/logs 正确 marshal / unmarshal

---

## 九、错误处理与降级

| 场景 | 处理 |
|------|------|
| 缓冲区满 | 丢弃 + `dropCounter++` + limited zap.Warn |
| BatchInsert SQL 失败 | 丢弃该批 + zap.Error |
| BatchInsert 超时（3s） | 视为失败，同上 |
| Shutdown 时 buffer 未清空 | drain 到底再退出 |
| processLoop panic | `defer recover` + zap.Fatal 重启（可选） |

---

## 十、性能与容量

- 峰值 100 QPS × 26 span/次 = 2600 span/s
- batch=100 → 26 batch/s，MySQL 完全可扛
- 单 span ~1KB → 缓冲区峰值内存 ~10MB
- 存储估算 220GB/天（生产超阈值后引入分区，本期不做）

**Tracing 自身开销目标**：埋点新增开销不超过原 Chat 端到端时延 5%，e2e 阶段前后对比压测验证。

---

## 十一、验收清单

- [ ] Tracer.commit 非阻塞（select-default）
- [ ] processLoop 按 size / timer / shutdown 三种触发条件工作
- [ ] BatchInsert 失败后不重试、不阻塞
- [ ] Shutdown 完成后 buffer 剩余 span 全部落盘或计入 dropCounter
- [ ] `go test -race` 通过、无 goroutine 泄漏
- [ ] 100 QPS 压测下 dropCounter 长期为 0

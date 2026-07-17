# M5 错误处理与降级设计文档

**日期**：2026-07-17
**父 spec**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块状态**：设计评审中
**关联仓库**：mooc-manus

---

## 一、模块目标

把「业务永不阻塞 tracing」的铁律在所有降级路径上落地：埋点异常 / Tracer 未初始化 / 缓冲拥塞 / 落盘失败 / panic / ctx cancel / 敏感字段泄露 —— 每种情况都有兜底策略，且这些策略必须被自动化测试覆盖。

### 1.1 交付范围

1. `is_error` 判定规则统一实现（不冒泡）
2. no-op Span 完整覆盖 6 种降级路径
3. 敏感字段打码规则最终版：正则、边界、白名单
4. `zap` 告警限流封装
5. Application 层 60s 超时兜底 + panic recovery 补 `SetError`
6. Tracer Shutdown 兜底测试
7. 查询侧错误 code 契约实现（M4 已定义，M5 补测试）
8. E2E 观测断言：`dropCounter` 长期为 0、无 goroutine 泄漏

### 1.2 非目标

- 埋点点位（M2 完成）
- 缓冲机制（M3 完成）
- 查询 API 主逻辑（M4 完成）

---

## 二、依赖关系

- **前置**：M1（no-op Span、SetTag 打码）、M2（埋点点位）、M3（缓冲队列）、M4（查询响应契约）
- 本模块是**横切加固**：不新增功能，只补测试 + 抠边界

---

## 三、埋点侧铁律

### 3.1 no-op Span 覆盖矩阵

| 场景 | 行为 |
|------|------|
| `StartSpanFromContext` ctx 无 parent | 返回 no-op Span，不 panic |
| Tracer 未 `SetGlobal` | `StartSpanFromContext` 返回 no-op |
| `SpanFromContext(ctx)` ctx 无 span | 返回 no-op |
| `Span.SetTag(key, nil)` / nil map | 静默忽略 + 限流 zap.Warn |
| `Span.End()` 多次调用 | 幂等，第二次直接 return |
| Tracer 已 Shutdown 后仍 commit | drop（select-default），不 panic |

### 3.2 敏感字段打码

**匹配规则**（`SetTag` 内部）：

```go
var maskKeyRe = regexp.MustCompile(`(?i)(api_?key|token|password|secret|authorization)`)

func maskIfSensitive(key string, val interface{}) interface{} {
    if maskKeyRe.MatchString(key) {
        return "***"
    }
    return val
}
```

**边界规则**：
- 大小写不敏感（`(?i)`）
- 子串匹配（`api_key` / `apikey` / `x-api-key` 均命中）
- 只作用于 value 替换，不改变 key（便于 debug 时看到「哪个字段被打码」）
- **不递归到嵌套结构**：如果 value 是 map 且内部有 `password`，本期不打码嵌套；相应地，`SetTag` 调用侧应扁平化敏感字段（约束在 M2 采集清单中兜底：不直接把整个 request 结构体塞进 tag）

**长值截断**：
- `user.query` 1KB
- `tool.arguments` 2KB
- `tool.result_preview` 512B
- 其他字段 8KB 硬上限（防意外大对象打爆）

### 3.3 zap 告警限流封装

```go
type rateLimitedWarner struct {
    interval time.Duration
    last     atomic.Int64
    logger   *zap.Logger
}

func (r *rateLimitedWarner) Warn(msg string, fields ...zap.Field) {
    now := time.Now().UnixNano()
    prev := r.last.Load()
    if now-prev < int64(r.interval) {
        return
    }
    if r.last.CompareAndSwap(prev, now) {
        r.logger.Warn(msg, fields...)
    }
}
```

用于：缓冲区满 / SetTag 参数非法。

---

## 四、`is_error` 判定规则

### 4.1 铁律：不冒泡

- 仅当**当前 span 内部**捕获到 error 时才标 `is_error=true`
- 不向父级冒泡：某 tool 失败只标该 TOOL_CALL；TOOL_BATCH / AGENT_ROUND / AGENT_ROOT 保持 `is_error=false`
- 顶层「这条 trace 是否有异常」由查询侧聚合：`SUM(is_error) > 0`

### 4.2 例外：Application / Domain 层 root-level 错误

- Application 层 60s 超时兜底：`root.SetError(ctx.Err())` + AddLog `agent.context_cancelled`
- Domain 层 `<-ctx.Done()`：同上
- 达到 `MaxIterations`：`root.SetError(errMaxIterations)` + AddLog `agent.max_iterations_exceeded`
- panic 被 Recovery middleware 捕获：`root.SetError(recovered)`

以上属于 root span 自身错误，不违反「不冒泡」，因为错误就发生在 root 层次。

### 4.3 SetError 实现

```go
func (s *Span) SetError(err error) {
    if err == nil {
        return
    }
    s.mu.Lock()
    defer s.mu.Unlock()
    s.IsError = true
    s.logs = append(s.logs, LogEntry{
        Ts:    time.Now().UnixNano(),
        Level: "ERROR",
        Msg:   err.Error(),
    })
}
```

---

## 五、查询侧错误契约（补 M4 测试）

| 场景 | HTTP | Code |
|------|------|------|
| trace 不存在 | 404 | `TRACE_NOT_FOUND` |
| 参数不合法 | 400 | `INVALID_PARAM` |
| DB 查询失败 | 500 | `INTERNAL_ERROR` |
| BuildSpanTree ErrNoRoot / ErrMultipleRoots | 500 | `TRACE_CORRUPTED` |
| BuildSpanTree ErrEmptyTrace | 404 | `TRACE_NOT_FOUND` |

**测试**（`api/handlers/trace_test.go`）：
- 每种 code 各 1 个用例
- 断言：不泄露 SQL / 内部堆栈到响应

---

## 六、Application 层 panic recovery 补丁

在 gin Recovery middleware 之后加一层「补 root span error」：

```go
func RecoveryWithTracing() gin.HandlerFunc {
    return func(c *gin.Context) {
        defer func() {
            if r := recover(); r != nil {
                root := tracing.SpanFromContext(c.Request.Context())
                root.SetError(fmt.Errorf("panic: %v", r))
                root.AddLog("ERROR", "panic.recovered", map[string]interface{}{
                    "stack": string(debug.Stack()),
                })
                c.AbortWithStatusJSON(500, gin.H{"code": "INTERNAL_ERROR"})
            }
        }()
        c.Next()
    }
}
```

**关键**：
- 顺序必须在 `StartRootSpan` 之后、业务 handler 之前
- `SpanFromContext` 无 span 时返回 no-op，业务 recovery 不受影响

---

## 七、Tracer Shutdown 兜底

- gin server shutdown timeout 30s → tracer shutdown timeout 10s（预留 20s 给业务）
- shutdown 期间 commit → drop（不 panic）
- shutdown 后 buffer 剩余 span drain + 最后一次 flush
- flush 失败也不 block 退出

---

## 八、单元与集成测试

### 8.1 Domain（tracing 包）

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestSpan_NoopWhenTracerNil` | Tracer 未初始化，Start / SetTag / End 都不 panic |
| 2 | `TestSpan_SensitiveTagMasking_AllPatterns` | 覆盖 5 组关键字大小写、子串场景 |
| 3 | `TestSpan_LongValueTruncation_AllFields` | 3 类字段截断长度正确 |
| 4 | `TestSpan_SetTag_NilMap_Silent` | 静默忽略，Warn 计数（可选） |
| 5 | `TestSpan_SetError_Nil` | `SetError(nil)` 不改状态 |
| 6 | `TestRateLimitedWarner` | 1s 内多次调用只输出一次 |

### 8.2 Application 集成

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestChat_TracerBufferFull_BusinessUnaffected` | cap=1 + flush=1h → 8 span 场景至少 drop 7，Chat 正常返回 |
| 2 | `TestChat_TracerNil_BusinessUnaffected` | 未 SetGlobal，Chat 全流程通过 |
| 3 | `TestChat_PanicRecovery_RootSetError` | mock tool panic → root span `is_error=true` + panic.recovered log |
| 4 | `TestChat_ToolError_NoBubble` | 叶子 tool span error，父 span 全 false |

### 8.3 查询侧 Handler

`M4-query-api-spec` 用例扩展，本模块补：
- `TestGetTraceDetail_DBError_500` mock repo 返错 → 500 INTERNAL_ERROR
- `TestGetTraceDetail_Corrupted_500` mock 多 root → 500 TRACE_CORRUPTED

### 8.4 优雅退出

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestTracer_Shutdown_DrainRemaining` | 关闭前 buffer 有 5 个 → 全部 flush |
| 2 | `TestTracer_ShutdownTimeout` | flush 慢 → 超时后仍能退出 |
| 3 | `TestTracer_Shutdown_NoGoroutineLeak` | `goleak.VerifyNone` |

---

## 九、观测断言

E2E 阶段（详见 M5-e2e）验证：

- 30 分钟持续负载测试下 `dropCounter` 长期为 0
- 强制 kill DB → tracing.batch.insert.error_total 上升，chat 依然正常
- `go tool pprof` 查内存 / goroutine 数无增长趋势

---

## 十、验收清单

- [ ] no-op Span 6 种降级路径全部覆盖
- [ ] 敏感字段打码覆盖 5 组正则关键字
- [ ] 长值截断 3 类字段边界正确
- [ ] `SetError(nil)` 安全
- [ ] RateLimitedWarner 每分钟至多一次
- [ ] Application panic → root span 补 error + log
- [ ] Shutdown 期间 commit 不 panic
- [ ] 查询侧 5 种错误 code 全覆盖
- [ ] E2E 观测：dropCounter=0、无 goroutine 泄漏

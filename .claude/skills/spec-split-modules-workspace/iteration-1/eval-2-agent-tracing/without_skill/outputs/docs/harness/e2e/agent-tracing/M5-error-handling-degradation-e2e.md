# M5 错误处理与降级 E2E 验证文档

**日期**：2026-07-17
**关联 spec**：`docs/harness/specs/agent-tracing/M5-error-handling-degradation-spec.md`

---

## 一、验证目标

- 埋点侧铁律：任何 tracing 故障不影响 Chat 主链路
- no-op Span 覆盖 6 种降级路径
- 敏感字段打码 5 组关键字全覆盖
- 长值截断 3 类字段边界正确
- `SetError(nil)` 安全
- RateLimitedWarner 每分钟至多一次
- Application 层 panic → root span 补 error
- Tracer Shutdown 期间 commit 静默 drop
- 查询侧 5 种错误 code 全覆盖
- 长时间负载：dropCounter=0、无 goroutine 泄漏

---

## 二、前置条件

- M1-M4 已交付
- 服务可启动、可 SIGTERM
- 压测工具（hey / wrk / vegeta）
- `pprof` 端点开启

---

## 三、验证步骤

### 3.1 no-op 降级路径

**位置**：`internal/domains/models/tracing/noop_test.go`

**用例矩阵**：

| 场景 | 触发方法 |
|------|---------|
| ctx 无 parent | 直接 `StartSpanFromContext(context.Background(), ...)` |
| Tracer 未 SetGlobal | 单测里不初始化，直接调用 |
| SpanFromContext ctx 无 span | `SpanFromContext(context.Background()).SetTag(...)` |
| SetTag(nil map) | `span.SetTag("x", nil)` |
| End 重复调用 | 连续调 3 次 |
| Shutdown 后 commit | 关闭 tracer 后 span.End() |

**通过标准**：所有场景 `require.NotPanics`，无 stderr / stdout 报错（除限流 zap.Warn）。

### 3.2 敏感字段打码

```go
cases := []struct{ K, V string; ExpectMasked bool }{
    {"api_key", "sk-1", true},
    {"apiKey", "sk-1", true},
    {"x-api-key", "sk-1", true},
    {"authorization", "Bearer x", true},
    {"AUTHORIZATION", "Bearer x", true},
    {"password", "p", true},
    {"PWD_secret", "p", true},
    {"user_token", "t", true},
    {"tool.arguments", "{\"api_key\":\"leak\"}", false},  // 顶层字段名不含关键字，不打码；内容打码在采集侧兜底
    {"normal", "keep", false},
}
```

**运行**：
```bash
go test -race -run TestSpan_SensitiveTagMasking_AllPatterns ./internal/domains/models/tracing/
```

**通过标准**：10 组用例全对，最后一组文档说明「嵌套值不递归打码是已知边界」。

### 3.3 长值截断

```go
cases := []struct{ Key string; InLen, ExpectMaxLen int }{
    {"user.query",         2048, 1024},
    {"tool.arguments",     4096, 2048},
    {"tool.result_preview",1024, 512},
    {"custom.large",      20480, 8192},  // 通用兜底 8KB
}
```

**通过标准**：`len(span.tags[key].(string)) == ExpectMaxLen`。

### 3.4 SetError(nil)

```go
func TestSpan_SetError_Nil(t *testing.T) {
    _, span := tracer.StartRootSpan(ctx, "t")
    span.SetError(nil)
    require.False(t, span.IsError)
    require.Empty(t, span.Logs())
}
```

### 3.5 RateLimitedWarner

```go
func TestRateLimitedWarner(t *testing.T) {
    core, obs := observer.New(zap.WarnLevel)
    w := newRateLimitedWarner(time.Second, zap.New(core))
    for i := 0; i < 100; i++ {
        w.Warn("msg")
    }
    require.Equal(t, 1, obs.Len())
}
```

### 3.6 Application 层 panic 兜底

**用例**：mock tool 主动 `panic("boom")`，观察：

- Chat 请求返回 500 `INTERNAL_ERROR`
- DB 中 root span：
  - `is_error = true`
  - logs 含 `panic.recovered`
  - logs.extra 含 stack 前 512 字符
- 服务不 crash，后续请求正常

### 3.7 Tracer Shutdown 期间 commit

**场景**：

```go
tracer.Shutdown(ctx)
// 之后再 span.End()
ctx2, span := tracing.StartSpanFromContext(context.Background(), ...)
span.End()  // 应该静默 drop，不 panic
```

### 3.8 查询侧错误 code

**测试路径**：`api/handlers/trace_test.go`

| 请求 | 期望 code |
|------|----------|
| trace 不存在 | 404 `TRACE_NOT_FOUND` |
| page=-1 | 400 `INVALID_PARAM` |
| mock repo 返 err | 500 `INTERNAL_ERROR`，无 SQL 泄露 |
| mock BuildSpanTree ErrNoRoot | 500 `TRACE_CORRUPTED` |
| mock BuildSpanTree ErrMultipleRoots | 500 `TRACE_CORRUPTED` |

### 3.9 长时间负载：观测断言

**场景**：持续 30 分钟 100 QPS，中途做 3 次干扰：

1. `kill -9 mysqld` 5 秒后重启
2. 拔网线（tc netem loss 20%）5 秒
3. `SIGSTOP` 后端进程 500ms 后 `SIGCONT`

**通过标准**：

| 指标 | 期望 |
|------|------|
| `tracing.buffer.drop_total` | 稳态 0（干扰期间可能上升） |
| Chat 5xx 比例 | 0（除干扰期间业务本身失败） |
| 内存 RSS | 峰值 < 2×稳态 |
| goroutine 数 | 稳定 |
| `curl /debug/pprof/goroutine?debug=2` | 无 tracing 相关 goroutine 泄漏 |

### 3.10 优雅退出

- 30 分钟负载末尾 `kill -TERM`
- 退出耗时 < 15s
- 日志顺序：`gin.graceful_shutdown` → `tracing.shutdown.draining` → `tracing.shutdown.flushed`
- DB span 总数与实际发出 chat 数 × 平均 span/chat 接近（允许 shutdown 前后各 1 batch 的丢失）

---

## 四、失败判定

| 场景 | 说明 |
|------|------|
| tracing 故障传播到 Chat 5xx | 隔离失效，红线破 |
| dropCounter 稳态非 0 | M3 或 M5 兜底有 bug |
| panic 后 root span 未标 error | Recovery middleware 未接入或 SpanFromContext 未取到 span |
| 敏感 key 泄露到 DB | 打码规则未生效 |
| SetError(nil) 改变状态 | 边界检查缺失 |
| goroutine 泄漏 | Shutdown 未彻底 |

---

## 五、观测点

- pprof heap / goroutine 快照对比
- zap 结构化日志中的 `tracing.*` key
- Prometheus 指标：drop_total / insert.error_total / batch.duration

---

## 六、回归红线

- **业务永不阻塞**：所有 tracing 异常都不能让 Chat 变慢或失败
- **信息不泄露**：DB / 响应中不出现明文 api_key / token
- **进程不 crash**：任何 tracing 内部 panic 都被 recover

---

## 七、通过标准（Gate）

- [ ] no-op 6 种降级路径全通过
- [ ] 敏感字段打码 10 组用例全对
- [ ] 长值截断 4 类字段边界正确
- [ ] SetError(nil) 安全
- [ ] RateLimitedWarner 每秒最多 1 条
- [ ] Panic 后 root span 补 error 且服务不 crash
- [ ] Shutdown 期间 commit 不 panic
- [ ] 查询侧 5 种 code 契约实现
- [ ] 30 分钟负载 + 3 次干扰：dropCounter=0（稳态）、无泄漏
- [ ] 优雅退出 < 15s、剩余 span 落盘

# M1 数据模型与 Tracer 基础设施 E2E 验证文档

**日期**：2026-07-17
**关联 spec**：`docs/harness/specs/agent-tracing/M1-tracing-foundation-spec.md`

---

## 一、验证目标

确认 M1 交付物在真实环境（编译 + MySQL + Go 单测）中可用：
- Domain 层类型编译通过、包结构符合 DDD
- `ai_span` 表 DDL 在 MySQL 中创建成功
- Tracer 单例、Span 生命周期、no-op 降级路径行为符合契约
- 所有单元测试通过（`go test -race`）

本模块不产生 HTTP 端到端流量，e2e 主要以「编译 + 集成级单测 + DB DDL 验证」为准。

---

## 二、前置条件

- 本地或 CI 环境有 Go 1.21+ + MySQL 5.7+
- `mooc-manus` 子仓可编译
- MySQL 上有 `mooc_manus` 数据库
- 环境变量或配置文件指向 MySQL 实例

---

## 三、验证步骤

### 3.1 编译验证

```bash
cd mooc-manus
go build ./...
```

**通过标准**：编译无 error、无 lint warning（`go vet ./...` 通过）。

### 3.2 建表验证

```bash
mysql -u <user> -p mooc_manus < migrations/2026-07-14-ai-span.sql
```

**通过标准**：

```sql
SHOW CREATE TABLE ai_span;
```

- 表存在
- 字段类型与 DDL 一致（`trace_id VARCHAR(64)`、`tags JSON` 等）
- 索引齐全：`PRIMARY`、`uk_trace_span`、`idx_trace`、`idx_conv`、`idx_error`
- 字符集 utf8mb4

### 3.3 Domain 单元测试

```bash
go test -race -v ./internal/domains/models/tracing/...
```

**通过标准**：11 个用例全部通过（对应 spec §5 单元测试清单）。关键断言：

| 用例 | 断言 |
|------|------|
| `TestSpan_LifecycleBasic` | End 后 `LatencyMs > 0`、字段完整 |
| `TestSpan_EndIdempotent` | 二次 End 不触发 commit |
| `TestSpan_ConcurrentSetTag` | -race 通过、tag 全部落地 |
| `TestSpan_SensitiveTagMasking` | `SetTag("api_key", "sk-xxx")` 后读取为 `"***"` |
| `TestSpan_LongValueTruncation` | `SetTag("user.query", 2KB字符串)` → 长度 1024 |
| `TestSpan_SetError` | IsError=true、logs 尾部 Level=ERROR |
| `TestTracer_StartRootSpan` | 返回 span_id=0、parent_span_id=-1、ctx 携带 span |
| `TestTracer_StartSpan_FromContext` | 连续 Start 三次得 span_id 1,2,3 |
| `TestTracer_StartSpan_NoParent` | 无 parent → no-op（方法调用不 panic） |
| `TestTracer_ConcurrentSpanIDGen` | 100 goroutine → 唯一 span_id 集合 |
| `TestSpanFromContext_NoTracer` | SetGlobal 前调用 → no-op |

### 3.4 Tracer 单例验证

手工脚本或 `_test.go` 补一个集成用例：

```go
func TestTracer_GlobalSingleton(t *testing.T) {
    repo := &fakeRepo{}
    tracer := tracing.NewTracer(repo)
    tracing.SetGlobal(tracer)
    require.Same(t, tracer, tracing.Global())

    ctx, root := tracing.Global().StartRootSpan(context.Background(), "trace-1")
    require.Equal(t, int32(0), root.SpanID)
    require.Equal(t, int32(-1), root.ParentSpanID)

    _, child := tracing.StartSpanFromContext(ctx, tracing.SpanTypeAgentRound, "")
    require.Equal(t, int32(1), child.SpanID)
    require.Equal(t, root.SpanID, child.ParentSpanID)
}
```

### 3.5 no-op 降级路径 smoke test

```go
func TestNoop_Smoke(t *testing.T) {
    // Tracer 未 SetGlobal
    tracing.ResetForTest()  // 清 globalTracer

    ctx := context.Background()
    _, span := tracing.StartSpanFromContext(ctx, tracing.SpanTypeToolCall, "test")
    require.NotPanics(t, func() {
        span.SetTag("foo", "bar")
        span.AddLog("INFO", "msg", nil)
        span.SetError(errors.New("x"))
        span.End()
    })
}
```

**通过标准**：全程无 panic、无 stderr 报错。

### 3.6 敏感字段打码正则边界

```go
cases := []struct{ Key, Val string; Expected interface{} }{
    {"api_key", "sk-xxx", "***"},
    {"apiKey", "sk-xxx", "***"},
    {"x-api-key", "sk-xxx", "***"},
    {"AUTHORIZATION", "Bearer xxx", "***"},
    {"password_hash", "abc", "***"},
    {"user_secret", "s", "***"},
    {"normal_field", "keep_me", "keep_me"},
}
```

**通过标准**：7 组用例断言全对。

---

## 四、失败判定

- 任一编译错误
- 表结构与 DDL 不一致（字段类型 / 索引缺失）
- 单元测试失败或 `-race` 报 warning
- no-op 路径出现 panic
- Tracer 单例返回错误的实例

---

## 五、观测点

- 编译产物大小：新增 `tracing` 包应在几十 KB 内
- 单元测试耗时：全套 < 5s（`batch=3` / `flushInterval=100ms` 缩短等待）

---

## 六、回归红线

| 场景 | 期望 |
|------|------|
| 未初始化 Tracer 调用埋点函数 | 静默 no-op，业务无感 |
| Tracer 已初始化但 repo 未接（M3 未上）| commit 桩实现丢弃即可，不阻塞 |
| ai_span 表被删除 | M1 不主动重建，交由 migration 管理 |
| tags 中含 nil / 循环引用 | SetTag 内部 catch，不 panic |

---

## 七、通过标准（Gate）

- [ ] 编译通过 + `go vet` 通过
- [ ] `ai_span` 表 DDL 部署成功
- [ ] Domain 单测全部 pass（11 用例）
- [ ] `go test -race` 无 race
- [ ] no-op 路径 smoke test 无 panic
- [ ] 敏感字段打码 7 组用例全对
- [ ] Tracer 单例返回一致实例

# M3 异步缓冲与批量落盘 E2E 验证文档

**日期**：2026-07-17
**关联 spec**：`docs/harness/specs/agent-tracing/M3-async-batch-persistence-spec.md`

---

## 一、验证目标

- 缓冲队列非阻塞：满时 drop、不 block 业务
- BatchProcessor 按 size / timer / shutdown 三种路径正确 flush
- Repository 批量 INSERT 稳定
- Shutdown 后 buffer 剩余 span 全部落盘
- `go test -race` 无 race、`goleak` 无泄漏
- 中等压力下 dropCounter 长期为 0

---

## 二、前置条件

- M1 完成（Tracer 骨架、SpanRepository 骨架）
- M2 完成或可用手工构造 Span 验证
- 本地或 CI MySQL 5.7+ 可用
- `github.com/DATA-DOG/go-sqlmock` 或 testcontainers 可选

---

## 三、验证步骤

### 3.1 Tracer 单测

```bash
cd mooc-manus
go test -race -v ./internal/domains/models/tracing/ -run TestTracer_
```

**必过用例**：

| 用例 | 断言 |
|------|------|
| `TestTracer_BufferFullDrop` | cap=5、连续 10 个 commit → dropCounter ≥ 5、耗时 < 100ms（证明非阻塞） |
| `TestTracer_BatchFlushBySize` | batch=3，提 3 → mock repo BatchInsert 收到 3 条 |
| `TestTracer_BatchFlushByTimer` | batch=100，提 2，等 150ms（flush=100ms）→ mock repo 收到 2 条 |
| `TestTracer_Shutdown` | Shutdown 前 commit 10 条 → 全部到达 repo、无 goroutine 泄漏 |
| `TestTracer_ShutdownFlushOrdering` | Shutdown 之后 commit → 静默 drop，不 panic |
| `TestBatchInsert_Error_DoesNotBlock` | mock repo 首次返 err → 下轮 commit 仍能进入并被 flush |

### 3.2 Goroutine 泄漏检测

```go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

**通过标准**：所有 tracer 测试跑完后无残留 goroutine。

### 3.3 Repository 集成测试

**前提**：真实 MySQL 或 testcontainers。

```bash
go test -race -v -run TestBatchInsert ./internal/infra/repositories/
```

用例：
- `TestBatchInsert_100Records`：插 100 条 → `SELECT COUNT(*)` = 100
- `TestBatchInsert_JSONColumn`：tags/logs 内容序列化后可反序列化还原
- `TestBatchInsert_Duplicate_UniqueKey`：同 (trace_id, span_id) 二次 INSERT 报唯一键冲突（提示批次去重责任在上层）

### 3.4 端到端负载测试

**目标**：验证 100 QPS 场景下 dropCounter 保持为 0。

**步骤**：

1. 启动服务
2. 配置 tracer：默认 cap=10000 / batch=100 / flush=5s
3. 用 `wrk` / `hey` / 自定义脚本压 `/api/agent/chat`：

```bash
hey -n 6000 -c 100 -m POST \
    -H "Content-Type: application/json" \
    -d '{"conversationId":"load-N","query":"简单问答"}' \
    http://localhost:8080/api/agent/chat
```

4. 持续 30 分钟
5. 观察指标（暴露为 HTTP `/metrics` 或日志）：

**通过标准**：

| 指标 | 期望 |
|------|------|
| `tracing.buffer.drop_total` | 0 |
| `tracing.batch.insert.error_total` | 0（若 DB 稳定） |
| P99 batch insert 延迟 | < 500ms |
| 单 chat 端到端时延增量 | < 5% |
| 内存 RSS 平稳 | 无持续增长 |
| goroutine 数 | 稳定（Tracer 只 1 个 processLoop） |

### 3.5 DB 故障演练

**场景**：压测中途 kill MySQL 5 秒后重启

**预期**：
- `tracing.batch.insert.error_total` 上升
- Chat API 完全正常返回
- MySQL 恢复后落盘继续，但 kill 期间的 span 已被丢弃（本期不重试）
- 服务不 crash

### 3.6 优雅退出验证

- 启动服务，压 100 QPS 持续 1 分钟
- `kill -TERM <pid>`
- 观察退出时日志：`tracing.shutdown.draining` → `tracing.shutdown.flushed`
- 关键：退出耗时 < 15s（tracer shutdown 内 10s 上限）

**DB 验证**：
```sql
SELECT COUNT(*) FROM ai_span WHERE created_at > NOW() - INTERVAL 5 MINUTE;
```
数字应接近「压测发起 chat 数 × span/chat」，允许 shutdown 时刻少量 drop。

---

## 四、失败判定

| 场景 | 说明 |
|------|------|
| dropCounter 稳态非 0 | 缓冲容量不足或消费者慢 |
| BatchInsert 阻塞主 goroutine | commit 未走 select-default |
| Shutdown 后仍有 goroutine 残留 | wg.Wait 或 shutdown chan 关闭有问题 |
| DB 故障期间 Chat 变慢或 5xx | 落盘错误未与业务隔离 |
| 单 chat 时延增长 > 5% | tracing 开销超标，需 profiling 优化 |

---

## 五、观测点

- Prometheus / zap 日志中的 `tracing.batch.insert.duration_ms` 分布
- 内存 pprof heap 快照对比前后端埋点新增字节数
- goroutine dump（`SIGQUIT` 或 `curl /debug/pprof/goroutine?debug=2`）

---

## 六、回归红线

- **业务永不阻塞**：任何 tracing 故障不影响 chat
- **不重试**：BatchInsert 失败丢弃即可，避免阻塞消费
- **shutdown 有界**：即使 flush 卡住也在 timeout 后退出

---

## 七、通过标准（Gate）

- [ ] Tracer 单测 6 用例全通过
- [ ] `goleak` 无泄漏
- [ ] Repository 集成测试全通过
- [ ] 100 QPS × 30 分钟负载：dropCounter=0、内存平稳
- [ ] DB kill 演练：Chat 无影响
- [ ] 优雅退出耗时 < 15s、剩余 span 落盘

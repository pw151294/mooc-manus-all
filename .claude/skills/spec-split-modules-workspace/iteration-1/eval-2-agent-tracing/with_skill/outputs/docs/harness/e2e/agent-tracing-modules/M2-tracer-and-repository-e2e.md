# M2 Tracer 与批量落盘模块验证文档

**对应规格**：`docs/harness/specs/agent-tracing-modules/M2-tracer-and-repository-spec.md`
**验证类型**：技术层验证 + 集成验证（本模块无 UI，通过单测 + 手写脚本触发）
**前置**：M1 已合入；本地 MySQL 5.7+ 可访问（ai_span 表已创建）；服务可正常启动

---

## 1. 编译与静态检查

- [ ] **`go build ./...` 通过**
  - Run: `cd mooc-manus && go build ./...`
  - Expected: 构建成功；`route.go` 内 Tracer 初始化链路无 undefined 符号

- [ ] **`go vet -race ./...` 无 race 相关告警**
  - Run: `cd mooc-manus && go vet ./...`
  - Expected: 输出为空

---

## 2. Tracer 单元测试（父规格 §8.2 用例 1–14）

对应父规格 §8.2 的 tracer_test.go 全量用例（14 个）：

- [ ] **TestSpan_LifecycleBasic**
  - Run: `go test -run TestSpan_LifecycleBasic ./internal/domains/models/tracing/...`
  - Expected: LatencyMs > 0；tags/logs 内容正确

- [ ] **TestSpan_EndIdempotent**
  - Run: `go test -run TestSpan_EndIdempotent ./internal/domains/models/tracing/...`
  - Expected: `End()` 调两次，`commit` 只触发一次（通过 mock repo 计数断言）

- [ ] **TestSpan_ConcurrentSetTag（`-race`）**
  - Run: `go test -race -run TestSpan_ConcurrentSetTag ./internal/domains/models/tracing/...`
  - Expected: 10 goroutine 并发 SetTag，无 race，最终 tags 数量 = 总提交数

- [ ] **TestSpan_SensitiveTagMasking**
  - Run: `go test -run TestSpan_SensitiveTagMasking ./internal/domains/models/tracing/...`
  - Expected: `api_key` / `authorization` value = `"***"`

- [ ] **TestSpan_LongValueTruncation**
  - Run: `go test -run TestSpan_LongValueTruncation ./internal/domains/models/tracing/...`
  - Expected: `user.query` 超 1KB 被截断

- [ ] **TestSpan_SetError**
  - Run: `go test -run TestSpan_SetError ./internal/domains/models/tracing/...`
  - Expected: `IsError=true`；logs 追加了 ERROR 级 entry 且含 error.Error() 字符串

- [ ] **TestTracer_StartRootSpan**
  - Run: `go test -run TestTracer_StartRootSpan ./internal/domains/models/tracing/...`
  - Expected: ctx 内可 `SpanFromContext` 取回 root；TraceID / SpanID=0 / ParentSpanID=-1

- [ ] **TestTracer_StartSpan_FromContext**
  - Run: `go test -run TestTracer_StartSpan_FromContext ./internal/domains/models/tracing/...`
  - Expected: 连续 StartSpan 内 span_id 单调递增，且 parent 正确指向上一个

- [ ] **TestTracer_StartSpan_NoParent**
  - Run: `go test -run TestTracer_StartSpan_NoParent ./internal/domains/models/tracing/...`
  - Expected: 无 parent 的 ctx StartSpan 返回 no-op Span，且业务代码不 panic

- [ ] **TestTracer_BufferFullDrop**
  - Run: `go test -run TestTracer_BufferFullDrop ./internal/domains/models/tracing/...`
  - Expected: 缓冲区容量 5，提交 10 个 span 后 `dropCounter ≥ 5`，无阻塞

- [ ] **TestTracer_BatchFlushBySize**
  - Run: `go test -run TestTracer_BatchFlushBySize ./internal/domains/models/tracing/...`
  - Expected: batch=3、提交 3 → mock repo `BatchInsert` 被调用一次

- [ ] **TestTracer_BatchFlushByTimer**
  - Run: `go test -timeout 30s -run TestTracer_BatchFlushByTimer ./internal/domains/models/tracing/...`
  - Expected: 提交 2 个 span、等 flushInterval 到期 → mock repo `BatchInsert` 被调用一次

- [ ] **TestTracer_Shutdown**
  - Run: `go test -run TestTracer_Shutdown ./internal/domains/models/tracing/...`
  - Expected: Shutdown 前提 10 个 → 全部 flush；goroutine 数在 Shutdown 前后一致（`goleak` 或计数）

- [ ] **TestTracer_ConcurrentSpanIDGen（`-race`）**
  - Run: `go test -race -run TestTracer_ConcurrentSpanIDGen ./internal/domains/models/tracing/...`
  - Expected: 并发 100 span，span_id 全在 `[1, 100]` 内且唯一

---

## 3. Repository 单元测试

- [ ] **BatchInsert 联调**（有 MySQL 时）
  - Run: `go test -run TestBatchInsert ./internal/infra/repositories/...`
  - Expected: 100 条 span 批量插入 → SELECT COUNT 返回 100

- [ ] **FindByTraceID 按 span_id ASC**
  - Run: `go test -run TestFindByTraceID ./internal/infra/repositories/...`
  - Expected: 返回结果按 `span_id ASC`；tags/logs JSON 正确反序列化

- [ ] **无 MySQL 环境时 skip**
  - Run: `go test ./internal/infra/repositories/...`
  - Expected: 用例被 skip 而非失败（`t.Skip` 触发）

---

## 4. 路由初始化与生命周期

- [ ] **启动时初始化链路**
  - Run: 启动服务（`make run` 或 `go run ./cmd/...`）
  - Expected: 日志包含 "tracer initialized" 或等效；`SetGlobal` 已生效；无异常

- [ ] **优雅退出 flush 剩余**
  - Step 1: 启动服务
  - Step 2: 手工构造伪 span 提交（用一个临时测试 handler 或直接 curl 触发 chat）
  - Step 3: 发送 SIGTERM（`kill -TERM <pid>`）
  - Expected: 进程正常退出；ai_span 表中该 trace 所有 span 已落盘

---

## 5. 集成手测：Tracer 单机跑通

前置：ai_span 表已创建、服务未启动 tracing 埋点（M3 尚未合入）。写一个临时集成测试或调试脚本：

- [ ] **手动 span 提交 → 落盘**
  - Step: 编写 `_debug/tracer_smoke_test.go`，`NewTracer` → `StartRootSpan` → `SetTag` → `End` → `Shutdown`
  - Expected: MySQL `SELECT * FROM ai_span WHERE trace_id = ?` 返回 1 条记录，字段填充正确

- [ ] **`SetGlobal` 未调时的 no-op 行为**
  - Step: 不调 `SetGlobal`，直接 `tracing.StartSpanFromContext(ctx, ...)` 拿到 span 并 `SetTag`
  - Expected: 无 panic；`span.End()` 无副作用；对业务无影响

---

## 6. 边界与异常

- [ ] **BatchInsert 失败降级**
  - Step: 断开 MySQL 或改错表名
  - Expected: Tracer flush goroutine 走降级路径 —— zap warn 记日志、不 panic、不 leak goroutine

- [ ] **缓冲区堵塞不影响业务**
  - Step: 缓冲区容量调 1、禁用 flush；提交 10 个 span
  - Expected: `dropCounter >= 9`；提交侧全部非阻塞返回

---

## 7. 交付验收

- [ ] 上述所有检查项通过（Repository 用例可在无 MySQL 时 skip）
- [ ] `git status` 干净
- [ ] `go test -race ./internal/domains/models/tracing/...` 全绿
- [ ] `route.go` 变更未破坏原有启动流程（一次冷启动 + 正常发 chat 请求应仍工作）
- [ ] M3 可直接调 `tracing.Global()` / `tracing.StartSpanFromContext` 而无需再改 M2 代码

---

**文档版本**：v1.0  |  **拆分自**：父规格 §2.3、§3.3–§3.5、§8.2 用例 1–14、§8.4

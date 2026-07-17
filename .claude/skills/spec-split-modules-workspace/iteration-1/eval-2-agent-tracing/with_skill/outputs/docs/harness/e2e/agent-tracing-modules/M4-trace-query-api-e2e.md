# M4 查询 API 与树构建模块验证文档

**对应规格**：`docs/harness/specs/agent-tracing-modules/M4-trace-query-api-spec.md`
**验证类型**：功能验证（HTTP API + JSON 契约）+ 单元测试
**前置**：M1、M2、M3 已合入；MySQL 内已有若干真实 trace 数据（或用 SQL 手工塞入固定 fixture）；服务运行中

---

## 1. 编译与路由注册

- [ ] **`go build ./...` 通过**
  - Run: `cd mooc-manus && go build ./...`
  - Expected: 编译成功

- [ ] **路由已注册**
  - Run: 启动服务后 `curl -o /dev/null -s -w '%{http_code}\n' http://localhost:8080/api/trace/nonexistent`
  - Expected: 返回 404（trace 不存在），而非 405 Method Not Allowed 或 502

---

## 2. BuildSpanTree 单元测试（父规格 §8.2 用例 15–19）

- [ ] **TestBuildSpanTree_HappyPath**
  - Run: `go test -run TestBuildSpanTree_HappyPath ./internal/domains/models/tracing/...`
  - Expected: 12 span 三级嵌套构建成功；children 数组按 span_id ASC；根节点 parent_span_id=-1

- [ ] **TestBuildSpanTree_EmptyInput**
  - Run: `go test -run TestBuildSpanTree_EmptyInput ./internal/domains/models/tracing/...`
  - Expected: 返回 `ErrEmptyTrace`

- [ ] **TestBuildSpanTree_NoRoot**
  - Run: `go test -run TestBuildSpanTree_NoRoot ./internal/domains/models/tracing/...`
  - Expected: 返回 `ErrNoRoot`

- [ ] **TestBuildSpanTree_MultipleRoots**
  - Run: `go test -run TestBuildSpanTree_MultipleRoots ./internal/domains/models/tracing/...`
  - Expected: 返回 `ErrMultipleRoots`

- [ ] **TestBuildSpanTree_OrphanNode**
  - Run: `go test -run TestBuildSpanTree_OrphanNode ./internal/domains/models/tracing/...`
  - Expected: 孤儿节点挂到 root、tags 内 `_orphan=true` 且 `_original_parent` 记原 parent_span_id

---

## 3. Handler 单元测试（父规格 §8.5）

- [ ] **TestGetTraceDetail_200**
  - Run: `go test -run TestGetTraceDetail_200 ./api/handlers/...`
  - Expected: 返回 200 + 嵌套树 JSON；`root.children` 非空

- [ ] **TestGetTraceDetail_404**
  - Run: `go test -run TestGetTraceDetail_404 ./api/handlers/...`
  - Expected: 返回 404 + `error` 字段包含 "trace not found"

- [ ] **TestListTraces_Pagination**
  - Run: `go test -run TestListTraces_Pagination ./api/handlers/...`
  - Expected: `page=1&page_size=20` 返回 20 条；`page_size=200` 被夹到 100 上限

---

## 4. GET /api/trace/:trace_id 契约验证

前置：DB 内已有 trace `test-trace-happy`（可通过发一次真实 chat 生成，或 SQL 手工塞入）。

- [ ] **返回结构对齐父规格 §6.1**
  - Run: `curl -s http://localhost:8080/api/trace/test-trace-happy | jq '.'`
  - Expected: 顶层含 `trace_id` / `conversation_id` / `agent_name` / `start_time` / `end_time` / `duration_ms` / `is_error` / `span_count` / `root`；`root.span_type="AGENT_ROOT"`；`root.parent_span_id=-1`

- [ ] **children 按 span_id ASC**
  - Run: `curl -s http://localhost:8080/api/trace/test-trace-happy | jq '.root.children | map(.span_id)'`
  - Expected: 数组升序无跳变

- [ ] **顶层 is_error 语义（关键）**
  - Step: 找一条有 tool 报错的 trace（叶子 span 有 `is_error=true`，但 root 自身 `is_error=false`）
  - Run: `curl -s http://localhost:8080/api/trace/<err-trace-id> | jq '{top_is_error: .is_error, root_is_error: .root.is_error}'`
  - Expected: `top_is_error=true`（因至少一 span 报错）、`root_is_error=false`（不冒泡）

- [ ] **span_count 与 flat 一致**
  - Run: `curl -s http://localhost:8080/api/trace/test-trace-happy | jq '.span_count'`
  - Verify with SQL: `mysql -e "SELECT COUNT(*) FROM ai_span WHERE trace_id='test-trace-happy'"`
  - Expected: 两值相等

- [ ] **duration_ms = root.latency_ms**
  - Run: `curl -s http://localhost:8080/api/trace/test-trace-happy | jq '.duration_ms == .root.latency_ms'`
  - Expected: `true`

---

## 5. GET /api/traces 分页 + 过滤

前置：DB 内已有 ≥ 30 条不同 trace_id 的 root span。

- [ ] **默认分页**
  - Run: `curl -s 'http://localhost:8080/api/traces' | jq '.page, .page_size, (.traces | length)'`
  - Expected: `page=1`、`page_size=20`、`length` ≤ 20

- [ ] **page_size 上限夹紧**
  - Run: `curl -s 'http://localhost:8080/api/traces?page_size=500' | jq '.page_size'`
  - Expected: 100（上限）

- [ ] **按 conversation_id 过滤**
  - Run: `curl -s 'http://localhost:8080/api/traces?conversation_id=conv-e2e-1' | jq '.traces | all(.conversation_id == "conv-e2e-1")'`
  - Expected: `true`

- [ ] **按 is_error=true 过滤**
  - Run: `curl -s 'http://localhost:8080/api/traces?is_error=true' | jq '.traces | all(.is_error)'`
  - Expected: `true`

- [ ] **按时间窗过滤**
  - Run: `curl -s 'http://localhost:8080/api/traces?start_time_from=<from-ns>&start_time_to=<to-ns>' | jq '.traces | all(.start_time >= <from-ns> and .start_time <= <to-ns>)'`
  - Expected: `true`

- [ ] **列表项字段齐全**
  - Run: `curl -s 'http://localhost:8080/api/traces?page_size=1' | jq '.traces[0] | keys'`
  - Expected: 包含 `trace_id` / `conversation_id` / `agent_name` / `start_time` / `duration_ms` / `span_count` / `is_error` / `user_query_preview`

---

## 6. 边界与异常

- [ ] **404 空 trace**
  - Run: `curl -o /dev/null -s -w '%{http_code}\n' http://localhost:8080/api/trace/never-existed`
  - Expected: `404`

- [ ] **多 root 数据损坏保护**
  - Step: SQL 手工插入两条 `parent_span_id=-1` 同 trace_id 的行
  - Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/trace/<broken-trace>`
  - Expected: 5xx + 错误 message 含 "multiple roots"（可 log 排查）；不 panic

- [ ] **孤儿节点降级展示**
  - Step: SQL 手工插入一条 span 引用不存在的 parent_span_id
  - Run: `curl -s http://localhost:8080/api/trace/<orphan-trace>' | jq '.. | select(.["tags"]?["_orphan"]==true)'`
  - Expected: 该孤儿节点挂到 root.children，其 tags._orphan=true

- [ ] **无效 page 参数**
  - Run: `curl -s 'http://localhost:8080/api/traces?page=-1'`
  - Expected: 后端夹紧到 1 或返回 400（任一都可接受，但不能 panic）

- [ ] **user_query_preview 截断**
  - Step: 找一个 user.query 超 128 字符的 trace
  - Run: `curl -s 'http://localhost:8080/api/traces?conversation_id=...' | jq '.traces[0].user_query_preview | length'`
  - Expected: ≤ 128

---

## 7. 空状态 / 加载态 / 终态

- [ ] **无任何 trace**
  - Step: 清空 ai_span 表
  - Run: `curl -s http://localhost:8080/api/traces | jq '.total, (.traces | length)'`
  - Expected: `0` 和 `0`；响应 200（列表空是正常状态）

- [ ] **单 trace 单 span**
  - Step: SQL 塞入一个只有 root span（无 round/llm/tool）的 trace
  - Run: `curl -s http://localhost:8080/api/trace/<single>' | jq '.span_count, .root.children'`
  - Expected: `span_count=1`；`root.children=[]`

---

## 8. 跨模块联动（依赖 M3 的产出）

- [ ] **端到端串联**
  - Step 1: 发一次真实 chat 生成新 trace
  - Step 2: 立即（等 5s+ 让 flush 生效）调 `GET /api/trace/<messageId>`
  - Expected: 返回完整嵌套树，含 AGENT_ROOT → N ROUND → LLM/TOOL_BATCH → TOOL_CALL 各层
  - 依赖：M3 已交付；单独验收 M4 时用 SQL fixture 替代 chat

---

## 9. 交付验收

- [ ] 上述所有检查项通过
- [ ] `git status` 干净
- [ ] `go test -race ./...` 全绿
- [ ] `route.go` 内 M4 handler 注册与 M2 Tracer 初始化无冲突
- [ ] curl 手测两条 API happy path 完全对齐父规格 §6 契约

---

**文档版本**：v1.0  |  **拆分自**：父规格 §6、§8.2 用例 15–19、§8.5

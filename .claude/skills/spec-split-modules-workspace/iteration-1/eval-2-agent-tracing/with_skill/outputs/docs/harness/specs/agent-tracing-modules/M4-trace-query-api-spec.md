# M4 查询 API 与树构建模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块编号**：M4
**依赖**：M1（SpanNode、SpanRepository 接口）、M2（Repository 实现）
**被依赖**：无（叶子模块）

---

## 1. 模块范围

在 M2 已能把 span 落盘的基础上，实现"事后追溯"链路的读侧：扁平 → 树构建算法、Application 服务
组装顶层元信息、HTTP Handler 暴露两个查询 API（详情 + 分页列表）。交付后运维/开发者可通过 HTTP
调用完整拿到 trace 数据。

### 1.1 交付物

- 树构建算法：
  - `internal/domains/models/tracing/tree.go`（新增函数，SpanNode 类型已由 M1 定义）
    - `BuildSpanTree(nodes []*SpanNode) (*SpanNode, error)` —— 见父规格 §6.2
    - 错误定义：`ErrEmptyTrace` / `ErrNoRoot` / `ErrMultipleRoots`
    - 孤儿节点处理：挂到 root 并加 `_orphan=true` / `_original_parent` tag
- 树构建单测：
  - `internal/domains/models/tracing/tree_test.go`：父规格 §8.2 用例 15–19
- Application Service：
  - `internal/applications/services/trace.go`
    - `TraceService.GetTraceDetail(ctx, traceID) (*TraceDetailDTO, error)`
      - 调 `SpanRepository.FindByTraceID`
      - 调 `BuildSpanTree` 构树
      - 顶层元信息聚合：`conversation_id` / `agent_name`（从 root span 独立列）/ `duration_ms`（root.LatencyMs）/ `is_error`（`SUM(is_error) > 0` 或树遍历短路）/ `span_count`
    - `TraceService.ListTraces(ctx, filter) (*TraceListDTO, error)`
      - 调 `SpanRepository.List`
      - 每行只返回 root span 摘要 + 聚合信息
- HTTP Handler：
  - `api/handlers/trace.go`
    - `GetTraceDetail`：绑定 `:trace_id` 路径参数 → 调 Application → 序列化响应
    - `ListTraces`：绑定 query 参数（`conversation_id` / `agent_name` / `is_error` / `start_time_from` / `start_time_to` / `page` / `page_size`）→ 调 Application → 序列化响应
    - 404：`ErrEmptyTrace` → HTTP 404 + `{"error": "trace not found"}`
    - 500：其他错误 → HTTP 500 + zap 记 error
- 路由注册：
  - `api/routers/route.go` 新增：
    - `GET /api/trace/:trace_id`
    - `GET /api/traces`
- Handler 单测：
  - `api/handlers/trace_test.go`：父规格 §8.5 三个用例

### 1.2 非目标

- 不做前端可视化瀑布图（父规格 §1.4）
- 不做树以外的检索能力（如全文搜 log）
- 不做实时推送（tracing 与事件系统解耦，父规格 §10.3）
- 不覆盖非 `/api/agent/chat` 的 trace（依 M3 覆盖范围）

---

## 2. 核心设计切片

### 2.1 BuildSpanTree 算法

严格对齐父规格 §6.2：

- 前置：nodes 已按 `span_id ASC` 排序（由 Repository 保证）
- 空 → `ErrEmptyTrace`
- 无 `parent_span_id = -1` 的 → `ErrNoRoot`
- 多个 `parent_span_id = -1` 的 → `ErrMultipleRoots`
- 找不到 parent 的 → 挂 root 并 mark `_orphan`
- 每层 children 已按 `span_id ASC`（因输入已排序）

### 2.2 GET /api/trace/:trace_id 响应契约

响应示例见父规格 §6.1。要点：

- 单节点入口 `root`，`children` 数组按 `span_id ASC`
- 顶层元字段派生：
  - `duration_ms = root.LatencyMs`
  - `is_error = ANY(node.is_error for node in flat)`（关键：与 root.is_error 语义分离，见父规格 §6.1）
  - `span_count = len(flat)`
- 404 场景：DB 无该 trace_id → 返回标准错误

### 2.3 GET /api/traces 分页列表

严格对齐父规格 §6.3：

- 查询参数：conversation_id / agent_name / is_error / start_time_from / start_time_to / page / page_size
- page_size 默认 20，最大 100
- Repository 层 SQL 从 `WHERE parent_span_id = -1` 的 root 行出发，配合子查询获取聚合
- `user_query_preview`：从 root span 的 tags 里取 `user.query`，截 128 字符

### 2.4 错误处理与降级

见父规格 §5.3：

- 查询失败 → zap error + HTTP 500，不影响主链路（本模块独立于主链路）
- BuildSpanTree 返回错误 → 转 HTTP 4xx/5xx，携带简短 error message
- 空 trace → 404，前端可显示"该 trace 已过期或不存在"

---

## 3. 数据流

```
GET /api/trace/:trace_id
        │
        ▼  Handler: 参数绑定
   TraceService.GetTraceDetail(ctx, traceID)
        │
        ▼  SpanRepository.FindByTraceID(ctx, traceID) → []*SpanNode
        │
        ▼  BuildSpanTree([]*SpanNode) → *SpanNode
        │
        ▼  聚合顶层元信息（is_error / span_count / duration_ms）
        │
        ▼  返回 JSON

GET /api/traces?...
        │
        ▼  Handler: query 参数绑定
   TraceService.ListTraces(ctx, filter)
        │
        ▼  SpanRepository.List(ctx, filter) → items, total
        │
        ▼  拼装分页响应
        │
        ▼  返回 JSON
```

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 扁平 → 树在 Domain 层做 | 算法可独立测试、与存储解耦 | §6.2 |
| 顶层 is_error 独立于 root.is_error | 错误不冒泡但列表页需红标 | §6.1 |
| 孤儿节点挂 root + 打 tag | 数据损坏时降级可读 | §6.2 |
| List 走 `parent_span_id=-1` 过滤 | 只列 root 摘要，避免全表扫 | §6.3 |
| page_size 上限 100 | 防止长响应拖慢查询 | §6.3 |

---

## 5. 验证边界

**技术验证**：`go test ./internal/domains/models/tracing/tree_test.go` 全绿；`go build ./...` 通过
**功能验证**：本模块前置需 M3 已产 span → 发一次真实 chat → 查询 API 拿回正确嵌套树 / 分页列表

详见 `docs/harness/e2e/agent-tracing-modules/M4-trace-query-api-e2e.md`

---

## 6. 交付验收

- [ ] `BuildSpanTree` 单测全绿（§8.2 用例 15–19）
- [ ] Handler 单测全绿（§8.5 三个用例）
- [ ] `GET /api/trace/:trace_id` 手动 curl 返回正确嵌套结构
- [ ] `GET /api/traces` 分页参数生效、过滤参数生效
- [ ] E2E 文档所有检查项通过
- [ ] `route.go` 变更与 M2 的初始化改动无冲突

---

**文档版本**：v1.0  |  **拆分自**：父规格 §3.2、§6、§5.3

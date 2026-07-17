# M4 查询 API 与树构建 E2E 验证文档

**日期**：2026-07-17
**关联 spec**：`docs/harness/specs/agent-tracing/M4-query-api-spec.md`

---

## 一、验证目标

- `GET /api/trace/:trace_id` 返回嵌套树、顶层字段正确
- `GET /api/traces` 分页 / 过滤生效
- BuildSpanTree 四种异常路径按契约响应
- 孤儿节点降级到 root 下、`_orphan=true` 标记
- 顶层 `is_error` 用聚合（而非 root.is_error）
- 查询响应时延：12 span 场景 < 50ms

---

## 二、前置条件

- M1 完成、`ai_span` 表存在
- M3 完成、有真实落盘数据（或用手写 SQL fixture）
- 服务可启动
- `curl` / `jq` / MySQL 客户端可用

---

## 三、验证步骤

### 3.1 Domain 单元测试

```bash
cd mooc-manus
go test -race -v -run TestBuildSpanTree ./internal/domains/models/tracing/
```

**必过用例（对应 spec §8.1）**：

| 用例 | 断言 |
|------|------|
| `TestBuildSpanTree_HappyPath` | 12 span 三级树，深度正确 |
| `TestBuildSpanTree_EmptyInput` | 返回 `ErrEmptyTrace` |
| `TestBuildSpanTree_NoRoot` | 返回 `ErrNoRoot` |
| `TestBuildSpanTree_MultipleRoots` | 返回 `ErrMultipleRoots` |
| `TestBuildSpanTree_OrphanNode` | 孤儿挂到 root，Tags["_orphan"]=true、Tags["_original_parent"]=原 parent |
| `TestBuildSpanTree_ChildrenSorted` | 输入乱序时 children 仍按 span_id ASC |

### 3.2 Application 单测

```bash
go test -race -v -run TestTraceService ./internal/applications/services/
```

**用例**：
- `TestGetTraceDetail_HappyPath` mock repo → 组装顶层字段 + 树
- `TestGetTraceDetail_IsErrorAggregation`：叶子 span error=true 时顶层 `is_error=true`（**root.is_error 仍为 false**）
- `TestListTraces_Filter`：filter 参数原样传递到 repo

### 3.3 Handler 单测

```bash
go test -race -v ./api/handlers/ -run TestTraceHandler
```

**用例**：
- `TestGetTraceDetail_200`
- `TestGetTraceDetail_404_NotFound`
- `TestGetTraceDetail_500_TraceCorrupted`（mock ErrNoRoot）
- `TestListTraces_Pagination`
- `TestListTraces_PageSizeClamp`：`page_size=200` clamp 到 100（不 400）
- `TestListTraces_InvalidPage`：`page=-1` → 400 INVALID_PARAM

### 3.4 端到端 HTTP 冒烟

**准备数据**：先发一次 chat 让 M2/M3 落盘

```bash
curl -X POST http://localhost:8080/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"e2e-conv-1","query":"帮我看一下 /tmp","messageId":"e2e-trace-1"}'
# 等待 5s 让 flush 落盘
sleep 6
```

**验证单条 trace**：

```bash
curl -s http://localhost:8080/api/trace/e2e-trace-1 | jq
```

**通过断言**：
- HTTP 200
- 顶层 `trace_id == "e2e-trace-1"`
- 顶层 `duration_ms > 0`
- `root.span_type == "AGENT_ROOT"`、`root.parent_span_id == -1`
- `root.children` 至少一个 AGENT_ROUND
- 每一层 `children` 按 `span_id` 升序
- 若 chat 内有 tool 调用：AGENT_ROUND 下有 TOOL_BATCH，TOOL_BATCH 下有 TOOL_CALL

**验证分页列表**：

```bash
curl -s "http://localhost:8080/api/traces?conversation_id=e2e-conv-1&page=1&page_size=10" | jq
```

**通过断言**：
- HTTP 200
- `total >= 1`
- `traces[0].trace_id == "e2e-trace-1"`
- `user_query_preview` 存在且长度 ≤ 128

### 3.5 顶层 `is_error` 聚合验证

**构造**：手写 3 条 span 到 DB：

```sql
INSERT INTO ai_span (trace_id, span_id, parent_span_id, span_type, is_error, start_time, end_time, ...) VALUES
  ('err-trace-1', 0, -1, 'AGENT_ROOT',  0, ..., ...),
  ('err-trace-1', 1,  0, 'AGENT_ROUND', 0, ..., ...),
  ('err-trace-1', 2,  1, 'TOOL_CALL',   1, ..., ...);
```

**请求**：

```bash
curl -s http://localhost:8080/api/trace/err-trace-1 | jq
```

**断言**：
- `is_error == true`（聚合）
- `root.is_error == false`（原样）

### 3.6 孤儿节点降级

**构造**：

```sql
INSERT INTO ai_span (trace_id, span_id, parent_span_id, span_type, ...) VALUES
  ('orphan-1', 0, -1,  'AGENT_ROOT', ...),
  ('orphan-1', 1,  0,  'AGENT_ROUND', ...),
  ('orphan-1', 2, 99,  'LLM_CALL', ...);  -- parent 99 不存在
```

**请求**：`GET /api/trace/orphan-1`

**断言**：
- HTTP 200（非 500）
- 存在挂在 root.children 里的节点带 `tags._orphan=true`、`tags._original_parent=99`

### 3.7 异常响应

| 请求 | 期望 |
|------|------|
| `GET /api/trace/does-not-exist` | 404 `{"code":"TRACE_NOT_FOUND"}` |
| `GET /api/traces?page=abc` | 400 `INVALID_PARAM` |
| `GET /api/trace/multi-root-fixture`（人工构造 2 个 -1）| 500 `TRACE_CORRUPTED` |
| DB 关掉后 `GET /api/trace/xxx` | 500 `INTERNAL_ERROR`，不泄露 SQL |

### 3.8 性能基线

```bash
hey -n 200 -c 20 http://localhost:8080/api/trace/e2e-trace-1
```

**通过标准**：
- P99 < 50ms（本地 MySQL，12 span 规模）
- 无 5xx

---

## 四、失败判定

| 场景 | 说明 |
|------|------|
| root.is_error 与顶层 is_error 混淆 | 未走聚合 |
| children 顺序错乱 | 排序或 append 逻辑错 |
| 孤儿节点导致 500 | 未做降级挂到 root |
| page_size=200 返回 400 | 未 clamp |
| DB 错误暴露 SQL | 错误处理泄露内部 |

---

## 五、观测点

- 查询 SQL 执行计划：应命中 `idx_trace` 索引
- 树构建 CPU 占用：12 span 场景 << 1ms
- JSON 序列化：无 escape 异常

---

## 六、回归红线

- 树构建不允许在生产触发 panic：孤儿 / 空 / 多 root 都要有明确 code
- 分页列表不允许全表扫描：filter 组合都应命中索引

---

## 七、通过标准（Gate）

- [ ] BuildSpanTree 单测 6 用例全通过
- [ ] Handler 单测覆盖 5 种响应 code
- [ ] HTTP 冒烟：单 trace 树、traces 列表返回符合契约
- [ ] 顶层 is_error 聚合语义正确（叶子红 → 顶层红、root 白）
- [ ] 孤儿降级：`_orphan=true` 标记生效
- [ ] 查询 P99 < 50ms（12 span）
- [ ] 错误响应不泄露内部

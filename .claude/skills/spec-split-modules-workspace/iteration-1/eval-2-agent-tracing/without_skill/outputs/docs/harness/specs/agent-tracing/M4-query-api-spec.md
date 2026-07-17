# M4 查询 API 与树构建设计文档

**日期**：2026-07-17
**父 spec**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块状态**：设计评审中
**关联仓库**：mooc-manus

---

## 一、模块目标

在已落盘的 `ai_span` 数据之上提供 HTTP 查询能力：单条 trace 的嵌套树 + 分页列表；核心是扁平→树构建算法。

### 1.1 交付范围

1. `api/handlers/trace.go`：`GET /api/trace/:trace_id`、`GET /api/traces`
2. `internal/applications/services/trace.go`：查询协调、DTO 组装、聚合派生
3. `internal/domains/models/tracing/tree.go`：`BuildSpanTree` 算法
4. Repository 查询实现：`FindByTraceID`、`ListTraces`
5. 路由注册（`api/routers/route.go`）
6. Handler / Application / Domain 三层单元测试

### 1.2 非目标

- 前端瀑布图（本期整体非目标）
- OpenTelemetry 协议序列化
- 敏感数据脱敏由 M1 已完成（存前打码），查询侧不再脱敏

---

## 二、依赖关系

- **前置**：M1（Repository 接口、SpanNode DO）、M3（数据已落盘）
- 若 M3 未完成，可用手写 SQL fixture 或 in-memory Repository 单测验证

---

## 三、GET /api/trace/:trace_id

### 3.1 请求

```
GET /api/trace/msg-abc-123
```

### 3.2 响应示例（嵌套树）

```json
{
  "trace_id": "msg-abc-123",
  "conversation_id": "conv-xyz",
  "agent_name": "manus-react",
  "start_time": 1734100000000000000,
  "end_time": 1734100015234000000,
  "duration_ms": 15234,
  "is_error": false,
  "span_count": 12,
  "root": {
    "span_id": 0,
    "parent_span_id": -1,
    "span_type": "AGENT_ROOT",
    "operation_name": "",
    "start_time": 1734100000000000000,
    "end_time": 1734100015234000000,
    "latency_ms": 15234,
    "is_error": false,
    "tags": { "agent.name": "manus-react", "user.query": "帮我..." },
    "logs": [],
    "children": [
      {
        "span_id": 1,
        "parent_span_id": 0,
        "span_type": "AGENT_ROUND",
        "children": [
          { "span_id": 2, "parent_span_id": 1, "span_type": "LLM_CALL", "children": [] },
          {
            "span_id": 3,
            "parent_span_id": 1,
            "span_type": "TOOL_BATCH",
            "children": [
              { "span_id": 4, "parent_span_id": 3, "span_type": "TOOL_CALL", "children": [] },
              { "span_id": 5, "parent_span_id": 3, "span_type": "TOOL_CALL", "children": [] }
            ]
          }
        ]
      }
    ]
  }
}
```

### 3.3 顶层字段派生

| 顶层字段 | 来源 |
|---------|------|
| `trace_id` | 请求路径参数 |
| `conversation_id` | root span 的 conversation_id 独立列 |
| `agent_name` | root span 的 agent_name 独立列 |
| `start_time` | root span 的 start_time |
| `end_time` | root span 的 end_time |
| `duration_ms` | root span 的 latency_ms |
| `span_count` | `SELECT COUNT(*) FROM ai_span WHERE trace_id=?` |
| `is_error` | **该 trace 内任意 span.is_error=true**（不是 root 自己的） |

**关键澄清**：由于埋点侧铁律「错误不冒泡」，`root.is_error` 可能为 false 但内部叶子已错。顶层 `is_error` 用聚合：`SUM(is_error) > 0`。前端「红色 trace」标记依赖顶层字段。

### 3.4 排序

- `children` 按 `span_id ASC`（输入已排序，append 顺序即升序）
- 树叶级 tags / logs 保持原样返回

---

## 四、扁平 → 树构建算法

### 4.1 位置

`internal/domains/models/tracing/tree.go`

### 4.2 实现

```go
var (
    ErrEmptyTrace    = errors.New("empty trace")
    ErrNoRoot        = errors.New("no root span")
    ErrMultipleRoots = errors.New("multiple root spans")
)

// BuildSpanTree 把从 DB 查出的扁平 SpanNode 数组还原成树
// 前置：nodes 已按 span_id ASC 排序
func BuildSpanTree(nodes []*SpanNode) (*SpanNode, error) {
    if len(nodes) == 0 {
        return nil, ErrEmptyTrace
    }

    idx := make(map[int32]*SpanNode, len(nodes))
    for _, n := range nodes {
        n.Children = make([]*SpanNode, 0)
        idx[n.SpanID] = n
    }

    var root *SpanNode
    var orphans []*SpanNode
    for _, n := range nodes {
        if n.ParentSpanID == -1 {
            if root != nil {
                return nil, ErrMultipleRoots
            }
            root = n
            continue
        }
        parent, ok := idx[n.ParentSpanID]
        if !ok {
            // 孤儿节点：parent 落盘丢失或数据损坏
            if n.Tags == nil {
                n.Tags = make(map[string]interface{})
            }
            n.Tags["_orphan"] = true
            n.Tags["_original_parent"] = n.ParentSpanID
            orphans = append(orphans, n)
            continue
        }
        parent.Children = append(parent.Children, n)
    }

    if root == nil {
        return nil, ErrNoRoot
    }
    for _, o := range orphans {
        root.Children = append(root.Children, o)
    }
    return root, nil
}
```

### 4.3 关键特性

- 两遍扫描 + map 索引，O(N) 时间 / O(N) 空间
- **孤儿节点降级**：parent 缺失时挂到 root 下 + `_orphan=true` 标记，避免「tracing 有洞时数据不可见」
- children 无需额外排序：输入已 ASC

---

## 五、GET /api/traces

### 5.1 请求

```
GET /api/traces?conversation_id=xxx&is_error=true&page=1&page_size=20
```

### 5.2 查询参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | string | 可选 |
| `agent_name` | string | 可选 |
| `is_error` | bool | 可选，只看有错 trace |
| `start_time_from` / `start_time_to` | int64（纳秒） | 可选 |
| `page` | int | 默认 1 |
| `page_size` | int | 默认 20，最大 100 |

### 5.3 响应示例

```json
{
  "total": 1234,
  "page": 1,
  "page_size": 20,
  "traces": [
    {
      "trace_id": "msg-abc-123",
      "conversation_id": "conv-xyz",
      "agent_name": "manus-react",
      "start_time": 1734100000000000000,
      "duration_ms": 15234,
      "span_count": 12,
      "is_error": false,
      "user_query_preview": "帮我查一下..."
    }
  ]
}
```

### 5.4 SQL 实现

- 从 `WHERE parent_span_id = -1` 的 root 行出发
- `user_query_preview` 从 root 的 `tags.user.query` 提取（前 128 字符）
- `is_error` 用子查询：`(SELECT SUM(is_error) FROM ai_span s2 WHERE s2.trace_id = s.trace_id) > 0`
- `span_count` 同上子查询 COUNT
- `page_size > 100` clamp 到 100

---

## 六、分层落位

| 层级 | 文件 | 职责 |
|------|------|------|
| Handler | `api/handlers/trace.go` | 参数绑定、Application 调用、序列化、HTTP 错误映射 |
| Application | `internal/applications/services/trace.go` | 查询协调、顶层字段派生、BuildSpanTree 调用 |
| Domain | `internal/domains/models/tracing/tree.go` | BuildSpanTree 算法 |
| Repository | `internal/infra/repositories/ai_span_repository.go` | FindByTraceID、ListTraces、poToNode |

---

## 七、错误响应

| 场景 | HTTP | Body |
|------|------|------|
| trace 不存在 | 404 | `{"code": "TRACE_NOT_FOUND"}` |
| 参数不合法（page_size 越界等） | 400 | `{"code": "INVALID_PARAM", "message": "..."}` |
| DB 查询失败 | 500 | `{"code": "INTERNAL_ERROR"}` |
| BuildSpanTree 返回 ErrNoRoot / ErrMultipleRoots | 500 | `{"code": "TRACE_CORRUPTED", "trace_id": "..."}` |
| BuildSpanTree 返回 ErrEmptyTrace | 404 | `{"code": "TRACE_NOT_FOUND"}` |

不暴露内部详情。

---

## 八、单元测试

### 8.1 Domain tree_test.go

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestBuildSpanTree_HappyPath` | 12 span 三级嵌套构建成功 |
| 2 | `TestBuildSpanTree_EmptyInput` | 返回 ErrEmptyTrace |
| 3 | `TestBuildSpanTree_NoRoot` | 返回 ErrNoRoot |
| 4 | `TestBuildSpanTree_MultipleRoots` | 返回 ErrMultipleRoots |
| 5 | `TestBuildSpanTree_OrphanNode` | 孤儿挂到 root，`_orphan=true` |
| 6 | `TestBuildSpanTree_ChildrenSorted` | 输入乱序时 children 仍按 span_id ASC |

### 8.2 Application trace_test.go

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestGetTraceDetail_HappyPath` | 从 mock repo 拿扁平数组 → 组装顶层字段 + 树 |
| 2 | `TestGetTraceDetail_IsErrorAggregation` | 叶子 span error=true 时顶层 `is_error=true` |
| 3 | `TestListTraces_Filter` | filter 参数正确传递到 repo |

### 8.3 Handler trace_test.go

| # | 用例 | 目标 |
|---|------|------|
| 1 | `TestGetTraceDetail_200` | 返回嵌套树 |
| 2 | `TestGetTraceDetail_404` | trace_id 不存在 |
| 3 | `TestGetTraceDetail_500_Corrupted` | mock BuildSpanTree 返 ErrNoRoot → 500 TRACE_CORRUPTED |
| 4 | `TestListTraces_Pagination` | page / page_size 参数、clamp |
| 5 | `TestListTraces_InvalidParam` | page_size=200 → clamp 到 100，不 400 |

---

## 九、验收清单

- [ ] `GET /api/trace/:trace_id` 返回嵌套树，顶层字段完整
- [ ] `GET /api/traces` 支持 5 类过滤 + 分页
- [ ] BuildSpanTree 四种异常路径均按契约返回
- [ ] 孤儿节点降级到 root 下、`_orphan=true` 标记
- [ ] 顶层 `is_error` 用聚合，不是 root 自身字段
- [ ] Handler / Application / Domain 三层单测全部通过
- [ ] 12 span 场景端到端调用 < 50ms（本地 MySQL）

# M1 数据模型与建表模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**模块编号**：M1
**依赖**：无
**被依赖**：M2、M3、M4

---

## 1. 模块范围

搭建 Agent Tracing 的领域数据地基：Span/LogEntry/SpanNode 值对象、SpanRepository 接口，配套敏感字段
打码与长度截断工具函数，以及 MySQL 建表 DDL。本模块交付后**没有可运行的追踪能力**，但为 M2/M3/M4
提供统一的类型契约和存储契约。

### 1.1 交付物

- 类型 / 值对象：
  - `internal/domains/models/tracing/span.go`
    - `SpanType` 常量（6 类：`AGENT_ROOT`、`AGENT_ROUND`、`LLM_CALL`、`TOOL_BATCH`、`TOOL_CALL`、`SUBAGENT_CALL`）
    - `LogEntry` 结构体（Ts / Level / Msg / Extra）
    - `Span` 结构体 + 方法骨架：`SetTag` / `AddLog` / `SetError` / `End` / `SetAgentName`（真正的运行时逻辑在 M2 补齐；本模块只定义签名与字段）
  - `internal/domains/models/tracing/tree.go`
    - `SpanNode` 结构体（查询响应专用 DO，与 Span 分开）
- 工具函数（供 `SetTag` 内部使用）：
  - `internal/domains/models/tracing/masker.go`
    - `MaskSensitive(key string, val interface{}) interface{}`：正则 `(?i)(api_?key|token|password|secret|authorization)` 命中则返回 `"***"`
    - `TruncateString(key string, val string) string`：按 key 分类阈值（`user.query` 1KB、`tool.arguments` 2KB、`tool.result_preview` 512B）
    - `Sha256Prefix(s string, n int) string`：sha256 前 n 位（用于 `system_prompt.hash`）
  - `internal/domains/models/tracing/masker_test.go`：正则命中、长度截断、hash 三组用例
- 仓储接口：
  - `internal/domains/models/tracing/repository.go`
    - `SpanRepository` 接口：`BatchInsert(ctx, spans []*Span) error`、`FindByTraceID(ctx, traceID string) ([]*SpanNode, error)`、`List(ctx, filter TraceListFilter) ([]*TraceListItem, int64, error)`（分页 total + list）
    - `TraceListFilter` / `TraceListItem` DTO
- 建表脚本：
  - `db/migrations/YYYYMMDDHHMM_create_ai_span.up.sql`
  - `db/migrations/YYYYMMDDHHMM_create_ai_span.down.sql`
  - 建表 DDL 见父规格 §3.6，索引：`uk_trace_span(trace_id, span_id)` / `idx_trace(trace_id)` / `idx_conv(conversation_id, created_at)` / `idx_error(is_error, created_at)`

### 1.2 非目标

- 不实现 Tracer 服务、缓冲区、批量 flush、Shutdown（属 M2）
- 不实现 SpanRepository 的 MySQL 版本（属 M2）
- 不做埋点注入到 BaseAgent / Chat（属 M3）
- 不实现 BuildSpanTree 树构建（属 M4；本模块仅定义 `SpanNode.Children` 字段）
- 不实现 HTTP Handler / Application Service（属 M4）

---

## 2. 核心设计切片

### 2.1 Span 值对象

字段与方法签名详见父规格 §3.1。本模块要求：

- `tags` 私有字段 `map[string]interface{}`
- `logs` 私有字段 `[]LogEntry`
- `mu sync.Mutex`、`ended atomic.Bool` 已声明（供 M2 使用）
- `tracer *Tracer` 反向引用字段声明（`Tracer` 类型在 M2 定义；M1 阶段可用前向声明或空 struct 占位）
- **方法体的实现**：本模块只需让 `SetTag` 走通"敏感字段打码 + 长度截断 + 加锁写 map"三步；`End()`/`SetError()`/`AddLog()` 的空壳骨架 + TODO 注释可留给 M2 补 commit 逻辑

### 2.2 SpanNode

- 字段严格与父规格 §3.2 一致
- JSON tag 必须齐全（`snake_case`）
- 与运行时 `Span` 解耦：无 mutex、无 tracer 反向引用

### 2.3 SpanRepository 接口

- 接口独立于任何具体存储实现，在 domain 层定义
- 具体 MySQL 实现（Repository）在 M2 落到 `internal/infra/repositories/ai_span_repository.go`
- 支持 Application 层的三种查询：全量查、按 conversation 查、按 error 查
- List 返回的 TraceListItem 只含 root span 摘要字段（用于列表页）

### 2.4 建表 DDL

DDL 全文见父规格 §3.6，关键字段：

- `trace_id VARCHAR(64)` = messageId
- `span_id INT` = trace 内自增，root 为 0
- `parent_span_id INT` = root 为 -1
- `tags JSON`、`logs JSON`（MySQL 5.7+；低版本降级为 LONGTEXT，本模块暂按 5.7+ 落）
- 四个索引齐全

---

## 3. 数据流

M1 无运行时数据流，只提供以下"契约"：

```
Domain 层：Span/LogEntry/SpanNode/SpanRepository（本模块）
                   ↑          ↑           ↑
                   │          │           │
Infra 层：       MySQL 实现（M2）       ────
                   ↑
Application 层：Tracer 服务、Handler（M2/M4）
```

**关键契约**：Span.tags/logs 私有 + SetTag 内做打码 → 打码逻辑集中，不可被埋点侧绕过。

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| Span 与 SpanNode 分离 | 运行时对象 vs 序列化 DO | §3.2 |
| tags/logs 私有 + Setter 内打码 | 打码不可绕过 | §3.1、§1.3 |
| SpanRepository 接口在 domain 层定义 | DDD 依赖倒置 | §2.2 |
| span_id 类型 `int32`、root=0、no-parent=-1 | 兼顾单调递增与嵌套树构建 | §3.1 / §3.6 |
| tags/logs 用 MySQL JSON | 5.7+ 原生支持、查询灵活 | §3.6 |
| `system_prompt` 只存 hash | 不冗余存储 | §1.3 |

---

## 5. 验证边界

**技术验证**（本模块无 UI、无对外接口，全部走技术层）：

- `go vet` / `go build ./...` 通过
- `go test ./internal/domains/models/tracing/...` 全绿（masker 用例）
- SQL 建表脚本可 `mysql < xxx.up.sql` 无错、`down.sql` 可回滚

**功能验证**（依赖下游模块 M2/M3/M4 补齐，本模块暂不涉及）

详见 `docs/harness/e2e/agent-tracing-modules/M1-tracing-domain-schema-e2e.md`

---

## 6. 交付验收

- [ ] 上述文件全部创建，位置与父规格 §2.2 分层一致
- [ ] `SpanType` 6 个常量齐全
- [ ] `MaskSensitive` 覆盖 5 个敏感 key 家族
- [ ] `TruncateString` 三档阈值可配
- [ ] `SpanRepository` 三个方法签名齐全
- [ ] 建表 DDL + rollback 可执行
- [ ] E2E 文档所有检查项通过
- [ ] 不阻塞 M2 立刻启动开发

---

**文档版本**：v1.0  |  **拆分自**：父规格 §3

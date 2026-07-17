# M1 数据模型与建表模块验证文档

**对应规格**：`docs/harness/specs/agent-tracing-modules/M1-tracing-domain-schema-spec.md`
**验证类型**：技术层验证（本模块无 UI、无对外接口）
**前置**：Go 环境可编译；本地 MySQL 5.7+ 可访问（可选，用于 DDL 校验）

---

## 1. 编译与静态检查

- [ ] **`go vet ./...` 无告警**
  - Run: `cd mooc-manus && go vet ./internal/domains/models/tracing/...`
  - Expected: 输出为空、退出码 0

- [ ] **`go build ./...` 无错**
  - Run: `cd mooc-manus && go build ./...`
  - Expected: 构建成功、无 undefined 符号

- [ ] **符号导出检查**
  - Run: `cd mooc-manus && go doc ./internal/domains/models/tracing`
  - Expected: 输出包含 `SpanType`、`Span`、`LogEntry`、`SpanNode`、`SpanRepository`、`MaskSensitive`、`TruncateString`、`Sha256Prefix` 等符号；`SpanType` 常量 6 个（`AGENT_ROOT` / `AGENT_ROUND` / `LLM_CALL` / `TOOL_BATCH` / `TOOL_CALL` / `SUBAGENT_CALL`）

---

## 2. Masker 工具函数单测

- [ ] **敏感 key 打码**
  - Run: `cd mooc-manus && go test -run TestMaskSensitive ./internal/domains/models/tracing/...`
  - Expected: 覆盖 `api_key` / `apikey` / `API_KEY` / `token` / `password` / `secret` / `authorization` 全部返回 `"***"`；非敏感 key（如 `agent.name`）原值透传

- [ ] **长度截断分档**
  - Run: `cd mooc-manus && go test -run TestTruncateString ./internal/domains/models/tracing/...`
  - Expected: `user.query` 键超 1024 字节被截断为 1024（含 `...` 后缀策略若有）；`tool.arguments` 超 2048 被截；`tool.result_preview` 超 512 被截；其他 key 不截

- [ ] **Sha256Prefix**
  - Run: `cd mooc-manus && go test -run TestSha256Prefix ./internal/domains/models/tracing/...`
  - Expected: `Sha256Prefix("hello world", 16)` 返回长度为 16 的十六进制字符串；同一输入结果稳定

---

## 3. SpanRepository 接口检查

- [ ] **接口方法齐全**
  - Run: `cd mooc-manus && go doc ./internal/domains/models/tracing SpanRepository`
  - Expected: 输出包含 `BatchInsert`、`FindByTraceID`、`List` 三个方法；DTO `TraceListFilter` / `TraceListItem` 已定义

- [ ] **接口独立性**
  - Run: `grep -rn "gorm\|sql\." mooc-manus/internal/domains/models/tracing/repository.go`
  - Expected: 无匹配 —— 接口层不能耦合具体 ORM/驱动

---

## 4. DDL 建表脚本

- [ ] **UP 脚本可执行**（有 MySQL 环境时）
  - Run: `mysql -u root -p test_db < mooc-manus/db/migrations/*_create_ai_span.up.sql`
  - Expected: 表 `ai_span` 创建成功；`SHOW INDEX FROM ai_span` 包含 `uk_trace_span` / `idx_trace` / `idx_conv` / `idx_error`

- [ ] **字段与父规格一致**
  - Run: `SHOW CREATE TABLE ai_span;`
  - Expected: 字段清单与父规格 §3.6 完全一致（含 trace_id / span_id / parent_span_id / span_type / operation_name / conversation_id / agent_name / start_time / end_time / latency_ms / is_error / tags / logs / created_at）

- [ ] **DOWN 脚本可回滚**
  - Run: `mysql -u root -p test_db < mooc-manus/db/migrations/*_create_ai_span.down.sql`
  - Expected: 表 `ai_span` 被 DROP；`SHOW TABLES LIKE 'ai_span'` 无输出

- [ ] **无 MySQL 环境时的降级校验**
  - Run: `grep -E "CREATE TABLE|INDEX|PRIMARY KEY" mooc-manus/db/migrations/*_create_ai_span.up.sql | wc -l`
  - Expected: 命中数 ≥ 5（1 CREATE + 4 INDEX/KEY）

---

## 5. Span 结构体字段与并发原语

- [ ] **字段与父规格 §3.1 对齐**
  - Run: `go doc ./internal/domains/models/tracing Span`
  - Expected: 公开字段包含 `TraceID` / `SpanID` / `ParentSpanID` / `SpanType` / `OperationName` / `ConversationID` / `AgentName` / `StartTime` / `EndTime` / `LatencyMs` / `IsError`；私有字段包含 `tags` / `logs` / `mu` / `ended` / `tracer`

- [ ] **SetTag 打码集成**
  - Run: `cd mooc-manus && go test -run TestSpan_SetTag_MaskSensitive ./internal/domains/models/tracing/...`
  - Expected: 调用 `span.SetTag("api_key", "sk-xxx")` 后从 span 序列化拿回 tags，值为 `"***"`（tags 私有需通过 SpanNode 或 helper 断言）

---

## 6. 边界与异常

- [ ] **敏感 key 大小写混合**
  - Run: `cd mooc-manus && go test -run TestMaskSensitive_CaseInsensitive ./internal/domains/models/tracing/...`
  - Expected: `Api-Key` / `AUTHORIZATION` / `Password` 全部命中打码

- [ ] **超长 value 无 panic**
  - Run: `cd mooc-manus && go test -run TestTruncate_HugeInput ./internal/domains/models/tracing/...`
  - Expected: 传入 10MB 字符串，截断结果长度 ≤ 阈值上限，函数不 panic 不 OOM

---

## 7. 交付验收

- [ ] 上述所有检查项通过
- [ ] `git status` 干净（本模块代码已 commit）
- [ ] `go test -race ./internal/domains/models/tracing/...` 全绿
- [ ] 无遗漏交付物（对照 spec §1.1 清单核对）
- [ ] M2 可以直接 import 本模块的类型与接口，无需再改 M1 代码

---

**文档版本**：v1.0  |  **拆分自**：父规格 §3、§8.2 用例 4–5

# 智能体链路追踪（Agent Tracing）端到端手动验证

> 关联 plan：`docs/superpowers/plans/2026-07-14-agent-tracing.md`
> 关联 spec：`mooc-manus/docs/superpowers/specs/2026-07-14-agent-tracing-design.md`

## 前置条件

- 本地 PostgreSQL 已应用 `mooc-manus/docs/sql/manus_schema.sql` 最新版本（含 `ai_span` 表）
- `config/config.toml` 里 PostgreSQL 连接字符串正确
- 依赖服务（Redis / Docker for skill executor）正常
- 后端：`cd mooc-manus && go run main.go`
- 前端可选：`cd mooc-manus-web && npm run dev`（本期不动前端，用 curl 即可）

## 用例 A：Happy Path（典型对话）

**目标**：验证一次成功 chat 产出完整 span 树，落盘到 `ai_span`，查询 API 返回嵌套树。

**步骤**：

1. 发起 chat（curl，需替换实际 model）：

```bash
curl -N -X POST http://localhost:8080/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "conversationId": "e2e-happy-'"$(date +%s)"'",
    "query": "帮我读取一下当前目录下 README.md 的前 20 行",
    "systemPrompt": "你是一个工程助手，善用 fileRead。",
    "toolIds": ["<fileRead 工具 id>"]
  }'
```

2. 从响应 SSE 里抓 `messageId`（即 `trace_id`），记为 `TID`。

3. 数据库校验：

```sql
SELECT span_id, parent_span_id, span_type, operation_name, latency_ms, is_error
FROM ai_span
WHERE trace_id = 'TID'
ORDER BY span_id ASC;
```

**期望**：
- 至少一行 `AGENT_ROOT`（span_id=0, parent=-1）
- 至少一行 `AGENT_ROUND` parent=0
- 至少一对 `LLM_CALL` / `TOOL_BATCH` parent 是同一个 ROUND
- `TOOL_CALL` operation_name = `fileRead`
- 所有 `is_error = false`
- `latency_ms > 0`

4. 查询 API 校验：

```bash
curl http://localhost:8080/api/trace/TID | jq
```

**期望**：
- HTTP 200
- 顶层 `is_error=false`、`span_count` ≥ 5
- `root.span_type = "AGENT_ROOT"`、`root.children[0].span_type = "AGENT_ROUND"`
- 树结构：ROUND 下同时含 LLM_CALL 和 TOOL_BATCH（若有 tool 调用）
- `root.tags` 含 `agent.name`、`user.query`、`conversation_id`、`system_prompt.hash`

## 用例 B：工具错误路径

**目标**：验证 tool 失败时叶子 span 标红，父 span 不冒泡。

**步骤**：

1. 发起 chat，引导 LLM 调用一个必然失败的工具（例如 fileRead 不存在的路径）：

```bash
curl -N -X POST http://localhost:8080/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"conversationId":"e2e-err-'"$(date +%s)"'","query":"读取 /tmp/definitely-not-exists.txt","toolIds":["<fileRead id>"]}'
```

2. 查询 API：

```bash
curl http://localhost:8080/api/trace/TID | jq '.root.children[0].children[] | {span_type, is_error, tags}'
```

**期望**：
- 至少一个 `TOOL_CALL` 的 `is_error=true`
- `TOOL_BATCH` 的 `is_error=false`（不冒泡）
- `AGENT_ROUND` / `AGENT_ROOT` 的 `is_error=false`
- 顶层聚合 `is_error=true`（`GET /api/trace/:trace_id` 响应的顶层）
- tool span 的 `logs` 含 `ERROR` 级 entry

## 用例 C：熔断触发

**目标**：验证熔断触发时 tool span 记录 `tool.circuit_breaker.trigger=true` 且 logs 有 `tool.circuit_breaker.open`。

**说明**：本期 tool.circuit_breaker.trigger tag 已在 Plan §Task 3.4 中标为 nice-to-have（可能未实现）。仅验证熔断本身机制仍正常触发即可。

**步骤**：

1. 构造场景：让同一 tool 反复失败（例如连续 3 次调用不存在的 skill）
2. 数据库：

```sql
SELECT span_id, tags->>'tool.circuit_breaker.trigger' AS cb_trigger, logs
FROM ai_span
WHERE trace_id = 'TID' AND span_type = 'TOOL_CALL';
```

**期望**：其中至少一行 `cb_trigger = 'true'`，`logs` 里含 `tool.circuit_breaker.open`。若本期未实现该 tag，只需验证熔断本身仍正常干预注入 prompt。

## 用例 D：HITL dangerous 工具审批

**目标**：验证 HITL 分支的 tool span 采集了 `tool.hitl.required=true` 与 `tool.hitl.decision`。

**步骤**：

1. 触发一个 dangerous 风险 tool（比如 bashExec 高危命令）
2. 通过 `/api/agent/resume` 批准或拒绝
3. 查询 API：

```bash
curl http://localhost:8080/api/trace/TID | jq '.root.children[].children[] | select(.span_type=="TOOL_CALL") | .tags'
```

**期望**：`tool.hitl.required=true`，`tool.hitl.decision` 是 `approve` / `reject` / `timeout` / `cancel` 之一，且 logs 含 `tool.hitl.requested` 和 `tool.hitl.decided`。

## 用例 E：子智能体调用

**目标**：验证 SubagentTool 产出 `SUBAGENT_CALL` 类型 span。

**步骤**：

1. 在 PlanMode 下发起 chat，让主智能体派发子任务（参考 `2026-07-12-subagents-implementation.md` 的验证用例）
2. 查询：

```sql
SELECT span_id, parent_span_id, span_type, operation_name
FROM ai_span
WHERE trace_id = 'TID' AND span_type = 'SUBAGENT_CALL';
```

**期望**：至少一行 `span_type = 'SUBAGENT_CALL'`，`operation_name` 是子智能体入口 tool 名。

## 用例 F：Stop 按钮 / context cancel

**目标**：验证 chat 中途 stop 时 root span 被 End、logs 含 `agent.context_cancelled`。

**步骤**：

1. 发起长 chat（触发工具执行）
2. 立即调用 `/api/agent/message/stop`（传 messageId）
3. 查询：

```bash
curl http://localhost:8080/api/trace/TID | jq '.root.logs, .duration_ms'
```

**期望**：`duration_ms` 存在（root 有 EndTime），logs 里出现 `agent.context_cancelled`。

## 用例 G：列表 API

**目标**：验证 `GET /api/traces` 分页、筛选。

**步骤**：

1. 发若干 chat 请求（成功 + 失败混合，同一 conversation_id）
2. 请求：

```bash
curl "http://localhost:8080/api/traces?page=1&page_size=10&conversation_id=e2e-err"
```

**期望**：`total` > 0，`traces` 数组每行含 `trace_id`、`is_error`、`user_query_preview`。

3. `is_error=true` 筛选：

```bash
curl "http://localhost:8080/api/traces?is_error=true&page=1&page_size=10"
```

**期望**：全部 `is_error=true`。

## 用例 H：缓冲区满不阻塞（压测）

**目标**：验证 tracing 缓冲区打满时业务 chat 依然完整返回。

**步骤**：

1. 临时把 `WithBufferCapacity(2)` 覆盖（可在 route.go 里改成很小容量，验证后回滚）
2. 循环发 50 个 chat 请求
3. 观察：所有 chat 均正常返回 SSE，`tracer.DroppedCount()` > 0（日志里能看到 `tracing buffer full, dropping span` Warn）
4. **验证完毕后回滚 route.go 的临时改动**

## 用例 I：性能对比

**步骤**：

1. 基线：`git stash` 回退本改动，跑 100 次 chat，记录 P50/P99
2. 恢复改动：`git stash pop`，重跑
3. 对比 P50/P99 增幅，**目标 ≤ 5%**

## 验证结果记录模板

```
## 验证记录

- **执行人**：XXX
- **日期**：YYYY-MM-DD
- **PostgreSQL 版本**：X.Y
- **用例 A 结果**：Pass / Fail（附截图或 SQL 查询结果）
- **用例 B 结果**：...
- ...
- **性能对比**：P50 baseline=XXms, after=YYms, delta=Z%
```

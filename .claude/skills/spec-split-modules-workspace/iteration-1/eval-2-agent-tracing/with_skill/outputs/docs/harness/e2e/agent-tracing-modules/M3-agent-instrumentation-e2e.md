# M3 埋点注入模块验证文档

**对应规格**：`docs/harness/specs/agent-tracing-modules/M3-agent-instrumentation-spec.md`
**验证类型**：功能验证（HTTP + DB 双验证）+ Application 集成测试
**前置**：M1、M2 已合入；MySQL 可访问；LLM Provider 已配置（或 mock）；服务可启动

---

## 1. 编译与签名改造

- [ ] **函数签名改造完成、调用点同步**
  - Run: `cd mooc-manus && go build ./...`
  - Expected: 编译通过；`StreamingInvokeLLM` / `InvokeLLM` 已收 `ctx` 首参；所有内部/外部调用点已更新

- [ ] **仅两处签名变更**
  - Run: `git diff --stat HEAD~1 | grep -E "base\.go|agent\.go"`
  - Expected: 签名改造只影响 `BaseAgent.StreamingInvokeLLM` / `BaseAgent.InvokeLLM`，其他 API 不变

---

## 2. Application 集成测试（父规格 §8.3 用例 1–8）

- [ ] **TestChat_HappyPath_SpanStructure**
  - Run: `go test -run TestChat_HappyPath_SpanStructure ./internal/applications/services/...`
  - Expected: 1 root + 2 round + 2 llm + 1 batch + 2 tool = 8 span；父子关系正确；tags 齐全；`ConversationID` / `AgentName` 独立列已填

- [ ] **TestChat_ToolError_IsErrorFlag**
  - Run: `go test -run TestChat_ToolError_IsErrorFlag ./internal/applications/services/...`
  - Expected: 出错 tool span `is_error=true`；所有父 span `is_error=false`（不冒泡）

- [ ] **TestChat_ContextCancel_RootSpanClosed**
  - Run: `go test -run TestChat_ContextCancel_RootSpanClosed ./internal/applications/services/...`
  - Expected: ctx cancel 后 root span 已 End；logs 含 `agent.context_cancelled`

- [ ] **TestChat_MaxIterationsExceeded_RootIsError**
  - Run: `go test -run TestChat_MaxIterationsExceeded_RootIsError ./internal/applications/services/...`
  - Expected: 死循环 tool → root `is_error=true`；logs 含 `agent.max_iterations_exceeded`

- [ ] **TestChat_HITLDangerousTool_SpanTags**
  - Run: `go test -run TestChat_HITLDangerousTool_SpanTags ./internal/applications/services/...`
  - Expected: dangerous 风险 tool span tags `tool.hitl.required=true` / `tool.hitl.decision="approve"`

- [ ] **TestChat_SubagentCall_SpanType**
  - Run: `go test -run TestChat_SubagentCall_SpanType ./internal/applications/services/...`
  - Expected: 子智能体 tool 对应 span `span_type="SUBAGENT_CALL"` + `subagent.name` tag

- [ ] **TestChat_TracerBufferFull_BusinessUnaffected**
  - Run: `go test -run TestChat_TracerBufferFull_BusinessUnaffected ./internal/applications/services/...`
  - Expected: 缓冲区容量 1 + flush 禁用 → Chat 正常返回；事件流完整；`dropCounter >= 7`

- [ ] **TestChat_LoopContextPropagation_RoundParentIsRoot**
  - Run: `go test -run TestChat_LoopContextPropagation_RoundParentIsRoot ./internal/applications/services/...`
  - Expected: 2 轮 ReAct，两个 AGENT_ROUND 的 `parent_span_id` 均 = root.span_id (=0)。防"ctx 覆盖"回归

---

## 3. 真实链路 happy path（HTTP + DB）

前置：服务运行中（`make run`）；MySQL ai_span 表为空；有效的 LLM Provider 配置。

- [ ] **发一次典型 chat**
  - Run:
    ```
    curl -N -X POST http://localhost:8080/api/agent/chat \
      -H 'Content-Type: application/json' \
      -d '{"messageId":"e2e-msg-001","conversationId":"conv-e2e-1","query":"帮我在当前目录 ls 一下","maxIterations":5}'
    ```
  - Expected: SSE 流正常输出、含 tool_call 与 tool_result 事件，最终 stream 收尾

- [ ] **DB span 落盘校验**
  - Run: `mysql -e "SELECT span_type, span_id, parent_span_id FROM ai_span WHERE trace_id='e2e-msg-001' ORDER BY span_id"`
  - Expected: 至少含 1 AGENT_ROOT (span_id=0, parent=-1) + N AGENT_ROUND + N LLM_CALL + M TOOL_BATCH + K TOOL_CALL；无孤儿 (parent_span_id 全部命中已知 span_id 或 =-1)

- [ ] **独立列填充**
  - Run: `mysql -e "SELECT conversation_id, agent_name FROM ai_span WHERE trace_id='e2e-msg-001' AND span_id=0"`
  - Expected: `conversation_id='conv-e2e-1'`；`agent_name` 非空（`base` 或实际 agent 名）

- [ ] **敏感字段打码校验**
  - Step: 触发一次 chat query 里含 `api_key=sk-xxx`（用户提问里带敏感字符串）
  - Run: `mysql -e "SELECT tags FROM ai_span WHERE trace_id='...' AND span_type='AGENT_ROOT'"`
  - Expected: tags 内 `user.query` 保留原文（因是 user 输入 preview，只截长度不打码）；但若 tool.arguments 中传入 api_key 则被打码为 `***`

---

## 4. 异常路径

- [ ] **工具错误 → 叶子标红，父不冒泡**
  - Step: 触发一次 tool 会 return error 的 chat（比如访问不存在文件）
  - Run: `mysql -e "SELECT span_id, span_type, is_error FROM ai_span WHERE trace_id='...' ORDER BY span_id"`
  - Expected: 该 tool 对应行 `is_error=1`；其他行 `is_error=0`

- [ ] **HITL 场景 span tags**
  - Step: 触发一次 dangerous tool（配置 HITL）且用户 Approve
  - Run: `mysql -e "SELECT JSON_EXTRACT(tags, '$.\"tool.hitl.required\"'), JSON_EXTRACT(tags, '$.\"tool.hitl.decision\"') FROM ai_span WHERE span_type='TOOL_CALL' AND trace_id='...'"`
  - Expected: `tool.hitl.required=true`；`tool.hitl.decision="approve"`

- [ ] **子智能体调用 span_type**
  - Step: 触发一次会调子 agent 的 chat
  - Run: `mysql -e "SELECT span_type, JSON_EXTRACT(tags, '$.\"subagent.name\"') FROM ai_span WHERE trace_id='...' AND span_type='SUBAGENT_CALL'"`
  - Expected: 至少 1 行 `SUBAGENT_CALL` + `subagent.name` 非空

- [ ] **ctx cancel 场景**
  - Step: 发一次 chat 后立即 client 断开连接（`curl` 中途 Ctrl-C）
  - Run: `mysql -e "SELECT logs FROM ai_span WHERE span_id=0 AND trace_id='...'"`
  - Expected: logs JSON 中含 `msg='agent.context_cancelled'` 的 entry

---

## 5. 性能与稳定性

- [ ] **端到端时延增长 ≤ 5%**
  - Step 1: M3 未合入前对 `/api/agent/chat` 做 10 次典型对话压测记录 p50/p95
  - Step 2: M3 合入后重复相同 workload
  - Expected: p95 增长 ≤ 5%；若不达标需按父规格 §7.5 调整方向（减 tag / 增大 batch / 换 ring buffer）

- [ ] **`-race` 无并发问题**
  - Run: `go test -race ./internal/applications/services/... ./internal/domains/services/agents/...`
  - Expected: 无 DATA RACE 告警

- [ ] **无 goroutine 泄漏**
  - Run: `go test -run TestChat_HappyPath_SpanStructure ./internal/applications/services/...`（结合 goleak）
  - Expected: 测试退出时无残留 goroutine

---

## 6. 空状态 / 加载态 / 终态

- [ ] **无历史数据**：ai_span 表清空后发第一条 chat → 表按 spec 结构填充
- [ ] **max_iterations 到达终态**：`is_error=true` + logs 有 `agent.max_iterations_exceeded`
- [ ] **正常终态**：chat 无 tool_calls 早停，root `is_error=false`，span 数量正确

---

## 7. 跨模块联动（M4 会消费本模块产出）

- [ ] **span 结构可被 BuildSpanTree 还原**（M4 交付后跑）
  - Run: `curl http://localhost:8080/api/trace/e2e-msg-001 | jq '.root.span_type'`
  - Expected: `"AGENT_ROOT"`；`.root.children` 数组非空
  - 依赖：M4 已交付；M3 单独验收时跳过此项（TODO）

---

## 8. 交付验收

- [ ] 上述所有检查项通过（跨模块联动项待 M4 后补测）
- [ ] `git status` 干净
- [ ] `go build ./... && go test -race ./...` 全绿
- [ ] p95 端到端时延增长 ≤ 5%
- [ ] Application 集成测试用例 1–8 全绿

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4、§8.3、§9

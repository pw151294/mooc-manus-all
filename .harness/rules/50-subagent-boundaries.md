---
rule_id: R-50-subagent
severity: high
---

# 子智能体（Subagents）边界与约束

## 禁止行为

1. **禁止子智能体递归调用 dispatchSubagent**
   - `allowed_tools` 参数校验必须拒绝包含 `dispatchSubagent` 的请求

2. **禁止子智能体访问主智能体的 ChatMemory**
   - 子智能体使用独立的局部 `ChatMemory`，不走全局 `FetchMemory`

3. **禁止非 PlanMode 下注入 SubagentTool**
   - Domain 层 `createBaseAgent` 必须检测 `request.EnableSubagent == true`

4. **禁止子智能体共享主智能体的熔断器**
   - 子智能体由 `buildAgentRunner` 创建，自带独立 `ToolCallCounter`

## 要求行为

1. **工具白名单严格校验**
   - `allowed_tools` 必须是主智能体工具集中已注册函数名的子集
   - 白名单校验失败立即返回错误

2. **资源隔离与清理**
   - 子智能体 Memory 不注册到全局 MemoryManager，依赖 GC 回收
   - 子智能体 messageId 格式：`{主messageId}-sub-{subagentId}`

3. **事件透传与标识**
   - 子智能体事件通过 `SubagentEventBridge.ForwardEvent` 透传
   - ToolEvent.Metadata 必须包含 `subagent_id`、`is_subagent`、`subagent_task` 字段
   - `parentEventCh` 为 nil 时安全降级（不透传，不 panic）

4. **HITL 审批共享**
   - 子智能体高危工具调用走主智能体的 `PendingSink`
   - messageId 使用组合格式确保审批定位正确

5. **Context 传递与超时**
   - 子智能体必须继承主智能体的 `context.Context`
   - 默认 3 分钟总超时保护（`SubagentTool.timeout`）

## 可验证性

- 单测：
  - `TestSubagentTool_RejectRecursiveCall` — 递归检测
  - `TestSubagentTool_RejectInvalidTools` — 白名单校验
  - `TestSubagentTool_ExecuteTimeout` — 超时保护
  - `TestSubagentTool_ExecuteContextCancelled` — 取消传递
- 集成测试：
  - `TestSubagentTool_ExecuteSuccess` — 完整执行流程
  - `TestSubagentTool_EventBridgeForwarding` — 事件透传

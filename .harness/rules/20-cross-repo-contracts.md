---
rule_id: R-20-contracts
severity: high
---

# 前后端契约

## SSE 事件契约（16 种，权威定义见 `mooc-manus/internal/domains/models/events/constants.go`）

前端 `mooc-manus-web/src/api/sse.ts` 订阅的事件类型，分四组：

- **通用消息**：`title` / `message` / `message_end`
- **工具调用**：`tool_call_start` / `tool_call_complete` / `tool_call_fail`
- **Plan 流转**：`plan_create_success` / `plan_update_success` / `plan_update_failed` / `plan_completed`
- **Step 流转**：`step_start` / `step_complete` / `step_fail`
- **系统控制**：`wait` / `error` / `done`

**约束**：
1. 后端新增事件类型 → 必须同步更新前端 `EventType` 类型定义
2. 修改事件 payload 结构 → 先写 ADR，说明向后兼容策略
3. 前端不得订阅未定义事件（ESLint 规则校验）

## DTO 结构约束

后端 `mooc-manus/internal/interfaces/dtos/` 定义的 DTO，与前端 `mooc-manus-web/src/types/` 对应 TS 类型必须：
- 字段名一致（camelCase）
- 可空性一致（Go `*Type` → TS `Type | null`）
- 枚举值一致

## API 版本

当前无版本号，默认 `/api/v1`。引入 breaking change 时：
- 先开 ADR 讨论迁移方案
- 通过 `/api/v2` 并行新旧两版，保留旧版至少 1 个 release cycle

## Agent 行为

- 任何"修改事件类型 / DTO"的 spec → 自动 dispatch `event-contract-checker`
- 发现契约不一致 → 标记为 blocker，生成双仓修复 plan

## 可验证性

CI 跑 `.harness/scripts/validate-contracts.sh`：
- 前端 EventType 枚举 ⊆ 后端事件定义
- DTO JSON schema 前后端一致性检查

详细 payload 必填字段见 `mooc-manus/.harness/rules/45-event-emission.md`（R-45）

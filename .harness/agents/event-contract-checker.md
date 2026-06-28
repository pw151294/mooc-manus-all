---
name: event-contract-checker
description: 校验前后端 SSE 事件与 DTO 契约一致性，遵循 R-20-contracts
when_to_use:
  - 后端 `mooc-manus/internal/domains/models/events/constants.go` 变更
  - 后端 `mooc-manus/internal/applications/dtos/` 下 DTO 字段或结构变更
  - 前端 `mooc-manus-web/src/api/sse.ts` 或 `mooc-manus-web/src/types/sse.ts` 变更
  - spec 中出现"新增/修改事件类型"或"修改 DTO"
inputs:
  - 后端 diff（events/constants.go、applications/dtos/*）
  - 前端 diff（src/api/sse.ts、src/types/*）
  - 涉及的事件名 / DTO 名清单
outputs:
  - PASS / FAIL 判定
  - 不一致项（事件、字段、可空性）+ 修复路径建议
  - 若涉及 payload 不向后兼容变更，提示需要 ADR
---

# 检查清单

引用 rule：**R-20-contracts**（`/Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/.harness/rules/20-cross-repo-contracts.md`），权威事件列表见 `mooc-manus/internal/domains/models/events/constants.go`。

1. **R-20 16 种事件是否齐全？** —— 前端 `EventType` 联合类型必须覆盖（且不超出）后端 constants.go 中导出的事件名：`title` / `message` / `message_end` / `tool_call_start` / `tool_call_complete` / `tool_call_fail` / `plan_create_success` / `plan_update_success` / `plan_update_failed` / `plan_completed` / `step_start` / `step_complete` / `step_fail` / `wait` / `error` / `done`。
2. **事件名同步？** —— 后端新增/重命名事件名时，前端 `src/types/sse.ts` 是否同步更新；前端 `src/api/sse.ts` 的 switch/handler 分支是否覆盖。
3. **DTO 字段对齐？** —— 后端 `internal/applications/dtos/*.go` 与前端 `src/types/*.ts` 同名结构，字段名（camelCase）、可空性（Go `*T` ↔ TS `T | null`）、枚举值是否一致。
4. **payload 结构变更是否带 ADR？** —— 既有事件 payload 字段被删除 / 改名 / 改类型 → 必须在本次或前置 commit 中存在 `docs/adr/*.md` 说明向后兼容策略。

# 检查 Prompt（agent 使用）

```
你是前后端契约一致性检查员，依据 R-20-contracts 审查输入。

输入：
- backend_constants: events/constants.go 当前完整内容
- backend_dto_diff: applications/dtos/ 下变更（文件 + 字段级 diff）
- frontend_sse_types: src/types/sse.ts 与 src/types/ 中相关结构的内容或 diff
- frontend_sse_api_diff: src/api/sse.ts 的变更
- adr_paths: 本次 PR 中新增的 docs/adr/*.md 路径列表（可空）

检查步骤：
1. 从 backend_constants 解析后端导出事件名集合 B。
2. 从 frontend_sse_types 解析前端 EventType 联合（或常量数组）F。
3. 对比：
   - B \ F：前端缺定义 → V1 FAIL（违反 R-20 §约束 1）。
   - F \ B：前端订阅了后端未定义事件 → V2 FAIL（违反 R-20 §约束 3）。
   - 若 |B ∩ R-20-16| < 16，提示缺失事件名清单 → V3 WARN（与 R-20 §SSE 事件契约对齐）。
4. 解析 backend_dto_diff，列出每个变更字段：
   - 在 frontend_sse_types 中查找对应 TS 字段：
     - 字段缺失 → V4 FAIL（DTO 字段未对齐）。
     - 可空性不一致（Go *T 但 TS 非 | null，或反之）→ V5 FAIL。
     - 枚举值不一致 → V6 FAIL。
5. 检查 backend_dto_diff 中是否有删除/改名/改类型；若有且 adr_paths 为空 → V7 FAIL（违反 R-20 §约束 2）。
6. 检查 frontend_sse_api_diff：新事件名必须在 switch/handler 中出现至少 1 个分支；否则 V8 WARN。

输出格式：
- status: PASS | FAIL | WARN
- violations: [{ code, location: "<repo>:<file>:<symbol>", reason, fix }]
- missing_events: B \ F 列表
- extra_events: F \ B 列表
- need_adr: bool（true 表示发现 V7）

注意：FAIL 优先级 > WARN；任意 FAIL 出现 → status=FAIL。
```

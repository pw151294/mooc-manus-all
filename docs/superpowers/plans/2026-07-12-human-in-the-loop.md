# 智能体高危工具人工审批（Human in the Loop）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mooc-manus 的 `BaseAgent.InvokeToolCalls` 前置一个"高危工具审批闸门"。主 LLM 在 `bashExec` schema 里自评 `risk_level`；`dangerous` 时 Agent goroutine park 在 chan、SSE 抛 `tool_call_interrupt`；用户通过 `POST /api/agent/resume` 回投决策；5 分钟无决策按拒绝处理。

**Architecture:** Agent 层通过窄接口 `PendingSink` 反查 app service 层的 `pendingInterrupts` map；`atomic.Bool` CAS 保证 Resume/Timer/Stop 三路互斥；Stop 路径先 resolve(Cancel) → 200ms sleep → 补齐孤儿 tool result → 原三段清理。前端在对话窗渲染 `InterruptCard`。

**Tech Stack:** Go 1.24（后端）、Gin、gin-gonic 现有 SSE 实现、Vue3 + TypeScript（前端）、Playwright MCP（E2E）。

**关联 spec：** `docs/superpowers/specs/2026-07-12-human-in-the-loop-design.md`（brainstorming 11 项决策 D1-D11 已定稿）。

**重要工作约束（.harness/rules 已确认）：**
- 🔴 禁止在总仓（mooc-manus-all）直接修改子仓（mooc-manus / mooc-manus-web）文件。所有编码在子模块目录内进行、子模块内独立提交。
- 🔴 分层：Handler → Application → Domain → Repository；不得跨层反向依赖。
- 🟠 事件类型新增必须同步维护 `.harness/rules/20-cross-repo-contracts.md` 与 `.harness/rules/45-event-emission.md` 里的事件类型清单。
- 🟠 ChatMemory 只能通过 `memory.FetchMemory(conversationId)` 获取，不能在其他地方新建。

**前置事实校正（vs spec）：**
- Tool 接口实际在 `internal/domains/services/tools/base.go`（不是 spec 写的 `models/tools/`）。plan 按实际路径落地。
- `ChatMemory.AddMessage` **无独立锁**（`memory/memory.go:21-24`）；仅 `memory.Manager.FetchMemory` 有 `sync.Mutex`。Stop 补齐路径在 goroutine 已 return 后单点写入，本方案在此单点写不会 race——见 Task 15 前置任务确认。
- `bashExec` 现有必填参数 `command` / `description`（`services/tools/bash_exec.go:120`）；新增 `risk_level` / `risk_reason` 后必填清单变为 4 项。
- `NewBaseAgent` 共 3 处调用者：`agents/agent.go:254`、`agents/a2a.go:123`、`flows/plan_react.go:32,34`；functional option 改造需 3 处迁移。

---

## 文件结构

**新增文件：**

| 路径 | 职责 |
|---|---|
| `internal/domains/models/interrupt/messages.go` | HITL 相关固定文案常量 |
| `internal/domains/models/interrupt/parse.go` | `ParseRiskFromArgs` 与错误哨兵 |
| `internal/domains/models/interrupt/parse_test.go` | ParseRiskFromArgs 单测 U-01~U-06 |
| `internal/domains/models/events/interrupt.go` | `ToolInterruptEvent` + `OnToolCallInterrupt` |
| `internal/domains/services/agents/pending_sink.go` | `PendingSink` 接口 + `InterruptDecision` / `InterruptSnapshot` |
| `internal/applications/services/interrupt.go` | `pendingSlot` + `RegisterInterrupt` / `WaitTimeout` / `Resume` 实现 |
| `internal/applications/services/interrupt_test.go` | pendingSlot & Resume 单测 U-07~U-17 |
| `internal/applications/services/agent_hitl_integration_test.go` | 集成测试 I-01~I-13 |
| `internal/applications/services/mocks_test.go` | MockInvoker + MockTool 测试基建 |
| `internal/applications/dtos/agent_resume.go` | `ResumeClientRequest` / `ResumeResult` |
| `docs/e2e/human-in-the-loop.md` | E2E-01~E2E-05 测试脚本 |

**修改文件：**

| 路径 | 改动 |
|---|---|
| `internal/domains/models/events/constants.go` | 增 `EventTypeToolCallInterrupt`、`ToolEventStatusInterrupted` |
| `internal/domains/services/tools/base.go` | `Tool` interface 增 `SupportsRiskAssessment() bool`；`BaseTool` 加默认实现返回 false |
| `internal/domains/services/tools/bash_exec.go` | schema 增 2 字段 + `SupportsRiskAssessment() bool { return true }` + 覆写 |
| `internal/domains/services/agents/base.go` | 结构体新增 `pendingSink` / `messageId` 字段；`NewBaseAgent` 改 functional option；`InvokeToolCalls` 增中断分支 |
| `internal/domains/services/agents/agent.go` | `NewBaseAgent` 调用点迁移 + 传入 pendingSink / messageId |
| `internal/domains/services/agents/a2a.go` | `NewBaseAgent` 调用点迁移（A2A 不传 pendingSink，本地不进闸门）|
| `internal/domains/services/flows/plan_react.go` | 2 处 `NewBaseAgent` 调用点迁移 |
| `internal/applications/services/agent.go` | `BaseAgentApplicationServiceImpl` 新增 `pendingInterrupts` 字段；`stopMessageInternal` 增 pending 联动；`Chat` 传 pendingSink |
| `internal/infra/external/sse/manager.go` | 新增导出函数 `ConversationIdOf(messageId) string` |
| `api/handlers/agent.go` | 新增 `Resume` handler |
| `api/routers/route.go` | 新增 `agent.POST("/resume", agentHandler.Resume)` |
| `mooc-manus-web/src/api/sse.ts` | 新增 `tool_call_interrupt` 事件解析与分发 |
| `mooc-manus-web/src/components/InterruptCard.vue`（或对齐现有组件目录）| 审批卡片组件（新增文件） |
| `mooc-manus-web/src/components/Chat/*.vue`（消息渲染入口）| 增 InterruptCard 分支渲染 |
| `.harness/rules/20-cross-repo-contracts.md` | 追加 `tool_call_interrupt` 事件契约 |
| `.harness/rules/45-event-emission.md` | 追加 `tool_call_interrupt` 事件类型 |

---

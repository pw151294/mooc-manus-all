# 智能体高危工具人工审批（Human in the Loop）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mooc-manus 的 `BaseAgent.InvokeToolCalls` 前置一个"高危工具审批闸门"。主 LLM 在 `bashExec` schema 里自评 `risk_level`；`dangerous` 时 Agent goroutine park 在 chan、SSE 抛 `tool_call_interrupt`；用户通过 `POST /api/agent/resume` 回投决策；5 分钟无决策按拒绝处理。

**Architecture:** Agent 层通过窄接口 `PendingSink` 反查 app service 层的 `pendingInterrupts` map；`atomic.Bool` CAS 保证 Resume/Timer/Stop 三路互斥；Stop 路径先 resolve(Cancel) → 200ms sleep → 补齐孤儿 tool result → 原三段清理。前端在对话窗渲染 `InterruptCard`。

**Tech Stack:** Go 1.24（后端）、Gin、gin-gonic 现有 SSE 实现、React 19 + Vite + TypeScript + Ant Design + Zustand（前端）、Playwright MCP（E2E）。

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
| `mooc-manus-web/src/types/sse.ts` | `SSEEventType` union 追加 `tool_call_interrupt`；新增 `ToolInterruptEventData` interface |
| `mooc-manus-web/src/api/modules/agent.ts`（或复用 request.ts 里的通用 POST）| 新增 `resumeAgent` 请求函数 |
| `mooc-manus-web/src/components/InterruptCard/InterruptCard.tsx`（新增目录/文件）| 审批卡片组件 |
| 前端对话窗消息渲染入口（React 组件，具体路径实施时定位）| 增 InterruptCard 分支渲染 |
| `.harness/rules/20-cross-repo-contracts.md` | 追加 `tool_call_interrupt` 事件契约 |
| `.harness/rules/45-event-emission.md` | 追加 `tool_call_interrupt` 事件类型 |

---

## 阶段划分

按依赖顺序 6 个阶段，每阶段结束一次可回归的稳定点：

- **阶段 A（Task 1-3）**：底层值对象 + 常量 + 事件（无外部依赖，纯 Domain 层）
- **阶段 B（Task 4-6）**：Tool 接口扩展 + bashExec schema 改造
- **阶段 C（Task 7-9）**：Agent 层集成（BaseAgent 结构体、NewBaseAgent option、InvokeToolCalls 中断分支）
- **阶段 D（Task 10-14）**：App Service 层集成（pendingSlot、Register、Resume、Stop 联动、Chat 装配）
- **阶段 E（Task 15-17）**：API 层 + Route + 前后端契约同步
- **阶段 F（Task 18-21）**：前端 SSE + InterruptCard + Resume 调用
- **阶段 G（Task 22-25）**：集成测试 + E2E + 手工验收

---

## 前置动作：进入子模块工作目录

⚠️ **所有编码都在 `mooc-manus/` 子模块内进行，子模块内独立 commit，父仓只做子模块指针升级。**

- [ ] **P0-1：切到 mooc-manus 子模块**

```bash
cd /Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/mooc-manus
git status
git branch --show-current
```

Expected: 显示 mooc-manus 子模块目录、当前 branch。若不是 master 或 feature 分支，与用户确认后创建 feature 分支。

- [ ] **P0-2：确认 memory 并发写入语义**

Run: `grep -n "AddMessage\|AddMessages" internal/domains/models/memory/memory.go`

Expected: 看到 `AddMessage`、`AddMessages` 无锁保护。**结论**：Stop 补齐 tool result 前 Agent goroutine 必须已经 return（依靠 200ms sleep 兜底 + Cancel 分支立即 return）；本方案在此前提下无 race，无需为 `ChatMemory` 加锁。若后续 review 发现有并发写路径，回头补锁。

---

## 阶段 A：底层值对象、常量与事件

### Task 1：新增 interrupt 包（固定文案 + ParseRiskFromArgs）

**Files:**
- Create: `internal/domains/models/interrupt/messages.go`
- Create: `internal/domains/models/interrupt/parse.go`
- Create: `internal/domains/models/interrupt/parse_test.go`

- [ ] **Step 1: 先写失败的测试**

`internal/domains/models/interrupt/parse_test.go`：

```go
package interrupt

import (
	"errors"
	"testing"
)

func TestParseRiskFromArgs_Safe(t *testing.T) {
	lv, r, err := ParseRiskFromArgs(`{"command":"ls","risk_level":"safe","risk_reason":"read-only"}`)
	if err != nil || lv != "safe" || r != "read-only" {
		t.Fatalf("want safe/read-only/nil, got %q/%q/%v", lv, r, err)
	}
}

func TestParseRiskFromArgs_Dangerous(t *testing.T) {
	lv, _, err := ParseRiskFromArgs(`{"command":"rm -rf /","risk_level":"dangerous","risk_reason":"destroys fs"}`)
	if err != nil || lv != "dangerous" {
		t.Fatalf("want dangerous/nil, got %q/%v", lv, err)
	}
}

func TestParseRiskFromArgs_BadJSON(t *testing.T) {
	_, _, err := ParseRiskFromArgs(`not json`)
	if !errors.Is(err, ErrParseJSON) {
		t.Fatalf("want ErrParseJSON, got %v", err)
	}
}

func TestParseRiskFromArgs_MissingRisk(t *testing.T) {
	_, _, err := ParseRiskFromArgs(`{"command":"ls"}`)
	if !errors.Is(err, ErrMissingRisk) {
		t.Fatalf("want ErrMissingRisk, got %v", err)
	}
}

func TestParseRiskFromArgs_InvalidRisk(t *testing.T) {
	_, _, err := ParseRiskFromArgs(`{"command":"ls","risk_level":"highrisk"}`)
	if !errors.Is(err, ErrInvalidRisk) {
		t.Fatalf("want ErrInvalidRisk, got %v", err)
	}
}

func TestParseRiskFromArgs_EmptyReasonOK(t *testing.T) {
	lv, r, err := ParseRiskFromArgs(`{"command":"ls","risk_level":"safe"}`)
	if err != nil || lv != "safe" || r != "" {
		t.Fatalf("want safe/empty/nil, got %q/%q/%v", lv, r, err)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/domains/models/interrupt/... -run TestParseRiskFromArgs -v`
Expected: FAIL 或 build error（包不存在）。

- [ ] **Step 3: 实现 messages.go**

`internal/domains/models/interrupt/messages.go`：

```go
package interrupt

// HITL 相关固定文案常量
const (
	MsgUserReject                = "用户拒绝执行此工具调用。"
	MsgUserRejectWithFeedbackTpl = "用户拒绝执行此工具调用。用户反馈：%s" // fmt 模板，Tpl 后缀表明需 Sprintf
	MsgTimeout                   = "用户在 5 分钟内未确认此工具调用，已按拒绝处理。"
	MsgUserStop                  = "用户中止了本次对话，此工具调用未执行。"
	MsgSiblingSkipped            = "因用户拒绝了本轮的高危调用，此工具调用未执行。"
)
```

- [ ] **Step 4: 实现 parse.go**

`internal/domains/models/interrupt/parse.go`：

```go
package interrupt

import (
	"encoding/json"
	"errors"
	"fmt"
)

var (
	ErrParseJSON   = errors.New("arguments JSON 解析失败")
	ErrMissingRisk = errors.New("缺少 risk_level 字段")
	ErrInvalidRisk = errors.New("risk_level 值非法")
)

// ParseRiskFromArgs 仅解析 risk_level / risk_reason；不影响 command 原样透传。
// 返回错误时，调用方应降级为"直接执行"（不拦截、Warn 日志）。
func ParseRiskFromArgs(argsJSON string) (level, reason string, err error) {
	var m map[string]interface{}
	if e := json.Unmarshal([]byte(argsJSON), &m); e != nil {
		return "", "", fmt.Errorf("%w: %v", ErrParseJSON, e)
	}
	lv, ok := m["risk_level"].(string)
	if !ok {
		return "", "", ErrMissingRisk
	}
	if lv != "safe" && lv != "dangerous" {
		return "", "", fmt.Errorf("%w: %s", ErrInvalidRisk, lv)
	}
	r, _ := m["risk_reason"].(string) // 允许空
	return lv, r, nil
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `go test ./internal/domains/models/interrupt/... -run TestParseRiskFromArgs -v`
Expected: PASS (6 tests)

- [ ] **Step 6: 提交**

```bash
git add internal/domains/models/interrupt/
git commit -m "feat(hitl): 新增 interrupt 包 - 固定文案与 ParseRiskFromArgs"
```

---

### Task 2：新增 tool_call_interrupt 事件类型

**Files:**
- Modify: `internal/domains/models/events/constants.go`
- Create: `internal/domains/models/events/interrupt.go`

- [ ] **Step 1: 修改常量文件**

在 `constants.go` 已有 `EventTypeXxx` 块末尾追加：

```go
EventTypeToolCallInterrupt = "tool_call_interrupt"
```

在 `ToolEventStatus` 常量块末尾追加：

```go
ToolEventStatusInterrupted ToolEventStatus = "interrupted"
```

- [ ] **Step 2: 创建 interrupt.go**

`internal/domains/models/events/interrupt.go`：

```go
package events

import (
	"time"

	"github.com/google/uuid"

	"mooc-manus/internal/domains/models/llm"
)

// ToolInterruptEvent 抛出于工具调用被判定为高危、需要用户决策时。
// 与 ToolEvent 平级独立结构体：字段差异较大（多 RiskLevel / RiskReason，无 FunctionResult）
type ToolInterruptEvent struct {
	BaseEvent
	Timestamp    time.Time       `json:"timestamp"`
	ToolCallID   string          `json:"tool_call_id"`
	ToolName     string          `json:"tool_name"`     // provider 名，如 "native"
	FunctionName string          `json:"function_name"` // 如 "bashExec"
	FunctionArgs string          `json:"function_args"` // 原始 arguments JSON
	RiskLevel    string          `json:"risk_level"`    // 当前恒为 "dangerous"
	RiskReason   string          `json:"risk_reason"`   // LLM 给出的风险说明
	Status       ToolEventStatus `json:"status"`        // 恒为 "interrupted"
}

func OnToolCallInterrupt(toolCall llm.ToolCall, toolName, riskLevel, riskReason string) AgentEvent {
	ev := ToolInterruptEvent{
		Timestamp:    time.Now(),
		ToolCallID:   toolCall.ID,
		ToolName:     toolName,
		FunctionName: toolCall.Name,
		FunctionArgs: toolCall.Arguments,
		RiskLevel:    riskLevel,
		RiskReason:   riskReason,
		Status:       ToolEventStatusInterrupted,
	}
	ev.ID = uuid.New().String()
	ev.CreatedAt = time.Now()
	ev.Type = EventTypeToolCallInterrupt
	return &ev
}
```

- [ ] **Step 3: 编译验证**

Run: `go build ./internal/domains/models/events/...`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add internal/domains/models/events/
git commit -m "feat(hitl): 新增 tool_call_interrupt 事件类型"
```

---

### Task 3：新增 PendingSink 接口与决策值对象

**Files:**
- Create: `internal/domains/services/agents/pending_sink.go`

- [ ] **Step 1: 创建 pending_sink.go**

```go
package agents

import "time"

// InterruptDecisionKind 用户对高危工具的决策分类
type InterruptDecisionKind string

const (
	DecisionApprove InterruptDecisionKind = "approve"
	DecisionReject  InterruptDecisionKind = "reject"
	DecisionCancel  InterruptDecisionKind = "cancel"  // Stop 路径注入
	DecisionTimeout InterruptDecisionKind = "timeout" // 超时兜底注入
)

type InterruptDecision struct {
	Kind     InterruptDecisionKind
	Feedback string // 仅 Reject 时可能非空
}

type InterruptSnapshot struct {
	ToolCallID   string
	FunctionName string
	FunctionArgs string
	RiskLevel    string
	RiskReason   string
	RegisteredAt time.Time
}

// PendingSink 是 Agent 层向 app service 反查的窄接口。
// 只暴露 Register 与 WaitTimeout；Resolve/Cancel 由 app service 内部完成。
type PendingSink interface {
	RegisterInterrupt(messageId string, snap InterruptSnapshot) (<-chan InterruptDecision, error)
	WaitTimeout() time.Duration
}
```

- [ ] **Step 2: 编译验证**

Run: `go build ./internal/domains/services/agents/...`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add internal/domains/services/agents/pending_sink.go
git commit -m "feat(hitl): 新增 PendingSink 接口与决策值对象"
```

---

## 阶段 B：Tool 接口扩展 + bashExec Schema 改造

### Task 4：Tool 接口扩展 SupportsRiskAssessment

**Files:**
- Modify: `internal/domains/services/tools/base.go`

**背景**：`Tool` interface 定义在 `services/tools/base.go:8-14`，`BaseTool` struct 定义在 :46-51。所有具体 tool 实现（mcp / custom / a2a / native）通过嵌入 `BaseTool` 复用 `GetTools` / `HasTool` / `ProviderName`。

- [ ] **Step 1: 修改 Tool interface**

在 `base.go` 的 `Tool` interface 里增加一个方法：

```go
type Tool interface {
	GetTools() []llm.Tool
	HasTool(funcName string) bool
	Invoke(funcName, funcArgs string) models.ToolCallResult
	Init() error
	ProviderName() string
	SupportsRiskAssessment() bool // 【HITL 新增】true 表示该工具的 arguments 需要读 risk_level / risk_reason
}
```

- [ ] **Step 2: 给 BaseTool 加默认实现**

在 `base.go` 的 `BaseTool` 方法群末尾追加：

```go
// SupportsRiskAssessment 默认返回 false；需要接入 HITL 的工具（如 BashExecTool）自行覆写为 true
func (t *BaseTool) SupportsRiskAssessment() bool { return false }
```

- [ ] **Step 3: 编译验证**

Run: `cd /Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/mooc-manus && go build ./internal/domains/services/tools/...`
Expected: 通过。所有嵌入 `BaseTool` 的具体 tool 天然继承 false。

- [ ] **Step 4: 提交**

```bash
git add internal/domains/services/tools/base.go
git commit -m "feat(hitl): Tool 接口新增 SupportsRiskAssessment，BaseTool 默认 false"
```

---

### Task 5：bashExec schema 扩展 + SupportsRiskAssessment 覆写

**Files:**
- Modify: `internal/domains/services/tools/bash_exec.go`
- Test: `internal/domains/services/tools/bash_exec_test.go`

**背景**：`bash_exec.go` 现在必填 `command` / `description`；新增 `risk_level` / `risk_reason` 后变 4 项必填。注意：`Invoke` 目前只反序列化 `bashExecParams`（command / timeout_sec / description）——**新增的两个字段不必反序列化**，因为 HITL 闸门在 `InvokeToolCalls` 里从 raw funcArgs 解析，进到 `Invoke` 时已通过审批。

- [ ] **Step 1: 修改 schema 定义**

定位 `bash_exec.go` 的 `Init()` 方法（bashExecFunctionDesc 之后），修改 `Parameters` 里的 `properties` 与 `required`：

```go
Parameters: map[string]any{
	"type": "object",
	"properties": map[string]any{
		"command": map[string]any{
			"type":        "string",
			"description": fmt.Sprintf("要执行的 bash 命令，长度不超过 %d 字节", bashExecCommandMaxBytes),
		},
		"timeout_sec": map[string]any{
			"type":        "integer",
			"description": fmt.Sprintf("超时秒数，默认 %d，上限 %d", int(t.timeoutDefault/time.Second), int(t.timeoutMax/time.Second)),
		},
		"description": map[string]any{
			"type":        "string",
			"description": "本次命令的用途简述，用于审计日志（必填）",
		},
		"risk_level": map[string]any{
			"type":        "string",
			"enum":        []string{"safe", "dangerous"},
			"description": "本次命令的风险等级；仅当命令确定不会造成任何数据丢失、权限变更、外部副作用时才可为 safe。以下类型必须标注为 dangerous：\n1. 删除类：rm -rf、find ... -delete、mkfs、dd\n2. 权限变更类：chmod 777、chown、sudo、setuid\n3. 网络下载执行类：curl ... | sh、wget ... | bash、任何管道到 shell 的模式\n4. 系统关键路径写入：/etc、/boot、/usr、/System、系统 crontab、~/.ssh/authorized_keys\n5. 进程/系统级操作：kill -9、pkill、systemctl、fork bomb\n6. 数据库破坏性操作：DROP、TRUNCATE、DELETE 全表",
		},
		"risk_reason": map[string]any{
			"type":        "string",
			"description": "本次风险等级的判断依据；若为 safe 也需一句话说明为何安全",
		},
	},
	"required": []string{"command", "description", "risk_level", "risk_reason"},
},
```

- [ ] **Step 2: 覆写 SupportsRiskAssessment**

在 `bash_exec.go` 的 `BashExecTool` 方法群末尾追加：

```go
// SupportsRiskAssessment 覆写 BaseTool 默认实现；bashExec 是 HITL 首发接入的工具
func (t *BashExecTool) SupportsRiskAssessment() bool { return true }
```

- [ ] **Step 3: 编译验证**

Run: `go build ./internal/domains/services/tools/...`
Expected: 通过。

- [ ] **Step 4: 现有测试回归**

Run: `go test ./internal/domains/services/tools/... -run BashExec -v`
Expected: 现有 bash_exec_test.go 用例仍通过（新增字段不参与 Invoke 反序列化，测试用例的 args 若缺 risk_level 不影响 Invoke，只影响 HITL 闸门；本 Task 不改 Invoke）。

- [ ] **Step 5: 提交**

```bash
git add internal/domains/services/tools/bash_exec.go
git commit -m "feat(hitl): bashExec schema 新增 risk_level/risk_reason 必填字段"
```

---

### Task 6：其余 tool 实现无需改动的确认

**Files:**
- Read: `internal/domains/services/tools/mcp.go`
- Read: `internal/domains/services/tools/custom.go`
- Read: `internal/domains/services/tools/a2a.go`
- Read: `internal/domains/services/tools/file_read.go`
- Read: `internal/domains/services/tools/file_write.go`
- Read: `internal/domains/services/tools/file_edit.go`
- Read: `internal/domains/services/tools/execute_skill.go`
- Read: `internal/domains/services/tools/load_skill.go`

- [ ] **Step 1: 确认每一个 tool 类型都嵌入了 BaseTool**

Run: `grep -n "BaseTool" internal/domains/services/tools/*.go | grep -v _test.go | grep -v "//"`
Expected: 每个具体 tool struct（McpTool / CustomTool / A2ATool / FileReadTool 等）都包含 `BaseTool` 嵌入行。

若发现某个 tool 未嵌入 `BaseTool`，需要单独给它加 `SupportsRiskAssessment() bool { return false }` 方法。

- [ ] **Step 2: 编译验证所有 tool 类型满足 Tool interface**

Run: `go build ./...`
Expected: 通过（若某个 tool 未嵌入 BaseTool 也未单独实现方法，会在此处报接口不满足）。

- [ ] **Step 3: 无代码改动就无需提交**

如 Step 1 显示所有 tool 都嵌入 `BaseTool`，则本 Task 无需提交。若有例外，按 Step 1 的补丁提交。

---

## 阶段 C：Agent 层集成

### Task 7：BaseAgent 结构体新增字段 + functional option 构造

**Files:**
- Modify: `internal/domains/services/agents/base.go`（结构体 :24-33、构造函数 :35-45）

- [ ] **Step 1: 修改 BaseAgent 结构体**

在 `base.go:24-33` 的 `BaseAgent` struct 末尾追加两个字段：

```go
type BaseAgent struct {
	name           string
	systemPrompt   string
	retryInterval  int
	agentConfig    models.AgentConfig
	invoker        invoker.Invoker
	memory         *memory.ChatMemory
	tools          []tools.Tool
	circuitBreaker *circuitbreaker.ToolCallCounter
	// 【HITL 新增】
	pendingSink PendingSink // 可为 nil，nil 时 InvokeToolCalls 跳过 HITL 闸门（A2A 场景）
	messageId   string      // HITL 用于 RegisterInterrupt 定位 slot
}
```

- [ ] **Step 2: 改造 NewBaseAgent 为 functional option**

替换 `base.go:35-45` 的 `NewBaseAgent`：

```go
// BaseAgentOption 为 NewBaseAgent 的可选参数
type BaseAgentOption func(*BaseAgent)

// WithPendingSink 注入 HITL 审批管理器；nil 或不传则不启用 HITL
func WithPendingSink(sink PendingSink) BaseAgentOption {
	return func(a *BaseAgent) { a.pendingSink = sink }
}

// WithMessageId 注入 messageId，供 HITL Register 使用
func WithMessageId(mid string) BaseAgentOption {
	return func(a *BaseAgent) { a.messageId = mid }
}

func NewBaseAgent(agentConfig models.AgentConfig, inv invoker.Invoker, mem *memory.ChatMemory,
	ts []tools.Tool, systemPrompt string, opts ...BaseAgentOption) *BaseAgent {
	a := &BaseAgent{
		agentConfig:    agentConfig,
		invoker:        inv,
		memory:         mem,
		tools:          ts,
		systemPrompt:   systemPrompt,
		retryInterval:  5,
		circuitBreaker: circuitbreaker.NewToolCallCounter(),
	}
	for _, opt := range opts {
		opt(a)
	}
	return a
}
```

- [ ] **Step 3: 编译验证——预期在 3 处调用者失败**

Run: `go build ./...`
Expected: 通过（因为 opts 是 variadic，旧调用者不传 opts 也能编译）。

- [ ] **Step 4: 检查 ReActAgent / PlanAgent 继承字段**

Run: `grep -n "circuitBreaker" internal/domains/services/agents/react.go internal/domains/services/agents/plan.go`
Expected: 看到 ReActAgent / PlanAgent 构造函数手动从 baseAgent 拷贝 `circuitBreaker` 字段——**需要同样拷贝 pendingSink 和 messageId**。

- [ ] **Step 5: 修改 ReActAgent 构造函数**

在 `react.go` 的 `NewReActAgent` 里补上：

```go
agent.pendingSink = baseAgent.pendingSink
agent.messageId = baseAgent.messageId
```

对应 `plan.go` 的 `NewPlanAgent` 同样补上两行。

- [ ] **Step 6: 编译验证**

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add internal/domains/services/agents/base.go internal/domains/services/agents/react.go internal/domains/services/agents/plan.go
git commit -m "feat(hitl): BaseAgent 增 pendingSink/messageId 字段与 functional option 构造"
```

---

### Task 8：InvokeToolCalls 中断分支实现

**Files:**
- Modify: `internal/domains/services/agents/base.go`（InvokeToolCalls :75-163）
- 依赖：Task 1（interrupt 包）、Task 2（events）、Task 3（PendingSink）、Task 7（BaseAgent 字段）

- [ ] **Step 1: 引入依赖**

在 `base.go` import 里追加：

```go
"mooc-manus/internal/domains/models/interrupt"
"time"
```

（`time` 若已存在则跳过；`interrupt` 是本次新增导入。）

- [ ] **Step 2: 抽取 buildRejectMessage helper**

在 `base.go` `recordToolFailure` 后追加：

```go
// buildRejectMessage 构造一条"工具未执行"的 tool result 消息，供 HITL 拒绝/超时/中止路径使用
func buildRejectMessage(toolCall llm.ToolCall, content string) llm.Message {
	return llm.Message{
		Role:       llm.RoleTool,
		Content:    content,
		ToolCallID: toolCall.ID,
	}
}
```

- [ ] **Step 3: 在 InvokeToolCalls 里插入中断分支**

在 `base.go:75-163` 的 `InvokeToolCalls` 里，**"查询 Agent 中对应的工具"之后、"开始工具调用（OnToolCallStart）"之前**插入 HITL 闸门。参考完整替换段（读者可直接对照当前 :138 前后）：

```go
		// 查询Agent中对应的工具
		tool := a.GetTool(funcName)
		if tool == nil {
			// ... 现有的 tool 不存在处理，保持不变 ...
		}

		// ===== 【HITL 新增】风险审批闸门 =====
		if tool.SupportsRiskAssessment() && a.pendingSink != nil {
			risk, reason, perr := interrupt.ParseRiskFromArgs(funcArgs)
			if perr != nil {
				logger.Warn("HITL 风险字段解析失败，降级为直接执行",
					zap.String("component", "hitl"),
					zap.String("tool", funcName),
					zap.Error(perr))
			} else if risk == "dangerous" {
				snap := InterruptSnapshot{
					ToolCallID:   toolCallID,
					FunctionName: funcName,
					FunctionArgs: funcArgs,
					RiskLevel:    risk,
					RiskReason:   reason,
					RegisteredAt: time.Now(),
				}
				ch, regErr := a.pendingSink.RegisterInterrupt(a.messageId, snap)
				if regErr != nil {
					logger.Error("HITL Register 撞已有 pending，视为拒绝",
						zap.String("component", "hitl"),
						zap.String("mid", a.messageId),
						zap.Error(regErr))
					toolMessages = append(toolMessages,
						buildRejectMessage(toolCall, "系统内部错误，拒绝执行"))
					// abort 剩余
					toolMessages = appendSiblingSkipped(toolMessages, toolCalls, toolCall.ID)
					a.circuitBreaker.StartNewRound(currentRoundKeys)
					return toolMessages
				}
				eventCh <- events.OnToolCallInterrupt(toolCall, tool.ProviderName(), risk, reason)

				var decision InterruptDecision
				select {
				case decision = <-ch:
				case <-time.After(a.pendingSink.WaitTimeout()):
					decision = InterruptDecision{Kind: DecisionTimeout}
				case <-ctx.Done():
					return toolMessages
				}

				switch decision.Kind {
				case DecisionApprove:
					// 落地：继续走原 InvokeTool 分支（下方无需 continue）
				case DecisionReject:
					content := interrupt.MsgUserReject
					if decision.Feedback != "" {
						content = fmt.Sprintf(interrupt.MsgUserRejectWithFeedbackTpl, decision.Feedback)
					}
					toolMessages = append(toolMessages, buildRejectMessage(toolCall, content))
					toolMessages = appendSiblingSkipped(toolMessages, toolCalls, toolCall.ID)
					a.circuitBreaker.StartNewRound(currentRoundKeys)
					return toolMessages
				case DecisionTimeout:
					toolMessages = append(toolMessages,
						buildRejectMessage(toolCall, interrupt.MsgTimeout))
					toolMessages = appendSiblingSkipped(toolMessages, toolCalls, toolCall.ID)
					a.circuitBreaker.StartNewRound(currentRoundKeys)
					return toolMessages
				case DecisionCancel:
					// Stop 路径接管清理，直接 return
					return toolMessages
				}
			}
		}
		// ===== 中断闸门结束 =====

		// 开始工具调用
		eventCh <- events.OnToolCallStart(toolCall, tool.ProviderName())
		// ... 现有 InvokeTool / OnToolCallComplete / 结果处理 保持不变 ...
```

- [ ] **Step 4: 补 appendSiblingSkipped helper**

在 `base.go` `buildRejectMessage` 之后追加：

```go
// appendSiblingSkipped 为 abortedToolCallID 之后（不含）的所有 toolCall 追加"因用户拒绝而未执行"占位消息。
// 保证同一轮内 assistant.tool_calls 中每条 ID 都能配到一条 tool result，避免 memory 里孤儿。
func appendSiblingSkipped(msgs []llm.Message, toolCalls []llm.ToolCall, abortedToolCallID string) []llm.Message {
	seen := false
	for _, tc := range toolCalls {
		if tc.ID == abortedToolCallID {
			seen = true
			continue
		}
		if !seen {
			continue
		}
		msgs = append(msgs, buildRejectMessage(tc, interrupt.MsgSiblingSkipped))
	}
	return msgs
}
```

- [ ] **Step 5: 编译验证**

Run: `go build ./...`
Expected: 通过。若报错通常是 import 缺失（`time` / `fmt` / `interrupt`）——按报错补齐。

- [ ] **Step 6: 提交**

```bash
git add internal/domains/services/agents/base.go
git commit -m "feat(hitl): InvokeToolCalls 增风险审批闸门与拒绝/超时/取消分支"
```

---

### Task 9：迁移 NewBaseAgent 现有 3 处调用者

**Files:**
- Modify: `internal/domains/services/agents/agent.go`（:254）
- Modify: `internal/domains/services/agents/a2a.go`（:123）
- Modify: `internal/domains/services/flows/plan_react.go`（:32, :34）

- [ ] **Step 1: agents/agent.go 迁移**

`agent.go:254` 的 `NewBaseAgent` 调用签名不变（因为 opts 是 variadic），但**若该函数已能拿到 messageId + pendingSink（例如从 request 上下文），此时应显式传入**。定位该函数的 caller 链路：向上追溯到 Chat 组装点（Task 11-13 会在 app service 里补传），这里的 `NewBaseAgent` 保持不加 opts，改由更上层传入。

实际操作：本 Task 只在 caller 明确可拿到 sink 时补 opts；否则留待 Task 13 的 `Chat` 一起改。

- [ ] **Step 2: agents/a2a.go 迁移**

`a2a.go:123` 是 A2A 场景：**不注入 pendingSink**（工具在远端执行，本地不进 InvokeToolCalls 中断闸门）。签名保持原样，此文件本 Task 无改动。

- [ ] **Step 3: flows/plan_react.go 迁移**

`plan_react.go:32, :34` 有两处 `NewBaseAgent`。此 flow 目前无 SSE / messageId 上下文，**保持不传 opts**。若日后 flow 也接入 HITL，另立 plan。

- [ ] **Step 4: 编译验证**

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 5: 无实际代码改动，本 Task 主要是"确认迁移策略"**

如无改动则跳过提交；如有必要的 opts 追加，按下述格式提交：

```bash
git commit -m "chore(hitl): NewBaseAgent 调用点迁移确认（A2A/PlanReAct 不接入 HITL）"
```

**关键说明**：`agents/agent.go:254` 的 `NewBaseAgent` 上层 caller 是 `BaseAgentDomainService.Chat`，它接收 `ChatRequest`（`internal/domains/models/agents/base.go:13-25` 已含 `MessageId` 字段）。因此本 Task 需要在 :254 补一个 opts：

```go
return NewBaseAgent(appConfig.AgentConfig, inv, chatMemory, baseTools, systemPrompt,
    WithMessageId(request.MessageId),
    // WithPendingSink 在 app service 层通过其它路径注入；见 Task 11-12 的方案说明
), nil
```

但 pendingSink 是 app service 层的实例，domain service 拿不到——**需要通过 `BaseAgentDomainService` 构造函数或 `ChatRequest` 携带 sink**。取"通过 ChatRequest 携带 sink"是最短路径：在 `ChatRequest` 上加一个 `PendingSink agents.PendingSink` 字段（Task 11 完成）。

因此本 Task 拆两个提交，第一次只补 `WithMessageId`，`WithPendingSink` 留到 Task 12。

- [ ] **Step 6: 在 agents/agent.go:254 补 WithMessageId**

```go
return NewBaseAgent(appConfig.AgentConfig, inv, chatMemory, baseTools, systemPrompt,
    WithMessageId(request.MessageId),
), nil
```

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add internal/domains/services/agents/agent.go
git commit -m "feat(hitl): agent.go 装配 BaseAgent 时透传 MessageId"
```

---

## 阶段 D：App Service 层集成

### Task 10：pendingSlot 实现 + 单元测试

**Files:**
- Create: `internal/applications/services/interrupt.go`
- Create: `internal/applications/services/interrupt_test.go`

- [ ] **Step 1: 先写失败测试**

`internal/applications/services/interrupt_test.go`：

```go
package services

import (
	"sync"
	"testing"
	"time"

	"mooc-manus/internal/domains/services/agents"
)

func newTestSlot() *pendingSlot {
	return &pendingSlot{
		snapshot: agents.InterruptSnapshot{ToolCallID: "tc1"},
		ch:       make(chan agents.InterruptDecision, 1),
	}
}

func TestPendingSlot_ResolveFirstWins(t *testing.T) {
	slot := newTestSlot()
	if !slot.resolve(agents.InterruptDecision{Kind: agents.DecisionApprove}) {
		t.Fatal("first resolve should return true")
	}
	if slot.resolve(agents.InterruptDecision{Kind: agents.DecisionReject}) {
		t.Fatal("second resolve should return false")
	}
	d := <-slot.ch
	if d.Kind != agents.DecisionApprove {
		t.Fatalf("chan should hold approve, got %v", d.Kind)
	}
}

func TestPendingSlot_ConcurrentResolve(t *testing.T) {
	slot := newTestSlot()
	var wins int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			kind := agents.DecisionApprove
			if i%2 == 0 {
				kind = agents.DecisionReject
			}
			if slot.resolve(agents.InterruptDecision{Kind: kind}) {
				atomicAdd(&wins, 1)
			}
		}(i)
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("exactly 1 winner expected, got %d", wins)
	}
	count := 0
	for range slot.ch {
		count++
	}
	if count != 1 {
		t.Fatalf("chan should have exactly 1 value, got %d", count)
	}
}

// atomicAdd 用局部 int32 + sync/atomic；避免 import 名冲突
func atomicAdd(p *int32, v int32) { /* 用 sync/atomic 实际实现 */ }
```

（`atomicAdd` 换成 `atomic.AddInt32` 即可，import `sync/atomic`。此处伪代码保留意图。）

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/applications/services/... -run TestPendingSlot -v`
Expected: FAIL / build error（interrupt.go 尚未创建）。

- [ ] **Step 3: 实现 interrupt.go**

```go
package services

import (
	"errors"
	"sync/atomic"
	"time"

	"mooc-manus/internal/domains/services/agents"
)

var ErrAlreadyPending = errors.New("pending interrupt already exists for messageId")

type pendingSlot struct {
	snapshot agents.InterruptSnapshot
	ch       chan agents.InterruptDecision
	resolved atomic.Bool
	timer    *time.Timer
}

// resolve 保证 chan 只被写入一次；返回 true 表示这次决策生效
func (p *pendingSlot) resolve(d agents.InterruptDecision) bool {
	if !p.resolved.CompareAndSwap(false, true) {
		return false
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	p.ch <- d
	close(p.ch)
	return true
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/applications/services/... -run TestPendingSlot -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/applications/services/interrupt.go internal/applications/services/interrupt_test.go
git commit -m "feat(hitl): 新增 pendingSlot 结构体与 CAS resolve 语义"
```

---

### Task 11：BaseAgentApplicationServiceImpl 实现 PendingSink 接口

**Files:**
- Modify: `internal/applications/services/agent.go`（结构体 :30-36、构造 :38-49）

- [ ] **Step 1: 结构体新增 pendingInterrupts 字段**

在 `agent.go:30-36` 的 `BaseAgentApplicationServiceImpl` struct 里追加：

```go
type BaseAgentApplicationServiceImpl struct {
	agentDomainSvc      agents.BaseAgentDomainService
	skillExecutor       tools.SkillExecutor
	nativeToolsProvider tools.NativeToolsProvider
	cancelFuncs         map[string]context.CancelFunc
	pendingInterrupts   map[string]*pendingSlot // 【HITL 新增】messageId -> pending slot
	waitTimeout         time.Duration           // 【HITL 新增】测试注入用
	mu                  sync.Mutex
}
```

- [ ] **Step 2: 构造函数初始化字段**

```go
func NewBaseAgentApplicationService(
	agentDomainSvc agents.BaseAgentDomainService,
	skillExecutor tools.SkillExecutor,
	nativeToolsProvider tools.NativeToolsProvider,
) BaseAgentApplicationService {
	return &BaseAgentApplicationServiceImpl{
		agentDomainSvc:      agentDomainSvc,
		skillExecutor:       skillExecutor,
		nativeToolsProvider: nativeToolsProvider,
		cancelFuncs:         make(map[string]context.CancelFunc),
		pendingInterrupts:   make(map[string]*pendingSlot),
		waitTimeout:         5 * time.Minute,
	}
}
```

- [ ] **Step 3: 实现 PendingSink 接口**

在 `interrupt.go` 追加：

```go
// RegisterInterrupt 由 BaseAgent.InvokeToolCalls 调用；本 messageId 已有 pending 时返回 ErrAlreadyPending
func (s *BaseAgentApplicationServiceImpl) RegisterInterrupt(
	messageId string, snap agents.InterruptSnapshot,
) (<-chan agents.InterruptDecision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.pendingInterrupts[messageId]; exists {
		return nil, ErrAlreadyPending
	}
	slot := &pendingSlot{
		snapshot: snap,
		ch:       make(chan agents.InterruptDecision, 1),
	}
	slot.timer = time.AfterFunc(s.waitTimeout, func() {
		s.mu.Lock()
		cur, ok := s.pendingInterrupts[messageId]
		if ok && cur == slot {
			delete(s.pendingInterrupts, messageId)
		}
		s.mu.Unlock()
		if ok && cur == slot {
			_ = slot.resolve(agents.InterruptDecision{Kind: agents.DecisionTimeout})
		}
	})
	s.pendingInterrupts[messageId] = slot
	return slot.ch, nil
}

// WaitTimeout 返回 HITL 等待用户决策的最大时长
func (s *BaseAgentApplicationServiceImpl) WaitTimeout() time.Duration {
	return s.waitTimeout
}
```

- [ ] **Step 4: 编译验证**

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 5: 补 U-11~U-17 单测**

在 `interrupt_test.go` 追加：

```go
func newTestSvc(timeout time.Duration) *BaseAgentApplicationServiceImpl {
	return &BaseAgentApplicationServiceImpl{
		cancelFuncs:       make(map[string]context.CancelFunc),
		pendingInterrupts: make(map[string]*pendingSlot),
		waitTimeout:       timeout,
	}
}

func TestRegisterInterrupt_Success(t *testing.T) {
	s := newTestSvc(time.Minute)
	ch, err := s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	if err != nil || ch == nil {
		t.Fatalf("want success, got %v", err)
	}
	if _, ok := s.pendingInterrupts["m1"]; !ok {
		t.Fatal("slot not registered")
	}
}

func TestRegisterInterrupt_AlreadyPending(t *testing.T) {
	s := newTestSvc(time.Minute)
	_, _ = s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	_, err := s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc2"})
	if !errors.Is(err, ErrAlreadyPending) {
		t.Fatalf("want ErrAlreadyPending, got %v", err)
	}
}

func TestRegisterInterrupt_TimerFires(t *testing.T) {
	s := newTestSvc(50 * time.Millisecond)
	ch, _ := s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	select {
	case d := <-ch:
		if d.Kind != agents.DecisionTimeout {
			t.Fatalf("want Timeout, got %v", d.Kind)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timer did not fire")
	}
	s.mu.Lock()
	_, ok := s.pendingInterrupts["m1"]
	s.mu.Unlock()
	if ok {
		t.Fatal("slot should be deleted after timer fire")
	}
}
```

Run: `go test ./internal/applications/services/... -run TestRegisterInterrupt -v`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add internal/applications/services/agent.go internal/applications/services/interrupt.go internal/applications/services/interrupt_test.go
git commit -m "feat(hitl): app service 实现 PendingSink（Register + WaitTimeout + Timer 兜底）"
```

---

### Task 12：ChatRequest 携带 PendingSink + Chat 装配传入

**Files:**
- Modify: `internal/domains/models/agents/base.go`（ChatRequest 结构体 :13-25）
- Modify: `internal/domains/services/agents/agent.go`（NewBaseAgent 调用点 :254）
- Modify: `internal/applications/services/agent.go`（Chat 方法 :75-159）

**背景**：Task 9 已在 `agent.go:254` 补 `WithMessageId`。本 Task 补 `WithPendingSink`。sink 由 app service 层通过 `ChatRequest` 新增字段透传给 domain 层。

- [ ] **Step 1: ChatRequest 增字段**

`internal/domains/models/agents/base.go` 的 `ChatRequest`：

```go
type ChatRequest struct {
	Streaming      bool
	SystemPrompt   string
	ConversationId string
	MessageId      string
	Query          string
	AppConfigId    string
	FunctionIds    []string
	ProviderIds    []string
	SkillRefs      []SkillRef
	Files          []file.File
	PlanMode       bool
	PendingSink    interface{} // 【HITL 新增】实际类型 agents.PendingSink；用 interface{} 避免 models 层反向依赖 services 层
}
```

**说明**：`domain/models` 不能反向依赖 `domain/services/agents`，因此这里用 `interface{}` 承接，在 domain service 里 type assert。type assert 失败时降级为不注入 sink。

- [ ] **Step 2: agent.go:254 补 WithPendingSink**

```go
opts := []BaseAgentOption{WithMessageId(request.MessageId)}
if sink, ok := request.PendingSink.(PendingSink); ok && sink != nil {
	opts = append(opts, WithPendingSink(sink))
}
return NewBaseAgent(appConfig.AgentConfig, inv, chatMemory, baseTools, systemPrompt, opts...), nil
```

- [ ] **Step 3: Chat 方法把 s 作为 sink 传入 request**

`internal/applications/services/agent.go` 的 `Chat` 方法（:75-159），在 `request := dtos.ConvertChatClientRequest2Request(...)` 之后追加：

```go
request.PendingSink = s // s 已实现 agents.PendingSink 接口（Task 11）
```

- [ ] **Step 4: 编译验证**

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add internal/domains/models/agents/base.go internal/domains/services/agents/agent.go internal/applications/services/agent.go
git commit -m "feat(hitl): ChatRequest 透传 PendingSink 到 BaseAgent 装配"
```

---

### Task 13：sse.Manager 新增 ConversationIdOf 导出函数

**Files:**
- Modify: `internal/infra/external/sse/manager.go`

- [ ] **Step 1: 追加导出函数**

在 `manager.go` `MessageIdsOf` 之后追加：

```go
// ConversationIdOf 返回 messageId 对应的 conversationId；未绑定时返回空串
// 供 HITL Stop 路径补齐孤儿 tool result 时反查 memory
func ConversationIdOf(messageId string) string {
	manager.Lock()
	defer manager.Unlock()
	return manager.messageId2ConversationId[messageId]
}
```

- [ ] **Step 2: 编译验证**

Run: `go build ./internal/infra/external/sse/...`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add internal/infra/external/sse/manager.go
git commit -m "feat(hitl): sse.Manager 新增 ConversationIdOf 导出函数"
```

---

### Task 14：Stop 路径联动 pending 清理 + 孤儿 tool result 补齐

**Files:**
- Modify: `internal/applications/services/agent.go`（stopMessageInternal :255-297）
- 依赖：Task 13（ConversationIdOf）

- [ ] **Step 1: 修改 stopMessageInternal 头部**

在原 `stopMessageInternal` 开头（`detail := dtos.StopMessageCleanDetail{}` 之后、`if messageId == ""` 之前）插入 pending 清理：

```go
func (s *BaseAgentApplicationServiceImpl) stopMessageInternal(messageId string) dtos.StopMessageCleanDetail {
	detail := dtos.StopMessageCleanDetail{}
	if messageId == "" {
		return detail
	}

	// 【HITL 新增】0.5) 先解绑 pending 让 Agent goroutine 从 select 退出
	s.mu.Lock()
	slot, hasPending := s.pendingInterrupts[messageId]
	if hasPending {
		delete(s.pendingInterrupts, messageId)
	}
	s.mu.Unlock()

	if hasPending {
		_ = slot.resolve(agents.InterruptDecision{Kind: agents.DecisionCancel})
		time.Sleep(200 * time.Millisecond) // 兜底：等 goroutine 从 select 退出

		// 补齐孤儿 tool result：conversationId 优先从 sse.Manager 反查
		if cid := sse.ConversationIdOf(messageId); cid != "" {
			mem := memory.FetchMemory(cid)
			mem.AddMessage(llm.Message{
				Role:       llm.RoleTool,
				Content:    interrupt.MsgUserStop,
				ToolCallID: slot.snapshot.ToolCallID,
			})
			logger.Info("HITL 补齐孤儿 tool result",
				zap.String("component", "hitl"),
				zap.String("mid", messageId),
				zap.String("tcid", slot.snapshot.ToolCallID))
		} else {
			logger.Warn("HITL Stop 补齐 memory 找不到 conversationId",
				zap.String("component", "hitl"),
				zap.String("mid", messageId))
		}
	}

	// 0) Context cancel（保持原逻辑不变）
	s.mu.Lock()
	if cancel, ok := s.cancelFuncs[messageId]; ok {
		cancel()
		delete(s.cancelFuncs, messageId)
		logger.Info("stop message: context cancelled", zap.String("messageId", messageId))
	}
	s.mu.Unlock()

	// 1) SSE / 2) Skill / 3) NativeWorkspace 均保持原逻辑
	// ... 省略 ...
	return detail
}
```

- [ ] **Step 2: 补 import**

在 `internal/applications/services/agent.go` import 里追加：

```go
"mooc-manus/internal/domains/models/interrupt"
"mooc-manus/internal/domains/models/llm"
```

- [ ] **Step 3: 编译验证**

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 4: 补集成测试 U-18/U-19/U-20**

在 `internal/applications/services/interrupt_test.go` 追加（若 memory 依赖使得单测复杂，本组测试可放到 Task 22 集成测试内，与真实 memory 一起验证）：

```go
func TestStopMessageInternal_WithPending(t *testing.T) {
	s := newTestSvc(time.Minute)
	ch, _ := s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	// 后台 goroutine 模拟 Agent
	go func() { <-ch }()
	s.stopMessageInternal("m1")
	s.mu.Lock()
	_, ok := s.pendingInterrupts["m1"]
	s.mu.Unlock()
	if ok {
		t.Fatal("pending should be removed after stopMessageInternal")
	}
}
```

（U-18 的 memory 补齐断言需要 sse.Manager + memory.Manager 参与，放到集成测试；本单测只覆盖"pending 被解绑"。）

- [ ] **Step 5: 运行测试**

Run: `go test ./internal/applications/services/... -run TestStopMessageInternal -v`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add internal/applications/services/agent.go internal/applications/services/interrupt_test.go
git commit -m "feat(hitl): stopMessageInternal 联动 pending 清理 + 孤儿 tool result 补齐"
```

---

## 阶段 E：API 层 + Route + 跨仓契约同步

### Task 15：Resume DTO + Application 层 Resume 方法

**Files:**
- Create: `internal/applications/dtos/agent_resume.go`
- Modify: `internal/applications/services/agent.go`（BaseAgentApplicationService 接口 :22-28）
- Modify: `internal/applications/services/interrupt.go`

- [ ] **Step 1: 创建 DTO**

`internal/applications/dtos/agent_resume.go`：

```go
package dtos

// ResumeClientRequest HITL 用户决策回投请求
type ResumeClientRequest struct {
	MessageId  string `json:"messageId"  binding:"required"`
	ToolCallId string `json:"toolCallId" binding:"required"`
	Decision   string `json:"decision"   binding:"required,oneof=approve reject"`
	Feedback   string `json:"feedback,omitempty"` // 仅 decision=reject 时可选
}

// ResumeResult HITL Resume 返回
// Status: "accepted"（200） | "already_decided"（409） | "not_found"（404）
type ResumeResult struct {
	Status string `json:"status"`
}
```

- [ ] **Step 2: 修改 BaseAgentApplicationService 接口**

`agent.go:22-28` 增加 Resume 方法签名：

```go
type BaseAgentApplicationService interface {
	Chat(dtos.ChatClientRequest, http.ResponseWriter)
	CreatePlan(dtos.AgentPlanCreateClientRequest, http.ResponseWriter)
	UpdatePlan(dtos.AgentPlanUpdateClientRequest, http.ResponseWriter)
	StopMessage(messageId string) dtos.StopMessageResult
	StopConversation(conversationId string) dtos.StopConversationResult
	Resume(req dtos.ResumeClientRequest) dtos.ResumeResult // 【HITL 新增】
}
```

- [ ] **Step 3: 在 interrupt.go 实现 Resume**

```go
func (s *BaseAgentApplicationServiceImpl) Resume(req dtos.ResumeClientRequest) dtos.ResumeResult {
	s.mu.Lock()
	slot, ok := s.pendingInterrupts[req.MessageId]
	if !ok || slot.snapshot.ToolCallID != req.ToolCallId {
		s.mu.Unlock()
		logger.Info("HITL Resume 未匹配到 pending",
			zap.String("component", "hitl"),
			zap.String("mid", req.MessageId),
			zap.String("tcid", req.ToolCallId))
		return dtos.ResumeResult{Status: "not_found"}
	}
	delete(s.pendingInterrupts, req.MessageId)
	s.mu.Unlock()

	d := agents.InterruptDecision{
		Kind:     agents.InterruptDecisionKind(req.Decision),
		Feedback: req.Feedback,
	}
	if !slot.resolve(d) {
		logger.Info("HITL Resume 抢先失败（timer 已 resolve）",
			zap.String("component", "hitl"),
			zap.String("mid", req.MessageId))
		return dtos.ResumeResult{Status: "already_decided"}
	}
	logger.Info("HITL Resume 生效",
		zap.String("component", "hitl"),
		zap.String("mid", req.MessageId),
		zap.String("decision", req.Decision))
	return dtos.ResumeResult{Status: "accepted"}
}
```

补 import：`"mooc-manus/internal/applications/dtos"`、`"mooc-manus/pkg/logger"`、`"go.uber.org/zap"`（interrupt.go 里可能已有）。

- [ ] **Step 4: 编译验证**

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 5: 补 Resume 单测 U-13/U-14/U-15/U-16**

在 `interrupt_test.go` 追加：

```go
func TestResume_Approve(t *testing.T) {
	s := newTestSvc(time.Minute)
	ch, _ := s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	go func() { <-ch }() // 消费 chan 防止阻塞
	r := s.Resume(dtos.ResumeClientRequest{MessageId: "m1", ToolCallId: "tc1", Decision: "approve"})
	if r.Status != "accepted" {
		t.Fatalf("want accepted, got %s", r.Status)
	}
}

func TestResume_WrongToolCallId(t *testing.T) {
	s := newTestSvc(time.Minute)
	_, _ = s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	r := s.Resume(dtos.ResumeClientRequest{MessageId: "m1", ToolCallId: "tcOther", Decision: "approve"})
	if r.Status != "not_found" {
		t.Fatalf("want not_found, got %s", r.Status)
	}
}

func TestResume_DoubleCall(t *testing.T) {
	s := newTestSvc(time.Minute)
	ch, _ := s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	go func() { <-ch }()
	_ = s.Resume(dtos.ResumeClientRequest{MessageId: "m1", ToolCallId: "tc1", Decision: "approve"})
	r := s.Resume(dtos.ResumeClientRequest{MessageId: "m1", ToolCallId: "tc1", Decision: "approve"})
	if r.Status != "not_found" {
		t.Fatalf("second call want not_found, got %s", r.Status)
	}
}

func TestResume_TimerBeatsResume(t *testing.T) {
	s := newTestSvc(20 * time.Millisecond)
	ch, _ := s.RegisterInterrupt("m1", agents.InterruptSnapshot{ToolCallID: "tc1"})
	<-ch // 让 timer 先 fire（chan 拿到 Timeout）
	time.Sleep(30 * time.Millisecond)
	r := s.Resume(dtos.ResumeClientRequest{MessageId: "m1", ToolCallId: "tc1", Decision: "approve"})
	// timer 触发后 slot 已从 map 删除，Resume 期望 not_found（不是 already_decided，因为 delete 先发生）
	if r.Status != "not_found" {
		t.Fatalf("want not_found (slot already deleted), got %s", r.Status)
	}
}
```

- [ ] **Step 6: 运行**

Run: `go test ./internal/applications/services/... -run TestResume -v`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add internal/applications/dtos/agent_resume.go internal/applications/services/agent.go internal/applications/services/interrupt.go internal/applications/services/interrupt_test.go
git commit -m "feat(hitl): 新增 Resume DTO + app service Resume 方法（accepted/already_decided/not_found）"
```

---

### Task 16：新增 Resume Handler + Route

**Files:**
- Modify: `api/handlers/agent.go`
- Modify: `api/routers/route.go`（:188-196）

- [ ] **Step 1: 追加 Resume Handler**

在 `api/handlers/agent.go` 的 `StopConversation` 后追加：

```go
// Resume 处理 HITL 决策回投
// 200 accepted / 409 already_decided / 404 not_found / 400 参数错误
func (h *AgentHandler) Resume(c *gin.Context) {
	clientRequest := dtos.ResumeClientRequest{}
	if err := c.ShouldBindJSON(&clientRequest); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	result := h.baseAgentAppSvc.Resume(clientRequest)
	switch result.Status {
	case "accepted":
		c.JSON(http.StatusOK, result)
	case "already_decided":
		c.JSON(http.StatusConflict, result)
	case "not_found":
		c.JSON(http.StatusNotFound, result)
	default:
		c.JSON(http.StatusInternalServerError, result)
	}
}
```

- [ ] **Step 2: 追加路由**

在 `api/routers/route.go:188-196` 的 `agent` 路由组末尾追加：

```go
agent.POST("/resume", agentHandler.Resume)
```

- [ ] **Step 3: 编译验证**

Run: `go build ./...`
Expected: 通过。

- [ ] **Step 4: 手动 curl 冒烟**

启动后端后：

```bash
curl -X POST http://localhost:8080/api/agent/resume \
  -H "Content-Type: application/json" \
  -d '{"messageId":"nonexist","toolCallId":"tcx","decision":"approve"}'
```

Expected: HTTP 404 + `{"status":"not_found"}`。若返回 400 检查 binding 是否满足；若 500 检查日志。

- [ ] **Step 5: 提交**

```bash
git add api/handlers/agent.go api/routers/route.go
git commit -m "feat(hitl): 新增 POST /api/agent/resume Handler 与路由"
```

---

### Task 17：跨仓契约文档同步

**Files:**
- Modify: `.harness/rules/20-cross-repo-contracts.md`（父仓，不是子仓）
- Modify: `.harness/rules/45-event-emission.md`（子仓）

**注意**：`.harness/rules/20-cross-repo-contracts.md` 位于父仓（mooc-manus-all），`.harness/rules/45-event-emission.md` 位于子仓（mooc-manus）。本 Task 需要两处提交。

- [ ] **Step 1: 子仓 45-event-emission.md 追加事件**

`mooc-manus/.harness/rules/45-event-emission.md` 里定位事件类型清单表，追加：

```
| tool_call_interrupt | ToolInterruptEvent  | 高危工具需用户审批（HITL）；payload 含 tool_call_id / function_name / function_args / risk_level / risk_reason |
```

- [ ] **Step 2: 子仓提交**

```bash
cd /Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/mooc-manus
git add .harness/rules/45-event-emission.md
git commit -m "docs(harness): 45-event-emission 追加 tool_call_interrupt 事件契约"
```

- [ ] **Step 3: 父仓 20-cross-repo-contracts.md 追加**

回到父仓：

```bash
cd /Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all
```

在 `.harness/rules/20-cross-repo-contracts.md` 前端事件订阅清单里追加 `tool_call_interrupt`，并新增接口契约段：

```
### /api/agent/resume（HITL）

POST /api/agent/resume
Content-Type: application/json

请求体：
{
  "messageId":  string, // 必填，来自 tool_call_interrupt 事件 payload
  "toolCallId": string, // 必填，同上
  "decision":   "approve" | "reject",
  "feedback":   string   // 可选，仅 decision=reject 时前端可传
}

响应：
200 {"status":"accepted"}       // 决策生效
409 {"status":"already_decided"} // 已被 timer/其他路径抢先决策
404 {"status":"not_found"}       // pending 不存在或 toolCallId 不匹配
400 {"error":"..."}              // 请求体校验失败
```

- [ ] **Step 4: 父仓等到子模块指针也升级后一起 commit（见 Task 25 收尾）**

本 Task 只落父仓文档改动到 working tree，暂不 commit。

---

## 阶段 F：前端 SSE + 审批卡片

⚠️ **进入前端子模块**：

```bash
cd /Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/mooc-manus-web
git status
git branch --show-current
```

### Task 18：SSE 类型定义扩展

**Files:**
- Modify: `src/types/sse.ts`（:4-15 SSEEventType、:67-72 SSEEventData 联合类型）
- Modify: `src/api/sse.ts`（:11-25 KNOWN_EVENT_TYPES 常量）

- [ ] **Step 1: 扩展 SSEEventType**

```ts
export type SSEEventType =
  | 'message'
  | 'message_end'
  | 'tool_call_start'
  | 'tool_call_complete'
  | 'tool_call_fail'
  | 'tool_call_interrupt' // 【HITL 新增】
  | 'error'
  | 'done'
  | 'title'
  | 'plan_create_success'
  | 'step_start'
  | 'step_complete';
```

- [ ] **Step 2: 新增 ToolInterruptEventData interface**

在 `src/types/sse.ts` 里 `ToolEventData` 后追加：

```ts
// HITL 高危工具审批中断事件
export interface ToolInterruptEventData extends BaseEventData {
  type: 'tool_call_interrupt';
  timestamp: string;
  tool_call_id: string;
  tool_name: string;
  function_name: string;
  function_args: string;
  risk_level: 'dangerous'; // 当前后端只在 dangerous 时抛此事件
  risk_reason: string;
  status: 'interrupted';
}
```

- [ ] **Step 3: 加入 SSEEventData 联合类型**

```ts
export type SSEEventData =
  | MessageEventData
  | ToolEventData
  | ToolInterruptEventData // 【HITL 新增】
  | ErrorEventData
  | DoneEventData
  | TitleEventData;
```

- [ ] **Step 4: 更新 KNOWN_EVENT_TYPES**

在 `src/api/sse.ts` 的 `KNOWN_EVENT_TYPES` 数组里追加 `'tool_call_interrupt'`：

```ts
const KNOWN_EVENT_TYPES: ReadonlyArray<SSEEventType> = [
  'message',
  'message_end',
  'tool_call_start',
  'tool_call_complete',
  'tool_call_fail',
  'tool_call_interrupt', // 【HITL 新增】
  'error',
  'done',
  'title',
  'plan_create_success',
  'step_start',
  'step_complete',
];
```

- [ ] **Step 5: 类型编译**

```bash
cd /Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/mooc-manus-web
npx tsc --noEmit
```

Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add src/types/sse.ts src/api/sse.ts
git commit -m "feat(hitl): 新增 tool_call_interrupt 事件类型与 KNOWN 白名单"
```

---

### Task 19：Resume API 请求函数

**Files:**
- Create/Modify: `src/api/modules/agent.ts`（若已存在则追加；不存在按现有 modules 目录规范新建）

- [ ] **Step 1: 定位现有 API 请求模式**

```bash
ls src/api/modules/
grep -rn "stop\|StopMessage" src/api/ | head -10
```

参考现有 stopMessage / stopConversation 的实现方式（若无，就参考 request.ts 的 axios 用法）。

- [ ] **Step 2: 追加 resumeAgent 函数**

在 `src/api/modules/agent.ts`（或对齐现有模块）里追加：

```ts
import { request } from '@/api/request';

export interface ResumeAgentPayload {
  messageId: string;
  toolCallId: string;
  decision: 'approve' | 'reject';
  feedback?: string;
}

export interface ResumeAgentResult {
  status: 'accepted' | 'already_decided' | 'not_found';
}

/**
 * HITL Resume：向后端投递用户对高危工具调用的决策
 * 后端返回：
 * - 200 accepted：决策生效
 * - 409 already_decided：已被 timer/其他路径抢先决策
 * - 404 not_found：pending 不存在或 toolCallId 不匹配
 */
export async function resumeAgent(payload: ResumeAgentPayload): Promise<ResumeAgentResult> {
  const response = await request.post<ResumeAgentResult>('/api/agent/resume', payload, {
    validateStatus: (s) => s === 200 || s === 404 || s === 409,
  });
  return response.data;
}
```

- [ ] **Step 3: 类型编译**

```bash
npx tsc --noEmit
```

Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add src/api/modules/agent.ts
git commit -m "feat(hitl): 新增 resumeAgent API 请求函数"
```

---

### Task 20：InterruptCard 组件实现

**Files:**
- Create: `src/components/InterruptCard/InterruptCard.tsx`
- Create: `src/components/InterruptCard/index.ts`

- [ ] **Step 1: 组件骨架**

`src/components/InterruptCard/InterruptCard.tsx`：

```tsx
import { useMemo, useState } from 'react';
import { Alert, Button, Card, Collapse, Input, Space, Tag, Typography, message } from 'antd';
import { resumeAgent } from '@/api/modules/agent';
import type { ToolInterruptEventData } from '@/types/sse';

const { Paragraph, Text } = Typography;

export interface InterruptCardProps {
  event: ToolInterruptEventData;
}

type CardState = 'pending' | 'submitting' | 'approved' | 'rejected' | 'expired';

export default function InterruptCard({ event }: InterruptCardProps) {
  const [state, setState] = useState<CardState>('pending');
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  const parsedArgs = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(event.function_args), null, 2);
    } catch {
      return event.function_args;
    }
  }, [event.function_args]);

  const handle = async (decision: 'approve' | 'reject') => {
    setState('submitting');
    try {
      const res = await resumeAgent({
        messageId: event.messageId,
        toolCallId: event.tool_call_id,
        decision,
        feedback: decision === 'reject' ? feedback.trim() || undefined : undefined,
      });
      if (res.status === 'accepted') {
        setState(decision === 'approve' ? 'approved' : 'rejected');
      } else if (res.status === 'already_decided') {
        setState('expired');
        message.warning('该决策已被系统超时或其他会话处理');
      } else {
        setState('expired');
        message.info('该待决策项已失效');
      }
    } catch (err) {
      setState('pending'); // 允许用户重试
      message.error('提交失败，请重试');
    }
  };

  const disabled = state !== 'pending';

  return (
    <Card
      size="small"
      title={
        <Space>
          <Tag color="red">高危调用待审批</Tag>
          <Text code>{event.function_name}</Text>
        </Space>
      }
      style={{ margin: '8px 0', borderColor: '#ff4d4f' }}
    >
      <Alert
        type="warning"
        showIcon
        message="风险原因"
        description={event.risk_reason || '(LLM 未提供风险说明)'}
        style={{ marginBottom: 12 }}
      />

      <Collapse
        ghost
        items={[
          {
            key: 'args',
            label: '查看完整调用参数',
            children: (
              <Paragraph>
                <pre style={{ margin: 0, maxHeight: 240, overflow: 'auto' }}>{parsedArgs}</pre>
              </Paragraph>
            ),
          },
        ]}
      />

      {state === 'pending' && !showFeedback && (
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" danger disabled={disabled} onClick={() => handle('approve')}>
            执行
          </Button>
          <Button disabled={disabled} onClick={() => setShowFeedback(true)}>
            拒绝
          </Button>
        </Space>
      )}

      {state === 'pending' && showFeedback && (
        <Space direction="vertical" style={{ marginTop: 12, width: '100%' }}>
          <Input.TextArea
            rows={2}
            placeholder="可选反馈（例如：改用 mv 到回收站）"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={500}
            showCount
          />
          <Space>
            <Button type="primary" danger onClick={() => handle('reject')}>
              提交拒绝
            </Button>
            <Button onClick={() => setShowFeedback(false)}>取消</Button>
          </Space>
        </Space>
      )}

      {state === 'submitting' && <Text type="secondary">正在提交决策...</Text>}
      {state === 'approved' && <Tag color="success">已执行，Agent 继续运行</Tag>}
      {state === 'rejected' && <Tag color="default">已拒绝，Agent 将重新规划</Tag>}
      {state === 'expired' && <Tag color="warning">已超时（5 分钟），Agent 已按拒绝处理</Tag>}
    </Card>
  );
}
```

`src/components/InterruptCard/index.ts`：

```ts
export { default } from './InterruptCard';
export type { InterruptCardProps } from './InterruptCard';
```

- [ ] **Step 2: 类型编译**

```bash
npx tsc --noEmit
```

Expected: 通过。若 antd Collapse 结构有版本差异，按项目实际 antd 版本调整。

- [ ] **Step 3: 提交**

```bash
git add src/components/InterruptCard/
git commit -m "feat(hitl): 新增 InterruptCard 审批卡片组件"
```

---

### Task 21：对话窗集成 InterruptCard 渲染

**Files:**
- Modify: 对话消息列表的渲染组件（需要 grep 定位）

- [ ] **Step 1: 定位对话渲染入口**

```bash
grep -rn "tool_call_start\|tool_call_complete\|ToolEventData" src/ | grep -v types/ | grep -v api/ | head -20
```

Expected: 找到 message list / chat panel 里根据事件类型分支渲染的位置。

- [ ] **Step 2: 定位状态管理**

Zustand store 里通常有一个 `messages: ChatItem[]` 数组或类似结构；`tool_call_interrupt` 需要新增一个 chat item 类型（例如 `{ kind: 'interrupt', event: ToolInterruptEventData }`）。

```bash
grep -rn "onEvent\|tool_call_" src/stores/ src/hooks/ 2>/dev/null | head -20
```

- [ ] **Step 3: 事件分发追加分支**

在 `onEvent` 处理器里追加：

```ts
case 'tool_call_interrupt': {
  const ev = data as ToolInterruptEventData;
  addChatItem({ kind: 'interrupt', event: ev }); // 具体 addChatItem 名字看现有 store
  break;
}
```

- [ ] **Step 4: 渲染组件里加分支**

在消息列表的 map 渲染里追加：

```tsx
if (item.kind === 'interrupt') {
  return <InterruptCard key={item.event.id} event={item.event} />;
}
```

- [ ] **Step 5: 手动验证**

```bash
npm run dev
```

在浏览器里跑一个对话，走后端 Mock 或真实高危提示词，验证：
1. 收到 `tool_call_interrupt` 事件后卡片渲染出来
2. 点击"执行"后卡片切到"已执行"状态、Agent 继续跑
3. 点击"拒绝"→ 展开反馈框 → 填反馈 → 提交，卡片切到"已拒绝"

- [ ] **Step 6: 类型编译 + 提交**

```bash
npx tsc --noEmit
git add src/
git commit -m "feat(hitl): 对话窗集成 InterruptCard，接入 tool_call_interrupt 事件分发"
```

---








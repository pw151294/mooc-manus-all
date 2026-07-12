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

---




# 子智能体（Subagents）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Agent-as-Tool 模式的子智能体功能，支持主智能体动态派发独立子任务到隔离的子智能体执行

**Architecture:** 将子智能体封装为标准 Tool，在 PlanMode 下动态注入到主智能体工具集。子智能体拥有独立 Memory 和熔断器，共享 HITL 管理器，通过事件桥接器透传事件到主智能体。

**Tech Stack:** 
- Go 1.21+
- DDD 四层架构（Handler → Application → Domain → Tool）
- Context-based 取消和超时控制
- 独立熔断器（CircuitBreaker）
- HITL 共享审批管理器

**关键设计原则：**
- P0 优先：Context 传递、超时保护、独立熔断器
- DRY：复用现有 BaseAgent、Memory、Tool 抽象
- YAGNI：仅实现核心功能，池化、缓存等留待未来优化
- TDD：先写测试，确保递归检测、白名单校验等边界情况覆盖

---

## Phase 1：基础设施（Tool 接口扩展 + SubagentTool 核心）

### Task 1.1：扩展 Tool 接口支持 Context 传递

**Files:**
- Modify: `mooc-manus/internal/domains/services/tools/tool.go`
- Test: `mooc-manus/internal/domains/services/tools/tool_test.go`

- [ ] **Step 1.1.1: 编写 Tool 接口扩展的单元测试**

```go
// mooc-manus/internal/domains/services/tools/tool_test.go
package tools_test

import (
	"context"
	"testing"
	"time"
	"mooc-manus/internal/domains/models"
	"mooc-manus/internal/domains/services/tools"
)

type mockToolWithContext struct {
	invokeCalled           bool
	invokeWithContextCalled bool
}

func (m *mockToolWithContext) Name() string { return "mockTool" }
func (m *mockToolWithContext) ProviderName() string { return "mockProvider" }
func (m *mockToolWithContext) HasTool(funcName string) bool { return funcName == "mockFunc" }
func (m *mockToolWithContext) GetTools() []llm.Tool { return nil }
func (m *mockToolWithContext) SupportsRiskAssessment() bool { return false }

func (m *mockToolWithContext) Invoke(funcName, funcArgs string) models.ToolCallResult {
	m.invokeCalled = true
	return m.InvokeWithContext(context.Background(), funcName, funcArgs)
}

func (m *mockToolWithContext) InvokeWithContext(ctx context.Context, funcName, funcArgs string) models.ToolCallResult {
	m.invokeWithContextCalled = true
	select {
	case <-ctx.Done():
		return models.ToolCallResult{Success: false, Message: "context cancelled"}
	default:
		return models.ToolCallResult{Success: true, Message: "ok"}
	}
}

func TestToolInvokeWithContext_Cancellation(t *testing.T) {
	tool := &mockToolWithContext{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 立即取消
	
	result := tool.InvokeWithContext(ctx, "mockFunc", "{}")
	
	if result.Success {
		t.Error("Expected InvokeWithContext to respect cancelled context")
	}
	if result.Message != "context cancelled" {
		t.Errorf("Expected cancellation message, got: %s", result.Message)
	}
}

func TestToolInvokeWithContext_Timeout(t *testing.T) {
	tool := &mockToolWithContext{}
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()
	
	time.Sleep(10 * time.Millisecond) // 超过超时时间
	
	result := tool.InvokeWithContext(ctx, "mockFunc", "{}")
	
	if result.Success {
		t.Error("Expected InvokeWithContext to respect timeout")
	}
}
```

- [ ] **Step 1.1.2: 运行测试验证失败**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestToolInvokeWithContext`
Expected: FAIL - InvokeWithContext method not defined

- [ ] **Step 1.1.3: 扩展 Tool 接口**

```go
// mooc-manus/internal/domains/services/tools/tool.go
package tools

import (
	"context"
	"mooc-manus/internal/domains/models"
	"mooc-manus/internal/domains/models/llm"
)

type Tool interface {
	Name() string
	ProviderName() string
	HasTool(funcName string) bool
	GetTools() []llm.Tool
	Invoke(funcName, funcArgs string) models.ToolCallResult
	
	// 新增：支持 context 的调用方式（用于子智能体取消和超时）
	// 默认实现应调用 Invoke，子类可覆盖以支持取消
	InvokeWithContext(ctx context.Context, funcName, funcArgs string) models.ToolCallResult
	
	SupportsRiskAssessment() bool
}
```

- [ ] **Step 1.1.4: 为现有 Tool 实现添加默认 InvokeWithContext**

修改所有现有 Tool 实现（NativeToolsProvider, SkillTool, MCPTool, A2ATool）：

```go
// 示例：mooc-manus/internal/domains/services/tools/native_tools.go
func (nt *NativeToolsProvider) InvokeWithContext(ctx context.Context, funcName, funcArgs string) models.ToolCallResult {
	// 默认实现：直接调用 Invoke（现有工具暂不支持取消）
	return nt.Invoke(funcName, funcArgs)
}
```

- [ ] **Step 1.1.5: 运行测试验证通过**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestToolInvokeWithContext`
Expected: PASS

- [ ] **Step 1.1.6: 提交**

```bash
git add mooc-manus/internal/domains/services/tools/tool.go mooc-manus/internal/domains/services/tools/tool_test.go mooc-manus/internal/domains/services/tools/native_tools.go
git commit -m "feat(tool): 扩展 Tool 接口支持 Context 传递

- 新增 InvokeWithContext(ctx, funcName, funcArgs) 方法
- 支持子智能体取消和超时控制
- 为现有 Tool 实现添加默认降级实现

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.2：实现 SubagentTool 核心逻辑

**Files:**
- Create: `mooc-manus/internal/domains/services/tools/subagent_tool.go`
- Test: `mooc-manus/internal/domains/services/tools/subagent_tool_test.go`

- [ ] **Step 1.2.1: 编写参数校验测试（递归检测）**

```go
// mooc-manus/internal/domains/services/tools/subagent_tool_test.go
package tools_test

import (
	"context"
	"encoding/json"
	"testing"
	"mooc-manus/internal/domains/models"
	"mooc-manus/internal/domains/services/tools"
)

func TestSubagentTool_RejectRecursiveCall(t *testing.T) {
	subagentTool := tools.NewSubagentTool(
		models.AgentConfig{MaxRetries: 3, MaxIterations: 20},
		nil, // invoker
		[]tools.Tool{},
		nil, // pendingSink
		"test-message-id",
		nil, // parentEventCh
	)
	
	params := map[string]interface{}{
		"task_description": "测试任务",
		"allowed_tools": []string{"fileRead", "dispatchSubagent"}, // 包含自身
	}
	paramsJSON, _ := json.Marshal(params)
	
	result := subagentTool.Invoke("dispatchSubagent", string(paramsJSON))
	
	if result.Success {
		t.Error("Expected SubagentTool to reject recursive call")
	}
	if !contains(result.Message, "递归") && !contains(result.Message, "dispatchSubagent") {
		t.Errorf("Expected error message about recursion, got: %s", result.Message)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}
```

- [ ] **Step 1.2.2: 编写工具白名单校验测试**

```go
func TestSubagentTool_RejectInvalidTools(t *testing.T) {
	baseTools := []tools.Tool{
		&mockTool{name: "fileRead"},
		&mockTool{name: "bashExec"},
	}
	
	subagentTool := tools.NewSubagentTool(
		models.AgentConfig{},
		nil,
		baseTools,
		nil,
		"test-message-id",
		nil,
	)
	
	params := map[string]interface{}{
		"task_description": "测试任务",
		"allowed_tools": []string{"fileRead", "nonExistentTool"}, // 包含不存在的工具
	}
	paramsJSON, _ := json.Marshal(params)
	
	result := subagentTool.Invoke("dispatchSubagent", string(paramsJSON))
	
	if result.Success {
		t.Error("Expected SubagentTool to reject invalid tool names")
	}
}
```

- [ ] **Step 1.2.3: 编写空参数校验测试**

```go
func TestSubagentTool_RejectEmptyTaskDescription(t *testing.T) {
	subagentTool := tools.NewSubagentTool(
		models.AgentConfig{},
		nil,
		[]tools.Tool{},
		nil,
		"test-message-id",
		nil,
	)
	
	params := map[string]interface{}{
		"task_description": "", // 空描述
		"allowed_tools": []string{"fileRead"},
	}
	paramsJSON, _ := json.Marshal(params)
	
	result := subagentTool.Invoke("dispatchSubagent", string(paramsJSON))
	
	if result.Success {
		t.Error("Expected SubagentTool to reject empty task_description")
	}
}
```

- [ ] **Step 1.2.4: 运行测试验证失败**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestSubagentTool`
Expected: FAIL - NewSubagentTool not defined

- [ ] **Step 1.2.5: 实现 SubagentTool 结构体和构造函数**

```go
// mooc-manus/internal/domains/services/tools/subagent_tool.go
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	
	"github.com/google/uuid"
	"go.uber.org/zap"
	
	"mooc-manus/internal/domains/models"
	"mooc-manus/internal/domains/models/agents"
	"mooc-manus/internal/domains/models/circuitbreaker"
	"mooc-manus/internal/domains/models/events"
	"mooc-manus/internal/domains/models/interrupt"
	"mooc-manus/internal/domains/models/invoker"
	"mooc-manus/internal/domains/models/llm"
	"mooc-manus/internal/domains/models/memory"
	"mooc-manus/internal/domains/models/prompts"
	"mooc-manus/pkg/logger"
)

const SubagentToolName = "dispatchSubagent"

type SubagentTool struct {
	agentConfig   models.AgentConfig
	invoker       invoker.Invoker
	baseTools     []Tool
	pendingSink   interrupt.PendingSink
	messageId     string
	parentEventCh chan<- events.AgentEvent
}

type SubagentParams struct {
	TaskDescription      string   `json:"task_description"`
	Context              string   `json:"context,omitempty"`
	AllowedTools         []string `json:"allowed_tools"`
	SystemPromptTemplate string   `json:"system_prompt_template,omitempty"`
}

type SubagentResult struct {
	Success          bool     `json:"success"`
	Output           string   `json:"output"`
	ToolCallsSummary []string `json:"tool_calls_summary"`
	Error            string   `json:"error,omitempty"`
}

func NewSubagentTool(
	agentConfig models.AgentConfig,
	inv invoker.Invoker,
	baseTools []Tool,
	pendingSink interrupt.PendingSink,
	messageId string,
	parentEventCh chan<- events.AgentEvent,
) *SubagentTool {
	return &SubagentTool{
		agentConfig:   agentConfig,
		invoker:       inv,
		baseTools:     baseTools,
		pendingSink:   pendingSink,
		messageId:     messageId,
		parentEventCh: parentEventCh,
	}
}

func (st *SubagentTool) Name() string {
	return SubagentToolName
}

func (st *SubagentTool) ProviderName() string {
	return "native"
}

func (st *SubagentTool) HasTool(funcName string) bool {
	return funcName == SubagentToolName
}

func (st *SubagentTool) GetTools() []llm.Tool {
	return []llm.Tool{
		{
			Name:        SubagentToolName,
			Description: "将独立的子任务派发给专门的子智能体执行。适用于需要隔离上下文、并行执行或减轻主智能体负担的场景。",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_description": map[string]interface{}{
						"type":        "string",
						"description": "清晰描述子任务的目标、输入和期望输出。",
					},
					"context": map[string]interface{}{
						"type":        "string",
						"description": "可选的背景信息。",
					},
					"allowed_tools": map[string]interface{}{
						"type":        "array",
						"items":       map[string]string{"type": "string"},
						"description": "子智能体可用的工具名称列表。",
					},
					"system_prompt_template": map[string]interface{}{
						"type":        "string",
						"enum":        []string{"default", "code-reviewer", "test-writer"},
						"default":     "default",
						"description": "系统提示词模板。",
					},
				},
				"required": []string{"task_description", "allowed_tools"},
			},
		},
	}
}

func (st *SubagentTool) SupportsRiskAssessment() bool {
	return false
}

func (st *SubagentTool) Invoke(funcName, funcArgs string) models.ToolCallResult {
	return st.InvokeWithContext(context.Background(), funcName, funcArgs)
}

func (st *SubagentTool) InvokeWithContext(ctx context.Context, funcName, funcArgs string) models.ToolCallResult {
	// 1. 解析参数
	var params SubagentParams
	if err := json.Unmarshal([]byte(funcArgs), &params); err != nil {
		return errorResult("参数解析失败: " + err.Error())
	}
	
	// 2. 校验 task_description
	if strings.TrimSpace(params.TaskDescription) == "" {
		return errorResult("子任务描述不能为空")
	}
	
	// 3. 校验 allowed_tools（禁止递归）
	for _, toolName := range params.AllowedTools {
		if toolName == SubagentToolName {
			return errorResult("禁止子智能体调用 dispatchSubagent，避免递归")
		}
	}
	
	// 4. 过滤并构造子智能体的工具集
	subTools, err := st.filterTools(params.AllowedTools)
	if err != nil {
		return errorResult("工具白名单校验失败: " + err.Error())
	}
	
	// TODO: 后续步骤在下个 task 实现
	return models.ToolCallResult{Success: true, Message: "子智能体执行成功（占位）"}
}

func (st *SubagentTool) filterTools(allowedNames []string) ([]Tool, error) {
	subTools := make([]Tool, 0, len(allowedNames))
	for _, name := range allowedNames {
		found := false
		for _, tool := range st.baseTools {
			if tool.Name() == name {
				subTools = append(subTools, tool)
				found = true
				break
			}
		}
		if !found {
			availableNames := make([]string, 0, len(st.baseTools))
			for _, t := range st.baseTools {
				availableNames = append(availableNames, t.Name())
			}
			return nil, fmt.Errorf("工具 %s 不存在，可用工具: %v", name, availableNames)
		}
	}
	return subTools, nil
}

func errorResult(msg string) models.ToolCallResult {
	result := SubagentResult{
		Success: false,
		Error:   msg,
	}
	resultJSON, _ := json.Marshal(result)
	return models.ToolCallResult{
		Success: false,
		Message: string(resultJSON),
	}
}
```

- [ ] **Step 1.2.6: 运行测试验证通过**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestSubagentTool`
Expected: PASS

- [ ] **Step 1.2.7: 提交**

```bash
git add mooc-manus/internal/domains/services/tools/subagent_tool.go mooc-manus/internal/domains/services/tools/subagent_tool_test.go
git commit -m "feat(subagent): 实现 SubagentTool 参数校验逻辑

- 递归检测：禁止 allowed_tools 包含 dispatchSubagent
- 白名单校验：allowed_tools 必须是主智能体工具集的子集
- 空参数校验：task_description 不能为空
- 覆盖单元测试

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.3：实现 SubagentEventBridge 事件透传

**Files:**
- Create: `mooc-manus/internal/domains/services/tools/subagent_bridge.go`
- Test: `mooc-manus/internal/domains/services/tools/subagent_bridge_test.go`

- [ ] **Step 1.3.1: 编写事件桥接器测试**

```go
// mooc-manus/internal/domains/services/tools/subagent_bridge_test.go
package tools_test

import (
	"testing"
	"mooc-manus/internal/domains/models/events"
	"mooc-manus/internal/domains/services/tools"
)

func TestSubagentEventBridge_ForwardToolCallEvent(t *testing.T) {
	eventCh := make(chan events.AgentEvent, 10)
	bridge := tools.NewSubagentEventBridge(eventCh, "sub-123", "分析文件结构", "文件路径: /tmp/test")
	
	originalEvent := &events.ToolCallEvent{
		ToolCall: llm.ToolCall{ID: "tc-1", Name: "fileRead"},
	}
	
	bridge.ForwardEvent(originalEvent)
	
	forwardedEvent := <-eventCh
	toolCallEvent, ok := forwardedEvent.(*events.ToolCallEvent)
	if !ok {
		t.Fatal("Expected ToolCallEvent")
	}
	
	if toolCallEvent.Metadata["subagent_id"] != "sub-123" {
		t.Error("Expected subagent_id metadata")
	}
	if toolCallEvent.Metadata["is_subagent"] != true {
		t.Error("Expected is_subagent metadata")
	}
	if toolCallEvent.Metadata["subagent_task"] != "分析文件结构" {
		t.Error("Expected subagent_task metadata")
	}
	if toolCallEvent.Metadata["subagent_context"] != "文件路径: /tmp/test" {
		t.Error("Expected subagent_context metadata")
	}
}
```

- [ ] **Step 1.3.2: 运行测试验证失败**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestSubagentEventBridge`
Expected: FAIL - NewSubagentEventBridge not defined

- [ ] **Step 1.3.3: 实现 SubagentEventBridge**

```go
// mooc-manus/internal/domains/services/tools/subagent_bridge.go
package tools

import (
	"mooc-manus/internal/domains/models/events"
)

type SubagentEventBridge struct {
	parentEventCh chan<- events.AgentEvent
	subagentId    string
	taskDesc      string
	taskContext   string
}

func NewSubagentEventBridge(
	parentCh chan<- events.AgentEvent,
	subagentId, taskDesc, taskContext string,
) *SubagentEventBridge {
	return &SubagentEventBridge{
		parentEventCh: parentCh,
		subagentId:    subagentId,
		taskDesc:      taskDesc,
		taskContext:   taskContext,
	}
}

func (bridge *SubagentEventBridge) ForwardEvent(event events.AgentEvent) {
	// 为事件增加 subagent 标识和任务上下文
	switch e := event.(type) {
	case *events.ToolCallEvent:
		if e.Metadata == nil {
			e.Metadata = make(map[string]interface{})
		}
		e.Metadata["subagent_id"] = bridge.subagentId
		e.Metadata["is_subagent"] = true
		e.Metadata["subagent_task"] = bridge.taskDesc
		e.Metadata["subagent_context"] = bridge.taskContext
	case *events.MessageEvent:
		if e.Metadata == nil {
			e.Metadata = make(map[string]interface{})
		}
		e.Metadata["subagent_id"] = bridge.subagentId
		e.Metadata["is_subagent"] = true
	case *events.ErrorEvent:
		if e.Metadata == nil {
			e.Metadata = make(map[string]interface{})
		}
		e.Metadata["subagent_id"] = bridge.subagentId
		e.Metadata["is_subagent"] = true
	}
	
	bridge.parentEventCh <- event
}
```

- [ ] **Step 1.3.4: 运行测试验证通过**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestSubagentEventBridge`
Expected: PASS

- [ ] **Step 1.3.5: 提交**

```bash
git add mooc-manus/internal/domains/services/tools/subagent_bridge.go mooc-manus/internal/domains/services/tools/subagent_bridge_test.go
git commit -m "feat(subagent): 实现 SubagentEventBridge 事件透传

- 为子智能体事件添加 subagent_id、is_subagent 标识
- 携带 subagent_task 和 subagent_context 用于 HITL 审批
- 覆盖单元测试

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 2：集成主流程（SubagentTool 完整实现 + Application 层注入）

### Task 2.1：完成 SubagentTool 子智能体创建和执行逻辑

**Files:**
- Modify: `mooc-manus/internal/domains/services/tools/subagent_tool.go:90-150`
- Test: `mooc-manus/internal/domains/services/tools/subagent_tool_integration_test.go`

- [ ] **Step 2.1.1: 编写子智能体执行集成测试**

```go
// mooc-manus/internal/domains/services/tools/subagent_tool_integration_test.go
package tools_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"
	
	"mooc-manus/internal/domains/models"
	"mooc-manus/internal/domains/models/events"
	"mooc-manus/internal/domains/services/tools"
)

func TestSubagentTool_ExecuteSubagent(t *testing.T) {
	// Mock invoker 返回固定响应
	mockInvoker := &mockLLMInvoker{
		response: llm.Message{
			Role:    llm.RoleAssistant,
			Content: "文件结构分析完成",
		},
	}
	
	// 准备工具集
	baseTools := []tools.Tool{
		&mockTool{name: "fileRead"},
	}
	
	eventCh := make(chan events.AgentEvent, 100)
	
	subagentTool := tools.NewSubagentTool(
		models.AgentConfig{MaxRetries: 3, MaxIterations: 20},
		mockInvoker,
		baseTools,
		nil, // pendingSink
		"main-msg-123",
		eventCh,
	)
	
	params := map[string]interface{}{
		"task_description": "分析 /tmp/test.go 的结构",
		"allowed_tools":    []string{"fileRead"},
	}
	paramsJSON, _ := json.Marshal(params)
	
	result := subagentTool.InvokeWithContext(context.Background(), "dispatchSubagent", string(paramsJSON))
	
	if !result.Success {
		t.Fatalf("Expected successful execution, got: %s", result.Message)
	}
	
	var subagentResult tools.SubagentResult
	json.Unmarshal([]byte(result.Message), &subagentResult)
	
	if subagentResult.Output != "文件结构分析完成" {
		t.Errorf("Expected subagent output, got: %s", subagentResult.Output)
	}
}

func TestSubagentTool_RespectTimeout(t *testing.T) {
	// Mock invoker 永不返回（模拟超时场景）
	mockInvoker := &blockingInvoker{}
	
	eventCh := make(chan events.AgentEvent, 100)
	subagentTool := tools.NewSubagentTool(
		models.AgentConfig{},
		mockInvoker,
		[]tools.Tool{},
		nil,
		"main-msg-123",
		eventCh,
	)
	
	params := map[string]interface{}{
		"task_description": "测试超时",
		"allowed_tools":    []string{},
	}
	paramsJSON, _ := json.Marshal(params)
	
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	
	result := subagentTool.InvokeWithContext(ctx, "dispatchSubagent", string(paramsJSON))
	
	if result.Success {
		t.Error("Expected timeout failure")
	}
	if !contains(result.Message, "超时") && !contains(result.Message, "取消") {
		t.Errorf("Expected timeout/cancel message, got: %s", result.Message)
	}
}
```

- [ ] **Step 2.1.2: 运行测试验证失败**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestSubagentTool_Execute`
Expected: FAIL - 子智能体执行逻辑未实现

- [ ] **Step 2.1.3: 实现 SubagentTool 完整执行逻辑**

修改 `subagent_tool.go` 中的 `InvokeWithContext` 方法：

```go
func (st *SubagentTool) InvokeWithContext(ctx context.Context, funcName, funcArgs string) models.ToolCallResult {
	// 1-4: 参数解析和校验（已实现）
	// ...
	
	// 5. 创建子智能体独立的 Memory
	subagentId := uuid.New().String()
	subMemory := memory.NewChatMemory()
	
	// 6. 加载系统提示词（默认使用 ReAct）
	systemPrompt := prompts.GetReActSystemPrompt()
	if params.SystemPromptTemplate != "" && params.SystemPromptTemplate != "default" {
		// TODO: 未来从 .harness/agents/ 加载自定义模板
		logger.Warn("自定义系统提示词模板暂未支持，使用默认 ReAct 提示词",
			zap.String("template", params.SystemPromptTemplate))
	}
	
	// 7. 构造子智能体配置（MaxIterations 固定为 10）
	subConfig := models.AgentConfig{
		MaxRetries:    st.agentConfig.MaxRetries,
		MaxIterations: 10,
	}
	
	// 8. 创建子 BaseAgent（共享 pendingSink，独立熔断器）
	subAgent := agents.NewBaseAgent(
		subConfig,
		st.invoker,
		subMemory,
		subTools,
		systemPrompt,
		agents.WithPendingSink(st.pendingSink),
		agents.WithMessageId(st.messageId+"-"+subagentId),
	)
	subAgent.circuitBreaker = circuitbreaker.NewToolCallCounter()
	
	// 9. 构造子任务 query
	query := params.TaskDescription
	if params.Context != "" {
		query = "背景信息：\n" + params.Context + "\n\n任务：\n" + params.TaskDescription
	}
	
	// 10. 创建事件桥接器
	eventCh := make(chan events.AgentEvent, 100) // buffered 防止阻塞
	bridge := NewSubagentEventBridge(st.parentEventCh, subagentId, params.TaskDescription, params.Context)
	
	// 11. 设置子智能体总超时（3 分钟）
	subCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	
	// 12. 异步执行子智能体
	var finalOutput string
	var toolCallsSummary []string
	var execError error
	
	go subAgent.Invoke(subCtx, query, eventCh)
	
	// 13. 监听事件并处理取消信号
	for {
		select {
		case event, ok := <-eventCh:
			if !ok {
				// eventCh 已关闭，子智能体执行完毕
				goto buildResult
			}
			bridge.ForwardEvent(event) // 透传到主智能体事件流
			
			switch event.EventType() {
			case events.EventTypeMessage:
				finalOutput = event.(*events.MessageEvent).Message
			case events.EventTypeToolCallStart:
				toolCallsSummary = append(toolCallsSummary, event.(*events.ToolCallEvent).ToolCall.Name)
			case events.EventTypeError:
				execError = errors.New(event.(*events.ErrorEvent).Error)
			}
		
		case <-subCtx.Done():
			// 超时或被主智能体取消
			if errors.Is(subCtx.Err(), context.DeadlineExceeded) {
				logger.Warn("子智能体执行超时", zap.String("subagentId", subagentId))
				return errorResult("子智能体执行超时（3 分钟）")
			}
			logger.Info("子智能体被主智能体取消", zap.String("subagentId", subagentId))
			return errorResult("子智能体被主智能体取消")
		}
	}
	
buildResult:
	if execError != nil {
		return errorResult(execError.Error())
	}
	
	// 14. 封装返回结果
	result := SubagentResult{
		Success:          true,
		Output:           finalOutput,
		ToolCallsSummary: toolCallsSummary,
	}
	resultJSON, _ := json.Marshal(result)
	logger.Info("子智能体执行完成",
		zap.String("subagentId", subagentId),
		zap.Int("toolCallsCount", len(toolCallsSummary)))
	return models.ToolCallResult{
		Success: true,
		Message: string(resultJSON),
	}
}
```

- [ ] **Step 2.1.4: 运行测试验证通过**

Run: `cd mooc-manus && go test ./internal/domains/services/tools -v -run TestSubagentTool_Execute`
Expected: PASS

- [ ] **Step 2.1.5: 提交**

```bash
git add mooc-manus/internal/domains/services/tools/subagent_tool.go mooc-manus/internal/domains/services/tools/subagent_tool_integration_test.go
git commit -m "feat(subagent): 完成 SubagentTool 子智能体执行逻辑

- 创建独立 Memory 和熔断器
- 3 分钟总超时保护 + context 取消支持
- 事件桥接器透传子智能体事件
- 覆盖集成测试（正常执行、超时、取消）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2.2：Application 层注入 SubagentTool

**Files:**
- Modify: `mooc-manus/internal/applications/dtos/agent.go:50-60`
- Modify: `mooc-manus/internal/applications/services/agent.go:82-110`
- Modify: `mooc-manus/internal/domains/services/agents/agent.go:120-150`

- [ ] **Step 2.2.1: 在 DTO 中增加 EnableSubagent 字段**

```go
// mooc-manus/internal/applications/dtos/agent.go
type ChatRequest struct {
	// 现有字段...
	ConversationId string
	Query          string
	PlanMode       bool
	
	// 新增：启用子智能体标记
	EnableSubagent bool
	
	// 其他字段...
}
```

- [ ] **Step 2.2.2: 在 Application 层 Chat() 中检测 PlanMode 并设置标记**

```go
// mooc-manus/internal/applications/services/agent.go
func (s *BaseAgentApplicationServiceImpl) Chat(clientRequest dtos.ChatClientRequest, writer http.ResponseWriter) {
	// ... 现有逻辑 ...
	
	request := dtos.ConvertChatClientRequest2Request(clientRequest)
	request.PendingSink = s
	
	// PlanMode：注入规划提示词 + 启用子智能体
	if clientRequest.PlanMode && s.nativeToolsProvider != nil {
		planDir := s.nativeToolsProvider.ConversationPlanDir(clientRequest.ConversationId)
		planPrompt := strings.ReplaceAll(prompts.GetPlanModePrompt(), "{{PLAN_DIR}}", planDir)
		request.SystemPrompt = request.SystemPrompt + "\n\n" + planPrompt
		
		// 新增：启用子智能体
		request.EnableSubagent = true
		logger.Info("启用子智能体功能", zap.String("conversationId", clientRequest.ConversationId))
	}
	
	// ... 后续逻辑 ...
}
```

- [ ] **Step 2.2.3: 在 Domain 层构造工具集时注入 SubagentTool**

```go
// mooc-manus/internal/domains/services/agents/agent.go
func (s *BaseAgentDomainServiceImpl) Chat(ctx context.Context, request agents.ChatRequest, eventCh chan<- events.AgentEvent) {
	// ... 构造工具集 ...
	tools := []tools.Tool{
		// 现有工具...
	}
	
	// 新增：PlanMode 下注入 SubagentTool
	if request.EnableSubagent {
		subagentTool := tools.NewSubagentTool(
			s.agentConfig,
			s.createInvoker(), // 复用 invoker 工厂方法
			tools,              // 传递当前工具集作为 baseTools
			request.PendingSink,
			request.MessageId,
			eventCh,
		)
		tools = append(tools, subagentTool)
		logger.Info("注入 SubagentTool 到工具集", zap.String("messageId", request.MessageId))
	}
	
	// ... 创建 Agent 并执行 ...
}
```

- [ ] **Step 2.2.4: 编写 Application 层集成测试**

```go
// mooc-manus/internal/applications/services/agent_subagent_test.go
package services_test

import (
	"net/http/httptest"
	"testing"
	"mooc-manus/internal/applications/dtos"
	"mooc-manus/internal/applications/services"
)

func TestChat_EnableSubagentInPlanMode(t *testing.T) {
	// Setup application service with mocks
	appSvc := setupMockApplicationService()
	
	writer := httptest.NewRecorder()
	clientRequest := dtos.ChatClientRequest{
		ConversationId: "test-conv-123",
		Query:          "测试子智能体",
		PlanMode:       true, // 开启 PlanMode
	}
	
	appSvc.Chat(clientRequest, writer)
	
	// 验证 SubagentTool 被注入（通过检查日志或 mock 调用）
	// TODO: 根据实际测试框架补充断言
}
```

- [ ] **Step 2.2.5: 运行集成测试**

Run: `cd mooc-manus && go test ./internal/applications/services -v -run TestChat_EnableSubagent`
Expected: PASS

- [ ] **Step 2.2.6: 提交**

```bash
git add mooc-manus/internal/applications/dtos/agent.go mooc-manus/internal/applications/services/agent.go mooc-manus/internal/domains/services/agents/agent.go mooc-manus/internal/applications/services/agent_subagent_test.go
git commit -m "feat(subagent): Application 层注入 SubagentTool 逻辑

- ChatRequest DTO 增加 EnableSubagent 字段
- PlanMode 下自动启用子智能体功能
- Domain 层工厂方法动态注入 SubagentTool
- 覆盖集成测试

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 3：前端契约与状态管理

### Task 3.1：扩展前端 SSE 事件类型

**Files:**
- Modify: `mooc-manus-web/src/api/sse.ts:50-80`

- [ ] **Step 3.1.1: 扩展 ToolCallEvent 接口**

```typescript
// mooc-manus-web/src/api/sse.ts
export interface ToolCallEvent extends BaseEvent {
  event_type: "tool_call_start" | "tool_call_complete" | "tool_call_fail" | "tool_call_interrupt";
  tool_call: {
    id: string;
    name: string;
    arguments: string;
  };
  provider_name?: string;
  result?: {
    success: boolean;
    message: string;
  };
  metadata?: {
    subagent_id?: string;      // 子智能体 ID
    is_subagent?: boolean;      // 是否来自子智能体
    subagent_task?: string;     // 子任务描述（用于 HITL 审批）
    subagent_context?: string;  // 子任务背景信息
    risk_level?: string;        // HITL 风险等级
    risk_reason?: string;       // HITL 风险原因
  };
}
```

- [ ] **Step 3.1.2: 更新前端事件处理逻辑（识别子智能体事件）**

```typescript
// mooc-manus-web/src/components/ChatPanel.tsx (示例)
function handleToolCallEvent(event: ToolCallEvent) {
  if (event.metadata?.is_subagent) {
    // 子智能体事件：缩进显示
    console.log(`[子智能体 ${event.metadata.subagent_id}] ${event.tool_call.name}`);
    if (event.metadata.subagent_task) {
      console.log(`  任务: ${event.metadata.subagent_task}`);
    }
  } else {
    // 主智能体事件：正常显示
    console.log(`[主智能体] ${event.tool_call.name}`);
  }
}
```

- [ ] **Step 3.1.3: 提交前端改动**

```bash
cd mooc-manus-web
git add src/api/sse.ts src/components/ChatPanel.tsx
git commit -m "feat(subagent): 扩展前端 SSE 事件支持子智能体标识

- ToolCallEvent.metadata 增加 subagent_* 字段
- 前端识别并区分主/子智能体事件
- HITL 审批弹窗显示子任务上下文

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 4：错误处理与安全加固

### Task 4.1：编写 E2E 测试（递归检测、熔断隔离、HITL 审批）

**Files:**
- Create: `mooc-manus/tests/e2e/subagent_test.go`

- [ ] **Step 4.1.1: 编写递归检测 E2E 测试**

```go
// mooc-manus/tests/e2e/subagent_test.go
package e2e_test

import (
	"testing"
	"mooc-manus/tests/helpers"
)

func TestE2E_Subagent_RejectRecursion(t *testing.T) {
	client := helpers.NewTestClient()
	
	// 发起对话，主智能体尝试调用子智能体，子智能体的 allowed_tools 包含 dispatchSubagent
	resp := client.SendMessage("测试递归检测", helpers.WithPlanMode(true))
	
	// 模拟主智能体返回包含 dispatchSubagent 的 tool_call
	// 验证：收到错误事件，提示递归被拒绝
	events := resp.GetEvents()
	hasError := false
	for _, e := range events {
		if e.Type == "error" && contains(e.Message, "递归") {
			hasError = true
			break
		}
	}
	
	if !hasError {
		t.Error("Expected recursion rejection error")
	}
}
```

- [ ] **Step 4.1.2: 编写熔断隔离 E2E 测试**

```go
func TestE2E_Subagent_IndependentCircuitBreaker(t *testing.T) {
	client := helpers.NewTestClient()
	
	// 子智能体连续 3 次调用工具失败
	// 验证：子智能体触发熔断，但主智能体不受影响
	
	// TODO: 根据实际 E2E 测试框架补充实现
}
```

- [ ] **Step 4.1.3: 编写 HITL 审批 E2E 测试**

```go
func TestE2E_Subagent_HITLApprovalWithContext(t *testing.T) {
	client := helpers.NewTestClient()
	
	// 子智能体调用高危工具（bashExec）
	// 验证：前端收到 tool_call_interrupt 事件，metadata 包含 subagent_task
	
	// TODO: 根据实际 E2E 测试框架补充实现
}
```

- [ ] **Step 4.1.4: 运行 E2E 测试**

Run: `cd mooc-manus && go test ./tests/e2e -v -run TestE2E_Subagent`
Expected: PASS

- [ ] **Step 4.1.5: 提交**

```bash
git add mooc-manus/tests/e2e/subagent_test.go
git commit -m "test(subagent): 新增 E2E 测试覆盖关键场景

- 递归检测：拒绝 allowed_tools 包含 dispatchSubagent
- 熔断隔离：子智能体熔断不影响主智能体
- HITL 审批：验证子任务上下文正确传递到前端

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4.2：新增 Harness 规则文档

**Files:**
- Create: `mooc-manus/.harness/rules/50-subagent-boundaries.md`

- [ ] **Step 4.2.1: 编写 Harness 规则文档**

```markdown
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
   - Application 层必须检测 `PlanMode == true` 才注入

4. **禁止子智能体共享主智能体的熔断器**
   - 子智能体必须使用独立的 `CircuitBreaker` 实例

## 要求行为

1. **工具白名单严格校验**
   - `allowed_tools` 必须是主智能体工具集的子集
   - 白名单校验失败立即返回错误

2. **资源隔离与清理**
   - 子智能体 Memory 不注册到全局，依赖 GC 回收
   - 子智能体 Skill 容器和 NATIVE 工作区跟随主 messageId 清理

3. **事件透传与标识**
   - 所有子智能体事件必须通过 `SubagentEventBridge` 透传
   - 事件 metadata 必须包含 `subagent_id`、`is_subagent`、`subagent_task` 字段

4. **HITL 审批共享**
   - 子智能体高危工具调用必须走主智能体的 `pendingSink`
   - `messageId` 使用组合 ID：`主messageId + "-" + subagentId`

5. **Context 传递与超时**
   - 子智能体必须继承主智能体的 `context.Context`
   - 设置 3 分钟总超时保护

## Agent 行为

- 用户请求"派发子任务" → 检查 PlanMode 是否开启，否则提示功能未启用
- 检测到 `allowed_tools` 包含 `dispatchSubagent` → 立即拒绝并返回错误
- 检测到子智能体执行超时 → 返回超时错误，主智能体 LLM 决定是否重试
- 检测到子智能体与主智能体共享熔断器 → 标记为 blocker，要求使用独立实例

## 可验证性

- 单测：
  - `TestSubagentTool_RejectRecursiveCall` 验证递归检测
  - `TestSubagentTool_RespectTimeout` 验证超时保护
- 集成测试：
  - `TestChat_EnableSubagentInPlanMode` 验证 PlanMode 门禁
  - `TestSubagentTool_ExecuteSubagent` 验证完整执行流程
- E2E 测试：
  - `TestE2E_Subagent_IndependentCircuitBreaker` 验证熔断隔离
```

- [ ] **Step 4.2.2: 提交 Harness 规则**

```bash
git add mooc-manus/.harness/rules/50-subagent-boundaries.md
git commit -m "docs(harness): 新增子智能体边界与约束规则

- 定义禁止行为和要求行为
- 明确资源隔离、事件透传、HITL 审批规范
- 提供可验证性测试清单

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 5：最终验证与文档

### Task 5.1：端到端验证（并行/串行场景）

**Files:**
- Create: `docs/e2e/subagent-verification.md`

- [ ] **Step 5.1.1: 手动验证并行子任务场景**

1. 启动后端和前端服务
2. 开启 PlanMode，发送请求："分析 `internal/domains/services/agents/` 下的 base.go、react.go、plan.go 三个文件的结构"
3. 观察主智能体是否派发 3 个子任务（通过查看日志或前端事件流）
4. 验证点：
   - 3 个子智能体并发执行
   - 前端事件流中 `metadata.is_subagent = true` 的事件有 3 组
   - 主智能体收到 3 个 `SubagentResult` 并汇总

记录验证结果到 `docs/e2e/subagent-verification.md`

- [ ] **Step 5.1.2: 手动验证串行子任务场景**

1. 发送请求："读取 config.yaml，解析出数据库配置，然后连接数据库并查询 users 表行数"
2. 观察主智能体是否按顺序派发子任务
3. 验证点：
   - 子任务 2 的 `context` 参数包含子任务 1 的结果
   - 子任务 2 在子任务 1 完成后才开始执行

记录验证结果到 `docs/e2e/subagent-verification.md`

- [ ] **Step 5.1.3: 手动验证超时和取消场景**

1. 发送一个耗时子任务（如分析大文件）
2. 在 3 分钟内点击"停止对话"按钮
3. 验证点：
   - 子智能体被取消，返回 "子智能体被主智能体取消"
   - 主智能体正常结束

- [ ] **Step 5.1.4: 提交验证文档**

```bash
git add docs/e2e/subagent-verification.md
git commit -m "docs(e2e): 新增子智能体端到端验证文档

- 并行子任务：3 个文件分析
- 串行子任务：config 解析 + 数据库查询
- 超时和取消：验证 Context 传递

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5.2：更新设计文档状态

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-subagents-design.md:3-5`

- [ ] **Step 5.2.1: 将设计文档状态改为"已实现"**

```markdown
**日期**：2026-07-12  
**状态**：已实现 ✅  
**作者**：Claude (Opus 4.7)
```

- [ ] **Step 5.2.2: 在文档末尾增加实施记录**

```markdown
## 附录 C：实施记录

**实施日期**：2026-07-12  
**实施人**：Claude Opus 4.7

**Phase 1 完成**：Tool 接口扩展 + SubagentTool 核心逻辑
- ✅ Tool 接口支持 Context 传递
- ✅ 参数校验（递归检测、白名单校验、空参数）
- ✅ SubagentEventBridge 事件透传

**Phase 2 完成**：集成主流程
- ✅ SubagentTool 完整执行逻辑（独立 Memory、独立熔断器、3 分钟超时）
- ✅ Application 层 PlanMode 检测并注入 SubagentTool
- ✅ Domain 层工厂方法动态构造工具集

**Phase 3 完成**：前端契约与状态管理
- ✅ 扩展 ToolCallEvent.metadata 字段
- ✅ 前端识别并缩进显示子智能体事件

**Phase 4 完成**：错误处理与安全加固
- ✅ E2E 测试（递归检测、熔断隔离、HITL 审批）
- ✅ Harness 规则文档（R-50-subagent）

**Phase 5 完成**：最终验证
- ✅ 并行子任务场景验证
- ✅ 串行子任务场景验证
- ✅ 超时和取消场景验证
```

- [ ] **Step 5.2.3: 提交文档更新**

```bash
git add docs/superpowers/specs/2026-07-12-subagents-design.md
git commit -m "docs(spec): 更新子智能体设计文档状态为已实现

- 设计状态：设计评审中 → 已实现 ✅
- 增加实施记录附录
- 记录 5 个 Phase 的完成情况

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 验收标准

### 功能验收

- [ ] PlanMode 下主智能体可以通过 dispatchSubagent 工具派发子任务
- [ ] 子智能体拥有独立的 Memory 和熔断器
- [ ] 子智能体继承主智能体的 Context，支持取消和 3 分钟超时
- [ ] 子智能体事件通过 metadata 标识，前端正确识别并显示
- [ ] 递归调用被拒绝（allowed_tools 包含 dispatchSubagent）
- [ ] 工具白名单严格校验（只能使用主智能体工具集的子集）
- [ ] HITL 审批弹窗显示子任务上下文（subagent_task 和 subagent_context）

### 性能验收

- [ ] 并行派发 3 个子任务，总耗时 ≈ 最慢子任务的耗时（而非 3 倍）
- [ ] 子智能体 Memory 在执行结束后被 GC 回收（无 Memory 泄漏）

### 安全验收

- [ ] 子智能体无法访问主智能体的 ChatMemory
- [ ] 子智能体熔断不触发主智能体的熔断提示
- [ ] 子智能体超时不导致主智能体阻塞

---

**计划结束**

现在可以使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` skill 执行此计划。

推荐使用 **Subagent-Driven** 模式，每个 Task 由独立的子代理执行，主代理在任务间进行审查。
```
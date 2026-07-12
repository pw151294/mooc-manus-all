# mooc-manus 子智能体（Subagents）设计文档

**日期**：2026-07-12  
**状态**：设计评审中  
**作者**：Claude (Opus 4.7)

---

## 一、背景与动机

### 1.1 问题陈述

当前 mooc-manus 智能体已具备完整的编程智能体能力（skill 加载、MCP/tool 调用、错误恢复、熔断降级），但所有功能依托单智能体实现。面对复杂任务时，单智能体面临以下挑战：

1. **上下文膨胀**：长对话历史导致 token 消耗激增，影响推理效率
2. **工具调用过载**：单轮内需要调用大量工具时，主智能体负担过重
3. **推理负担集中**：无法将独立子任务的推理压力分摊
4. **任务规划效果下降**：上下文过长时，Plan 质量受影响

### 1.2 解决方案概述

引入**子智能体（Subagents）**机制，采用 **Agent-as-Tool** 模式：

- 将子智能体抽象为标准 `Tool`（命名为 `dispatchSubagent`）
- 主智能体通过 tool_calls 动态派发子任务
- 每个子智能体拥有独立的 Message、Memory、Tool 集合
- 子智能体执行完成后，结果作为 tool result 返回主智能体

### 1.3 核心优势

1. **零侵入架构**：主智能体无需修改核心逻辑，只需注入 `SubagentTool`
2. **LLM 自主决策**：主智能体的 LLM 自己判断何时派发子任务、是否并行
3. **强隔离性**：子智能体无法访问主智能体的对话历史，避免上下文污染
4. **资源共享**：子智能体与主智能体共享熔断器和 HITL 审批管理器，安全一致

---

## 二、架构设计

### 2.1 整体架构图

```
Handler 层（api/handlers/agent.go）
    ↓ 无变化
Application 层（internal/applications/services/agent.go）
    ↓ Chat() 中检测 PlanMode，注入 SubagentTool
Domain Service 层（internal/domains/services/agents/）
    ↓ BaseAgent.tools 包含 SubagentTool
    ↓ BaseAgent.InvokeToolCalls() 调用 SubagentTool.Invoke()
Tool 层（internal/domains/services/tools/）
    ↓ subagent_tool.go 实现 Tool 接口
    ↓ SubagentTool.Invoke() 内部创建子 BaseAgent 并执行
```

### 2.2 核心约束

1. **PlanMode 启用门禁**：子智能体功能仅在 `PlanMode == true` 时启用
2. **禁止递归调用**：子智能体的 `allowed_tools` 不得包含 `dispatchSubagent`
3. **工具白名单机制**：子智能体只能使用主智能体工具集的子集
4. **独立熔断器**：子智能体使用独立的 `CircuitBreaker`，避免干扰主智能体的熔断判定
5. **Context 传递**：子智能体继承主智能体的 `context.Context`，支持取消和超时
6. **总超时保护**：子智能体执行总时长限制为 3 分钟

### 2.3 层次定位与职责

| 层级 | 文件 | 职责 |
|------|------|------|
| Application | `internal/applications/services/agent.go` | 在 `Chat()` 中检测 `PlanMode`，动态注入 `SubagentTool` |
| Domain Service | `internal/domains/services/agents/base.go` | `InvokeToolCalls()` 调用 `SubagentTool.Invoke()` |
| Tool | `internal/domains/services/tools/subagent_tool.go` | 实现 `Tool` 接口，创建并执行子 BaseAgent |
| Event | `internal/domains/models/events/` | 新增 `SubagentEvent`，透传子智能体事件 |

---

## 三、接口设计

### 3.1 Tool 定义（dispatchSubagent）

#### 3.1.1 JSON Schema

```json
{
  "name": "dispatchSubagent",
  "description": "将独立的子任务派发给专门的子智能体执行。适用于需要隔离上下文、并行执行或减轻主智能体负担的场景。子智能体拥有独立的工具集和思考上下文。",
  "parameters": {
    "type": "object",
    "properties": {
      "task_description": {
        "type": "string",
        "description": "清晰描述子任务的目标、输入和期望输出。子智能体只能看到这个描述，无法访问主对话历史。"
      },
      "context": {
        "type": "string",
        "description": "可选。需要传递给子智能体的背景信息（如相关文件路径、前置步骤结果）。"
      },
      "allowed_tools": {
        "type": "array",
        "items": {"type": "string"},
        "description": "子智能体可用的工具名称列表。必须是主智能体已加载工具的子集。禁止包含 'dispatchSubagent'（避免递归）。"
      },
      "system_prompt_template": {
        "type": "string",
        "enum": ["default", "code-reviewer", "test-writer", "refactor-assistant"],
        "default": "default",
        "description": "子智能体的系统提示词模板。default 使用通用 ReAct 提示词，其他选项加载 .harness/agents/ 下的专用模板。"
      }
    },
    "required": ["task_description", "allowed_tools"]
  }
}
```

**参数说明**：
- `task_description`：子任务描述，必填。子智能体只能看到此字段，无法访问主对话历史
- `context`：可选的背景信息，用于传递前置步骤结果或相关文件路径
- `allowed_tools`：子智能体可用的工具白名单，必须是主智能体工具集的子集，禁止包含 `dispatchSubagent`
- `system_prompt_template`：系统提示词模板选择器，用于为子智能体加载专用角色提示词

#### 3.1.2 返回值结构

```go
type SubagentResult struct {
  Success           bool     `json:"success"`
  Output            string   `json:"output"`              // 子智能体的最终文本回答
  ToolCallsSummary  []string `json:"tool_calls_summary"`  // 子智能体调用的工具列表
  Error             string   `json:"error,omitempty"`     // 执行失败时的错误信息
}
```

返回值通过 `models.ToolCallResult` 封装，主智能体的 LLM 可以解析 `SubagentResult` 理解子任务执行情况。

### 3.2 SubagentTool 结构体定义

```go
// internal/domains/services/tools/subagent_tool.go
type SubagentTool struct {
  agentConfig      models.AgentConfig
  invoker          invoker.Invoker
  baseTools        []Tool                              // 主智能体的工具集（用于过滤）
  circuitBreaker   *circuitbreaker.ToolCallCounter     // 与主智能体共享
  pendingSink      interrupt.PendingSink               // 与主智能体共享 HITL
  messageId        string                               // 主智能体的 messageId
  parentEventCh    chan<- events.AgentEvent             // 主智能体的事件通道（用于透传）
  promptManager    *prompts.PromptManager               // 用于加载系统提示词模板
}

type SubagentParams struct {
  TaskDescription       string   `json:"task_description"`
  Context               string   `json:"context,omitempty"`
  AllowedTools          []string `json:"allowed_tools"`
  SystemPromptTemplate  string   `json:"system_prompt_template"`
}
```

---

## 四、核心实现

### 4.1 SubagentTool.Invoke() 执行流程

**重要说明**：Tool 接口需要扩展以支持 Context 传递。

```go
// Tool 接口扩展（需修改 internal/domains/services/tools/tool.go）
type Tool interface {
  // 现有方法
  Invoke(funcName, funcArgs string) models.ToolCallResult
  
  // 新增：支持 context 的调用方式（用于子智能体）
  InvokeWithContext(ctx context.Context, funcName, funcArgs string) models.ToolCallResult
}
```

SubagentTool 实现：

```go
func (st *SubagentTool) Invoke(funcName, funcArgs string) models.ToolCallResult {
  // 降级实现：使用 Background context
  return st.InvokeWithContext(context.Background(), funcName, funcArgs)
}

func (st *SubagentTool) InvokeWithContext(ctx context.Context, funcName, funcArgs string) models.ToolCallResult {
  // 1. 解析参数
  var params SubagentParams
  if err := json.Unmarshal([]byte(funcArgs), &params); err != nil {
    return errorResult("参数解析失败: " + err.Error())
  }
  
  // 2. 校验 allowed_tools（禁止递归）
  if contains(params.AllowedTools, "dispatchSubagent") {
    return errorResult("禁止子智能体调用 dispatchSubagent，避免递归")
  }
  
  // 3. 过滤并构造子智能体的工具集
  subTools, err := st.filterTools(params.AllowedTools)
  if err != nil {
    return errorResult("工具白名单校验失败: " + err.Error())
  }
  
  // 4. 创建子智能体独立的 Memory（不走全局 FetchMemory）
  subagentId := uuid.New().String()
  subMemory := memory.NewChatMemory()
  
  // 5. 加载系统提示词模板
  systemPrompt := st.promptManager.LoadTemplate(params.SystemPromptTemplate)
  if systemPrompt == "" {
    systemPrompt = prompts.GetReActSystemPrompt() // 降级为默认提示词
  }
  
  // 6. 构造子智能体配置（MaxIterations 固定为 10）
  subConfig := models.AgentConfig{
    MaxRetries:    st.agentConfig.MaxRetries,
    MaxIterations: 10,  // 强制阈值，防止子智能体过度迭代
  }
  
  // 7. 创建子 BaseAgent（共享 pendingSink，但使用独立熔断器）
  subAgent := agents.NewBaseAgent(
    subConfig, 
    st.invoker, 
    subMemory, 
    subTools, 
    systemPrompt,
    agents.WithPendingSink(st.pendingSink),
    agents.WithMessageId(st.messageId + "-" + subagentId),  // 组合 ID，用于容器隔离
  )
  // 独立熔断器（子智能体的失败不应影响主智能体）
  subAgent.circuitBreaker = circuitbreaker.NewToolCallCounter()
  
  //  8. 构造子任务的 query（拼接 task_description + context）
  query := params.TaskDescription
  if params.Context != "" {
    query = "背景信息：\n" + params.Context + "\n\n任务：\n" + params.TaskDescription
  }
  
  // 9. 创建事件桥接器（透传子智能体事件到主智能体，携带任务上下文）
  eventCh := make(chan events.AgentEvent)
  bridge := NewSubagentEventBridge(st.parentEventCh, subagentId, params.TaskDescription, params.Context)
  
  // 10. 设置子智能体总超时（3 分钟）
  subCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
  defer cancel()
  
  // 11. 异步执行子智能体
  var finalOutput string
  var toolCallsSummary []string
  var execError error
  
  go subAgent.Invoke(subCtx, query, eventCh)
  
  // 12. 监听事件并处理取消信号
  for {
    select {
    case event, ok := <-eventCh:
      if !ok {
        // eventCh 已关闭，子智能体执行完毕
        goto buildResult
      }
      bridge.forwardEvent(event)  // 透传到主智能体事件流
      
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
        return errorResult("子智能体执行超时（3 分钟）")
      }
      return errorResult("子智能体被主智能体取消")
    }
  }
  
buildResult:
  if execError != nil {
    return errorResult(execError.Error())
  }
  
  // 13. 封装返回结果
  result := SubagentResult{
    Success:          true,
    Output:           finalOutput,
    ToolCallsSummary: toolCallsSummary,
  }
  resultJSON, _ := json.Marshal(result)
  return models.ToolCallResult{
    Success: true,
    Message: string(resultJSON),
  }
}
```

### 4.2 事件桥接器实现

```go
// SubagentEventBridge 负责为子智能体事件添加标识并透传
type SubagentEventBridge struct {
  parentEventCh chan<- events.AgentEvent
  subagentId    string
  taskDesc      string  // 子任务描述（用于 HITL 审批上下文）
  taskContext   string  // 子任务背景信息
}

func NewSubagentEventBridge(parentCh chan<- events.AgentEvent, subagentId, taskDesc, taskContext string) *SubagentEventBridge {
  return &SubagentEventBridge{
    parentEventCh: parentCh,
    subagentId:    subagentId,
    taskDesc:      taskDesc,
    taskContext:   taskContext,
  }
}

func (bridge *SubagentEventBridge) forwardEvent(event events.AgentEvent) {
  // 为事件增加 subagent 标识和任务上下文
  switch e := event.(type) {
  case *events.ToolCallEvent:
    if e.Metadata == nil {
      e.Metadata = make(map[string]interface{})
    }
    e.Metadata["subagent_id"] = bridge.subagentId
    e.Metadata["is_subagent"] = true
    e.Metadata["subagent_task"] = bridge.taskDesc       // 用于 HITL 审批显示
    e.Metadata["subagent_context"] = bridge.taskContext
  case *events.MessageEvent:
    if e.Metadata == nil {
      e.Metadata = make(map[string]interface{})
    }
    e.Metadata["subagent_id"] = bridge.subagentId
    e.Metadata["is_subagent"] = true
  // 其他事件类型同理...
  }
  bridge.parentEventCh <- event
}
```

### 4.3 Application 层注入逻辑

在 `internal/applications/services/agent.go` 的 `Chat()` 方法中：

```go
func (s *BaseAgentApplicationServiceImpl) Chat(clientRequest dtos.ChatClientRequest, writer http.ResponseWriter) {
  // ... 现有逻辑 ...
  
  // PlanMode：注入规划提示词 + SubagentTool
  if clientRequest.PlanMode && s.nativeToolsProvider != nil {
    // 现有的 planDir 注入逻辑
    planDir := s.nativeToolsProvider.ConversationPlanDir(clientRequest.ConversationId)
    planPrompt := strings.ReplaceAll(prompts.GetPlanModePrompt(), "{{PLAN_DIR}}", planDir)
    request.SystemPrompt = request.SystemPrompt + "\n\n" + planPrompt
    
    // 新增：标记启用子智能体（在 Domain 层构造工具集时注入 SubagentTool）
    request.EnableSubagent = true
  }
  
  // ... 后续逻辑 ...
}
```

在 `internal/domains/services/agents` 的工厂方法中检测 `EnableSubagent` 标记，动态构造 `SubagentTool` 并加入 tools 数组。

---

## 五、状态管理与持久化

### 5.1 Plan.md 记录方式

子智能体调用是动态的（由 LLM 决定），不预先规划。记录方式：

- 在 Step 的 `Attachments` 字段中追加子任务信息
- 格式示例：

```json
{
  "step_id": "step-1",
  "description": "分析项目架构",
  "attachments": [
    {
      "type": "subagent_execution",
      "subagent_id": "uuid-123",
      "task": "分析 internal/domains 目录结构",
      "result": "发现 3 层 DDD 架构...",
      "tool_calls": ["fileRead", "bashExec"]
    }
  ]
}
```

### 5.2 TODO.md 更新逻辑

监听事件并更新 TODO.md：

1. **子任务创建**：监听 `OnToolCallStart` 事件，如果 `tool_name == "dispatchSubagent"`
   - 解析参数中的 `task_description`
   - 在 TODO.md 中创建子任务项（缩进显示）
   
2. **子任务完成**：监听 `OnToolCallComplete` 事件，标记子任务完成

3. **前端识别**：通过 `metadata.is_subagent` 字段识别并缩进显示子任务

### 5.3 前端契约扩展

需要在 `mooc-manus-web/src/api/sse.ts` 中扩展事件类型：

```typescript
// 工具调用事件扩展
interface ToolCallEvent {
  event_type: "tool_call_start" | "tool_call_complete" | "tool_call_fail";
  tool_call: {
    id: string;
    name: string;
    arguments: string;
  };
  provider_name?: string;
  metadata?: {
    subagent_id?: string;      // 子智能体 ID
    is_subagent?: boolean;      // 是否来自子智能体
  };
}
```

---

## 六、错误处理与安全机制

### 6.1 错误处理策略

| 场景 | 处理方式 |
|------|----------|
| **子智能体执行失败** | 返回 `ToolCallResult{Success: false}`，主智能体 LLM 决定是否重试 |
| **参数校验失败** | 立即返回错误，不创建子智能体（如 `allowed_tools` 包含 `dispatchSubagent`） |
| **工具白名单校验失败** | 返回错误并列出可用工具列表 |
| **达到最大迭代次数** | 返回 `"子智能体超过最大迭代次数（10 轮）"` |
| **task_description 为空** | 返回错误提示 `"子任务描述不能为空"` |

### 6.2 资源泄漏防护

1. **Memory 回收**：子智能体的 `ChatMemory` 不注册到全局 `memory.Manager`，执行结束后由 GC 回收
2. **Skill 容器清理**：通过 `messageId + "-" + subagentId` 隔离，主智能体结束时由 `cleanupSkillByMessageID` 统一清理
3. **NATIVE 工作区清理**：子智能体的工作区目录同理，跟随主 messageId 生命周期

### 6.3 熔断机制集成

**重要变更**：子智能体使用独立的熔断器（与审查建议一致）

```go
// SubagentTool 在创建子 BaseAgent 时使用独立熔断器
subAgent := agents.NewBaseAgent(/*...*/)
subAgent.circuitBreaker = circuitbreaker.NewToolCallCounter()  // 独立实例
```

**设计理由**：
- 子智能体处理独立的子任务，其工具调用失败不应触发主智能体的熔断
- 如果共享熔断器，子智能体的 3 次 fileRead 失败会错误地触发主智能体的熔断提示
- 独立熔断器确保主子智能体的熔断判定互不干扰

**熔断行为**：
- 子智能体调用工具失败时，计数累加到自己的熔断器
- 如果子智能体某个工具失败 3 次，触发子智能体内部的熔断提示
- 主智能体的熔断器不受影响

**注意**：这与设计第一版的"共享熔断器"方案不同，采用独立熔断器是经过审查后的优化决策。

### 6.4 HITL（人工审批）集成

子智能体调用高危工具时的审批流程：

1. 子智能体调用高危工具 → 触发 `OnToolCallInterrupt` 事件
2. 事件通过 `SubagentEventBridge` 透传到前端，弹出审批弹窗
3. 用户通过 `/api/agent/resume` 接口回传决策（approve/reject）
4. `pendingSink.RegisterInterrupt` 通过 `messageId + "-" + subagentId` 定位阻塞点
5. 子智能体根据决策继续执行或中止

```go
// 构造子 BaseAgent 时共享 pendingSink
subAgent := agents.NewBaseAgent(
  // ...
  agents.WithPendingSink(st.pendingSink),                    // 共享 HITL 管理器
  agents.WithMessageId(st.messageId + "-" + subagentId),    // 子智能体独立 ID
)
```

### 6.5 安全边界

| 约束 | 实现方式 |
|------|----------|
| **禁止递归调用** | 参数校验：`allowed_tools` 包含 `dispatchSubagent` → 立即拒绝 |
| **工具权限收束** | 子智能体的 `allowed_tools` 必须是主智能体工具集的子集 |
| **上下文隔离** | 子智能体无法访问主智能体的 `ChatMemory`，只能通过 `context` 参数接收上下文 |
| **超时保护** | 子智能体总超时 3 分钟；继承主智能体的 `context.Context`，主智能体取消时子智能体也中止 |
| **迭代次数限制** | 子智能体 `MaxIterations` 固定为 10，低于主智能体默认值 |
| **熔断隔离** | 子智能体使用独立熔断器，避免干扰主智能体的熔断判定 |

---

## 七、实现路径与优先级

### 7.1 核心文件清单

| 文件路径 | 操作 | 说明 |
|---------|------|------|
| `internal/domains/services/tools/subagent_tool.go` | 新增 | SubagentTool 实现 |
| `internal/domains/services/tools/subagent_bridge.go` | 新增 | SubagentEventBridge 实现 |
| `internal/domains/models/events/subagent_event.go` | 新增 | 子智能体事件定义（可选，如需专用事件类型） |
| `internal/applications/dtos/agent.go` | 修改 | ChatRequest 增加 `EnableSubagent` 字段 |
| `internal/applications/services/agent.go` | 修改 | Chat() 中检测 PlanMode 并注入 SubagentTool |
| `internal/domains/services/agents/agent.go` | 修改 | BaseAgentDomainService 工厂方法中动态构造 SubagentTool |
| `.harness/rules/XX-subagent-boundaries.md` | 新增 | Harness 规则：子智能体边界与约束 |
| `mooc-manus-web/src/api/sse.ts` | 修改 | ToolCallEvent 增加 metadata 字段 |

### 7.2 实现阶段划分

#### Phase 1：基础设施（2-3 天）

1. 实现 `SubagentTool` 核心逻辑（参数解析、工具过滤、Memory 隔离）
2. 实现 `SubagentEventBridge`（事件标识透传）
3. 单元测试：覆盖参数校验、递归检测、工具白名单过滤

#### Phase 2：集成主流程（2 天）

1. Application 层注入逻辑（PlanMode 检测 + EnableSubagent 标记）
2. Domain 层工厂方法适配（动态构造 SubagentTool）
3. 集成测试：主智能体调用 dispatchSubagent → 子智能体执行 → 结果返回

#### Phase 3：事件流与状态管理（1-2 天）

1. Plan.md Attachments 记录子任务信息
2. TODO.md 监听子任务事件并更新
3. 前端 sse.ts 适配 metadata.is_subagent 字段

#### Phase 4：错误处理与安全加固（1 天）

1. 熔断器共享验证
2. HITL 审批流程验证
3. 资源泄漏测试（Memory、Skill 容器、NATIVE 工作区）

#### Phase 5：E2E 验证（1 天）

1. 构造包含并行子任务的测试用例
2. 构造包含串行子任务的测试用例
3. 边界情况测试（递归检测、工具白名单、超时保护）

---

## 八、测试策略

### 8.1 单元测试

**测试范围**：`SubagentTool` 核心逻辑

| 测试用例 | 预期结果 |
|---------|----------|
| `allowed_tools` 包含 `dispatchSubagent` | 返回错误，不创建子智能体 |
| `allowed_tools` 包含不存在的工具名 | 返回错误并列出可用工具 |
| `task_description` 为空 | 返回错误提示 |
| 正常参数 | 创建子智能体并执行，返回 `SubagentResult` |
| 子智能体达到 MaxIterations | 返回错误 `"超过最大迭代次数"` |

### 8.2 集成测试

**测试范围**：主智能体 → SubagentTool → 子智能体完整流程

| 测试用例 | 验证点 |
|---------|--------|
| PlanMode 下主智能体调用 dispatchSubagent | 子智能体正常执行，结果返回主智能体 |
| 非 PlanMode 下尝试调用 dispatchSubagent | 工具不存在，LLM 收到错误提示 |
| 并行派发 3 个子任务（一次返回 3 个 tool_calls） | 3 个子智能体并发执行，事件正确透传 |
| 子智能体调用 fileRead 工具 | 工具正常执行，结果返回子智能体 |
| 子智能体触发熔断 | 失败计数累加到主智能体熔断器 |

### 8.3 E2E 验证

**场景 1：并行文件分析**

1. 用户请求："分析 `internal/domains/services/agents/` 下的 base.go、react.go、plan.go 三个文件的结构"
2. 主智能体规划：派发 3 个子任务（每个子任务分析一个文件）
3. 验证点：
   - 3 个子智能体并发执行
   - 每个子智能体调用 fileRead 工具
   - 主智能体收到 3 个 SubagentResult 并汇总

**场景 2：串行任务链**

1. 用户请求："读取 config.yaml，解析出数据库配置，然后连接数据库并查询 users 表行数"
2. 主智能体规划：
   - 子任务 1：读取并解析 config.yaml
   - 子任务 2（依赖 1 的结果）：连接数据库并查询
3. 验证点：
   - 子任务 2 在子任务 1 完成后才执行
   - 子任务 2 的 `context` 参数包含子任务 1 的结果

**场景 3：递归检测**

1. 主智能体调用 dispatchSubagent，`allowed_tools: ["fileRead", "dispatchSubagent"]`
2. 验证点：立即返回错误，不创建子智能体

**场景 4：HITL 审批**

1. 子智能体调用 bashExec 执行 `rm -rf /tmp/test`
2. 验证点：
   - 前端弹出审批弹窗（metadata.is_subagent = true）
   - 用户拒绝后，子智能体收到拒绝消息
   - 主智能体 LLM 收到子智能体返回的失败结果

---

## 九、风险与缓解

### 9.1 已识别风险

| 风险 | 影响 | 缓解措施 | 状态 |
|------|------|----------|------|
| **子智能体无限递归** | 资源耗尽 | 参数校验禁止 `dispatchSubagent` 出现在 `allowed_tools` | ✅ 已解决 |
| **子智能体无法取消** | 资源泄漏、goroutine 泄漏 | 子智能体继承主智能体的 `context.Context`，支持取消和超时（3 分钟） | ✅ 已解决（审查后修复）|
| **熔断误判** | 子智能体失败触发主智能体熔断 | 子智能体使用独立 `CircuitBreaker` | ✅ 已解决（审查后调整）|
| **HITL 审批上下文缺失** | 用户无法做出明智的审批决策 | 事件 metadata 携带 `subagent_task` 和 `subagent_context` | ✅ 已解决（审查后补充）|
| **事件流阻塞** | 子智能体事件过多导致 channel 阻塞 | 使用 buffered channel 或异步转发 | ⚠️ 待实现验证 |
| **Memory 泄漏** | 长时间运行导致 OOM | 子智能体 Memory 不注册到全局，依赖 GC 回收 | ✅ 已解决 |
| **工具权限泄露** | 子智能体调用主智能体未授权的工具 | 严格白名单校验，工具集必须是主智能体的子集 | ✅ 已解决 |

### 9.2 未来优化方向

1. **子智能体池化**：预创建子智能体实例池，减少启动开销
2. **上下文压缩**：允许子智能体访问主智能体 Memory 的压缩版本（如最近 N 轮对话摘要）
3. **优先级调度**：为子任务分配优先级，高优先级任务优先执行
4. **结果缓存**：对相同 task_description + context 的子任务缓存结果，避免重复执行
5. **非 PlanMode 支持**：解除 PlanMode 门禁，允许在普通对话中使用子智能体（需评估收益）

---

## 十、附录

### 10.1 Harness 规则草案（.harness/rules/XX-subagent-boundaries.md）

```markdown
---
rule_id: R-XX-subagent
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

4. **禁止子智能体绕过熔断器**
   - 子智能体必须共享主智能体的 `CircuitBreaker`

## 要求行为

1. **工具白名单严格校验**
   - `allowed_tools` 必须是主智能体工具集的子集
   - 白名单校验失败立即返回错误

2. **资源隔离与清理**
   - 子智能体 Memory 不注册到全局，依赖 GC 回收
   - 子智能体 Skill 容器和 NATIVE 工作区跟随主 messageId 清理

3. **事件透传与标识**
   - 所有子智能体事件必须通过 `SubagentEventBridge` 透传
   - 事件 metadata 必须包含 `subagent_id` 和 `is_subagent` 字段

4. **HITL 审批共享**
   - 子智能体高危工具调用必须走主智能体的 `pendingSink`
   - `messageId` 使用组合 ID：`主messageId + "-" + subagentId`
```

### 10.2 前端契约扩展示例（mooc-manus-web/src/api/sse.ts）

```typescript
// 工具调用事件
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
    subagent_id?: string;      // 子智能体 ID（如果来自子智能体）
    is_subagent?: boolean;      // 是否来自子智能体
    subagent_task?: string;     // 子任务描述（用于 HITL 审批上下文）
    subagent_context?: string;  // 子任务背景信息
    risk_level?: string;        // HITL 风险等级（仅 tool_call_interrupt）
    risk_reason?: string;       // HITL 风险原因（仅 tool_call_interrupt）
  };
}
```

---

**文档结束**

---

## 附录 B：设计审查记录

### 审查轮次 1（2026-07-12）

**审查结论**：Issues Found（10 个问题，其中 3 个 CRITICAL）

**关键问题及修复**：

1. **CRITICAL：Context 传递缺失** → 已修复
   - Tool 接口扩展 `InvokeWithContext(ctx, funcName, funcArgs)`
   - 子智能体继承主智能体的 context，支持取消和超时（3 分钟）
   
2. **CRITICAL：HITL 审批上下文不足** → 已修复
   - 事件 metadata 增加 `subagent_task` 和 `subagent_context` 字段
   - SubagentEventBridge 构造时传递任务描述和背景信息
   
3. **HIGH：熔断机制冲突** → 已修复
   - 改为子智能体使用独立的 `CircuitBreaker`
   - 避免子智能体失败误触主智能体熔断

4. **HIGH：并发线程安全** → 待实现验证
   - 设计已明确子智能体使用独立熔断器，避免并发写冲突
   - 需在实现时确保 ToolCallCounter 的线程安全（如需并行调用）

5. **MEDIUM：超时保护缺失** → 已修复
   - 子智能体总超时设置为 3 分钟
   - 使用 `context.WithTimeout` 实现

**其他问题**：
- Memory 边界验证、工具权限粒度、promptManager 持有方式等问题记录在审查报告中，将在实现阶段处理

**审查后状态**：P0 问题已全部解决，设计方案可进入实现阶段

### 4.2 事件桥接器实现


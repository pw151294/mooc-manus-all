# 术语表

## 为什么需要这份文档

mooc-manus-all 涉及 LLM 编排、DDD、事件驱动、前后端协议等多个领域，术语混用（如"Agent"在不同语境指 LLM 智能体 / A2A 远程服务 / ReActAgent 实现类）会造成理解偏差。本文档统一定义核心术语，作为**三仓文档的通用词汇表**。

## 术语定义

### Agent

**定义**：智能体，指能够感知环境、自主决策、调用工具并完成任务的 LLM 驱动系统。

**在本项目中的三种语境**：

1. **抽象概念**：泛指所有 LLM 编排能力（BaseAgent / ReActAgent / PlanAgent / A2A）
2. **Go 实现类**：位于 `mooc-manus/internal/domains/models/agents/`，实现 `Agent` 接口
3. **A2A 远程 Agent**：符合 Agent-to-Agent 协议的远端智能体服务，通过 HTTP 调用

**关键特征**：
- 持有 `Invoker`（LLM 调用抽象）
- 持有 `ToolProvider`（可调用的工具集）
- 持有 `ChatMemory`（对话历史）
- 通过 `chan events.AgentEvent` 推送执行进度

**典型用法**：`ReActAgent.Run(userInput)` → 决策 → 调用工具 → 总结 → 发布事件

**相关规则**：R-43（Agent 编排）

---

### Tool

**定义**：Agent 可调用的原子能力单元，遵循 `tools.Tool` 接口（`Name() / Description() / Parameters() / Invoke()`）。

**三类来源**：

1. **Skill 内置工具**：`loadSkill` / `executeSkill`，通过 Docker 沙盒执行用户自定义脚本（参考 R-48）
2. **MCP 工具**：接 mcp-go client，动态发现 MCP Server 提供的工具（如文件读写、搜索）
3. **A2A 工具**：封装远程 A2A Agent 的能力为工具（如 SRE 诊断 agent）

**注册机制**：所有 Tool 通过 `ToolProvider.RegisterTool` 统一注册，LLM 调用时由 `ToolProvider.InvokeTool` 分发。

**调用流程**：
1. LLM 返回 `tool_call`（包含 toolName + arguments）
2. Agent 发布 `tool_call_start` 事件
3. `ToolProvider.InvokeTool(toolName, args)` 执行
4. 返回结果 → 发布 `tool_call_complete` / `tool_call_fail` 事件

**相关规则**：R-44（工具注册）

---

### Plan

**定义**：结构化的任务执行方案，包含多个 Step 的有序序列，由 `PlanAgent` 生成并持久化。

**结构**：
```go
type Plan struct {
    PlanID       string
    Title        string
    Steps        []Step
    Status       PlanEventStatus  // created / updated / completed / failed
    ConversationID string
}
```

**生命周期**：
1. PlanAgent 根据用户需求调用 LLM 生成 Plan → 发布 `plan_create_success` 事件
2. 逐个执行 Step → 每个 Step 开始 / 完成 / 失败发布对应事件
3. 所有 Step 完成 → 发布 `plan_completed` 事件
4. 中途失败 → 发布 `plan_update_failed` 事件

**持久化**：通过 `PromptManager.SavePlan` 保存为 JSON，支持断点续执行（R-46）。

**相关规则**：R-45（plan_* 事件顺序）

---

### Step

**定义**：Plan 中的单个执行步骤，包含描述、工具调用、预期输出。

**结构**：
```go
type Step struct {
    StepID      string
    Description string
    ToolCalls   []ToolCall
    Status      StepEventStatus  // started / completed / failed
    Output      string
}
```

**执行流程**：
1. PlanAgent 开始执行 Step → 发布 `step_start` 事件
2. 调用关联的 Tools（可能多个）→ 每个 Tool 调用发布 `tool_call_*` 事件
3. Step 完成 → 发布 `step_complete` / `step_fail` 事件

**顺序约束**：`step_complete` / `step_fail` 必有先行的 `step_start`（同一 StepID，参考 R-45）。

**相关规则**：R-45（step_* 事件顺序）

---

### Event

**定义**：后端 Domain 层通过 `chan events.AgentEvent` 向上游推送的结构化消息，前端通过 SSE 订阅并响应式渲染。

**16 种事件类型**（分四组）：

1. **消息事件**：`title` / `message` / `message_end`
2. **工具事件**：`tool_call_start` / `tool_call_complete` / `tool_call_fail`
3. **计划事件**：`plan_create_success` / `plan_update_success` / `plan_update_failed` / `plan_completed`
4. **步骤事件**：`step_start` / `step_complete` / `step_fail`
5. **系统事件**：`wait` / `error` / `done`

**权威定义**：`mooc-manus/internal/domains/models/events/constants.go`

**前后端契约**：后端新增事件类型必须同步前端 `EventType` 枚举（参考 R-20）。

**必填字段**：所有事件继承 `BaseEvent`（含 `ConversationID` / `MessageID` / `EventType` / `Timestamp`），各类型事件有额外必填字段（详见 event-protocol.md）。

**相关规则**：R-20（跨仓契约）、R-45（事件发布）

---

### Memory

**定义**：单个 conversation 的 LLM 对话历史（`[]llm.Message`），由 `ChatMemory` 管理，支持增量追加、裁剪、清理。

**实现**：`internal/domains/models/memory/memory.go` 定义 `ChatMemory` 结构体，`manager.go` 提供全局管理器。

**关键特性**：
- **conversationID 隔离**：不同对话的 Memory 完全隔离，禁止跨会话访问（R-47）
- **自动裁剪**：超过 token 上限时保留 system prompt + 最近 N 轮
- **生命周期**：conversation 结束后异步清理

**访问模式**：
```go
memory := memoryManager.GetOrCreate(conversationID)
memory.AddMessage(llm.Message{Role: "user", Content: "..."})
history := memory.GetMessages()
```

**相关规则**：R-47（Memory 边界）

---

### Prompt

**定义**：LLM 的输入模板，分为 system prompt（定义 Agent 身份与能力）和 task prompt（具体任务指令）。

**管理机制**：`PromptManager` 全局单例，从 `config/prompts/` 加载所有模板（`system.txt` / `react.txt` / `plan.txt` / `a2a.txt` / `sre.txt`）。

**动态注入能力**：支持 skill 运行时注入自定义 prompt（详见 `mooc-manus/docs/skill-system-prompt-injection-implementation.md`，参考 R-46）。

**加载时机**：应用启动时由 `PromptManager.LoadPrompts()` 一次性加载，之后通过 `GetPrompt(name)` 获取。

**相关规则**：R-46（Prompt 管理）

---

### DO (Domain Object)

**定义**：领域对象，位于 Domain 层（`internal/domains/models/`），表达核心业务逻辑与不变量，不依赖外部框架。

**典型例子**：`Agent` / `Message` / `Tool` / `ChatMemory` / `Plan`

**职责**：
- 封装业务规则（如"Tool 必须有 Name 和 Invoke 方法"）
- 提供行为方法（如 `ReActAgent.Run`）
- 不含持久化逻辑（由 Repository 层负责）

**相关规则**：R-40（DDD 分层）

---

### DTO (Data Transfer Object)

**定义**：数据传输对象，位于 Application 层（`internal/applications/dtos/`），用于 API 请求 / 响应的序列化。

**与 DO 的区别**：
- DTO 是"扁平结构"，适合 JSON 序列化
- DO 是"富对象"，包含行为方法
- DTO → DO：Application 层转换（`dto.ToXXX()`）
- DO → DTO：Application 层转换（`XXX.ToDTO()`）

**前后端契约**：DTO 字段名（camelCase）与前端 TS 类型必须一致（参考 R-20）。

**相关规则**：R-40（DTO 转换职责）

---

### PO (Persistent Object)

**定义**：持久化对象，位于 Infrastructure 层（`internal/infra/models/`），与数据库表结构一一对应（GORM 模型）。

**职责**：
- 映射数据库表（含 `gorm` tag）
- 不含业务逻辑
- 由 Repository 层转换为 DO

**转换路径**：`PO ↔ Repository ↔ DO`（Repository 负责双向转换，Application / Domain 层不可直接访问 PO，参考 R-40）。

**相关规则**：R-40（三态模型转换）

---

### Skill

**定义**：用户自定义的可执行脚本包（通常为 bash / python），通过 Docker 沙盒执行，支持版本管理与动态加载。

**组成**：
```
skill-files/
├── main.sh           # 入口脚本
├── config.json       # 元数据（名称、版本、依赖）
└── ...               # 其他文件
```

**执行流程**：
1. `loadSkill` 工具下载 SkillFiles 到挂载源
2. `executeSkill` 工具调用 `DockerSkillExecutor` 创建容器
3. 容器内注入 bash 脚本执行 `main.sh`
4. 输出写入 stdout → 返回给 Agent

**相关规则**：R-48（Skill 执行器）

---

### MCP (Model Context Protocol)

**定义**：Anthropic 提出的 LLM 工具调用标准协议，后端通过 mcp-go 客户端接入 MCP Server（如 filesystem / search / database）。

**集成方式**：
1. MCP Server 启动（独立进程）
2. mcp-go client 连接 → 动态发现 tools
3. 每个 MCP tool 封装为 `tools.Tool` 并注册到 `ToolProvider`
4. LLM 调用时通过 mcp-go 转发请求

**相关规则**：R-44（MCP 工具注册）

---

### A2A (Agent-to-Agent)

**定义**：智能体间协作协议，允许本地 Agent 调用远程 Agent 的能力（如专门的 SRE 诊断 agent）。

**两种角色**：

1. **A2A Client**：本地 Agent 封装远程 Agent 为 Tool
2. **A2A Server**：对外暴露 HTTP API，接收任务并返回结果

**实现**：
- `A2ADomainService`（`mooc-manus/internal/domains/services/flows/a2a_flow.go`）
- `A2AServerConfig`（远程 agent 的 URL / auth）

**相关规则**：R-43（A2A Agent 调用）

---

### Invoker

**定义**：LLM 调用的统一抽象接口，隔离各家 LLM SDK（OpenAI / Anthropic / Azure）的差异。

**接口定义**：
```go
type Invoker interface {
    Call(messages []Message, options CallOptions) (Message, error)
    CallWithTools(messages []Message, tools []Tool, options CallOptions) (Message, error)
    StreamCall(messages []Message, options CallOptions) (<-chan Message, error)
}
```

**实现类**：`OpenAIInvoker` / `AnthropicInvoker` / `AzureInvoker`（位于 `internal/domains/models/invoker/`）

**设计动机**：避免 Domain 层直接依赖 `go-openai` / `anthropic-sdk`，便于切换 LLM 提供商（参考 ADR-0001）。

**相关规则**：R-42（LLM 协议抽象）

---

### Message

**定义**：LLM 对话中的单条消息，包含角色（user / assistant / system）与内容（文本 / tool_call / tool_result）。

**结构**：
```go
type Message struct {
    Role       string       // "user" / "assistant" / "system"
    Content    string       // 文本内容
    ToolCalls  []ToolCall   // LLM 返回的工具调用
    ToolResult *ToolResult  // 工具执行结果
}
```

**转换路径**：各家 SDK 的 Message 类型 → `llm.Message`（统一格式）→ Invoker 调用（参考 R-42）。

**相关规则**：R-42（Message 值对象）

---

### ToolCall

**定义**：LLM 决定调用某个工具的请求，包含工具名、参数、调用 ID。

**结构**：
```go
type ToolCall struct {
    ID        string
    ToolName  string
    Arguments map[string]interface{}
}
```

**流程**：
1. LLM 返回 `Message` 含 `ToolCalls`
2. Agent 遍历 `ToolCalls` → 逐个调用 `ToolProvider.InvokeTool`
3. 结果封装为 `ToolResult` → 追加到 Memory → 继续 LLM 调用

**相关规则**：R-42（ToolCall 值对象）、R-45（tool_call_* 事件）

---

## 术语关系图

```
Agent (持有)
  ├─ Invoker (调用) → LLM Provider
  ├─ ToolProvider (注册)
  │   ├─ Skill (Docker 沙盒)
  │   ├─ MCP (mcp-go client)
  │   └─ A2A (远程 Agent)
  ├─ ChatMemory (读写) → Message[]
  └─ PromptManager (加载) → Prompt templates

Plan (包含)
  └─ Step[] (每个 Step 可包含多个 ToolCall)

Event (推送链)
  Domain Layer → chan events.AgentEvent → Application Layer → SSE Stream → Frontend EventSource

三态模型 (转换路径)
  PO (Repository 层) ↔ DO (Domain 层) ↔ DTO (Application 层)
```

## 验证方式

```bash
# 检查 Agent 实现
ls mooc-manus/internal/domains/models/agents/

# 检查事件定义
grep "EventType" mooc-manus/internal/domains/models/events/constants.go

# 检查 Invoker 实现
ls mooc-manus/internal/domains/models/invoker/

# 检查 PromptManager
ls mooc-manus/config/prompts/
```

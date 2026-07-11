```go
func (a *BaseAgent) InvokeToolCalls(toolCalls []llm.ToolCall, eventCh chan<- events.AgentEvent) []llm.Message {
    toolMessages := make([]llm.Message, 0, len(toolCalls))
    currentRoundKeys := make([]string, 0, len(toolCalls))  // 收集本轮所有工具 Key
    
    for _, toolCall := range toolCalls {
        toolCallID := toolCall.ID
        funcName := toolCall.Name
        funcArgs := toolCall.Arguments
        
        // ... 原有参数修复、工具查找逻辑 ...
        
        // 【埋点 2-1】生成工具调用 Key
        key, err := circuit_breaker.GenerateKey(funcName, funcArgs)
        if err != nil {
            logger.Warn("生成工具调用 Key 失败，跳过计数",
                zap.String("tool", funcName),
                zap.Error(err))
            key = "" // 设置为空 Key，后续跳过计数逻辑
        } else {
            currentRoundKeys = append(currentRoundKeys, key)
        }
        
        // 执行工具调用
        eventCh <- events.OnToolCallStart(toolCall, tool.ProviderName())
        result := a.InvokeTool(tool, funcName, funcArgs)
        eventCh <- events.OnToolCallComplete(toolCall, tool.ProviderName(), &result)
        
        // 【埋点 2-2】记录失败 + 更新计数器
        if !result.Success && key != "" {
            metadata := circuit_breaker.ToolCallMetadata{
                ToolName:      funcName,
                ParamsPreview: generateParamsPreview(funcName, funcArgs),
            }
            failCount := a.circuitBreaker.RecordFailure(key, metadata)
            logger.Info("工具调用失败，更新计数器",
                zap.String("tool", funcName),
                zap.String("key", key),
                zap.Int("failCount", failCount))
            eventCh <- events.OnToolCallFail(toolCall, tool.ProviderName(), &result)
        }
        
        // ... 原有 toolMessages 构建逻辑 ...
    }
    
    // 【埋点 3】本轮结束，触发清零检查
    a.circuitBreaker.StartNewRound(currentRoundKeys)
    
    return toolMessages
}

// generateParamsPreview 生成参数预览（用于干预提示展示）
func generateParamsPreview(toolName string, argsJSON string) string {
    var args map[string]interface{}
    if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
        return argsJSON[:min(len(argsJSON), 50)]
    }
    
    switch toolName {
    case "fileRead", "fileWrite", "fileEdit":
        if path, ok := args["path"].(string); ok {
            return fmt.Sprintf("path=%s", path)
        }
    case "bashExec":
        if cmd, ok := args["command"].(string); ok {
            return fmt.Sprintf("command=%s", truncate(cmd, 80))
        }
    }
    
    // 默认：返回 JSON 前 100 字符
    return truncate(argsJSON, 100)
}
```

---

### 埋点 3：计数更新 - 清零策略

**位置**：`internal/domains/services/agents/base.go` - `InvokeToolCalls` 方法末尾

**时机**：每轮工具调用批次结束后，调用 `StartNewRound` 触发清零检查

**逻辑**：
- 收集本轮所有 `toolCall` 的 Key（即使成功的也收集，用于判断"是否调用了其他工具"）
- 如果上一轮失败的某个 Key 在本轮未出现，说明智能体转而尝试其他工具，清零该 Key 的计数

**代码**：已在埋点 2 中展示（`StartNewRound` 调用）

---

### 埋点 4：阈值判断 + Prompt 注入

**位置**：`internal/domains/services/agents/base.go` - `InvokeLLM` 和 `StreamingInvokeLLM` 方法开头

**时机**：向 LLM 发起请求**之前**，检查计数器并注入干预提示

**改造点**：
```go
func (a *BaseAgent) InvokeLLM(messages []llm.Message) (llm.Message, error) {
    // 【埋点 4】检查是否有工具达到熔断阈值
    triggeredRecords := a.circuitBreaker.GetTriggeredRecords(3)
    if len(triggeredRecords) > 0 {
        // 注入干预提示（追加到 messages 最后）
        interventionMsg := buildInterventionPrompt(triggeredRecords)
        messages = append(messages, llm.Message{
            Role:    llm.RoleUser,
            Content: interventionMsg,
        })
        logger.Warn("检测到工具调用死循环，注入干预提示",
            zap.Int("triggeredCount", len(triggeredRecords)),
            zap.Any("records", triggeredRecords))
    }
    
    a.AddToMemory(messages)
    // ... 原有 LLM 调用逻辑 ...
}

// StreamingInvokeLLM 同样需要在开头增加相同的熔断检查逻辑
func (a *BaseAgent) StreamingInvokeLLM(messages []llm.Message, eventCh chan<- events.AgentEvent) llm.Message {
    // 【埋点 4】检查熔断（同 InvokeLLM）
    triggeredRecords := a.circuitBreaker.GetTriggeredRecords(3)
    if len(triggeredRecords) > 0 {
        interventionMsg := buildInterventionPrompt(triggeredRecords)
        messages = append(messages, llm.Message{
            Role:    llm.RoleUser,
            Content: interventionMsg,
        })
        logger.Warn("检测到工具调用死循环，注入干预提示",
            zap.Int("triggeredCount", len(triggeredRecords)))
    }
    
    a.AddToMemory(messages)
    // ... 原有逻辑 ...
}
```

---

### 埋点 5：会话结束销毁计数器

**位置**：无需额外处理

**理由**：
- `BaseAgent` 实例在 `BaseAgentDomainService.Chat` 方法内创建，方法结束后自动回收
- Go 的 GC 会自动回收 `circuitBreaker` 字段指向的内存
- `memory.Manager` 在 `DeleteMemory(conversationId)` 时只清理 Memory，不涉及 Agent 实例

**验证点**：确保 `BaseAgentDomainService.Chat` 中每次调用都创建新的 `BaseAgent` 实例（当前代码已满足）

---

## 四、干预 Prompt 模板设计

**位置**：`internal/domains/models/circuit_breaker/prompt_builder.go`

```go
package circuit_breaker

import (
    "fmt"
    "sort"
    "strings"
)

// buildInterventionPrompt 生成干预提示（方案 B：列举所有达标工具）
func buildInterventionPrompt(records []FailureRecord) string {
    // 按失败次数降序排列（优先展示最严重的）
    sort.Slice(records, func(i, j int) bool {
        return records[i].FailCount > records[j].FailCount
    })
    
    var builder strings.Builder
    builder.WriteString("⚠️ **系统干预提示**：以下工具调用已连续失败达到上限，禁止继续重试相同参数：\n\n")
    
    // 最多展示前 10 条
    maxDisplay := 10
    if len(records) > maxDisplay {
        builder.WriteString(fmt.Sprintf("【注意：共 %d 个工具失败，仅展示前 %d 个】\n\n", 
            len(records), maxDisplay))
        records = records[:maxDisplay]
    }
    
    for i, r := range records {
        builder.WriteString(fmt.Sprintf("%d. **%s** - 已失败 %d 次\n", 
            i+1, r.ToolName, r.FailCount))
        preview := r.ParamsPreview
        if len(preview) > 100 {
            preview = preview[:100] + "..."
        }
        builder.WriteString(fmt.Sprintf("   参数预览：`%s`\n\n", preview))
    }
    
    builder.WriteString("**请选择以下操作之一**：\n\n")
    builder.WriteString("1. **向用户反馈失败原因**，说明当前子任务无法完成，结束本轮对话\n")
    builder.WriteString("2. **重新规划任务**，基于已有信息更换工具或修改参数后继续\n")
    builder.WriteString("3. **明确告知用户需要人工介入**（如文件不存在、权限不足等环境问题）\n\n")
    builder.WriteString("❌ **严禁**：继续调用上述列出的工具+参数组合\n")
    
    return builder.String()
}
```

**示例输出**：
```
⚠️ **系统干预提示**：以下工具调用已连续失败达到上限，禁止继续重试相同参数：

1. **fileRead** - 已失败 3 次
   参数预览：`path=/nonexist.txt`

**请选择以下操作之一**：

1. **向用户反馈失败原因**，说明当前子任务无法完成，结束本轮对话
2. **重新规划任务**，基于已有信息更换工具或修改参数后继续
3. **明确告知用户需要人工介入**（如文件不存在、权限不足等环境问题）

❌ **严禁**：继续调用上述列出的工具+参数组合
```

---

# 智能体工具调用死循环干预机制 - 设计规范

**文档版本**：v1.0  
**创建日期**：2026-07-11  
**设计状态**：已评审通过  
**目标项目**：mooc-manus  
**影响范围**：`/api/agent/chat` 核心流程

---

## 文档摘要

本文档定义了**智能体工具调用熔断机制**的完整设计方案，用于解决智能体在工具调用持续失败时陷入死循环的问题。核心策略是在会话级别维护失败计数器，当同一工具+参数组合连续失败 ≥3 次时，在下一轮 LLM 请求前注入干预提示，引导智能体停止无效重试或切换策略。

**关键设计决策**：
- 采用方案一（Domain 层拦截 + 会话级 Map 存储）
- 计数器与 `ChatMemory` 生命周期绑定
- 清零策略：中间调用其他工具则历史失败计数清零（方案 B）
- 哈希策略：根据工具类型定制（方案 C）
- 干预粒度：列举所有达标工具（方案 B）

---

## 一、需求边界与不做事项

### 1.1 机制生效范围

**生效场景**：
- 仅针对 `BaseAgent`、`ReActAgent`、`PlanAgent` 三种 Agent 的工具调用流程
- 仅统计通过 `BaseAgent.InvokeToolCalls` 执行且返回 `result.Success == false` 的调用
- 仅在单个 `conversationId` 生命周期内计数（会话销毁则计数器自动清空）

**排除场景**：
- ❌ **A2A Agent**：A2A 是远程调用，工具执行在远端 Agent，本地无法感知失败细节
- ❌ **LLM 调用失败**：`InvokeLLM` 本身的网络错误或 API 异常不计入（只管工具调用）
- ❌ **参数修复失败**：`jsonrepair.JSONRepair` 失败直接返回错误消息，不进入 `InvokeTool` 流程，不计数
- ❌ **跨会话累计**：计数器不持久化，conversationId 变更后历史计数不继承

### 1.2 不做事项

- **不做自动降级**：触发熔断后不会自动切换到其他工具或修改参数，只通过 Prompt 引导 LLM 自主决策
- **不做工具黑名单**：不会永久封禁某个工具，只是在当前会话内针对特定参数组合熔断
- **不做统计持久化**：计数器数据不写入数据库，重启服务后历史失败记录清零
- **不做跨 Agent 共享**：`BaseAgent` 和 `PlanAgent` 各自独立计数（虽然共用一个 Memory，但 Counter 绑定 Agent 实例）

---

## 二、核心数据结构定义

### 2.1 计数器核心结构

**位置**：`internal/domains/models/circuit_breaker/counter.go`

```go
package circuit_breaker

import (
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
)

// ToolCallCounter 会话级工具调用失败计数器
// 生命周期：绑定单个 conversationId，与 ChatMemory 同步创建/销毁
type ToolCallCounter struct {
    // Key: 工具名+参数指纹哈希，Value: 连续失败次数
    failureCounts map[string]int
    
    // 记录上一轮执行的所有工具 Key，用于清零判定
    lastRoundKeys map[string]bool
    
    // 记录 Key 到工具元信息的映射（用于生成干预提示）
    keyMetadata map[string]ToolCallMetadata
}

// ToolCallMetadata 工具调用元信息
type ToolCallMetadata struct {
    ToolName      string
    ParamsPreview string // 参数预览（截断后的可读形式）
}

// FailureRecord 失败记录，用于生成干预提示
type FailureRecord struct {
    ToolName      string
    ParamsPreview string
    FailCount     int
}

func NewToolCallCounter() *ToolCallCounter {
    return &ToolCallCounter{
        failureCounts: make(map[string]int),
        lastRoundKeys: make(map[string]bool),
        keyMetadata:   make(map[string]ToolCallMetadata),
    }
}
```

### 2.2 哈希 Key 生成策略（方案 C：定制化）

```go
// GenerateKey 生成工具调用唯一标识 Key
// 根据工具类型采用不同的哈希策略，避免参数微调绕过熔断
func GenerateKey(toolName string, argsJSON string) (string, error) {
    var args map[string]interface{}
    if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
        return "", fmt.Errorf("解析参数失败: %w", err)
    }
    
    var hashInput string
    switch toolName {
    case "fileRead", "fileWrite":
        // 只哈希 path 参数
        if path, ok := args["path"].(string); ok {
            hashInput = fmt.Sprintf("%s:path=%s", toolName, path)
        }
    case "fileEdit":
        // 哈希 path + old_string 前100字符 + new_string 前100字符
        path, _ := args["path"].(string)
        oldStr, _ := args["old_string"].(string)
        newStr, _ := args["new_string"].(string)
        hashInput = fmt.Sprintf("%s:path=%s:old=%s:new=%s",
            toolName, path, truncate(oldStr, 100), truncate(newStr, 100))
    case "bashExec":
        // 完整 command 哈希
        if cmd, ok := args["command"].(string); ok {
            hashInput = fmt.Sprintf("%s:command=%s", toolName, cmd)
        }
    default:
        // 其他工具：完整参数哈希
        hashInput = fmt.Sprintf("%s:%s", toolName, argsJSON)
    }
    
    hash := sha256.Sum256([]byte(hashInput))
    return hex.EncodeToString(hash[:]), nil
}

func truncate(s string, maxLen int) string {
    if len(s) <= maxLen {
        return s
    }
    return s[:maxLen]
}
```

### 2.3 计数器核心方法

```go
// RecordFailure 记录单次失败，返回当前累计次数
// 同时记录工具元信息，用于后续生成干预提示
func (c *ToolCallCounter) RecordFailure(key string, metadata ToolCallMetadata) int {
    c.failureCounts[key]++
    c.keyMetadata[key] = metadata
    
    // 可选：防止单 Key 失败次数异常累积
    if c.failureCounts[key] > 1000 {
        c.failureCounts[key] = 1000
    }
    
    return c.failureCounts[key]
}

// StartNewRound 开始新一轮工具调用（清零上一轮未重复的失败记录）
// 实现方案 B：中间调用其他工具则清零历史失败计数
func (c *ToolCallCounter) StartNewRound(currentRoundKeys []string) {
    currentKeys := make(map[string]bool)
    for _, k := range currentRoundKeys {
        currentKeys[k] = true
    }
    
    // 清零策略：如果上一轮的 Key 在本轮未出现，说明中间调用了其他工具，清零该 Key
    for k := range c.failureCounts {
        if !currentKeys[k] {
            delete(c.failureCounts, k)
            delete(c.keyMetadata, k)
        }
    }
    
    c.lastRoundKeys = currentKeys
}

// GetTriggeredRecords 返回所有达到阈值的失败记录（阈值 >= 3）
func (c *ToolCallCounter) GetTriggeredRecords(threshold int) []FailureRecord {
    records := make([]FailureRecord, 0)
    for key, count := range c.failureCounts {
        if count >= threshold {
            meta := c.keyMetadata[key]
            records = append(records, FailureRecord{
                ToolName:      meta.ToolName,
                ParamsPreview: meta.ParamsPreview,
                FailCount:     count,
            })
        }
    }
    return records
}
```

---

## 三、主流程接入点位

基于 `/api/agent/chat` 调用链路，需要在以下五个位置埋点：

### 埋点 1：会话初始化 - 创建计数器

**位置**：`internal/domains/services/agents/base.go` - `NewBaseAgent` 函数

**改造点**：
```go
type BaseAgent struct {
    name             string
    systemPrompt     string
    retryInterval    int
    agentConfig      models.AgentConfig
    invoker          invoker.Invoker
    memory           *memory.ChatMemory
    tools            []tools.Tool
    circuitBreaker   *circuit_breaker.ToolCallCounter  // 【新增】熔断计数器
}

func NewBaseAgent(...) *BaseAgent {
    return &BaseAgent{
        // ... 原有字段
        circuitBreaker: circuit_breaker.NewToolCallCounter(),
    }
}
```

**理由**：`BaseAgent` 实例与单次对话会话绑定，Agent 销毁时计数器自动回收。

---

### 埋点 2：工具调用结果回执 - 记录失败

**位置**：`internal/domains/services/agents/base.go` - `InvokeToolCalls` 方法

**改造点**：在每个 `toolCall` 执行完成后，判断 `result.Success` 并更新计数器

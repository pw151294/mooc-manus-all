# 智能体工具调用死循环干预机制 - 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 BaseAgent 中实现工具调用熔断机制，当同一工具+参数组合连续失败 ≥3 次时，自动注入干预提示阻断死循环。

**Architecture:** Domain 层方案 - 在 `BaseAgent` 内部维护会话级 `ToolCallCounter`，在 `InvokeToolCalls` 中记录失败并清零，在 `InvokeLLM` 开始前检查阈值并注入干预提示。计数器生命周期与 Agent 实例绑定，自动回收。

**Tech Stack:** Go 1.21+, `crypto/sha256` (哈希), `encoding/json` (参数解析), `go.uber.org/zap` (日志), `testify/assert` (测试)

---

## 文件结构规划

### 新增文件

```
internal/domains/models/circuit_breaker/
├── counter.go           # ToolCallCounter 结构体 + 核心方法
├── key_generator.go     # GenerateKey 函数 + 定制化哈希策略
├── prompt_builder.go    # BuildInterventionPrompt 干预提示生成
└── counter_test.go      # 单元测试（13 个用例）
```

### 修改文件

```
internal/domains/services/agents/
├── base.go              # 新增 circuitBreaker 字段 + 5 处埋点改造
└── base_test.go         # 新增集成测试（可选，放在 counter_test.go 中）
```

---

## Task 1: 创建 circuit_breaker 包目录结构

**Files:**
- Create: `mooc-manus/internal/domains/models/circuit_breaker/`

- [ ] **Step 1: 创建包目录**

```bash
mkdir -p mooc-manus/internal/domains/models/circuit_breaker
```

- [ ] **Step 2: 验证目录存在**

```bash
ls -la mooc-manus/internal/domains/models/circuit_breaker
```

Expected: 空目录

- [ ] **Step 3: Commit**

```bash
git add mooc-manus/internal/domains/models/circuit_breaker
git commit -m "feat(circuit-breaker): 创建熔断器包目录结构

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: 实现 counter.go 核心数据结构

**Files:**
- Create: `mooc-manus/internal/domains/models/circuit_breaker/counter.go`

- [ ] **Step 1: 编写 ToolCallCounter 结构体定义**

```go
package circuit_breaker

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

// NewToolCallCounter 创建计数器实例
func NewToolCallCounter() *ToolCallCounter {
	return &ToolCallCounter{
		failureCounts: make(map[string]int),
		lastRoundKeys: make(map[string]bool),
		keyMetadata:   make(map[string]ToolCallMetadata),
	}
}
```

- [ ] **Step 2: 编写 RecordFailure 方法**

```go
// RecordFailure 记录单次失败，返回当前累计次数
// 同时记录工具元信息，用于后续生成干预提示
func (c *ToolCallCounter) RecordFailure(key string, metadata ToolCallMetadata) int {
	c.failureCounts[key]++
	c.keyMetadata[key] = metadata

	// 防止单 Key 失败次数异常累积
	if c.failureCounts[key] > 1000 {
		c.failureCounts[key] = 1000
	}

	return c.failureCounts[key]
}
```

- [ ] **Step 3: 编写 StartNewRound 方法**

```go
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
```

- [ ] **Step 4: 编写 GetTriggeredRecords 方法**

```go
// GetTriggeredRecords 返回所有达到阈值的失败记录（阈值 >= threshold）
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

- [ ] **Step 5: Commit**

```bash
git add mooc-manus/internal/domains/models/circuit_breaker/counter.go
git commit -m "feat(circuit-breaker): 实现 ToolCallCounter 核心数据结构

- 新增 ToolCallCounter 结构体（计数器 + 元信息 + 清零判定）
- 实现 RecordFailure（记录失败 + 上限保护）
- 实现 StartNewRound（清零未重复 Key）
- 实现 GetTriggeredRecords（提取达标记录）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: 实现 key_generator.go 哈希策略

**Files:**
- Create: `mooc-manus/internal/domains/models/circuit_breaker/key_generator.go`

- [ ] **Step 1: 编写 GenerateKey 函数（定制化哈希策略）**

```go
package circuit_breaker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

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

- [ ] **Step 2: 编写 generateParamsPreview 辅助函数**

```go
// GenerateParamsPreview 生成参数预览（用于干预提示展示）
func GenerateParamsPreview(toolName string, argsJSON string) string {
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return truncate(argsJSON, 50)
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

- [ ] **Step 3: Commit**

```bash
git add mooc-manus/internal/domains/models/circuit_breaker/key_generator.go
git commit -m "feat(circuit-breaker): 实现定制化哈希 Key 生成策略

- fileRead/fileWrite: 只哈希 path
- fileEdit: 哈希 path + old_string 前100字符 + new_string 前100字符
- bashExec: 完整 command 哈希
- 其他工具: 完整参数哈希
- 新增 GenerateParamsPreview 用于干预提示展示

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: 实现 prompt_builder.go 干预提示生成

**Files:**
- Create: `mooc-manus/internal/domains/models/circuit_breaker/prompt_builder.go`

- [ ] **Step 1: 编写 BuildInterventionPrompt 函数**

```go
package circuit_breaker

import (
	"fmt"
	"sort"
	"strings"
)

// BuildInterventionPrompt 生成干预提示（方案 B：列举所有达标工具）
// 导出为公开方法，供 base.go 调用
func BuildInterventionPrompt(records []FailureRecord) string {
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

- [ ] **Step 2: Commit**

```bash
git add mooc-manus/internal/domains/models/circuit_breaker/prompt_builder.go
git commit -m "feat(circuit-breaker): 实现干预提示生成函数

- BuildInterventionPrompt 列举所有达标工具（按失败次数降序）
- 最多展示前 10 条记录 + 截断提示
- 参数预览截断到 100 字符
- 提供三种操作引导（反馈失败/重新规划/人工介入）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: 编写 counter_test.go 单元测试（Part 1: GenerateKey）

**Files:**
- Create: `mooc-manus/internal/domains/models/circuit_breaker/counter_test.go`

- [ ] **Step 1: 编写测试文件头部 + fileRead 哈希测试**

```go
package circuit_breaker

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// UT-01: fileRead 工具 - 只哈希 path
func TestGenerateKey_FileRead(t *testing.T) {
	key1, err := GenerateKey("fileRead", `{"path": "/tmp/test.txt"}`)
	assert.NoError(t, err)

	key2, err := GenerateKey("fileRead", `{"path": "/tmp/test.txt"}`)
	assert.NoError(t, err)
	assert.Equal(t, key1, key2, "相同 path 应生成相同 Key")

	key3, err := GenerateKey("fileRead", `{"path": "/tmp/other.txt"}`)
	assert.NoError(t, err)
	assert.NotEqual(t, key1, key3, "不同 path 应生成不同 Key")
}
```

- [ ] **Step 2: 运行测试验证通过**

```bash
cd mooc-manus && go test ./internal/domains/models/circuit_breaker -v -run TestGenerateKey_FileRead
```

Expected: PASS

- [ ] **Step 3: 编写 fileEdit 哈希测试（UT-02）**

```go
// UT-02: fileEdit 工具 - 截断 old_string/new_string
func TestGenerateKey_FileEdit(t *testing.T) {
	// 前 100 字符相同
	oldStr1 := strings.Repeat("a", 100) + "different"
	oldStr2 := strings.Repeat("a", 100) + "other"

	key1, err := GenerateKey("fileEdit", fmt.Sprintf(`{"path":"/test.txt","old_string":"%s","new_string":"new"}`, oldStr1))
	assert.NoError(t, err)

	key2, err := GenerateKey("fileEdit", fmt.Sprintf(`{"path":"/test.txt","old_string":"%s","new_string":"new"}`, oldStr2))
	assert.NoError(t, err)

	assert.Equal(t, key1, key2, "old_string 前 100 字符相同应生成相同 Key")

	// path 不同
	key3, err := GenerateKey("fileEdit", fmt.Sprintf(`{"path":"/other.txt","old_string":"%s","new_string":"new"}`, oldStr1))
	assert.NoError(t, err)
	assert.NotEqual(t, key1, key3, "path 不同应生成不同 Key")
}
```

- [ ] **Step 4: 编写 bashExec 和 default 测试（UT-03/UT-04）**

```go
// UT-03: bashExec 工具 - 完整 command 哈希
func TestGenerateKey_BashExec(t *testing.T) {
	key1, err := GenerateKey("bashExec", `{"command": "ls -la"}`)
	assert.NoError(t, err)

	key2, err := GenerateKey("bashExec", `{"command": "ls -la"}`)
	assert.NoError(t, err)
	assert.Equal(t, key1, key2)

	key3, err := GenerateKey("bashExec", `{"command": "ls -la "}`)
	assert.NoError(t, err)
	assert.NotEqual(t, key1, key3, "command 多一个空格应生成不同 Key")
}

// UT-04: 未知工具 - 完整参数哈希
func TestGenerateKey_UnknownTool(t *testing.T) {
	key1, err := GenerateKey("customTool", `{"param1":"value1","param2":"value2"}`)
	assert.NoError(t, err)

	key2, err := GenerateKey("customTool", `{"param1":"value1","param2":"value2"}`)
	assert.NoError(t, err)
	assert.Equal(t, key1, key2)

	key3, err := GenerateKey("customTool", `{"param1":"value1","param2":"different"}`)
	assert.NoError(t, err)
	assert.NotEqual(t, key1, key3, "参数任何字段变化应生成不同 Key")
}
```

- [ ] **Step 5: 编写非法 JSON 测试（UT-05）**

```go
// UT-05: 参数 JSON 非法
func TestGenerateKey_InvalidJSON(t *testing.T) {
	_, err := GenerateKey("fileRead", `{invalid json}`)
	assert.Error(t, err, "非法 JSON 应返回 error")
	assert.Contains(t, err.Error(), "解析参数失败")
}
```

- [ ] **Step 6: 运行所有 GenerateKey 测试**

```bash
cd mooc-manus && go test ./internal/domains/models/circuit_breaker -v -run TestGenerateKey
```

Expected: 5 个测试全部 PASS

- [ ] **Step 7: Commit**

```bash
git add mooc-manus/internal/domains/models/circuit_breaker/counter_test.go
git commit -m "test(circuit-breaker): 新增 GenerateKey 单元测试

- UT-01: fileRead 只哈希 path
- UT-02: fileEdit 截断 old_string/new_string
- UT-03: bashExec 完整 command 哈希
- UT-04: 未知工具完整参数哈希
- UT-05: 非法 JSON 返回 error

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: 编写 counter_test.go 单元测试（Part 2: Counter 方法）

**Files:**
- Modify: `mooc-manus/internal/domains/models/circuit_breaker/counter_test.go`

- [ ] **Step 1: 编写 RecordFailure 测试（UT-06/UT-07）**

```go
// UT-06: 正常计数累加
func TestRecordFailure_NormalIncrement(t *testing.T) {
	counter := NewToolCallCounter()
	metadata := ToolCallMetadata{ToolName: "fileRead", ParamsPreview: "path=/test.txt"}

	count1 := counter.RecordFailure("keyA", metadata)
	assert.Equal(t, 1, count1)

	count2 := counter.RecordFailure("keyA", metadata)
	assert.Equal(t, 2, count2)

	count3 := counter.RecordFailure("keyA", metadata)
	assert.Equal(t, 3, count3)
}

// UT-07: 不同 Key 独立计数
func TestRecordFailure_IndependentKeys(t *testing.T) {
	counter := NewToolCallCounter()
	metaA := ToolCallMetadata{ToolName: "fileRead", ParamsPreview: "path=/a.txt"}
	metaB := ToolCallMetadata{ToolName: "fileRead", ParamsPreview: "path=/b.txt"}

	counter.RecordFailure("keyA", metaA)
	counter.RecordFailure("keyA", metaA)
	counter.RecordFailure("keyA", metaA)

	countB := counter.RecordFailure("keyB", metaB)
	assert.Equal(t, 1, countB, "keyB 应独立计数")

	assert.Equal(t, 3, counter.failureCounts["keyA"])
	assert.Equal(t, 1, counter.failureCounts["keyB"])
}
```

- [ ] **Step 2: 编写 StartNewRound 测试（UT-08/UT-09）**

```go
// UT-08: 清零逻辑 - 本轮未出现的 Key
func TestStartNewRound_ClearUnusedKeys(t *testing.T) {
	counter := NewToolCallCounter()
	metadata := ToolCallMetadata{ToolName: "fileRead", ParamsPreview: "path=/test.txt"}

	counter.RecordFailure("keyA", metadata)
	counter.RecordFailure("keyA", metadata)
	counter.RecordFailure("keyA", metadata)

	// 本轮只调用 keyB，keyA 应被清零
	counter.StartNewRound([]string{"keyB"})

	records := counter.GetTriggeredRecords(3)
	assert.Empty(t, records, "keyA 应被清零，不在触发记录中")
	assert.Equal(t, 0, counter.failureCounts["keyA"], "keyA 计数应为 0")
}

// UT-09: 保留逻辑 - 本轮再次出现的 Key
func TestStartNewRound_KeepRepeatedKeys(t *testing.T) {
	counter := NewToolCallCounter()
	metadata := ToolCallMetadata{ToolName: "fileRead", ParamsPreview: "path=/test.txt"}

	counter.RecordFailure("keyA", metadata)
	counter.RecordFailure("keyA", metadata)
	counter.RecordFailure("keyA", metadata)

	// 本轮继续调用 keyA，不应清零
	counter.StartNewRound([]string{"keyA"})

	assert.Equal(t, 3, counter.failureCounts["keyA"], "keyA 计数应保持 3")
}
```

- [ ] **Step 3: 编写 GetTriggeredRecords 测试（UT-10/UT-11）**

```go
// UT-10: 阈值临界值
func TestGetTriggeredRecords_Threshold(t *testing.T) {
	counter := NewToolCallCounter()
	metadata := ToolCallMetadata{ToolName: "fileRead", ParamsPreview: "path=/test.txt"}

	counter.RecordFailure("key2", metadata)
	counter.RecordFailure("key2", metadata)

	counter.RecordFailure("key3", metadata)
	counter.RecordFailure("key3", metadata)
	counter.RecordFailure("key3", metadata)

	counter.RecordFailure("key4", metadata)
	counter.RecordFailure("key4", metadata)
	counter.RecordFailure("key4", metadata)
	counter.RecordFailure("key4", metadata)

	records := counter.GetTriggeredRecords(3)
	assert.Len(t, records, 2, "失败 2 次不返回，3 次和 4 次返回")
}

// UT-11: 多个 Key 达标
func TestGetTriggeredRecords_MultipleKeys(t *testing.T) {
	counter := NewToolCallCounter()
	metaA := ToolCallMetadata{ToolName: "fileRead", ParamsPreview: "path=/a.txt"}
	metaB := ToolCallMetadata{ToolName: "bashExec", ParamsPreview: "command=ls"}

	// keyA 失败 3 次
	counter.RecordFailure("keyA", metaA)
	counter.RecordFailure("keyA", metaA)
	counter.RecordFailure("keyA", metaA)

	// keyB 失败 4 次
	counter.RecordFailure("keyB", metaB)
	counter.RecordFailure("keyB", metaB)
	counter.RecordFailure("keyB", metaB)
	counter.RecordFailure("keyB", metaB)

	// keyC 失败 2 次
	counter.RecordFailure("keyC", metaA)
	counter.RecordFailure("keyC", metaA)

	records := counter.GetTriggeredRecords(3)
	assert.Len(t, records, 2, "应返回 keyA 和 keyB")

	// 验证记录内容
	toolNames := []string{records[0].ToolName, records[1].ToolName}
	assert.Contains(t, toolNames, "fileRead")
	assert.Contains(t, toolNames, "bashExec")
}
```

- [ ] **Step 4: 运行所有 Counter 方法测试**

```bash
cd mooc-manus && go test ./internal/domains/models/circuit_breaker -v -run "TestRecordFailure|TestStartNewRound|TestGetTriggeredRecords"
```

Expected: 6 个测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add mooc-manus/internal/domains/models/circuit_breaker/counter_test.go
git commit -m "test(circuit-breaker): 新增 Counter 方法单元测试

- UT-06: RecordFailure 正常计数累加
- UT-07: 不同 Key 独立计数
- UT-08: StartNewRound 清零未重复 Key
- UT-09: StartNewRound 保留重复 Key
- UT-10: GetTriggeredRecords 阈值临界值
- UT-11: 多个 Key 达标场景

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: 编写 counter_test.go 单元测试（Part 3: Prompt 生成）

**Files:**
- Modify: `mooc-manus/internal/domains/models/circuit_breaker/counter_test.go`

- [ ] **Step 1: 编写 BuildInterventionPrompt 测试（UT-12）**

```go
// UT-12: 单条失败记录
func TestBuildInterventionPrompt_SingleRecord(t *testing.T) {
	records := []FailureRecord{
		{ToolName: "fileRead", ParamsPreview: "path=/test.txt", FailCount: 3},
	}

	prompt := BuildInterventionPrompt(records)

	assert.Contains(t, prompt, "系统干预提示")
	assert.Contains(t, prompt, "fileRead")
	assert.Contains(t, prompt, "已失败 3 次")
	assert.Contains(t, prompt, "path=/test.txt")
	assert.Contains(t, prompt, "向用户反馈失败原因")
	assert.Contains(t, prompt, "严禁")
}
```

- [ ] **Step 2: 编写多条记录 + 截断测试（UT-13）**

```go
// UT-13: 10+ 条失败记录 - 截断测试
func TestBuildInterventionPrompt_TruncateTo10(t *testing.T) {
	records := make([]FailureRecord, 15)
	for i := 0; i < 15; i++ {
		records[i] = FailureRecord{
			ToolName:      fmt.Sprintf("tool%d", i),
			ParamsPreview: fmt.Sprintf("param%d", i),
			FailCount:     i + 1,
		}
	}

	prompt := BuildInterventionPrompt(records)

	assert.Contains(t, prompt, "共 15 个工具失败")
	assert.Contains(t, prompt, "仅展示前 10 个")

	// 验证只包含前 10 个（按失败次数降序）
	assert.Contains(t, prompt, "tool14") // 失败 15 次，排第一
	assert.Contains(t, prompt, "tool13") // 失败 14 次，排第二
	assert.NotContains(t, prompt, "tool0") // 失败 1 次，不在前 10
}
```

- [ ] **Step 3: 运行 Prompt 生成测试**

```bash
cd mooc-manus && go test ./internal/domains/models/circuit_breaker -v -run TestBuildInterventionPrompt
```

Expected: 2 个测试全部 PASS

- [ ] **Step 4: 运行所有单元测试验证覆盖率**

```bash
cd mooc-manus && go test ./internal/domains/models/circuit_breaker -cover
```

Expected: 覆盖率 ≥ 90%

- [ ] **Step 5: Commit**

```bash
git add mooc-manus/internal/domains/models/circuit_breaker/counter_test.go
git commit -m "test(circuit-breaker): 新增 Prompt 生成单元测试

- UT-12: 单条失败记录包含完整信息
- UT-13: 10+ 条记录截断到前 10 个
- 单元测试覆盖率达到 90%+

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---


## Task 8: BaseAgent 集成 - 新增 circuitBreaker 字段（埋点 1）

**Files:**
- Modify: `mooc-manus/internal/domains/services/agents/base.go:22-30`

- [ ] **Step 1: 在 BaseAgent 结构体添加 circuitBreaker 字段**

找到 `type BaseAgent struct` 定义（约第 22 行），在 `tools` 字段后新增：

```go
type BaseAgent struct {
	name          string
	systemPrompt  string
	retryInterval int
	agentConfig   models.AgentConfig
	invoker       invoker.Invoker
	memory        *memory.ChatMemory
	tools         []tools.Tool
	circuitBreaker *circuit_breaker.ToolCallCounter // 【埋点 1】熔断计数器
}
```

- [ ] **Step 2: 修改 NewBaseAgent 初始化计数器**

找到 `NewBaseAgent` 函数（约第 32 行），在 return 语句中新增：

```go
func NewBaseAgent(agentConfig models.AgentConfig, inv invoker.Invoker, mem *memory.ChatMemory, ts []tools.Tool, systemPrompt string) *BaseAgent {
	return &BaseAgent{
		agentConfig:    agentConfig,
		invoker:        inv,
		memory:         mem,
		tools:          ts,
		systemPrompt:   systemPrompt,
		retryInterval:  5,
		circuitBreaker: circuit_breaker.NewToolCallCounter(), // 【埋点 1】初始化
	}
}
```

- [ ] **Step 3: 添加 import**

在文件顶部 import 块中新增：

```go
import (
	// ... 原有 imports
	"mooc-manus/internal/domains/models/circuit_breaker"
)
```

- [ ] **Step 4: 编译验证**

```bash
cd mooc-manus && go build ./internal/domains/services/agents
```

Expected: 编译成功，无错误

- [ ] **Step 5: Commit**

```bash
git add mooc-manus/internal/domains/services/agents/base.go
git commit -m "feat(circuit-breaker): BaseAgent 新增 circuitBreaker 字段

【埋点 1】会话初始化 - 创建计数器
- BaseAgent 结构体新增 circuitBreaker 字段
- NewBaseAgent 初始化计数器实例
- 计数器生命周期与 Agent 实例绑定

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: BaseAgent 集成 - InvokeToolCalls 记录失败（埋点 2）

**Files:**
- Modify: `mooc-manus/internal/domains/services/agents/base.go:71-135`

- [ ] **Step 1: 在 InvokeToolCalls 开头初始化 currentRoundKeys**

找到 `func (a *BaseAgent) InvokeToolCalls` 函数（约第 72 行），在 `toolMessages` 初始化后新增：

```go
func (a *BaseAgent) InvokeToolCalls(toolCalls []llm.ToolCall, eventCh chan<- events.AgentEvent) []llm.Message {
	toolMessages := make([]llm.Message, 0, len(toolCalls))
	currentRoundKeys := make([]string, 0, len(toolCalls)) // 【埋点 2】收集本轮所有工具 Key
	
	for _, toolCall := range toolCalls {
		// ...
	}
}
```

- [ ] **Step 2: 在工具执行前生成 Key**

在 for 循环内，找到 `tool := a.GetTool(funcName)` 之前，插入 Key 生成逻辑：

```go
for _, toolCall := range toolCalls {
	toolCallID := toolCall.ID
	funcName := toolCall.Name
	funcArgs := toolCall.Arguments
	
	// 使用jsonrepair修复funcArgs
	repairedArgs, err := jsonrepair.JSONRepair(funcArgs)
	if err != nil {
		logger.Error("repair tool call args failed", zap.Error(err), zap.String("function args", funcArgs))
		errMsg := fmt.Sprintf("工具调用参数不符合规范，修复失败：%v", err)
		toolMessages = append(toolMessages, llm.Message{
			Role:       llm.RoleTool,
			Content:    errMsg,
			ToolCallID: toolCallID,
		})
		result := models.ToolCallResult{
			Success: false,
			Message: errMsg,
		}
		eventCh <- events.OnToolCallFail(toolCall, "", &result)
		continue
	}
	funcArgs = repairedArgs
	
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
	
	// 查询Agent中对应的工具
	tool := a.GetTool(funcName)
	// ...
}
```

- [ ] **Step 3: 在工具调用失败后记录计数**

在 `eventCh <- events.OnToolCallComplete` 之后，修改失败处理逻辑：

```go
	// 开始工具调用
	eventCh <- events.OnToolCallStart(toolCall, tool.ProviderName())
	result := a.InvokeTool(tool, funcName, funcArgs)
	eventCh <- events.OnToolCallComplete(toolCall, tool.ProviderName(), &result)
	
	// 【埋点 2-2】记录失败 + 更新计数器
	if !result.Success && key != "" {
		metadata := circuit_breaker.ToolCallMetadata{
			ToolName:      funcName,
			ParamsPreview: circuit_breaker.GenerateParamsPreview(funcName, funcArgs),
		}
		failCount := a.circuitBreaker.RecordFailure(key, metadata)
		logger.Info("工具调用失败，更新计数器",
			zap.String("tool", funcName),
			zap.String("key", key),
			zap.Int("failCount", failCount))
	}
	
	if !result.Success {
		eventCh <- events.OnToolCallFail(toolCall, tool.ProviderName(), &result)
		toolMessages = append(toolMessages, llm.Message{
			Role:       llm.RoleTool,
			Content:    "工具调用失败：" + result.Message,
			ToolCallID: toolCallID,
		})
	} else {
		toolMessages = append(toolMessages, llm.Message{
			Role:       llm.RoleTool,
			Content:    models.ConvertToolCallResult2Text(result),
			ToolCallID: toolCallID,
		})
	}
```

- [ ] **Step 4: 在函数末尾触发清零检查（埋点 3）**

在 `return toolMessages` 之前新增：

```go
	// 【埋点 3】本轮结束，触发清零检查
	a.circuitBreaker.StartNewRound(currentRoundKeys)
	
	return toolMessages
}
```

- [ ] **Step 5: 编译验证**

```bash
cd mooc-manus && go build ./internal/domains/services/agents
```

Expected: 编译成功

- [ ] **Step 6: Commit**

```bash
git add mooc-manus/internal/domains/services/agents/base.go
git commit -m "feat(circuit-breaker): InvokeToolCalls 记录失败 + 清零策略

【埋点 2】工具调用结果回执 - 记录失败
- 生成工具调用 Key（GenerateKey）
- 失败时记录计数器（RecordFailure）
- 记录工具元信息用于干预提示

【埋点 3】计数更新 - 清零策略
- 收集本轮所有工具 Key
- 调用 StartNewRound 触发清零检查

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---


## Task 10: BaseAgent 集成 - InvokeLLM 注入干预提示（埋点 4）

**Files:**
- Modify: `mooc-manus/internal/domains/services/agents/base.go:190-227`

- [ ] **Step 1: 在 InvokeLLM 开头检查熔断并注入提示**

找到 `func (a *BaseAgent) InvokeLLM` 函数（约第 190 行），在 `a.AddToMemory(messages)` 之前插入：

```go
func (a *BaseAgent) InvokeLLM(messages []llm.Message) (llm.Message, error) {
	// 【埋点 4】检查是否有工具达到熔断阈值
	triggeredRecords := a.circuitBreaker.GetTriggeredRecords(3)
	if len(triggeredRecords) > 0 {
		// 注入干预提示（追加到 messages 最后）
		interventionMsg := circuit_breaker.BuildInterventionPrompt(triggeredRecords)
		messages = append(messages, llm.Message{
			Role:    llm.RoleUser,
			Content: interventionMsg,
		})
		logger.Warn("检测到工具调用死循环，注入干预提示",
			zap.Int("triggeredCount", len(triggeredRecords)),
			zap.Any("records", triggeredRecords))
	}
	
	a.AddToMemory(messages)
	// ... 原有逻辑
}
```

- [ ] **Step 2: 同样修改 StreamingInvokeLLM**

找到 `func (a *BaseAgent) StreamingInvokeLLM` 函数（约第 152 行），在 `a.AddToMemory(messages)` 之前插入相同逻辑：

```go
func (a *BaseAgent) StreamingInvokeLLM(messages []llm.Message, eventCh chan<- events.AgentEvent) llm.Message {
	// 【埋点 4】检查熔断（同 InvokeLLM）
	triggeredRecords := a.circuitBreaker.GetTriggeredRecords(3)
	if len(triggeredRecords) > 0 {
		interventionMsg := circuit_breaker.BuildInterventionPrompt(triggeredRecords)
		messages = append(messages, llm.Message{
			Role:    llm.RoleUser,
			Content: interventionMsg,
		})
		logger.Warn("检测到工具调用死循环，注入干预提示（流式）",
			zap.Int("triggeredCount", len(triggeredRecords)))
	}
	
	a.AddToMemory(messages)
	// ... 原有逻辑
}
```

- [ ] **Step 3: 编译验证**

```bash
cd mooc-manus && go build ./internal/domains/services/agents
```

Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add mooc-manus/internal/domains/services/agents/base.go
git commit -m "feat(circuit-breaker): InvokeLLM 注入干预提示

【埋点 4】阈值判断 + Prompt 注入
- 在 LLM 请求前检查 GetTriggeredRecords(3)
- 达标时注入干预提示到 messages 尾部
- 日志记录触发熔断的工具列表
- InvokeLLM 和 StreamingInvokeLLM 均实现

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: 验证 ReActAgent/PlanAgent 自动继承

**Files:**
- Read: `mooc-manus/internal/domains/services/agents/react.go`
- Read: `mooc-manus/internal/domains/services/agents/plan.go`

- [ ] **Step 1: 检查 ReActAgent 调用路径**

```bash
cd mooc-manus && grep -n "InvokeToolCalls\|InvokeLLM" internal/domains/services/agents/react.go
```

Expected: 所有工具调用和 LLM 调用都通过 `BaseAgent` 的方法

- [ ] **Step 2: 检查 PlanAgent 调用路径**

```bash
cd mooc-manus && grep -n "InvokeToolCalls\|InvokeLLM" internal/domains/services/agents/plan.go
```

Expected: 所有调用都通过 `BaseAgent`

- [ ] **Step 3: 如果发现绕过路径，记录为待修复项**

如果发现直接调用 `invoker.Invoke` 或绕过 `BaseAgent` 的路径，在计划末尾新增任务修复。

否则无需改动，ReActAgent/PlanAgent 自动继承熔断能力。

- [ ] **Step 4: Commit 验证记录**

```bash
git commit --allow-empty -m "docs(circuit-breaker): 验证 ReActAgent/PlanAgent 调用路径

【埋点 5 验证】计数器生命周期确认
- ReActAgent 工具调用路径经过 BaseAgent.InvokeToolCalls
- PlanAgent 工具调用路径经过 BaseAgent.InvokeToolCalls
- 无需额外代码改动，自动继承熔断能力

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: 端到端手动验证（构造失败场景）

**Files:**
- None (manual testing)

- [ ] **Step 1: 启动 mooc-manus 后端**

```bash
cd mooc-manus && go run main.go
```

Expected: 服务启动在 8080 端口

- [ ] **Step 2: 通过前端或 curl 发起对话，构造 fileRead 失败场景**

```bash
curl -X POST http://localhost:8080/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{
    "query": "读取文件 /nonexistent-file-for-circuit-breaker-test.txt",
    "conversationId": "test-circuit-breaker-001"
  }'
```

- [ ] **Step 3: 观察日志输出**

预期日志：
```
[INFO] 工具调用失败，更新计数器 tool=fileRead key=<hash> failCount=1
[INFO] 工具调用失败，更新计数器 tool=fileRead key=<hash> failCount=2
[INFO] 工具调用失败，更新计数器 tool=fileRead key=<hash> failCount=3
[WARN] 检测到工具调用死循环，注入干预提示 triggeredCount=1
```

- [ ] **Step 4: 观察 SSE 响应中的干预提示**

预期响应包含：
```
⚠️ **系统干预提示**：以下工具调用已连续失败达到上限...
1. **fileRead** - 已失败 3 次
   参数预览：`path=/nonexistent-file-for-circuit-breaker-test.txt`
```

- [ ] **Step 5: 验证后续无重复调用**

观察日志，确认第 4 轮及之后没有相同的 `fileRead(/nonexistent-file...)` 调用。

- [ ] **Step 6: 记录验证结果**

在计划文档或 CHANGELOG 中记录手动验证通过。

---

## Task 13: 编写功能文档

**Files:**
- Create: `mooc-manus/docs/features/tool-call-circuit-breaker.md`

- [ ] **Step 1: 编写功能文档**

```markdown
# 智能体工具调用熔断机制

## 功能概述

当智能体在工具调用持续失败时，会陷入死循环重复调用相同工具+参数。本机制在会话级别维护失败计数器，当同一工具+参数组合连续失败 ≥3 次时，自动注入干预提示阻断循环。

## 工作原理

1. **会话级计数器**：每个 `BaseAgent` 实例内部维护 `ToolCallCounter`
2. **定制化哈希**：根据工具类型生成唯一 Key（fileRead 只哈希 path，fileEdit 截断字符串）
3. **失败记录**：`InvokeToolCalls` 中每次工具失败后更新计数器
4. **清零策略**：中间调用其他工具则历史失败计数清零（避免误判）
5. **干预注入**：`InvokeLLM` 开始前检查阈值，达标时注入用户消息引导 LLM 停止重试

## 五个埋点位置

- **埋点 1**：`NewBaseAgent` - 初始化计数器
- **埋点 2**：`InvokeToolCalls` - 记录失败
- **埋点 3**：`InvokeToolCalls` 末尾 - 触发清零
- **埋点 4**：`InvokeLLM` / `StreamingInvokeLLM` 开头 - 检查阈值并注入提示
- **埋点 5**：自动回收（Agent 实例销毁时计数器自动释放）

## 配置参数

- **熔断阈值**：3 次（硬编码，未来可配置化）
- **哈希策略**：见 `internal/domains/models/circuit_breaker/key_generator.go`

## 日志关键字

- `"工具调用失败，更新计数器"` - 记录失败
- `"检测到工具调用死循环，注入干预提示"` - 触发熔断

## 相关文件

- `internal/domains/models/circuit_breaker/` - 核心包
- `internal/domains/services/agents/base.go` - 集成点
- 设计规范：`docs/superpowers/specs/2026-07-11-tool-call-circuit-breaker-design.md`
```

- [ ] **Step 2: Commit**

```bash
git add mooc-manus/docs/features/tool-call-circuit-breaker.md
git commit -m "docs(circuit-breaker): 新增功能文档

- 功能概述与工作原理
- 五个埋点位置说明
- 配置参数与日志关键字
- 相关文件索引

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: 更新 CHANGELOG

**Files:**
- Modify: `mooc-manus/CHANGELOG.md`

- [ ] **Step 1: 在 CHANGELOG 顶部新增版本条目**

```markdown
## [Unreleased]

### Added
- **智能体工具调用熔断机制**：当同一工具+参数组合连续失败 ≥3 次时，自动注入干预提示阻断死循环
  - 新增 `circuit_breaker` 包（计数器 + 哈希策略 + 干预提示生成）
  - BaseAgent 集成熔断逻辑（5 处埋点）
  - ReActAgent/PlanAgent 自动继承熔断能力
  - 单元测试覆盖率 90%+
  - 相关设计文档：`docs/superpowers/specs/2026-07-11-tool-call-circuit-breaker-design.md`
```

- [ ] **Step 2: Commit**

```bash
git add mooc-manus/CHANGELOG.md
git commit -m "chore(changelog): 记录工具调用熔断机制上线

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 实现计划完成

**总任务数**：14 个主任务，67 个子步骤

**预计耗时**：2-3 小时（包含测试与验证）

**验收标准**：
- ✅ 单元测试覆盖率 ≥ 90%
- ✅ 手动验证熔断机制生效
- ✅ ReActAgent/PlanAgent 自动继承
- ✅ 日志中能观测到计数器更新与干预注入
- ✅ 代码通过 golangci-lint 检查

---

## 执行建议

**推荐方式**：superpowers:subagent-driven-development
- 每个任务派发一个新子代理
- 任务间进行两阶段审查（编译检查 + 逻辑审查）
- 快速迭代，失败时立即修复

**备选方式**：superpowers:executing-plans
- 在当前会话中批量执行
- 适合对代码库非常熟悉的场景


## 五、分层开发子任务拆解

将整个功能按模块拆解为 6 个独立子任务，按依赖顺序排列：

### 子任务 1：熔断计数器核心模块

**模块位置**：`internal/domains/models/circuit_breaker/`

**产出文件**：
- `counter.go` - `ToolCallCounter` 结构体 + 核心方法
- `key_generator.go` - `GenerateKey` 函数 + 定制化哈希策略
- `prompt_builder.go` - `buildInterventionPrompt` 干预提示生成
- `counter_test.go` - 单元测试

**职责**：
- 实现计数器 CRUD 操作
- 实现工具名+参数到哈希 Key 的映射（方案 C 定制策略）
- 实现清零逻辑（`StartNewRound`）
- 实现阈值判定与失败记录提取

**依赖**：无（纯值对象，无外部依赖）

**验收标准**：
- 单元测试覆盖率 ≥ 90%
- 支持所有定制哈希场景（fileRead/fileEdit/bashExec/default）
- 清零逻辑通过测试验证

---

### 子任务 2：BaseAgent 集成计数器

**模块位置**：`internal/domains/services/agents/base.go`

**改造点**：
1. `BaseAgent` 结构体新增 `circuitBreaker` 字段
2. `NewBaseAgent` 初始化计数器
3. `InvokeToolCalls` 埋点记录失败 + 触发清零
4. `InvokeLLM` / `StreamingInvokeLLM` 埋点判断阈值 + 注入提示

**依赖**：子任务 1（需要 `circuit_breaker` 包）

**验收标准**：
- 编译通过，无破坏现有功能
- 日志中能观测到计数器更新记录
- 手动触发失败 3 次后，下一轮 LLM 请求中包含干预提示

---

### 子任务 3：ReActAgent 和 PlanAgent 集成

**模块位置**：
- `internal/domains/services/agents/react.go`
- `internal/domains/services/agents/plan.go`

**改造点**：
- `ReActAgent` 和 `PlanAgent` 内嵌 `BaseAgent`，自动继承熔断能力
- 验证 `react.go` 和 `plan.go` 中调用 `InvokeLLM` / `InvokeToolCalls` 的路径是否正确传递计数器

**依赖**：子任务 2

**验收标准**：
- ReAct 和 Plan 模式下熔断机制生效
- 日志中正确记录对应 Agent 类型的熔断事件

---

### 子任务 4：日志与可观测性增强

**模块位置**：`internal/domains/services/agents/base.go`

**改造点**：
- 在 `RecordFailure` 时新增结构化日志（`zap.String("key", key)`, `zap.Int("failCount", count)`）
- 在 `GetTriggeredRecords` 触发时记录告警级别日志
- 在干预提示注入时记录完整的 `triggeredRecords` 内容

**依赖**：子任务 2

**验收标准**：
- 通过日志可追踪单次会话的完整熔断过程
- 日志字段完整，便于后续接入监控告警

---

### 子任务 5：异常分支处理

**覆盖场景**：
1. **哈希计算异常**：JSON 解析失败 → 降级为不计数，工具调用正常执行
2. **计数器溢出**：单个 Key 失败次数超过 1000 → 设置上限防止异常
3. **并发会话隔离**：每个 `BaseAgent` 实例独立持有计数器 → 天然隔离，无需额外处理
4. **多工具批量失败**：单轮 10 个工具全失败 → `GetTriggeredRecords` 返回所有达标记录，干预提示列举全部

**改造点**：
- `GenerateKey` 增加错误处理，返回空 Key 时降级跳过计数
- `RecordFailure` 增加上限检查（单 Key 最大失败次数 1000）
- 完善干预提示模板，支持一次性展示 10+ 条失败记录（截断前 10 条）

**依赖**：子任务 2

**验收标准**：
- 异常场景不影响工具调用正常执行
- 日志中有明确的降级/异常告警记录

---

### 子任务 6：文档与代码注释

**产出物**：
- `docs/features/tool-call-circuit-breaker.md` - 功能设计文档
- 代码注释：每个埋点位置增加 `// 【熔断机制埋点X】` 标记
- CHANGELOG：记录本次功能新增

**依赖**：子任务 1-5 全部完成

**验收标准**：
- 文档包含架构图、数据流图、配置说明
- 代码注释清晰标注五个埋点位置

---

## 六、异常分支处理细化

### 6.1 哈希计算异常

**场景**：
- `GenerateKey` 中 `json.Unmarshal` 失败（参数不是合法 JSON）
- 参数中缺少必需字段（如 `fileRead` 无 `path` 参数）

**处理策略**：
```go
func (a *BaseAgent) InvokeToolCalls(...) {
    key, err := circuit_breaker.GenerateKey(funcName, funcArgs)
    if err != nil {
        logger.Warn("生成工具调用 Key 失败，跳过计数",
            zap.String("tool", funcName),
            zap.Error(err))
        key = "" // 设置为空 Key，后续跳过计数逻辑
    }
    
    // ...工具执行...
    
    if !result.Success && key != "" {  // key 为空时不计数
        a.circuitBreaker.RecordFailure(key, metadata)
    }
}
```

**不做事项**：
- ❌ 不阻断工具执行（哈希失败不影响工具调用）
- ❌ 不抛出错误事件（只记录 Warn 日志）

---

### 6.2 计数器数值边界

**场景**：
- 单个 Key 失败次数累积到极大值（理论上 int 可达 2^31-1）
- 单个会话中 `failureCounts` map 包含数千条 Key（极端场景）

**处理策略**：
```go
func (c *ToolCallCounter) RecordFailure(key string, metadata ToolCallMetadata) int {
    c.failureCounts[key]++
    
    // 设置单 Key 失败次数上限（防止异常场景）
    if c.failureCounts[key] > 1000 {
        c.failureCounts[key] = 1000
    }
    
    return c.failureCounts[key]
}
```

**内存保护**：
- Map 大小上限：如果 `len(failureCounts) > 1000`，清理最早插入的 50% 条目（FIFO）
- 实际场景中单次会话不太可能触发，但可作为保护措施

---

### 6.3 并发会话隔离验证

**场景**：
- 两个用户同时发起对话，conversationId 不同，但可能同时调用相同工具+参数

**验证点**：
- 每个 `BaseAgent` 实例在 `BaseAgentDomainService.Chat` 中创建
- 不同 conversationId 对应不同 `ChatMemory`，也对应不同 `BaseAgent` 实例
- 计数器 `circuitBreaker` 字段是 `BaseAgent` 的成员变量，自然隔离

**测试用例**：
```go
func TestConcurrentSessionIsolation(t *testing.T) {
    // 启动两个 goroutine 模拟并发会话
    // 验证两个 Agent 的 circuitBreaker 实例地址不同
    // 验证计数器状态互不影响
}
```

---

### 6.4 多工具批量失败场景

**场景**：
- 单轮 LLM 返回 10 个 toolCall，全部失败且都达到阈值 3
- 干预提示需要列举 10 条失败记录

**处理策略**：
- 参数预览字段截断（避免干预提示占用过多 token）
- 失败记录按失败次数降序排列（优先展示最严重的）
- 最多展示前 10 条，超出部分显示截断提示

**代码示例**：已在"四、干预 Prompt 模板设计"中展示

---

### 6.5 清零策略边界场景

**场景 1**：智能体连续两轮都调用了工具 A（参数相同），中间没有其他工具

**预期行为**：
- 第一轮：A 失败 3 次，计数器 `{A: 3}`
- `StartNewRound([A])` 被调用，发现 A 在本轮出现，不清零
- 第二轮：A 再次失败，计数器累加到 `{A: 4}` ✅ 符合预期

---

**场景 2**：智能体第一轮调用 A 失败 3 次，第二轮调用 B 和 C

**预期行为**：
- 第一轮：A 失败 3 次，计数器 `{A: 3}`
- `StartNewRound([B, C])` 被调用，发现 A 不在本轮，清零 A
- 计数器变为 `{B: 0, C: 0}` ✅ 符合预期（方案 B）

---

**场景 3**：智能体第一轮调用 A 失败 3 次，第二轮调用 B 成功 + A 失败

**预期行为**：
- 第一轮：A 失败 3 次，计数器 `{A: 3}`
- 第二轮开始前，`StartNewRound([A, B])` 被调用
- 发现 A 在本轮出现，不清零，保持 `{A: 3}`
- 第二轮 A 再次失败，累加到 `{A: 4}`
- 干预提示在第三轮开始前注入 ✅ 符合预期

---

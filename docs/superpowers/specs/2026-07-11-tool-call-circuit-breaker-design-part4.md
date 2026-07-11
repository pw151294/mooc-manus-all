## 七、全维度测试验证方案

### 7.1 单元测试（Unit Test）

**测试框架**：Go 原生 `testing` + `testify/assert`

**测试文件**：`internal/domains/models/circuit_breaker/counter_test.go`

#### 测试用例清单

| 用例编号 | 测试对象 | 场景描述 | 断言点 |
|---------|---------|---------|--------|
| UT-01 | `GenerateKey` | fileRead 工具 - 只哈希 path | 相同 path 生成相同 Key，path 变化生成不同 Key |
| UT-02 | `GenerateKey` | fileEdit 工具 - 截断 old_string/new_string | old_string 前 100 字符相同则 Key 相同，101 字符变化不影响 |
| UT-03 | `GenerateKey` | bashExec 工具 - 完整 command 哈希 | command 任何字符变化都生成不同 Key |
| UT-04 | `GenerateKey` | 未知工具 - 完整参数哈希 | 参数任何字段变化都生成不同 Key |
| UT-05 | `GenerateKey` | 参数 JSON 非法 | 返回 error，不 panic |
| UT-06 | `RecordFailure` | 正常计数累加 | 连续调用 3 次，返回值分别为 1/2/3 |
| UT-07 | `RecordFailure` | 不同 Key 独立计数 | Key A 计数 3 次，Key B 计数 1 次，互不影响 |
| UT-08 | `StartNewRound` | 清零逻辑 - 本轮未出现的 Key | 上一轮的 Key A 在本轮未出现，A 被清零 |
| UT-09 | `StartNewRound` | 保留逻辑 - 本轮再次出现的 Key | 上一轮的 Key A 在本轮再次出现，A 不清零 |
| UT-10 | `GetTriggeredRecords` | 阈值临界值 | 失败 2 次不返回，3 次返回，4 次返回 |
| UT-11 | `GetTriggeredRecords` | 多个 Key 达标 | 3 个 Key 分别失败 3/4/2 次，返回前两个 |
| UT-12 | `buildInterventionPrompt` | 单条失败记录 | 生成的提示包含工具名、失败次数、参数预览 |
| UT-13 | `buildInterventionPrompt` | 10+ 条失败记录 | 只展示前 10 条 + 截断提示 |

**示例测试代码**：
```go
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
}
```

**覆盖率目标**：≥ 90%

---

### 7.2 集成测试（Integration Test）

**测试框架**：Go 原生 `testing` + Mock LLM Invoker

**测试文件**：`internal/domains/services/agents/base_circuitbreaker_test.go`

#### 测试用例清单

| 用例编号 | 测试场景 | 模拟条件 | 验证点 |
|---------|---------|---------|--------|
| IT-01 | 单轮工具失败 3 次触发熔断 | Mock 工具返回失败 3 次 | 第 4 轮 LLM 入参包含干预提示 |
| IT-02 | 工具失败 2 次未触发熔断 | Mock 工具返回失败 2 次后成功 | 无干预提示注入 |
| IT-03 | 中间调用其他工具清零 | 第 1 轮 A 失败 3 次 → 第 2 轮调用 B → 第 3 轮 A 再次失败 | 第 3 轮 A 计数从 1 开始 |
| IT-04 | 多个工具同时达标 | A 失败 3 次，B 失败 4 次 | 干预提示列举 A 和 B |
| IT-05 | 干预后 LLM 不再调用同源工具 | 触发熔断 → Mock LLM 返回文本回答 | Agent 正常结束，无循环 |
| IT-06 | 参数变化不触发熔断 | A(path=a.txt) 失败 3 次 → A(path=b.txt) 失败 | 不触发熔断（Key 不同） |

**示例测试代码**：
```go
func TestCircuitBreaker_ThreeFailuresTriggerIntervention(t *testing.T) {
    // 1. 准备 Mock Invoker（LLM 固定返回工具调用）
    mockInvoker := &MockInvoker{
        responses: []llm.Message{
            {ToolCalls: []llm.ToolCall{{ID: "1", Name: "fileRead", Arguments: `{"path":"test.txt"}`}}},
            {ToolCalls: []llm.ToolCall{{ID: "2", Name: "fileRead", Arguments: `{"path":"test.txt"}`}}},
            {ToolCalls: []llm.ToolCall{{ID: "3", Name: "fileRead", Arguments: `{"path":"test.txt"}`}}},
            {Content: "我无法读取该文件，请检查路径"}, // 第 4 轮返回文本
        },
    }
    
    // 2. 准备 Mock Tool（固定返回失败）
    mockTool := &MockTool{
        name: "fileRead",
        result: models.ToolCallResult{Success: false, Message: "文件不存在"},
    }
    
    // 3. 创建 BaseAgent
    memory := memory.NewChatMemory()
    agent := NewBaseAgent(defaultConfig, mockInvoker, memory, []tools.Tool{mockTool}, "test")
    
    // 4. 执行对话
    eventCh := make(chan events.AgentEvent)
    go agent.Invoke("读取 test.txt", eventCh)
    
    // 5. 收集最后一轮 LLM 请求的 messages
    var lastMessages []llm.Message
    for event := range eventCh {
        // 假设有 LLMRequestEvent 类型（需要新增）
        // 实际测试中可以通过 mock invoker 的调用记录获取
    }
    
    // 6. 断言：最后一轮 messages 中包含干预提示
    found := false
    for _, msg := range lastMessages {
        if msg.Role == llm.RoleUser && strings.Contains(msg.Content, "系统干预提示") {
            found = true
            assert.Contains(t, msg.Content, "fileRead")
            assert.Contains(t, msg.Content, "已失败 3 次")
        }
    }
    assert.True(t, found, "应该注入干预提示")
}
```

---

### 7.3 端到端自动化测试（E2E Test）

**测试框架**：Playwright MCP + Go HTTP Client

**测试文件**：`mooc-manus/docs/e2e/tool-call-circuit-breaker.md`

#### E2E 测试架构

```
┌─────────────────────────────────────────────────────────────┐
│  Playwright Test Script (TypeScript/JavaScript)            │
│  - 通过 MCP 调用 /api/agent/chat                            │
│  - 监听 SSE 事件流                                          │
│  - 断言计数器状态、干预提示、工具调用行为                    │
└─────────────────────────────────────────────────────────────┘
                          ↓ HTTP/SSE
┌─────────────────────────────────────────────────────────────┐
│  mooc-manus Backend                                          │
│  - BaseAgentApplicationService.Chat                          │
│  - BaseAgent 执行工具调用 + 熔断逻辑                         │
└─────────────────────────────────────────────────────────────┘
                          ↓ Tool Invoke
┌─────────────────────────────────────────────────────────────┐
│  Mock Tool Provider（测试专用）                              │
│  - 可配置返回固定失败结果                                     │
│  - 支持计数器状态查询接口                                     │
└─────────────────────────────────────────────────────────────┘
```

#### 测试用例设计

**E2E-01：死循环复现与熔断验证**

**步骤**：
1. Playwright 通过 MCP 发起 `/api/agent/chat` 请求
2. 请求体：`{query: "读取文件 /nonexist.txt", conversationId: "test-001"}`
3. 后端配置 Mock Tool：`fileRead` 固定返回失败
4. 监听 SSE 事件流，收集所有 `ToolCallFail` 事件
5. 等待第 4 轮 LLM 响应（应包含干预提示）
6. 验证后续无 `fileRead(/nonexist.txt)` 工具调用

**自动化断言**：
```typescript
test('工具调用死循环熔断', async ({ page }) => {
  const events: AgentEvent[] = [];
  
  // 1. 发起请求并订阅 SSE 事件
  const eventSource = await page.evaluate(() => {
    return new EventSource('/api/agent/chat', {
      method: 'POST',
      body: JSON.stringify({
        query: '读取文件 /nonexist.txt',
        conversationId: 'e2e-test-001',
      }),
    });
  });
  
  // 2. 收集事件
  await page.on('sse-message', (event) => {
    events.push(JSON.parse(event.data));
  });
  
  // 3. 等待对话结束
  await page.waitForTimeout(10000); // 或监听 MessageEnd 事件
  
  // 4. 断言失败次数
  const failEvents = events.filter(e => 
    e.type === 'ToolCallFail' && 
    e.payload.toolName === 'fileRead' &&
    JSON.parse(e.payload.arguments).path === '/nonexist.txt'
  );
  expect(failEvents.length).toBe(3); // 正好失败 3 次
  
  // 5. 断言干预提示（通过 MessageEvent 观察）
  const messages = events.filter(e => e.type === 'Message');
  const interventionMsg = messages.find(m => 
    m.payload.content.includes('系统干预提示') &&
    m.payload.content.includes('fileRead') &&
    m.payload.content.includes('已失败 3 次')
  );
  expect(interventionMsg).toBeDefined();
  
  // 6. 断言后续无重复调用
  const interventionIndex = events.indexOf(interventionMsg!);
  const toolCallsAfter = events
    .slice(interventionIndex + 1)
    .filter(e => e.type === 'ToolCallStart');
  const duplicateCalls = toolCallsAfter.filter(e =>
    e.payload.toolName === 'fileRead' &&
    JSON.parse(e.payload.arguments).path === '/nonexist.txt'
  );
  expect(duplicateCalls.length).toBe(0); // 无重复调用
});
```

---

**E2E-02：参数修改后允许新调用（反向用例）**

**步骤**：
1. 第 1 轮：`fileRead(/a.txt)` 失败 3 次
2. 配置 Mock LLM：第 4 轮返回 `fileRead(/b.txt)` 工具调用
3. 验证 `fileRead(/b.txt)` 正常执行，不被熔断

**自动化断言**：
```typescript
test('参数修改后不触发熔断', async ({ page }) => {
  const events: AgentEvent[] = [];
  
  // ... 类似上述流程，收集事件 ...
  
  // 断言：/a.txt 失败 3 次后，/b.txt 仍能调用
  const aFailEvents = events.filter(e =>
    e.type === 'ToolCallFail' &&
    e.payload.toolName === 'fileRead' &&
    JSON.parse(e.payload.arguments).path === '/a.txt'
  );
  expect(aFailEvents.length).toBe(3);
  
  const bStartEvents = events.filter(e =>
    e.type === 'ToolCallStart' &&
    e.payload.toolName === 'fileRead' &&
    JSON.parse(e.payload.arguments).path === '/b.txt'
  );
  expect(bStartEvents.length).toBeGreaterThan(0);
});
```

---

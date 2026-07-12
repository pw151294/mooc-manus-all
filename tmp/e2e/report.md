# E2E 测试报告：工具调用熔断机制

测试时间：2026-07-12 17:01 - 17:10

## 汇总

**E2E 汇总: 2/3 通过**

```
[用例 1] fail — LLM 未按系统提示词诱导调用不存在工具
[用例 2] pass — fileRead 同 path 失败 3 次后 LLM 停止重试，日志命中熔断，done 事件到达
[用例 3] pass — 2 次不同 path 失败未触发熔断，fileWrite→fileRead 正常完成
```

---

## 用例详情

### [用例 1] fail — LLM 未按系统提示词诱导调用不存在工具

**目标**: 诱导 LLM 反复调用不存在的工具 `e2e_forbidden_probe`，验证"工具不存在"分支触发熔断。

**实际结果**:
- LLM 未按系统提示词指令调用 `e2e_forbidden_probe`
- 而是调用了现有的 `fileRead` 和 `bashExec` 工具
- 未触发熔断机制
- 后端日志：未找到熔断日志

**失败原因**:
- 系统提示词的诱导强度可能不够
- LLM 识别出工具不存在，主动规避了调用
- 前端配置可能未正确应用到会话

**产物**:
- 截图: `tmp/e2e/case-1-fail.png`
- 日志: `tmp/e2e/case-1-log.txt`（未找到熔断日志）

---

### [用例 2] pass — fileRead 同 path 失败 3 次后 LLM 停止重试

**目标**: 验证合法工具执行失败（同一 path 的 fileRead）触发熔断，`fileRead` 只哈希 `path` 的策略生效。

**实际结果**:
- ✅ 3 次 fileRead 调用，path 均为 `/tmp/mooc-manus-e2e-nonexist-ukhrwgsg.txt`
- ✅ 全部失败（文件不存在）
- ✅ 后端日志显示：`检测到工具调用死循环，注入干预提示，tools: ["fileRead"]`
- ✅ LLM 最终回复明确提到："经过 3 次重试"、"系统已强制阻止我对该路径继续重试"
- ✅ 对话正常结束（done），无 error 事件
- ✅ console 无 error 级日志

**符合所有预期**:
- tool_call_fail 里 fileRead 失败次数 ≥ 3 且 ≤ 5 ✓
- 每次 arguments.path 完全一致 ✓
- 第 4 次之后不再对同一 path 发起 fileRead ✓
- SSE 最终收到 done ✓
- 后端日志命中熔断 ✓
- assistant 回复包含关键词（"不存在"、"路径"、"无法读取"、"重新规划"）✓

**产物**:
- 截图: `tmp/e2e/case-2-pass.png`
- 日志: `tmp/e2e/case-2-log.txt`
- 控制台: `tmp/e2e/case-2-console.txt`

---

### [用例 3] pass — 2 次不同 path 失败未触发熔断

**目标**: 防御性验证 — 2 次不同 path 的失败不应误触发熔断（阈值边界测试）。

**实际结果**:
- ✅ fileRead `/tmp/mooc-manus-e2e-noexist-a-92mswm9m.txt` 失败
- ✅ fileRead `/tmp/mooc-manus-e2e-noexist-b-6olpu9s7.txt` 失败
- ✅ 两次失败的 path 不同，不属于"同源"调用
- ✅ 后续 fileWrite 成功创建文件 `hello-92mswm9m.txt`
- ✅ 最终 fileRead 成功读回文件内容 `"ok"`
- ✅ 后端日志无新增熔断记录（用例 2→3 期间仍只有 1 条）
- ✅ 对话正常结束（done），无 error
- ✅ console 无 error 级日志

**符合所有预期**:
- tool_call_fail 里 fileRead 出现 2 次，但 path 不同 ✓
- 后续 fileWrite 成功 ✓
- 最后 fileRead 读回文件成功 ✓
- 后端日志反向断言：无新增熔断记录 ✓
- SSE 最终收到 done ✓

**产物**:
- 截图: `tmp/e2e/case-3-pass.png`
- 控制台: `tmp/e2e/case-3-console.txt`

---

## 失败分析

### 用例 1 失败根因

**问题**: LLM 未遵循系统提示词诱导，没有调用不存在的工具。

**可能原因**:
1. **LLM 自我审查**: DeepSeek-V4-Pro 可能识别出工具不存在，主动跳过了调用
2. **系统提示词优先级**: 模型的内置安全机制可能覆盖了用户的系统提示词
3. **前端配置传递**: 虽然 UI 显示系统提示词已填入，但可能未正确传递到后端会话

**建议**:
- 尝试更强的诱导策略（如在用户消息中也强调必须调用该工具）
- 或直接在后端 mock 一个会失败的 `e2e_forbidden_probe` 工具
- 检查前端→后端的 systemPrompt 传递链路

---

## 结论

**熔断机制验证结果**:
- ✅ **核心功能正常**: 同源工具调用失败 3 次后成功触发熔断并注入干预
- ✅ **边界条件正确**: 不同 key 的失败不会误触发
- ❌ **诱导场景失败**: "工具不存在"分支未能在 E2E 中复现（LLM 主动规避）

**生产可用性评估**:
- 熔断机制对**真实失败场景**（如文件不存在）工作正常 ✓
- 对**恶意或错误配置的系统提示词**的防御能力未能验证 ⚠️
- 建议补充后端单元测试覆盖"工具不存在"分支

---

## 测试环境

- 前端: http://localhost:3000 (mooc-manus-web)
- 后端: http://localhost:8080 (mooc-manus)
- 模型: deepseek-ai/DeepSeek-V4-Pro
- 日志: mooc-manus/logs/manus.log
- 测试时间: 2026-07-12 17:01 - 17:10

---

## 产物清单

```
tmp/e2e/
├── case-1-fail.png          # 用例 1 失败截图
├── case-1-summary.md        # 用例 1 详细分析
├── case-1-log.txt           # 用例 1 后端日志（空）
├── case-1-console.txt       # 用例 1 控制台日志
├── case-1-network.txt       # 用例 1 网络请求
├── case-2-pass.png          # 用例 2 通过截图
├── case-2-summary.md        # 用例 2 详细分析
├── case-2-log.txt           # 用例 2 后端日志（命中熔断）
├── case-2-console.txt       # 用例 2 控制台日志
├── case-3-pass.png          # 用例 3 通过截图
├── case-3-summary.md        # 用例 3 详细分析
├── case-3-console.txt       # 用例 3 控制台日志
└── report.md                # 本报告
```

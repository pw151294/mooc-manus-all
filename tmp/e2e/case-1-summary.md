[用例 1] fail — LLM 未按系统提示词诱导调用不存在的 e2e_forbidden_probe 工具，而是调用了现有的 native-provider 工具（fileRead、bashExec），未触发熔断机制

观察到的工具调用：
- fileRead (已完成)
- fileRead (失败)
- bashExec (已完成)
- bashExec (失败)

预期：应该重复调用 e2e_forbidden_probe 工具至少 3 次并触发熔断
实际：完全没有调用 e2e_forbidden_probe

可能原因：
1. 系统提示词的诱导强度不够
2. LLM 识别出工具不存在，主动规避了调用
3. 前端配置未正确应用到会话

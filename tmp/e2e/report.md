# E2E 测试报告：工具调用熔断机制

测试时间：2026-07-12 16:42

## 前置条件检查失败

**严重问题**：后端代码不在正确的分支上

- 期望分支：`feature/tool-call-circuit-breaker`
- 实际分支：`master`
- 影响：熔断机制代码未部署，无法验证熔断功能

## 用例执行情况

### 用例 1：诱导反复调用不存在工具

**状态**：❌ FAIL

**失败原因**：
1. 后端未切换到 `feature/tool-call-circuit-breaker` 分支，熔断代码不存在
2. LLM 未按预期调用不存在的 `e2e_forbidden_probe`，而是变通使用 `bashExec`
3. `bashExec` 参数格式反复失败（JSON 解析错误），但这是参数校验失败而非工具不存在失败
4. 后端日志中**没有**"检测到工具调用死循环"的记录
5. SSE 连接超时并中断（前端控制台警告）

**观察到的行为**：
- LLM 总共发起 4 次工具调用，均为 `bashExec`
- 每次参数都包含 `e2e_forbidden_probe` 相关字符串但导致 JSON 解析错误
- 错误类型：`Colon expected at position 72/74` (JSON 解析失败)
- 对话持续时间：约 101 秒
- 最终状态：未正常完成（SSE 超时）

**产物**：
- 截图：`tmp/e2e/case-1-fail.png`
- 控制台：`tmp/e2e/case-1-console.txt`
- 后端日志：`tmp/e2e/case-1-log.txt`（空，无熔断记录）
- 网络请求：`tmp/e2e/case-1-network.txt`

### 用例 2 & 3

**状态**：⏭️ SKIPPED

**原因**：用例 1 前置条件不满足（后端分支错误），继续测试无意义

## 汇总

```
E2E 汇总: 0/3 通过

[用例 1] fail — 后端未在 feature/tool-call-circuit-breaker 分支，熔断代码不存在
[用例 2] skip — 前置条件不满足
[用例 3] skip — 前置条件不满足
```

## 操作建议

1. 切换后端到正确分支：
   ```bash
   cd mooc-manus
   git checkout feature/tool-call-circuit-breaker
   git pull origin feature/tool-call-circuit-breaker
   ```

2. 重启后端服务

3. 重新运行 E2E 测试

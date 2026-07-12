# 共享根因（所有 5 个 E2E 用例均阻塞）

## 现象
`bashExec` 从未触发 HITL 中断分支：
- 手工回归 P-danger-1 / P-danger-2 / 自定义"直接执行 rm"prompt / 加系统提示词强制 risk_level 字段，4 次尝试均未出现「高危调用待审批」卡片
- 后端 log 命中：`risk_level` 只出现 1 次（bash_exec.go 源码里定义的一次），`tool_call_interrupt` 0 次，`action=register` 0 次

## 根因（后端应用代码 bug）
后端**发送给 LLM** 的 bashExec Function Calling schema，`Parameters.properties` 只包含：
```
command / description / timeout_sec
```
**缺少** `risk_level` 与 `risk_reason` 两个必填字段，`required` 也只有 `["command","description"]`。

但源码 `mooc-manus/internal/domains/services/tools/bash_exec.go:142-152` 明确定义了这两个字段并声明 required。

**推断**：从 `models.ToolFunctionDO.Schema.Parameters` 到 LLM 客户端 tool schema 的序列化路径某一步丢字段。

## 传导链
1. LLM 收到的 schema 不含 risk_level → LLM 生成 tool call 不带 risk_level
2. `base.go:161` `interrupt.ParseRiskFromArgs(funcArgs)` 报 `ErrMissingRisk`
3. `base.go:163-166` 打 warn "HITL 风险字段解析失败，降级为直接执行"
4. 危险命令走 `denyList.Match` 拦截 / 或直接执行，**永远不进入 HITL 中断分支**

## 影响
E2E-01~E2E-05 全部 5 个用例都以「触发 `tool_call_interrupt`」为前置，全部无法验证。

## 建议
建议交回后端排查：`internal/domains/services/tools/bash_exec.go` → `models.ToolFunctionDO` → LLM 客户端 tool 转换环节，为什么 required 段落 4 个字段被削到 2 个。E2E 自身不做修复（skill 硬约束）。

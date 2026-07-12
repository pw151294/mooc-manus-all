# E2E 汇总: 0/5 通过

**测试时间**: 2026-07-12 20:34 ~ 20:49
**Spec**: `docs/e2e/human-in-the-loop.md`

## 结论

**5 个用例全部 fail — 单一共享根因**(详见 `tmp/e2e/shared-root-cause.md`):

后端发送给 LLM 的 `bashExec` Function Calling schema **缺少 `risk_level` 与 `risk_reason` 两个必填字段**,`required` 只有 `["command","description"]`。虽然 `mooc-manus/internal/domains/services/tools/bash_exec.go:142-152` 源码定义了这两个字段,但从 `models.ToolFunctionDO.Schema.Parameters` 到 LLM 客户端 tool schema 的序列化路径某一步丢了字段。

传导链:
1. LLM 收到的 schema 不含 `risk_level` → LLM tool call arguments 不带 `risk_level`
2. `base.go:161` `interrupt.ParseRiskFromArgs(funcArgs)` 报 `ErrMissingRisk`
3. `base.go:163-166` 打 warn `"HITL 风险字段解析失败,降级为直接执行"`
4. 危险命令走 `denyList.Match` 拦截 / 或直接执行,**永远不进入 HITL 中断分支**

后端 log 关键词命中(整段 log 范围内):
- `risk_level` — 1 次(仅源码内定义的一次)
- `tool_call_interrupt` — 0 次
- `action=register` — 0 次
- `dangerous` — 0 次

## 各用例结果

[用例 E2E-01] fail — 3 次不同 prompt(P-danger-1 / P-danger-3 / 定制 rm)+ 2 个模型(deepseek-ai/DeepSeek-V4-Pro、zai-org/GLM-5.2)+ 强制系统提示词,均未出现"高危调用待审批"卡片
  截图: tmp/e2e/case-1-fail.png
  SSE: tmp/e2e/case-1-sse.txt(仅含 message 事件,无 tool_call_interrupt)
  日志: tmp/e2e/case-1-log.txt

[用例 E2E-02] fail — 前置条件"触发 tool_call_interrupt"无法满足,共享 case-1 根因
  日志: tmp/e2e/case-2-log.txt

[用例 E2E-03] fail — 前置条件"触发 tool_call_interrupt"无法满足,共享 case-1 根因
  日志: tmp/e2e/case-3-log.txt

[用例 E2E-04] fail — 前置条件"触发 tool_call_interrupt"无法满足,共享 case-1 根因;`HITL_WAIT_TIMEOUT` 环境变量本用例未验证到(即使调低超时,前置不满足也无从触发)
  日志: tmp/e2e/case-4-log.txt

[用例 E2E-05] fail — 前置条件"触发 tool_call_interrupt"无法满足,共享 case-1 根因
  日志: tmp/e2e/case-5-log.txt

## 建议下一步

不属于 E2E 层修复范畴。建议交回后端排查:
`internal/domains/services/tools/bash_exec.go` → `models.ToolFunctionDO.Schema.Parameters` → LLM 客户端 tool 序列化 → OpenAI/Anthropic tools payload。为什么 `required` 段落从 4 个字段被削到 2 个,`properties` 里 `risk_level` / `risk_reason` 被丢弃。

参考对照测试:`internal/applications/services/agent_hitl_integration_test.go` 里 I-01~I-13 集成测试用手工构造的 `argsDangerous(...)` 绕过了 LLM,直接注入含 `risk_level=dangerous` 的 arguments。如果集成测试全绿而 E2E 触发不了,进一步佐证问题在"schema 从 Domain 送到 LLM 客户端"这段。

## 产物清单

- `tmp/e2e/case-1-fail.png` — case-1 截图(卡片未出现)
- `tmp/e2e/case-1-sse.txt` — case-1 SSE 原始流
- `tmp/e2e/case-1-console.txt` — 控制台日志(仅 antd 弃用告警,无业务 error)
- `tmp/e2e/case-1-log.txt` — 后端关键词命中统计 + schema 证据
- `tmp/e2e/case-{2..5}-log.txt` — 共享根因归档
- `tmp/e2e/shared-root-cause.md` — 根因详解

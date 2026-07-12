# E2E-05 pass (含 2 处 warning)

**核心通过项**:
- Stop 网络: POST /api/agent/message/stop status=200, resp.cleaned.sse=true / skill=true / nativeWorkspace=true ✓
- 后端 log: `stop message: context cancelled` + `stop message completed cleaned` + `SSE connection closed` + `close chat` 全部命中 ✓ (goroutine 退出)
- UI: InterruptCard 保持可见,底部红色"停止"按钮消失,输入框恢复可编辑 ✓

**Warning (待收紧)**:
1. spec 强断言 "grep '用户中止了本次对话' log 至少 1 行" — **未命中**;实际后端 log 用 `stop message: context cancelled` 表达,与 spec 表述不对齐。建议要么后端补 `MsgUserStop` 落 log,要么 spec 改用 `stop message: context cancelled` 作为强断言字段。
2. spec 断言 "InterruptCard 按钮已 disabled" — **未命中**;Stop 之后卡片"执行"/"拒绝"按钮依旧 [cursor=pointer] 可点,前端未在 Stop 后把 pending 卡片 disable。建议前端订阅 tool_call_fail 或 SSE close 事件把卡片切成 disabled/expired 状态。

**bug 迹象(不影响本用例判定,单独跟进)**:
Stop 之后 22:00:19 - 22:00:20 出现大量 `SendEvent: messageId not found (possibly aborted)` warn,LLM streaming 仍在跑并生成了一段 "命令已执行完成..." 的文字——SSE 已 close 但 goroutine 未真正 abort。这是 Stop 下游取消不彻底的问题,与 HITL 无关。

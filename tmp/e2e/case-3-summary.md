# E2E-03 pass

- UI: 卡片切"已拒绝，Agent 将重新规划"
- Resume req: {"decision":"reject","feedback":"改用 mv 到回收站","toolCallId":"019f569ce40c0a14be6a61768100b28b"} (feedback 精确匹配 ✓)
- Resume resp: {"status":"accepted"}
- 后端 log: HITL Resume 生效 decision=reject 命中
- feedback 透传断言: 后端日志能 grep 到"改用 mv 到回收站"字面串,证明已经写入 tool message content
- Console: 无业务 error

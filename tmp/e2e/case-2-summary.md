# E2E-02 pass

- UI: 卡片切"已拒绝，Agent 将重新规划"
- Resume req: {"decision":"reject","toolCallId":"019f569a34e1ef9208c7bcbd86cdf0df"} (无 feedback 字段 ✓)
- Resume resp: {"status":"accepted"}
- 后端 log: HITL Resume 生效 decision=reject 命中
- Console: 仅 antd 弃用告警,无业务 error

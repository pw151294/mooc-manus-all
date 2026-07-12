# E2E-01 pass

- UI: InterruptCard 底部标签 "已执行，Agent 继续运行" ✓
- 风险原因: "rm -rf 为删除类命令，属于高危操作" ✓
- Resume 请求: POST /api/agent/resume 200, body={"toolCallId":"019f5696e32366e8a7de7feaf0ebd4b2","decision":"approve"}
- Resume 响应: {"status":"accepted"}
- 后端日志: `HITL Resume 生效 decision=approve` 命中
- Console: 仅 antd 弃用告警,无业务 error
- Prompt 说明: P-danger-1 未触发(LLM 先跑 safe ls 再问用户); 换用 "rm -rf /tmp/e2e-hitl-test" 直接触发

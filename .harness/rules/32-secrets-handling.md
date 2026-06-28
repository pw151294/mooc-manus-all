---
rule_id: R-32-secrets
severity: high
---

# 敏感信息处理

## 必须脱敏的字段

- LLM API key（OpenAI / Anthropic / Azure 等）
- JWT / session token
- 数据库连接串里的密码
- 用户私密对话内容（仅在 conversation 范围内有意义，跨会话不传播）

## 脱敏规则

- 在 log / event payload / prompt 上下文中：
  - 保留 key 名（用于追踪）
  - value 替换为 `***`（如 `OPENAI_API_KEY=***`）
- conversationId / userId 可保留（追踪所必需）
- 禁止把完整 conversation history 写入 `retro/ai-error-log.md` 或 ADR

## Agent 行为

- 看到代码中 `log.Printf("token=%s", token)` 这类原文打印 → 标记违规，建议改为 `log.Printf("token=***")`
- 看到 commit diff 中含疑似 secret 的字符串（高熵 base64、JWT 三段式）→ 拒绝并提示

## 可验证性

`pre-commit` hook 检查：
- 用 `git secrets` 模式扫描已暂存文件
- 命中即 warning（不阻塞，但醒目提示）

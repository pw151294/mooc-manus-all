# Commit message 规范

> 与 `.harness/hooks/commit-msg` 校验一致。format：`<type>(<scope>): <subject>` 或 `<type>: <subject>`。

## type 枚举

- `feat`：新功能（新增 endpoint / 新增 agent / 新增 rule）
- `fix`：bug 修复
- `docs`：仅文档改动（.md / 注释）
- `refactor`：不改外部行为的内部改动
- `chore`：构建 / 工具 / 子模块指针升级
- `test`：仅测试改动
- `style`：格式（不影响语义）
- `perf`：性能优化

## scope 允许字符

字母数字 / 下划线 / 连字符 / 空格 / `&` / `.`（见 `.harness/hooks/commit-msg`）

常用 scope：

- 总仓：`harness`、`docs`、`ci`
- 后端（mooc-manus 子仓）：`agent`、`mcp`、`a2a`、`sse`、`llm`、`skill-executor`、`api`
- 前端（mooc-manus-web 子仓）：`ui`、`features`、`services`
- 子模块指针升级使用约定形式：`chore: 升级子模块指针(mooc-manus)` 或 `chore: 升级子模块指针(mooc-manus & mooc-manus-web)`

## 示例（项目历史）

```
feat(harness): workflows/3-plan/templates
fix(sse): drop heartbeat when client disconnected
docs(harness): add R-32 secrets-handling
chore: 升级子模块指针(mooc-manus)
chore: 升级子模块指针(mooc-manus & mooc-manus-web)
refactor(llm): unify protocol abstraction across providers
```

## subject 写法

- 一句话祈使句（"add X"、"fix Y bug"，不要 "added"、"fixes"）
- 重点写"为什么"，"做了什么"放 body
- 控制在 72 字符内（GitHub 列表会截断）
- 中文 OK（项目现状混用），但 type / scope 仍用英文

## body / footer（可选）

- 复杂改动：body 列要点 + 关联 spec / plan 路径
- breaking change：`BREAKING CHANGE:` 前缀 + 迁移说明
- AI 协作：`Co-Authored-By: Claude <noreply@anthropic.com>`（按调度方约定）

## 禁忌

- 不要 `--amend` 已 push 的 commit
- 不要 `--no-verify` 跳过 hook（除非用户明确授权）
- 不要把多个 Task 合并 commit（违反 task-breakdown-guide 单 commit 原则）

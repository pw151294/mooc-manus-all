# 实施 checklist

> 驱动 skill：`superpowers:executing-plans` / `superpowers:subagent-driven-development`。每个 Task 都过一遍。

## 实施前

- [ ] Read 完该 Task 在 plan 中的完整描述（包括 DoD）
- [ ] Read 该 Task 引用的 spec 章节
- [ ] Read 受影响文件的当前状态（不靠记忆，不靠搜索结果摘要）
- [ ] 确认 `Working dir` 与当前 cwd 一致
- [ ] 列出该 Task 涉及的 rules（如 R-20 cross-repo-contracts、R-31 untrusted-content）

## 实施中

- [ ] 单 Task 范围严格控制，不顺手改无关代码（YAGNI）
- [ ] 跨 DDD 层修改时，确认依赖方向（外→内）
- [ ] 新增外部依赖时，使用 pin 版本，不用 `^` / `~`
- [ ] 编辑前 Read，编辑后再 Read 校对
- [ ] 改 SSE / DTO / API：同步更新前后端两端，或在 plan 中标记后续 Task

## 实施后

- [ ] 跑 `bash .harness/scripts/validate-harness.sh`（总仓 / 子仓各自的版本）
- [ ] 跑相关单元测试 / 集成测试
- [ ] `git status` 确认无意外文件被修改
- [ ] commit message 符合 `commit-conventions.md`
- [ ] commit 后 `git log -1` 校对结果
- [ ] 跨仓 Task：先子仓 commit，再回总仓 `git add <submodule-path>` + `chore: 升级子模块指针(<name>)`

## subagent 专属

- [ ] 完成后向调度者报告：Status / commit 列表 / 验证脚本输出 / self-review
- [ ] 失败 / 阻塞：报 BLOCKED，不要绕过 rule 强行交付
- [ ] 不 push（推送由用户决定）

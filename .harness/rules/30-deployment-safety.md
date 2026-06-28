---
rule_id: R-30-deploy
severity: critical
---

# 部署护栏

## 禁止操作

1. 直接推送到 master/main 分支（应走 PR 流程）
2. force push（除非本地分支未推送过）
3. 子模块指针修改未经 CI 验证就推送
4. `git reset --hard origin/...`（远端跟踪分支硬重置，会丢失本地未推送 commit）
5. `git push --delete origin <branch>`（远端分支删除，无法直接恢复）
6. `git clean -fdx`（工作区暴力清理，会连同未跟踪的本地配置/构建产物一并删除）

## 要求操作

- 部署脚本（如 deploy.sh）变更 → 先在测试环境验证
- 升级子模块指针 → CI 通过 + 至少 1 人 review

## Agent 行为

- 任何 `git push origin master` 请求 → 拒绝，提示"请创建分支并发 PR"
- force push 到 origin/master 或 origin/main：直接拒绝（无例外）
- force push 到自己创建的 feature 分支：警告 + 二次确认

## 可验证性

pre-push hook 检查：
- 目标分支是否为 master/main
- 是否有 `--force` 标志
- `pre-push` hook 实现仅基于 stdin（refs）+ local sha 即可判断目标分支与 force flag，无需远端查询

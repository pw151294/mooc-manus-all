---
rule_id: R-30-deploy
severity: critical
---

# 部署护栏

## 禁止操作

1. 直接推送到 master/main 分支（应走 PR 流程）
2. force push（除非本地分支未推送过）
3. 子模块指针修改未经 CI 验证就推送

## 要求操作

- 部署脚本（如 deploy.sh）变更 → 先在测试环境验证
- 升级子模块指针 → CI 通过 + 至少 1 人 review

## Agent 行为

- 任何 `git push origin master` 请求 → 拒绝，提示"请创建分支并发 PR"
- 检测到 force push 意图 → 二次确认（除非用户显式说"我知道后果"）

## 可验证性

pre-push hook 检查：
- 目标分支是否为 master/main
- 是否有 `--force` 标志

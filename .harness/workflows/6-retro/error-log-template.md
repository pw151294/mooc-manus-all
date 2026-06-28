# Error log 条目模板

> 用法：每次发现"AI agent / 自动化流程做错了某件事"，在 `.harness/retro/ai-error-log.md` 顶部追加一条。条目按时间倒序排列（最新在上）。

## 单条格式

```
## <YYYY-MM-DD HH:MM> — <一句话标题>

- **触发 commit / PR**：<commit hash 或 PR 链接>
- **违反 rule**：<R-XX，如不涉及现成 rule 写 "无现成 rule，考虑新增 R-YY">
- **现象**：<出错时的可观察表现，1-3 段>
- **根因**：<分析后定位的根本原因，不是"agent 不小心"这种空话>
- **修复**：<采取的修复动作 + commit hash>
- **教训 / 后续行动**：
  - <例：在 R-20 中加一条 sub-rule>
  - <例：在 .harness/playbooks/ 加一篇专项 playbook>
  - <例：在 hooks/ 加一道校验>

---
```

## 写作要点

- **现象**要具体到文件 / 函数 / 命令；不要"流程不顺"这种泛泛描述
- **根因**至少深挖一层，不止步于表象（例："agent 没读 R-20" → 进一步问"R-20 是否描述不清"或"agent 是否没收到 rules"）
- **教训**要能落地为后续动作（rule / hook / playbook / spec），不是"以后注意"这种无效结论
- 包含 commit hash 便于追溯；如未 commit（被发现并阻拦在前）则写 "未 commit，阻拦于 <环节>"

## 示例骨架

```
## 2026-06-28 23:45 — 子模块指针漏 commit

- **触发 commit**：a1b2c3d
- **违反 rule**：R-10 submodule-discipline §3
- **现象**：CI 报"submodule pointer mismatch"，origin/master 上 mooc-manus 指针仍指向旧 commit
- **根因**：subagent 在子仓内 commit 后未回到总仓 `git add <submodule-path>` + 升级指针。R-10 §3 描述偏抽象，未给出操作步骤
- **修复**：手动补 commit b2c3d4e；并在 R-10 §3 加入具体命令示例
- **教训 / 后续行动**：
  - [x] R-10 §3 增补具体命令
  - [ ] 在 .harness/hooks/pre-push 校验"子模块指针是否落后"
  - [ ] 在 4-implement/checklist.md "实施后" 段强调跨仓 commit 双步
```

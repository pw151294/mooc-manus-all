# Playbooks 索引（总仓）

可重放的跨仓操作剧本。所有涉及"指针升级 / 双仓协同 / 紧急回滚"的动作走这里，单子仓内部剧本见 `mooc-manus/.harness/playbooks/` 与 `mooc-manus-web/.harness/playbooks/`。

## 何时进这里

- 出现 `git status` 显示 `modified: mooc-manus (new commits)` → 走 `upgrade-submodule.md`
- 需要后端发新 SSE 事件 + 前端订阅 → 走 `add-new-event-type.md`
- 接到一个跨前后端的新需求（spec → plan → 编码 → 联调）→ 走 `full-stack-feature.md`
- 线上指针指向有问题的 commit、需要立即回退 → 走 `emergency-rollback.md`

## 总仓剧本清单

| 剧本 | 适用 | 关联 rule |
|---|---|---|
| `upgrade-submodule.md` | 日常升级子仓指针 | R-10 / R-30 |
| `add-new-event-type.md` | 后端新增 SSE 事件 + 前端订阅 | R-20 / R-45 / R-41 |
| `full-stack-feature.md` | 端到端新功能（spec → plan → 双仓编码 → 联调 → 指针） | R-10 / R-20 / R-45 / R-41 |
| `emergency-rollback.md` | 指针回退 / 紧急回滚 | R-10 / R-30 |

## 通用规约

- 每份剧本结构：**前置条件 / 步骤 / 常见坑 / 验证 / Agent 行为**
- 所有命令在总仓根目录执行；进入子仓必显式 `cd mooc-manus` 或 `cd mooc-manus-web`，命令结尾返回 `cd ..`
- 指针升级 commit 走 `chore: 升级子模块指针(<子仓>, <一句话改动>)` 模板（详见 `upgrade-submodule.md`）
- 不允许在总仓直接修改子仓文件（R-10），所有"看着像总仓内的改动"必须先确认是否落在子仓 worktree 内

## 与其他目录

- 子仓内部剧本（"如何在后端加一种 Agent"等）见各子仓 `.harness/playbooks/`
- 工作流（CI / 验证）见 `mooc-manus-all/.harness/workflows/`
- 详细子模块知识背景见 `knowledge/submodule-workflow.md`
- 规则正文见 `rules/`，本目录仅引用 R-XX 短码

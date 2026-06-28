# workflows/ — SDD 全链路项目化封装层

> 本目录 **不另起一套流程**，而是把 `superpowers:*` skill 在本项目（mooc-manus-all：Go DDD 后端 + React 前端 + MCP/A2A 协议 + git submodule mono-repo）落地的"项目化约定层"。

详见 spec：`/docs/superpowers/specs/2026-06-28-harness-doc-architecture-design.md` §3.7.1。

## 六阶段与驱动 skill

| 阶段目录 | 实际驱动 skill | workflows/ 提供什么 |
| --- | --- | --- |
| `1-brainstorm/` | `superpowers:brainstorming` | brainstorm 输出模板（问题 / 候选方案 / 对比 / 推荐） |
| `2-spec/` | `superpowers:brainstorming` 的输出阶段（设计文档） | 本项目 spec 章节结构（DDD 影响面、SSE / DTO 跨仓契约影响面）+ checklist |
| `3-plan/` | `superpowers:writing-plans` | 本项目 plan 模板（含 submodule 升级流）+ task 拆解指南 |
| `4-implement/` | `superpowers:executing-plans` / `superpowers:subagent-driven-development` | 实施前/中/后 checklist + commit conventions + 测试要求 |
| `5-review/` | `superpowers:requesting-code-review` + 本仓 `.harness/agents/` | code review checklist + spec review prompt + 自检指南 |
| `6-retro/` | `superpowers:receiving-code-review` 之后 + 本仓 `.harness/retro/` | error-log 模板 + ADR 模板 |

## 使用约定

- spec / plan 文件**本体**仍存放在各仓 `docs/superpowers/{specs,plans}/`（兼容 superpowers skill 默认路径）
- 本目录的 `template.md` 是 **格式骨架**：写 spec 时复制模板章节，不是另存一份 spec 实体
- 子仓（mooc-manus / mooc-manus-web）通过 `.harness/manifest.yaml.inherits` 继承本目录，**不重复定义**
- 6 个阶段不是强制门禁，是"建议路径"：小修复可跳过 1-brainstorm / 2-spec 直接进入 3-plan 或 4-implement；改跨仓契约 / 引入新依赖 / 改 DDD 分层时**必须**走完 1→3

## 与 rules / playbooks 的关系

- **rules**（`.harness/rules/`）：硬性约束（必须遵守，每次都加载）
- **playbooks**（`.harness/playbooks/`）：高频操作的 step-by-step（例如"新增一个 agent"）
- **workflows**（本目录）：跨阶段的"做事顺序"模板（一次需求从想法到上线）

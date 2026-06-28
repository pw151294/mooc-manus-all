# mooc-manus-all Harness

本目录是 mooc-manus-all 全栈系统的 Harness 体系总仓部分，承载**跨仓共识、跨仓契约、SDD 流程模板**。

> ⚠️ Phase 1 仅建立骨架，knowledge / playbooks / workflows 实体内容由 Phase 5–7 填充。

## 受众

- **AI agent**：第一次进入本仓时，按下方"加载顺序"消化内容。
- **人类工程师**：从 `knowledge/architecture-overview.md` 开始。

## Agent 加载顺序

1. 读取 `manifest.yaml`
2. 按 `cognition.loadOrder` 依次加载 `rules/`
3. 遇到任务时按任务类型从 `playbooks/` 选剧本
4. 需要深度上下文时检索 `knowledge/`
5. 流程模板见 `workflows/`

## 七大子目录职责

| 目录 | 职责 |
|------|------|
| `rules/` | 硬约束，agent 写代码前必读 |
| `knowledge/` | 上下文百科，按需检索 |
| `playbooks/` | 任务剧本（"我要做 X" → 步骤） |
| `workflows/` | SDD 全链路模板（brainstorm → spec → plan → ...） |
| `specs/` | spec 索引层，指向 `docs/superpowers/specs/` 实体 |
| `plans/` | plan 索引层，指向 `docs/superpowers/plans/` 实体 |
| `retro/` | 错误案例库 + ADR |

## 执行层

| 目录 | 职责 |
|------|------|
| `agents/` | 项目专属子代理定义 |
| `hooks/` | git 钩子源（warning only） |
| `scripts/` | 自动化辅助（validate / sync / generate） |

## 归档层（archive/）

| 目录 | 职责 |
|------|------|
| `archive/` | 废弃的 rules / playbooks 或被新版替代的旧文档；保留 1 个 release cycle 后物理删除 |

详细设计见 `docs/superpowers/specs/2026-06-28-harness-doc-architecture-design.md`。

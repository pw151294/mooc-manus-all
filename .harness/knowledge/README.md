# 总仓 knowledge 索引

## 这是什么

`mooc-manus-all/.harness/knowledge/` 是**跨仓共识层**——只放与"前后端协作 / 三仓拓扑 / 全栈契约"相关的概念、术语、协议。仓内才有的细节（Go 错误处理、Zustand store 写法等）分别归属 `mooc-manus/.harness/knowledge/` 与 `mooc-manus-web/.harness/knowledge/`，不在这里。

knowledge 与 rules 的差异：
- **rules**（`.harness/rules/`）告诉 agent **必须做什么 / 不能做什么**，是约束正文，违反会被 hook 拦截
- **knowledge**（本目录）告诉 agent **为什么、怎么理解、长什么样**，是上下文，按需检索

因此本目录文档不重复 rule 约束正文（如"禁止 force push"不会再写一次），只通过 `R-XX` 交叉引用指向规则。

## 阅读顺序

新成员（人或 AI agent）首次进入项目，建议按下面顺序读：

| # | 文档 | 何时读 |
|---|---|---|
| 1 | [architecture-overview.md](./architecture-overview.md) | 想建立"三仓 + DDD + 事件驱动"心智模型时 |
| 2 | [glossary.md](./glossary.md) | 遇到不认识的术语（Agent / Invoker / DO / DTO / Skill ...）时 |
| 3 | [event-protocol.md](./event-protocol.md) | 改 SSE 事件、调试 / 实现前后端 streaming 时 |
| 4 | [submodule-workflow.md](./submodule-workflow.md) | 准备升级子模块指针 / 解决跨仓冲突时 |
| 5 | [deployment-topology.md](./deployment-topology.md) | 本地起服 / 排查端口或依赖问题时 |

## 文档清单

### [architecture-overview.md](./architecture-overview.md)

全栈架构总图（Mermaid）。给出三仓职责、DDD 四层、Domain 层核心模型（Agent / Invoker / Tool / Memory / Prompt）、外部依赖（LLM / MCP / A2A / Docker）的关系。含"典型对话流程"与"子仓协作流程"两个数据流示例。交叉引用：R-10 / R-20 / R-40 / R-42 / R-43 / R-45。

### [glossary.md](./glossary.md)

16 个核心术语的定义、语境、关键特征、相关 rule_id：Agent / Tool / Plan / Step / Event / Memory / Prompt / DO / DTO / PO / Skill / MCP / A2A / Invoker / Message / ToolCall。结尾给出术语关系图（PO ↔ DO ↔ DTO 转换链、Domain → Application → Frontend 事件推送链）。

### [event-protocol.md](./event-protocol.md)

16 种 SSE 事件的逐个详解（触发条件 / payload 必填字段 / 顺序约束 / 前端处理 / 例子）。按"消息 / 工具 / 计划 / 步骤 / 系统"五组归类。是 R-20（跨仓契约）与 R-45（事件发布）的展开形态——任何前后端事件相关变更都应先读它。

### [submodule-workflow.md](./submodule-workflow.md)

git submodule 日常工作流剧本：单子仓开发、跨仓协同、合并冲突中的指针处理。含历史 commit message 形态参考（`chore: 升级子模块指针(...)`）。是 R-10 的可重放展开。

### [deployment-topology.md](./deployment-topology.md)

本地开发拓扑（端口、依赖、启动顺序、配置文件位置）。生产拓扑暂为占位章节，列出未来扩展需要的决策项（编排 / TLS / 数据持久化 / Key 管理 / CI/CD），生产化前需先写 ADR（R-30）。

## 与其他目录的关系

- **`.harness/rules/`**：规则正文（R-00 ~ R-32）。本目录通过 `R-XX` 引用，不复制正文
- **`.harness/playbooks/`**（Phase 6 落地）：任务剧本（如 `upgrade-submodule.md`），步骤级操作指引；与本目录差异见 spec §3.6
- **`.harness/specs/` 与 `.harness/plans/`**：决策与实施记录，knowledge 沉淀自 spec 但不替代 spec
- **子仓 knowledge**：`mooc-manus/.harness/knowledge/` 放 Go / DDD / Agent 内核；`mooc-manus-web/.harness/knowledge/` 放 React / SSE client / 状态管理

## 维护约定

- 新增文档：单独 commit `feat(harness): knowledge/<name>.md`，并在本 README 加入清单
- 每份控制在 50-120 行（背景 / 现状 / 例子 / 验证四段为主）
- 引用 rule 时一律用 `R-XX` 短码，不复制规则正文
- 引用 spec 时用"参见 spec §X.Y"，不复制整段
- 内容必须与代码现状一致——发现漂移时优先修文档，必要时反向修代码

## 验证方式

```bash
# 文档数量
ls .harness/knowledge/ | grep -v gitkeep | wc -l   # 应为 6

# 每份是否含 R-XX 交叉引用
grep -L "R-[0-9]" .harness/knowledge/*.md          # 应为空

# Mermaid 图（架构图至少一处）
grep -l mermaid .harness/knowledge/architecture-overview.md

# harness 整体校验
./.harness/scripts/validate-harness.sh
```

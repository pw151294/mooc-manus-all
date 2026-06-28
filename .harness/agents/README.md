# 总仓 Agents 索引

本目录定义 `mooc-manus-all`（总仓）层级的 harness subagent。Agent 是带固定 frontmatter + 检查清单 + 检查 prompt 的 markdown 文件，供 CI / pre-commit / 人工 review 时按需调用。

## 设计原则

- **一个 agent 聚焦一条 rule**：保证职责单一；多条 rule 的复合校验由 workflow 编排。
- **Agent ≠ rule**：rule 是给"人 / 写代码的 LLM"的规约说明，agent 是给"做 review 的 LLM / 脚本"的可执行检查器。
- **路径绝对化**：检查 prompt 中提到的代码路径一律相对仓库根目录，避免在子模块上下文中歧义。

## 可用 agents

| Agent | 关联 Rule | 适用场景 |
|---|---|---|
| `submodule-discipline-checker` | R-10-submodule | PR 触及 `.gitmodules` / submodule 指针；commit message 含"升级子模块" |
| `event-contract-checker` | R-20-contracts | 后端 `events/constants.go` 或 `applications/dtos/*` 变更；前端 `src/api/sse.ts` 或 `src/types/sse.ts` 变更 |

## 调用方式（v1.0）

当前 v1.0 不在 manifest.yaml 的 `execution.agents` 字段中登记 agents（延后到 v1.1）。调用方式：
- **CI**：`.harness/scripts/validate-harness.sh` 可遍历 agents 目录，对触发条件命中的 agent 执行 prompt（实际接入见 Phase 10 / Phase 12）。
- **人工**：将 agent markdown 的"检查 Prompt"段落复制给任意 LLM subagent，附上输入材料即可执行。

## v1.1 规划

- 在 manifest.yaml `execution.agents` 中正式登记 agents 与触发条件
- 新增跨仓 release-readiness-checker（综合 R-30 / R-10）
- 与 `.harness/workflows/` 联动，由 spec→plan→implement 流程自动 dispatch

## 添加新 agent 的步骤

1. 在本目录创建 `<name>.md`，含三段：frontmatter / 检查清单 / 检查 prompt。
2. frontmatter 必备字段：`name / description / when_to_use / inputs / outputs`。
3. 检查清单引用至少一条 `rule_id`（保证可追溯）。
4. 更新本 README 的"可用 agents"表格。
5. 单独 commit：`feat(harness): agents/<name>.md`。

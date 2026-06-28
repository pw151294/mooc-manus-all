# Brainstorm 输出模板

> 驱动 skill：`superpowers:brainstorming`。本模板是 brainstorm 收尾沉淀产物的章节骨架，不是 brainstorming 流程本身。

填写时机：brainstorm 接近 converge 阶段，准备转写 spec 之前。产物路径建议：`docs/superpowers/specs/<date>-<topic>-brainstorm.md`（或直接进入 spec，不单独留底）。

---

## 1. 问题陈述

用 1-3 段写清楚：
- 现状是什么（具体到仓 / 模块 / 文件）
- 痛点 / 触发事件 / 影响面
- "不解决会怎样"

## 2. 候选方案（≥ 2 个，建议 3 个）

### 方案 A：<一句话命名>

- 核心思路：
- 关键改动点（按 DDD 分层列：interfaces / applications / domains / infrastructure；前端按 features/ui-kit/services 列）：
- 是否引入新跨仓契约（SSE 事件 / DTO / API path）：
- 成本估算：

### 方案 B：<一句话命名>

（同上结构）

### 方案 C（可选）

## 3. 对比表

| 维度 | 方案 A | 方案 B | 方案 C |
| --- | --- | --- | --- |
| 实现成本 |  |  |  |
| 跨仓契约影响 |  |  |  |
| 向后兼容 |  |  |  |
| 可观测性 |  |  |  |
| 风险（R-31 注入 / R-32 secrets / R-20 契约） |  |  |  |
| 落地周期 |  |  |  |

## 4. 推荐选项 + 理由

- 选定：方案 X
- 关键理由（3 条以内）：
- 主动放弃的能力（YAGNI 列表）：
- 已识别但暂不处理的风险（含 mitigation 时点）：

## 5. 下一步

- [ ] 转写 spec：`docs/superpowers/specs/<date>-<topic>-design.md`
- [ ] 或直接进 plan：`docs/superpowers/plans/<date>-<topic>.md`
- [ ] 是否需要 ADR：是 / 否（若是，落在 `.harness/retro/adr/`）

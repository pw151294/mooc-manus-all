# 评测平台前端模块拆分索引

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**拆分日期**：2026-07-17
**拆分方法**：按"技术分层 + 业务边界"切片，5 个模块相互依赖清晰、可独立交付

---

## 模块列表

| 模块 | Spec | E2E | 依赖 | 说明 |
|---|---|---|---|---|
| M1 基础设施 | [M1-infrastructure-spec.md](M1-infrastructure-spec.md) | [M1-infrastructure-e2e.md](../../e2e/eval-modules/M1-infrastructure-e2e.md) | 无 | types + api + 3 Store + 路由占位 + 菜单 |
| M2 用例管理 | [M2-case-management-spec.md](M2-case-management-spec.md) | [M2-case-management-e2e.md](../../e2e/eval-modules/M2-case-management-e2e.md) | M1 | Cases/* 5 组件（列表 + Modal + Drawer + ScriptInput） |
| M3 任务管理 | [M3-task-management-spec.md](M3-task-management-spec.md) | [M3-task-management-e2e.md](../../e2e/eval-modules/M3-task-management-e2e.md) | M1、(M2 推荐) | Tasks/* 4 组件（列表 + Filters + CreateModal） |
| M4 任务详情 | [M4-task-detail-spec.md](M4-task-detail-spec.md) | [M4-task-detail-e2e.md](../../e2e/eval-modules/M4-task-detail-e2e.md) | M1、M3 | TaskDetail/* 5 组件（Summary + Filters + InstanceTable + Drawer） |
| M5 Trace 深链 | [M5-trace-deeplink-spec.md](M5-trace-deeplink-spec.md) | [M5-trace-deeplink-e2e.md](../../e2e/eval-modules/M5-trace-deeplink-e2e.md) | M4 | Trace 页面深链改造 + 实例详情跳转 Trace |

---

## 依赖关系图

```
M1 (基础设施)
 ├── M2 (用例管理)  ─┐
 ├── M3 (任务管理) ──┤ ← 建议顺序：M1 → M2 → M3 → M4 → M5
 └── M4 (任务详情) ──┤
      └── M5 (Trace 深链) ┘
```

**关键点**：
- M2、M3、M4 都只强依赖 M1；M3 推荐（非强制）有 M2 数据可选
- M5 在 M4 之后，是收尾模块（改动 Trace 页面 + 完成 InstanceDrawer 的「查看 Trace」按钮）

---

## 拆分依据

**为何拆成 5 个而不是 3 个（按后端 CRUD 分组）或 6 个（按父规格 Phase）**：

1. **M1 单独抽出**：类型 + API + Store + 路由骨架是所有 UI 模块的共用基础，早交付可使后续模块并行开发；
2. **M2 / M3 / M4 按业务功能拆**：Cases / Tasks / TaskDetail 分别对应 3 个独立路由，UI 组件互不重叠；
3. **M5 单独拎出**：Trace 深链改造涉及现有 Trace 页面，改动风险独立，且是端到端体验的最后一环；
4. **Phase 6（打磨）合并到各模块 E2E**：不单独成模块，边界测试用例分散在 M2 ~ M5 的 e2e 中。

---

## 与父规格的关系

- 父规格是设计源头，包含完整的架构决策、组件设计、E2E 场景（父规格 §7 是每个模块 spec 的详情来源）
- 5 个子模块规格**从父规格切片而来**，各自可独立 spec → plan → implementation
- 子规格中引用父规格章节号（如"详见父规格 §7.1.4"），阅读时可交叉参考
- 若需修改核心决策，改父规格，再同步子规格

---

## 执行方式

每个模块可独立走 `superpowers:writing-plans` 生成 plan，再走 `superpowers:executing-plans` 或 `subagent-driven-development` 执行。

**推荐顺序**：M1 → M2 → M3 → M4 → M5，每完成一模块跑对应 E2E。

M2 / M3 也可并行开发（都只强依赖 M1）。

---

**索引版本**：v1.0

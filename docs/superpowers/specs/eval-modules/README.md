# 评测平台前端模块拆分索引

**父规格**：`../2026-07-17-eval-platform-frontend-design.md`
**拆分日期**：2026-07-17

---

## 模块列表

| 模块 | Spec | E2E | 依赖 | 说明 |
|---|---|---|---|---|
| M1 基础设施 | [M1-infrastructure-spec.md](./M1-infrastructure-spec.md) | [M1-infrastructure-e2e.md](../../plans/eval-modules/M1-infrastructure-e2e.md) | 无 | types + api + 3 Store + 路由占位 + 菜单 |
| M2 用例管理 | [M2-case-management-spec.md](./M2-case-management-spec.md) | [M2-case-management-e2e.md](../../plans/eval-modules/M2-case-management-e2e.md) | M1 | Cases/* 5 组件 |
| M3 任务管理 | [M3-task-management-spec.md](./M3-task-management-spec.md) | [M3-task-management-e2e.md](../../plans/eval-modules/M3-task-management-e2e.md) | M1、(M2 推荐) | Tasks/* 4 组件 |
| M4 任务详情 | [M4-task-detail-spec.md](./M4-task-detail-spec.md) | [M4-task-detail-e2e.md](../../plans/eval-modules/M4-task-detail-e2e.md) | M1、M3 | TaskDetail/* 5 组件 |
| M5 Trace 深链 | [M5-trace-deeplink-spec.md](./M5-trace-deeplink-spec.md) | [M5-trace-deeplink-e2e.md](../../plans/eval-modules/M5-trace-deeplink-e2e.md) | M4 | Trace 页面深链改造 |

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
- M5 在 M4 之后，是收尾模块

---

## 与父规格的关系

- 父规格是设计源头，包含完整的架构决策、组件设计、E2E 场景
- 5 个子模块规格**从父规格切片而来**，各自可独立 spec → plan → implementation
- 子规格中大量引用父规格章节号（如"详见父规格 §7.1.4"），阅读时可交叉参考
- 若需修改核心决策，改父规格，再同步子规格

---

## 执行方式

每个模块可独立走 `superpowers:writing-plans` 生成 plan，再走 `superpowers:executing-plans` 或 `subagent-driven-development` 执行。

**推荐顺序**：M1 → M2 → M3 → M4 → M5，每完成一模块跑对应 E2E。

---

**索引版本**：v1.0

# 评测平台前端 模块拆分索引

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**拆分日期**：2026-07-17
**拆分维度**：A（按页面/用户旅程）+ C（按分层/依赖阶段）

---

## 模块列表

| 模块 | Spec | E2E | 依赖 | 说明 |
|---|---|---|---|---|
| M1 基础设施 | [M1-infrastructure-spec.md](M1-infrastructure-spec.md) | [M1-infrastructure-e2e.md](../../e2e/eval-modules/M1-infrastructure-e2e.md) | 无 | types + api + store + 路由/菜单，无 UI，其余模块的地基 |
| M2 用例管理 | [M2-case-management-spec.md](M2-case-management-spec.md) | [M2-case-management-e2e.md](../../e2e/eval-modules/M2-case-management-e2e.md) | M1 | `pages/Eval/Cases/` 全 CRUD + 脚本上传 |
| M3 任务管理 | [M3-task-management-spec.md](M3-task-management-spec.md) | [M3-task-management-e2e.md](../../e2e/eval-modules/M3-task-management-e2e.md) | M1；(M2 弱依赖，测试数据用) | `pages/Eval/Tasks/` 列表 + 创建 + 5s 轮询 |
| M4 任务详情 | [M4-task-detail-spec.md](M4-task-detail-spec.md) | [M4-task-detail-e2e.md](../../e2e/eval-modules/M4-task-detail-e2e.md) | M1、M3 | `pages/Eval/TaskDetail/` + 实例 Drawer + 3s 轮询 |
| M5 Trace 深链 | [M5-trace-deeplink-spec.md](M5-trace-deeplink-spec.md) | [M5-trace-deeplink-e2e.md](../../e2e/eval-modules/M5-trace-deeplink-e2e.md) | M1、M4；改造 `pages/Trace/` | 实例 → Trace 跨页面跳转 + `?traceId=` 深链 |

---

## 依赖关系图

```
M1 (基础设施：types / api / store / 路由)
 ├── M2 (用例管理页)
 ├── M3 (任务管理页)  ← 弱依赖 M2（需要用例数据才能创建任务）
 │    └── M4 (任务详情 + 实例)
 │         └── M5 (Trace 深链：改造 Trace 页 + 实例 Drawer 跳转按钮)
 └── ...

建议顺序：M1 → M2 → M3 → M4 → M5
```

**关键点**：

- M2、M3 从 M1 的 store/api 分叉，可小规模并行（各自 owner 分开）；但 M3 用例选择器依赖 M2 已有用例才能验收创建流，串行更稳
- M4 强依赖 M3（任务列表→详情页路由跳转 + `taskId` 参数）
- M5 是"集成层"，同时改造既有 `pages/Trace/` 与 M4 的 Drawer，必须在 M4 稳定后进入
- 父规格 §10.6 "Phase 6 边界打磨"是横切收尾工作，不作为独立模块——每个模块自己的 e2e 已经覆盖各自边界，最终整体通过 M1–M5 的验收清单即视为达标

---

## 与父规格的关系

- 父规格是设计源头，包含完整的架构决策、组件设计、E2E 场景
- 子模块规格**从父规格切片而来**，各自可独立 spec → plan → implementation
- 子规格中大量引用父规格章节号（如"详见父规格 §7.1.4"），阅读时可交叉参考
- 若需修改核心决策（如路由结构、字段命名、轮询间隔），改父规格，再回同步子规格

---

## 执行方式

每个模块可独立走 `superpowers:writing-plans` 生成 plan，再走 `superpowers:executing-plans` 或
`subagent-driven-development` 执行。

**推荐顺序**：M1 → M2 → M3 → M4 → M5，每完成一模块跑对应 E2E。

---

**索引版本**：v1.0

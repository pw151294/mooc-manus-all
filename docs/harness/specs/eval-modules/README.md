# Eval Platform Frontend 模块拆分索引

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`  
**拆分日期**：2026-07-17

---

## 模块列表

| 模块 | Spec | E2E | 依赖 | 说明 |
|---|---|---|---|---|
| M1 基础设施 | [M1-infrastructure-spec.md](M1-infrastructure-spec.md) | [M1-infrastructure-e2e.md](../../e2e/eval-modules/M1-infrastructure-e2e.md) | 无 | 搭建类型、API、store、路由与菜单基座。 |
| M2 用例管理 | [M2-case-management-spec.md](M2-case-management-spec.md) | [M2-case-management-e2e.md](../../e2e/eval-modules/M2-case-management-e2e.md) | M1 | 交付用例 CRUD、脚本上传/编辑、搜索过滤与分页。 |
| M3 任务管理 | [M3-task-management-spec.md](M3-task-management-spec.md) | [M3-task-management-e2e.md](../../e2e/eval-modules/M3-task-management-e2e.md) | M1、M2 推荐 | 交付任务列表、创建任务、状态过滤、删除/重试与 5s 轮询。 |
| M4 任务详情与实例 | [M4-task-detail-instances-spec.md](M4-task-detail-instances-spec.md) | [M4-task-detail-instances-e2e.md](../../e2e/eval-modules/M4-task-detail-instances-e2e.md) | M1、M3 | 交付任务详情、实例列表、实例 Drawer、实例操作与 3s 轮询。 |
| M5 Trace 深链与联动 | [M5-trace-deeplink-spec.md](M5-trace-deeplink-spec.md) | [M5-trace-deeplink-e2e.md](../../e2e/eval-modules/M5-trace-deeplink-e2e.md) | M1、M4 | 交付实例到 Trace 的新 tab 跳转与 `/traces?traceId=` 自动开 Modal。 |

---

## 依赖关系图

```text
M1 基础设施
 ├── M2 用例管理
 ├── M3 任务管理（推荐复用 M2 产出的用例数据，但可用 API 预置数据独立验收）
 │    └── M4 任务详情与实例
 │         └── M5 Trace 深链与联动
 └── M5 Trace 深链与联动（复用 M1 的 getInstanceTrace API）

建议顺序：M1 → M2 → M3 → M4 → M5
```

**关键点**：

- M1 是强基础层，后续模块都依赖它的类型、API、store、路由或菜单基座。
- M2 与 M3 在实现上可部分并行；M3 可通过 API 预置用例独立验收，但完整用户流推荐先完成 M2。
- M4 强依赖 M3 的任务入口与任务数据。
- M5 是集成层，依赖 M4 的 InstanceDrawer 入口与 Trace 页面既有能力。
- 父规格 §10.6「边界测试与打磨」不单独拆模块，已分摊到 M1–M5 各自 e2e 的边界、异常、空状态、轮询停止和 A11y 检查中。

---

## 与父规格的关系

- 父规格是设计源头，包含完整架构决策、组件设计、E2E 场景与后端契约。
- 子模块规格从父规格切片而来，分别对齐父规格 §10.1–§10.5 的实施阶段。
- 子规格尽量引用父规格章节号，避免复制大段实现细节；核心决策仍以父规格为准。
- 若需修改核心交互、后端契约、路由结构或轮询策略，应先更新父规格，再同步对应子规格与 e2e。

---

## 执行方式

每个模块可独立走 `superpowers:writing-plans` 生成 plan，再走 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 执行。

推荐节奏：

1. M1 完成后先跑技术层验证，确认类型/API/store/路由基座可用。
2. M2、M3 交付后分别跑页面级功能验证，再补跑 M3 中引用 M2 的跨模块检查。
3. M4 完成后跑任务详情与实例验证，确认轮询停止和 Drawer 长文本场景。
4. M5 完成后跑跨页面深链验证，并回归 Trace 原有列表/详情行为。

---

**索引版本**：v1.0

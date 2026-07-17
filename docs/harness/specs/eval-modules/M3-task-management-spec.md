# M3 任务管理模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`  
**模块编号**：M3  
**依赖**：M1（types + api + `store/evalTask.ts` + 路由/菜单基座）；M2 推荐但非强制  
**被依赖**：M4

---

## 1. 模块范围

本模块交付评测任务列表、状态过滤、任务创建、任务删除、任务重试入口和任务列表智能轮询，使用户可以基于多个用例与多个 Agent 配置批量创建 M×N 评测实例。

### 1.1 交付物

- 页面容器：`mooc-manus-web/src/pages/Eval/Tasks/index.tsx`
- 表格组件：`mooc-manus-web/src/pages/Eval/Tasks/TaskTable.tsx`
- 创建任务组件：`mooc-manus-web/src/pages/Eval/Tasks/TaskCreateModal.tsx`
- 过滤组件：`mooc-manus-web/src/pages/Eval/Tasks/TaskFilters.tsx`
- 复用 M1：`store/evalTask.ts`、`api/modules/eval.ts`、`types/eval.ts`
- 复用 M1/M2 数据能力：`listCases({ page: 1, size: 100 })`、`listAgentConfigs()`

### 1.2 非目标

- 不实现用例 CRUD 页面（属 M2）。
- 不实现任务详情页和实例列表（属 M4）。
- 不实现 Trace 跳转（属 M5）。
- 不实现后端没有提供的任务编辑能力。
- 不为 500+ 用例做服务端分页懒加载；初版按父规格使用一次性拉取前 100 条。

---

## 2. 页面与组件设计

### 2.1 `Tasks/index.tsx`

负责组装状态过滤器、创建按钮、任务表格和创建任务 Modal。

生命周期：

- 首次进入调用 `evalTask.fetchTasks()`。
- 进入后调用 `evalTask.startPolling()`。
- 离开页面调用 `evalTask.stopPolling()`。

行点击：

- 点击任务行跳转 `/eval/tasks/:id`，由 M4 交付详情页。

**详见父规格 §7.2.1、§4.1.2。**

### 2.2 `TaskTable.tsx`

展示任务列表、状态、进度、时间和操作列。

列要求：

- 名称：纯文本。
- 状态：按状态映射 `Tag` 颜色。
- 进度：显示成功 / 失败 / 运行中 / 总计。
- 创建时间、开始时间、结束时间：格式化，可空显示 `--`。
- 操作：查看详情 / 重试 / 删除。

交互要求：

- 行可点击进入详情。
- 行具备键盘可访问基础：`tabIndex=0`、`role="button"`、`aria-label`。
- 操作按钮点击时避免冒泡触发行跳转。

**详见父规格 §7.2.2、§9.4。**

### 2.3 `TaskCreateModal.tsx`

提供三段式任务创建流程：任务名、双 Transfer 选择、M×N 实例数量预览。

数据加载：

- Modal 打开时调用 `listCases({ page: 1, size: 100 })`。
- Modal 打开时调用 `listAgentConfigs()`。
- 不走 `evalCase` store，避免污染用例列表页状态。

提交要求：

- `name`、`case_ids`、`agent_config_ids` 必填。
- 底部实时显示 `M × N = X`。
- 提交成功后关闭 Modal、刷新任务列表，并确保任务轮询继续运行。

**详见父规格 §4.2.1、§7.2.3。**

### 2.4 `TaskFilters.tsx`

用 `Radio.Group` 提供任务状态过滤。

选项：

- 全部：`''`
- 待执行：`PENDING`
- 运行中：`RUNNING`
- 已完成：`SUCCEEDED`
- 失败：`FAILED`

切换后调用 `evalTask.applyFiltersAndFetch({ status })`。

**详见父规格 §7.2.4。**

---

## 3. 数据流 / 关键实现细节

```text
进入任务页 → evalTask.fetchTasks() + startPolling()
状态过滤 → TaskFilters → evalTask.applyFiltersAndFetch()
创建任务 → TaskCreateModal → listCases + listAgentConfigs → createTask()
任务操作 → TaskTable → retryTask/deleteTask → list 刷新
点击任务 → navigate('/eval/tasks/:id') → M4 详情页
```

智能轮询要求：

- 若列表含 `PENDING` 或 `RUNNING`，每 5 秒刷新任务列表。
- 若所有任务均为终态，自动停止轮询。
- 页面卸载时必须停止轮询。
- 创建任务成功后，新任务通常为 `PENDING`，应确保轮询重新启动。

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 任务创建 | 双 Transfer + M×N 预览 | §4.2.1、§7.2.3、§13.2 |
| Agent 来源 | `listAgentConfigs()` | §5.1、§7.2.3 |
| 用例来源 | `listCases({ page: 1, size: 100 })`，不污染 evalCase store | §4.2.1、§7.2.3 |
| 列表实时性 | 5 秒智能轮询 | §4.1.2、§9.2.2 |
| 任务编辑 | 不做编辑，只删除/重试 | §1.3、§13.2 |
| 详情入口 | 行点击跳转 `/eval/tasks/:id` | §3.1、§7.2.2 |

---

## 5. 验证边界

**功能验证**：见 `../../e2e/eval-modules/M3-task-management-e2e.md`。  
**依赖前置**：M1 已交付；后端 eval task 与 agent config API 可用。M2 已交付时可直接从 UI 创建用例；否则可通过 API 预置用例。

---

## 6. 交付验收

- [ ] 4 个 `Tasks/` 组件文件已创建。
- [ ] 任务列表、状态过滤、分页、删除、重试入口可用。
- [ ] 创建任务 Modal 可加载用例与 Agent，能正确计算 M×N。
- [ ] 创建任务成功后列表刷新并触发轮询。
- [ ] 有活动任务时轮询继续，全部终态后轮询停止，离开页面后轮询停止。
- [ ] M3 e2e 文档所有检查项通过。
- [ ] M4 可基于任务行跳转交付详情页。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4.1.2、§4.2.1、§7.2、§9.2.2、§10.3

# M1 基础设施模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`  
**模块编号**：M1  
**依赖**：无  
**被依赖**：M2、M3、M4、M5

---

## 1. 模块范围

本模块为评测平台前端搭建基础能力：类型定义、API 封装、状态管理、路由与菜单入口，使后续页面模块可以直接复用统一的数据访问与状态流。

### 1.1 交付物

- 类型定义：`mooc-manus-web/src/types/eval.ts`
  - `CaseView` / `CaseCreateRequest` / `CaseUpdateRequest` / `ListCasesQuery` / `UploadContentResp`
  - `TaskView` / `TaskCreateRequest` / `ListTasksQuery` / `RetryTaskResp`
  - `InstanceView` / `ResultView` / `ListInstancesQuery`
  - `AgentConfigView` / `ListPage<T>`
- API 层：`mooc-manus-web/src/api/modules/eval.ts`
  - Case：`uploadContent`、`createCase`、`updateCase`、`listCases`、`getCase`、`deleteCase`
  - Task：`createTask`、`listTasks`、`getTask`、`retryTask`、`deleteTask`
  - Instance：`listInstances`、`getInstance`、`getInstanceTrace`、`retryInstance`、`deleteInstance`
  - Agent Config：`listAgentConfigs`
- 状态管理：`mooc-manus-web/src/store/evalCase.ts`
- 状态管理：`mooc-manus-web/src/store/evalTask.ts`
- 状态管理：`mooc-manus-web/src/store/evalInstance.ts`
- 路由注册：修改 `mooc-manus-web/src/router/index.tsx`
- 菜单入口：修改 `mooc-manus-web/src/components/Layout/index.tsx`
- 目录结构：创建 `mooc-manus-web/src/pages/Eval/Cases/`、`mooc-manus-web/src/pages/Eval/Tasks/`、`mooc-manus-web/src/pages/Eval/TaskDetail/`

### 1.2 非目标

- 不实现用例管理 UI（属 M2）。
- 不实现任务管理 UI（属 M3）。
- 不实现任务详情与实例展示 UI（属 M4）。
- 不实现 Trace 深链打开逻辑（属 M5）。
- 不新增后端 API，不改变后端 DTO 字段命名。

---

## 2. 类型与 API 设计

### 2.1 类型定义

`types/eval.ts` 必须 1:1 映射后端 DTO，字段名保持 snake_case，不做驼峰转换。

**详见父规格 §6.1、§6.2。**

### 2.2 API 封装

`api/modules/eval.ts` 复用 `src/api/request.ts`，按 Case / Task / Instance / Agent Config 分组导出函数。

关键要求：

- 文件上传使用 `FormData`，字段名为 `file`。
- `updateCase` 只传变更字段，保留 `undefined` 字段不序列化的语义。
- 409、413 等错误继续交由 request 拦截器统一提示，UI 层不重复处理。

**详见父规格 §5.1、§5.2、附录 A。**

---

## 3. Store 设计

### 3.1 `store/evalCase.ts`

负责用例列表、分页、过滤、创建、更新、删除。用例是静态数据，不做轮询。

关键要求：

- `page` 为 1-based。
- `filters` 包含 `nameLike` 与 `tags`。
- `fetchCases()` 使用模块级 `AbortController` 处理并发请求竞态。
- `applyFiltersAndFetch()` 应重置分页到第 1 页。

**详见父规格 §4.1.1。**

### 3.2 `store/evalTask.ts`

负责任务列表、分页、状态过滤、创建、删除、重试和 5 秒智能轮询。

关键要求：

- 仅在任务列表中存在 `PENDING` 或 `RUNNING` 时继续轮询。
- 轮询刷新不应制造明显表格闪烁。
- 离开任务列表页时由页面调用 `stopPolling()`。

**详见父规格 §4.1.2。**

### 3.3 `store/evalInstance.ts`

负责某个任务下的实例列表、分页、状态过滤、单实例重试/删除和 3 秒智能轮询。

关键要求：

- `taskId` 表示当前查看的任务。
- `startPolling(taskId)` 与 `fetchInstances(taskId)` 必须绑定同一个任务上下文。
- 离开详情页时调用 `stopPolling()` 与 `reset()`。

**详见父规格 §4.1.3。**

---

## 4. 路由与菜单基座

### 4.1 路由注册

新增 `/eval` 路由组：

- `/eval/cases` → `EvalCasesPage`
- `/eval/tasks` → `EvalTasksPage`
- `/eval/tasks/:id` → `TaskDetailPage`

在 M1 中可使用最小占位页面或懒加载引用，保证路由编译通过；完整页面由 M2/M3/M4 交付。

**详见父规格 §3.1、§8.1。**

### 4.2 Layout 菜单

新增父级菜单「评测平台」，包含「用例管理」与「任务管理」两个子项。

**详见父规格 §3.1、§8.2。**

---

## 5. 数据流 / 关键实现细节

基础设施层的数据流为：

```text
页面模块 → eval store → api/modules/eval.ts → request.ts → 后端 /api/eval/*
       ← Zustand 状态更新 ← DTO 响应 ←
```

关键边界：

- Store 只保存当前页面需要的列表状态，不引入全局缓存。
- API 层不改变字段名，保持后端契约可追踪。
- 路由和菜单只提供入口，不在 M1 内实现完整交互。
- 轮询定时器由 store 管理，生命周期由页面模块触发。

---

## 6. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 技术栈 | React 19 + TypeScript + Zustand + Ant Design + Axios | §2.1 |
| 字段命名 | API 与类型层透传 snake_case | §2.2、§6.1 |
| 数据访问 | 复用 `request.ts` 拦截器 | §2.1、§5.2.3 |
| 轮询策略 | 任务 5s、实例 3s，终态停止 | §4.1.2、§4.1.3、§13.2 |
| 路由结构 | `/eval/cases`、`/eval/tasks`、`/eval/tasks/:id` | §3.1、§8.1 |
| 菜单结构 | 「评测平台」父菜单 + 两个子项 | §3.1、§8.2 |

---

## 7. 验证边界

**技术验证**：见 `../../e2e/eval-modules/M1-infrastructure-e2e.md`。  
**覆盖范围**：类型导出、API 函数、store action、路由注册、菜单入口、轮询启停。

---

## 8. 交付验收

- [ ] `types/eval.ts` 已创建且 DTO 字段与父规格 §6.1 一致。
- [ ] `api/modules/eval.ts` 已创建且覆盖父规格 §5.1 的全部函数。
- [ ] 三个 eval store 已创建，分页、过滤、竞态、轮询职责清晰。
- [ ] `/eval/cases`、`/eval/tasks`、`/eval/tasks/:id` 路由注册可编译。
- [ ] Layout 菜单出现「评测平台」父级入口。
- [ ] M1 e2e 技术验证文档所有检查项通过。
- [ ] 不阻塞 M2、M3、M4、M5 基于本模块继续交付。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §2、§3、§4、§5、§6、§8.1、§8.2、§10.1

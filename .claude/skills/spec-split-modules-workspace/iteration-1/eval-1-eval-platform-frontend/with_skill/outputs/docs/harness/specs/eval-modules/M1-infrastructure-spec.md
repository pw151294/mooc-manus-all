# M1 基础设施模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M1
**依赖**：无
**被依赖**：M2、M3、M4、M5

---

## 1. 模块范围

搭建评测平台前端的"地基"层：类型定义、API 封装、Zustand store（含轮询）、路由与菜单注册。
本模块**没有页面**，交付后可通过 devtools 与 curl 验证；上层业务模块（M2–M5）
的所有 UI 都在此之上组装。

对应父规格 §10.1 Phase 1。

### 1.1 交付物

- 类型定义：`src/types/eval.ts`
  - Case 相关：`CaseView`、`CaseCreateRequest`、`CaseUpdateRequest`、`ListCasesQuery`、`UploadContentResp`
  - Task 相关：`TaskView`、`TaskCreateRequest`、`ListTasksQuery`、`RetryTaskResp`、`TaskStatus` 枚举
  - Instance 相关：`InstanceView`、`ListInstancesQuery`、`InstanceStatus` 枚举、`InstanceResult`
  - Agent Config：`AgentConfigView`
  - 通用分页：`ListPage<T>`
  - 详见父规格 §6.1（15+ 个 DTO 接口）
- API 层：`src/api/modules/eval.ts`（16 个函数，snake_case 透传）
  - Case 6 个：`uploadContent` / `createCase` / `updateCase` / `listCases` / `getCase` / `deleteCase`
  - Task 5 个：`createTask` / `listTasks` / `getTask` / `retryTask` / `deleteTask`
  - Instance 5 个：`listInstances` / `getInstance` / `getInstanceTrace` / `retryInstance` / `deleteInstance`
  - Agent Config 1 个：`listAgentConfigs`
- Store 三份（Zustand + AbortController 竞态处理）：
  - `src/store/evalCase.ts` — 无轮询
  - `src/store/evalTask.ts` — 5s 轮询（父规格 §4.1.2）
  - `src/store/evalInstance.ts` — 3s 轮询（父规格 §4.1.3）
- 路由与菜单：
  - `src/router/index.tsx` 追加 `/eval/cases`、`/eval/tasks`、`/eval/tasks/:id` 三条空占位路由（渲染 `<div>TODO M2/M3/M4</div>` 或 Empty）
  - `src/components/Layout/index.tsx` 新增"评测平台"父菜单 + 两条子项（图标：ExperimentOutlined）
- 目录骨架：
  - `src/pages/Eval/Cases/index.tsx`、`src/pages/Eval/Tasks/index.tsx`、`src/pages/Eval/TaskDetail/index.tsx`
    仅放一个占位组件，供 M2/M3/M4 替换

### 1.2 非目标

- 不做任何 UI 组件（表格、Modal、Drawer 均属 M2/M3/M4）
- 不做业务级错误 toast（复用 `request.ts` 现有拦截器）
- 不改造 `pages/Trace/`（属 M5）
- 不加 Monaco/CodeMirror 等编辑器依赖（父规格 §2.2「无新依赖」）

---

## 2. 类型设计要点

### 2.1 snake_case 透传

**决策**：字段名与后端 DTO 完全一致（`created_at`、`total_count`、`agent_latency_ms` 等），
不做 camelCase 转换。与现有 `types/trace.ts` 对齐。

**详见父规格 §2.2 设计原则、§6.1**

### 2.2 枚举收敛

- `TaskStatus`：`PENDING | RUNNING | SUCCEEDED | FAILED`（父规格 §附录 B 任务状态流转）
- `InstanceStatus`：`PENDING | RUNNING | SUCCEEDED | FAILED`（父规格 §附录 B 实例状态流转）
- 前端仅消费，不新增自定义状态

### 2.3 分页信封

```typescript
export interface ListPage<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
```

所有列表接口统一返回此结构。

---

## 3. API 层要点

### 3.1 函数签名

**详见父规格 §5.1**（15 + 1 = 16 个函数完整签名）。

### 3.2 特殊处理

- **文件上传** `uploadContent`：`multipart/form-data`，前端 `beforeUpload` 校验 10MB
  上限（父规格 §5.2.1、§9.2.5）
- **部分更新** `updateCase`：`undefined` 字段不序列化，与后端 `*string` 对齐（父规格 §5.2.2）
- **错误处理**：交给 `src/api/request.ts` 现有拦截器统一 `message.error(data?.error)`；
  本模块不写业务分支（父规格 §5.2.3）

---

## 4. Store 设计要点

### 4.1 三份 store 结构

| Store | 轮询 | 主要 state | 关键 action |
|---|---|---|---|
| `evalCase` | 无 | `cases` / `total` / `page` / `pageSize` / `filters` / `loading` | `fetchCases` / `createCase` / `updateCase` / `deleteCase` / `applyFiltersAndFetch` |
| `evalTask` | 5s（有 `PENDING/RUNNING` 时启动） | `tasks` / `total` / `page` / `pageSize` / `statusFilter` / `loading` | `fetchTasks` / `createTask` / `deleteTask` / `startPolling` / `stopPolling` |
| `evalInstance` | 3s（当前 taskId 有活动实例时） | `instances` / `total` / `currentTaskId` / `statusFilter` / `loading` | `fetchInstances(taskId)` / `retryInstance` / `deleteInstance` / `startPolling` / `stopPolling` |

**详见父规格 §4.1.1 / §4.1.2 / §4.1.3**（每份 store 的 state + action 完整签名）。

### 4.2 竞态处理

每个 fetch 类 action 内部持有一个 `AbortController`：
- 新请求发出前 `abort()` 上一次
- axios 请求配置 `signal: controller.signal`
- catch `AbortError` 时静默返回，不清空 loading

**详见父规格 §2.2 竞态安全、§4.1.2**

### 4.3 智能轮询

- `startPolling`：`setInterval` 定时调用 `fetchTasks`（或 `fetchInstances`）
- 每次 fetch 完成后检查 `tasks.some(t => t.status === 'PENDING' || t.status === 'RUNNING')`
  - 有活动 → 保持轮询
  - 全终态 → `clearInterval` + 置空 `pollingTimer`
- `stopPolling`：页面卸载时调用，防止后台请求泄漏

**详见父规格 §4.1.2 智能轮询逻辑、§9.2.5「离开页面轮询停止」**

---

## 5. 路由与菜单

### 5.1 路由结构

```
/eval
├── /cases          → <EvalCasesPage />          (占位，M2 实现)
├── /tasks          → <EvalTasksPage />          (占位，M3 实现)
└── /tasks/:id      → <TaskDetailPage />         (占位，M4 实现)
```

**详见父规格 §3.1 导航结构、§8.1 路由注册**

### 5.2 菜单

Layout 侧边栏在 Trace/Skill/Tool 之外新增一级菜单：

```
评测平台 (ExperimentOutlined)
├── 用例管理  → /eval/cases
└── 任务管理  → /eval/tasks
```

**详见父规格 §8.2**

---

## 6. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 字段命名 | snake_case 透传 | §2.2、§6.1 |
| 状态管理 | Zustand（复用现有） | §2.1 |
| 竞态处理 | AbortController，每 action 一个 | §2.2、§4.1.2 |
| 轮询间隔 | Task 5s / Instance 3s | §4.1.2 / §4.1.3 |
| 错误提示 | request.ts 拦截器统一 message.error | §5.2.3 |
| 文件上传上限 | 前端 10MB `beforeUpload` | §5.2.1、§9.2.5 |

---

## 7. 数据流

```
UI 组件 (M2/M3/M4)
  ↓ 调用 store action
Store (evalCase / evalTask / evalInstance)
  ↓ 调用 api 函数
api/modules/eval.ts
  ↓ axios 请求
后端 /api/eval/*
  ↓ JSON 响应
Store 更新 state → 触发订阅组件 re-render
```

轮询由 store 内 `setInterval` 驱动，页面 `useEffect` 负责 mount/unmount 时 start/stop。

---

## 8. 验证边界

**功能验证**：本模块无 UI，见 e2e 文档中的技术验证清单
`docs/harness/e2e/eval-modules/M1-infrastructure-e2e.md`
**技术验证**：TS 编译零错误、导出符号数量、curl 联通后端 API、devtools 中 store 三份实例存在

---

## 9. 交付验收

- [ ] `src/types/eval.ts` 存在，15+ 个 interface 导出且 TS 编译零错误
- [ ] `src/api/modules/eval.ts` 存在，16 个函数导出，`curl` 联通后端 case/task/instance
- [ ] 三份 store 存在，devtools 中可获取 store 实例并调用 action
- [ ] 路由跳转 `/eval/cases`、`/eval/tasks`、`/eval/tasks/:id` 不 404，渲染占位组件
- [ ] Layout 菜单新增"评测平台"父项 + 两条子项，图标正常
- [ ] E2E 文档所有检查项通过
- [ ] 依赖：无。不阻塞 M2–M5

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4 / §5 / §6 / §8 / §10.1

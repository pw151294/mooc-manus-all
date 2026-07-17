# M1 基础设施模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M1
**依赖**：无（评测平台的地基）
**被依赖**：M2、M3、M4、M5

---

## 1. 模块范围

搭建评测平台前端的技术地基。所有页面组件（M2-M5）都依赖本模块产出。

### 1.1 交付物

- 类型定义：`types/eval.ts`（15 个接口）
- API 层：`api/modules/eval.ts`（15 个函数）
- 状态管理：3 个 Zustand store
  - `store/evalCase.ts`（无轮询）
  - `store/evalTask.ts`（5s 智能轮询）
  - `store/evalInstance.ts`（3s 智能轮询）
- 路由骨架：`/eval/cases`、`/eval/tasks`、`/eval/tasks/:id`（占位组件）
- Layout 菜单：新增「评测平台」父菜单

### 1.2 非目标

- 不包含任何具体页面组件（属 M2-M4）
- 不包含 Trace 深链改造（属 M5）
- 不包含 E2E 功能测试（本模块只做技术层验证）

---

## 2. 类型定义（types/eval.ts）

**原则**：1:1 映射后端 DTO，字段名保持 snake_case。

**内容**：15 个接口（详见父规格 §6.1）
- Case 组：`CaseView` / `CaseCreateRequest` / `CaseUpdateRequest` / `ListCasesQuery` / `UploadContentResp`
- Task 组：`TaskView` / `TaskCreateRequest` / `ListTasksQuery` / `RetryTaskResp`
- Instance 组：`InstanceView` / `ResultView` / `ListInstancesQuery`
- 通用：`AgentConfigView` / `ListPage<T>`

---

## 3. API 层（api/modules/eval.ts）

**参考**：`api/modules/trace.ts`

**15 个函数**（详见父规格 §5.1）：
- Case（6 个）：`uploadContent` / `createCase` / `updateCase` / `listCases` / `getCase` / `deleteCase`
- Task（5 个）：`createTask` / `listTasks` / `getTask` / `retryTask` / `deleteTask`
- Instance（4 个）：`listInstances` / `getInstance` / `getInstanceTrace` / `retryInstance` / `deleteInstance`
- Agent Config（1 个）：`listAgentConfigs`

**特殊处理**：
- `uploadContent` 用 `FormData` + `multipart/form-data` header
- `updateCase` 部分字段（axios 自动过滤 undefined，对齐后端 `*string` 语义）
- 错误处理走 `request.ts` 拦截器（409/413/500 已统一处理）

---

## 4. 状态管理（3 个 Zustand Store）

**参考**：`store/trace.ts` 的 AbortController 竞态处理模式

### 4.1 `store/evalCase.ts`
- 状态：`cases / total / page / pageSize / filters(nameLike, tags) / loading`
- Actions：CRUD + 分页 + 过滤
- **无轮询**

### 4.2 `store/evalTask.ts`
- 状态：同 Case + `pollingTimer`
- Actions：CRUD（create/retry/delete）+ 分页 + 过滤 + **智能轮询**
- 轮询逻辑：5s 间隔，仅当存在 PENDING/RUNNING 时刷新，终态自动停止

### 4.3 `store/evalInstance.ts`
- 状态：`taskId / instances / total / page / pageSize / filters(status) / loading / pollingTimer`
- Actions：`fetchInstances(taskId)` / `retryInstance` / `deleteInstance` / **智能轮询（3s）** / `reset()`
- 特殊：`reset()` 清空状态 + 停轮询（离开详情页调用）

**竞态处理**：每个 store 使用模块级 `let inflight: AbortController | null`，每次 fetch 前 abort 上次请求。

---

## 5. 路由与菜单

### 5.1 路由注册

修改 `router/index.tsx`，新增：
```typescript
{
  path: 'eval',
  children: [
    { path: 'cases', element: <div>Placeholder</div> },      // M2 替换
    { path: 'tasks', element: <div>Placeholder</div> },      // M3 替换
    { path: 'tasks/:id', element: <div>Placeholder</div> },  // M4 替换
  ],
}
```

### 5.2 Layout 菜单

修改 `components/Layout/index.tsx`：
```typescript
{
  key: '/eval',
  icon: <ExperimentOutlined />,
  label: '评测平台',
  children: [
    { key: '/eval/cases', label: '用例管理' },
    { key: '/eval/tasks', label: '任务管理' },
  ],
}
```

---

## 6. 验证边界

**技术层验证**（本模块，不含功能测试）：
1. TypeScript 编译无错误
2. 3 条路由可访问（占位组件正常渲染）
3. 菜单显示「评测平台」父级 + 2 个子项
4. API 层可手动 curl/Postman 联调后端
5. Store 单元测试（可选）：轮询启停、AbortController 竞态

**功能层验证**：延后到 M2-M5，各模块结合实际页面测试。

---

## 7. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 类型透传 | snake_case，不做驼峰转换 | §2.2 |
| 状态管理 | Zustand，每个域独立 store | §4.1 |
| 竞态处理 | 模块级 AbortController | §4.1（trace.ts 模式） |
| 轮询策略 | 智能轮询，仅活动态刷新 | §4.1.2 / §4.1.3 |

---

## 8. 交付验收

- [ ] `types/eval.ts` 通过 `tsc --noEmit`
- [ ] `api/modules/eval.ts` 通过 `tsc --noEmit`
- [ ] 3 个 store 通过 `tsc --noEmit`
- [ ] 路由 `/eval/cases`、`/eval/tasks`、`/eval/tasks/:id` 可访问
- [ ] Layout 菜单可见「评测平台」父项
- [ ] 后续模块（M2）可直接 import 本模块产物

---

**文档版本**：v1.0  |  **拆分自**：父规格 §3.2、§5、§6、§4

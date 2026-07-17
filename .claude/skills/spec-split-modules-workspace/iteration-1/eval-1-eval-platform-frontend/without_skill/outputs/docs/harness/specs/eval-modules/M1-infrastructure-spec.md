# M1 基础设施规格

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`（§4、§5、§6、§8.1、§8.2）
**依赖模块**：无
**下游模块**：M2、M3、M4、M5 全部依赖 M1

---

## 1. 目标

搭建评测平台前端的技术基础层，提供类型定义、API 客户端、状态管理、路由骨架，让后续 UI 模块可以直接调用而无需自建基础设施。

**验收目标**：
- API 层可调通后端全部 15 个 endpoint（Case 6 / Task 5 / Instance 4）
- 3 个 Store 的 fetch/create/delete action 可用
- 智能轮询逻辑单独测试通过
- 路由 `/eval/cases`、`/eval/tasks`、`/eval/tasks/:id` 可访问（渲染占位组件）
- Layout 菜单出现"评测平台"父节点

---

## 2. 范围

### 2.1 in-scope（本模块交付）

| 文件 | 说明 |
|---|---|
| `src/types/eval.ts` | 15 个 DTO 接口，与后端 snake_case 1:1 |
| `src/api/modules/eval.ts` | 15 个 API 函数（含文件上传特殊处理） |
| `src/store/evalCase.ts` | 用例管理 Store（无轮询） |
| `src/store/evalTask.ts` | 任务管理 Store（5 秒轮询） |
| `src/store/evalInstance.ts` | 实例管理 Store（3 秒轮询） |
| `src/pages/Eval/Cases/index.tsx` | 空占位组件（`<div>用例管理占位</div>`） |
| `src/pages/Eval/Tasks/index.tsx` | 空占位组件 |
| `src/pages/Eval/TaskDetail/index.tsx` | 空占位组件（读取 `useParams().id`） |
| `src/router/index.tsx` | 新增 3 条评测路由 |
| `src/components/Layout/index.tsx` | 新增"评测平台"父菜单 + 2 个子菜单 |

### 2.2 out-of-scope

- 3 个页面的真实 UI（分别在 M2、M3、M4 交付）
- Trace 深链改造（M5）
- 任何 antd 表单/表格/Modal 组件实现（M2 ~ M4）

---

## 3. 详细设计

### 3.1 类型定义（`src/types/eval.ts`）

**原则**：1:1 映射后端 DTO，字段名保持 snake_case（与 `types/trace.ts` 一致）。

**导出接口清单**（详见父规格 §6.1 完整代码）：

- Case 相关：`CaseView` / `CaseCreateRequest` / `CaseUpdateRequest` / `ListCasesQuery` / `UploadContentResp`
- Task 相关：`TaskView` / `TaskCreateRequest` / `ListTasksQuery` / `RetryTaskResp`
- Instance 相关：`InstanceView` / `ResultView` / `ListInstancesQuery`
- Agent 相关：`AgentConfigView`
- 通用：`ListPage<T>`

**日期字段类型**：全部为 `string`（ISO8601），前端用 `dayjs` 格式化。

---

### 3.2 API 层（`src/api/modules/eval.ts`）

**函数签名**（15 个，详见父规格 §5.1 完整代码）：

```typescript
// ========== Case (6 个) ==========
export async function uploadContent(file: File): Promise<UploadContentResp>
export async function createCase(req: CaseCreateRequest): Promise<CaseView>
export async function updateCase(id: string, req: CaseUpdateRequest): Promise<CaseView>
export async function listCases(params: ListCasesQuery): Promise<ListPage<CaseView>>
export async function getCase(id: string): Promise<CaseView>
export async function deleteCase(id: string): Promise<void>

// ========== Task (5 个) ==========
export async function createTask(req: TaskCreateRequest): Promise<TaskView>
export async function listTasks(params: ListTasksQuery): Promise<ListPage<TaskView>>
export async function getTask(id: string): Promise<TaskView>
export async function retryTask(id: string): Promise<RetryTaskResp>
export async function deleteTask(id: string): Promise<void>

// ========== Instance (4 个) ==========
export async function listInstances(taskId: string, params: ListInstancesQuery): Promise<ListPage<InstanceView>>
export async function getInstance(id: string): Promise<InstanceView>
export async function getInstanceTrace(id: string): Promise<{ trace_id: string }>
export async function retryInstance(id: string): Promise<void>
export async function deleteInstance(id: string): Promise<void>

// ========== Agent Config (1 个) ==========
export async function listAgentConfigs(): Promise<AgentConfigView[]>
```

**特殊处理**：

1. **文件上传** — `uploadContent` 使用 `FormData` + `multipart/form-data` header（详见父规格 §5.2.1）
2. **部分更新** — `updateCase` 依赖 Axios 自动过滤 `undefined` 字段（详见父规格 §5.2.2）
3. **错误处理** — 409 / 413 由 `src/api/request.ts` 拦截器统一 `message.error(data?.error)`，API 层不做特殊处理（详见父规格 §5.2.3）

---

### 3.3 Store 设计

#### 3.3.1 `src/store/evalCase.ts`（无轮询）

**状态与 Actions**：详见父规格 §4.1.1。

**关键点**：
- **无轮询**：用例是静态数据，创建后不会自动变化
- **竞态处理**：模块级 `let inflight: AbortController | null`，每次 `fetchCases` 前 abort 上次请求
- `applyFiltersAndFetch(patch)` — 修改过滤条件时 page 重置为 1

#### 3.3.2 `src/store/evalTask.ts`（5 秒轮询）

**状态与 Actions**：详见父规格 §4.1.2。

**智能轮询逻辑**：
```typescript
startPolling() {
  // 若已有 timer，先清理
  if (get().pollingTimer) return;
  const timer = setInterval(async () => {
    await get().fetchTasks();
    // 若所有任务都是终态，停止轮询
    const hasActive = get().tasks.some(t =>
      t.status === 'PENDING' || t.status === 'RUNNING'
    );
    if (!hasActive) get().stopPolling();
  }, 5000);
  set({ pollingTimer: timer });
}
```

**页面生命周期集成**：
```typescript
useEffect(() => {
  evalTask.fetchTasks();
  evalTask.startPolling();
  return () => evalTask.stopPolling();
}, []);
```

#### 3.3.3 `src/store/evalInstance.ts`（3 秒轮询）

**状态与 Actions**：详见父规格 §4.1.3。

**关键点**：
- `taskId` 保存在 store 中，`fetchInstances(taskId)` / `startPolling(taskId)` 首参必传
- 轮询判定逻辑同 evalTask，但间隔为 3 秒
- 新增 `reset()`：清空状态（离开详情页时调用，防止 taskId 残留）

---

### 3.4 路由注册（`src/router/index.tsx`）

在现有路由树的 children 中新增：

```typescript
{
  path: 'eval',
  children: [
    { path: 'cases', element: <EvalCasesPage /> },
    { path: 'tasks', element: <EvalTasksPage /> },
    { path: 'tasks/:id', element: <TaskDetailPage /> },
  ],
}
```

3 个页面组件在本模块中先用占位实现（空 div + 页面标题），M2 / M3 / M4 分别替换为真实 UI。

---

### 3.5 Layout 菜单（`src/components/Layout/index.tsx`）

新增顶层菜单项：

```typescript
{
  key: '/eval',
  icon: <ExperimentOutlined />,  // 从 @ant-design/icons 引入
  label: '评测平台',
  children: [
    { key: '/eval/cases', label: '用例管理' },
    { key: '/eval/tasks', label: '任务管理' },
  ],
}
```

**注**：任务详情页 `/eval/tasks/:id` 不出现在菜单中（从任务列表行点击进入）。

---

## 4. 与父规格的对齐

- 目录结构：完全符合父规格 §3.2
- 状态管理：Store 结构与 Actions 完全对齐父规格 §4.1
- API 契约：15 个 endpoint 与父规格附录 A 一致
- 技术选型：无新依赖（父规格 §2.2 原则 5）

---

## 5. 验收标准

见 `M1-infrastructure-e2e.md`。核心要求：
- 路由可访问、菜单可点击
- 3 个 Store 的 CRUD Action 通过手工调用可拉到后端数据
- 智能轮询启停逻辑符合预期（详见 e2e 场景）

---

**规格版本**：v1.0
**依赖**：无
**预估工作量**：3 ~ 5 天

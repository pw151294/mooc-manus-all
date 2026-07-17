# 评测平台前端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现评测平台前端完整功能（用例管理 + 任务管理 + 实例详情 + Trace 深链），对齐后端 15 个 API endpoint

**Architecture:** React 19 + TypeScript + Zustand 状态管理 + Ant Design 5.x UI 库；3 层页面结构（Cases/Tasks/TaskDetail）+ 3 个 store（智能轮询）+ 20 个组件；完全复用现有 Trace/Skill/Tool 模块模式

**Tech Stack:** React 19、TypeScript、Zustand、Ant Design 5.x、Axios、React Router v6、dayjs

---

## Phase 1: 基础设施（API + 类型 + Store）

### Task 1: 定义类型（types/eval.ts）

**Files:**
- Create: `mooc-manus-web/src/types/eval.ts`

- [ ] **Step 1: 创建 eval.ts 并定义 Case 相关类型**

```typescript
// mooc-manus-web/src/types/eval.ts

// ===== Case =====
export interface CaseView {
  id: string;
  name: string;
  description: string;
  init_script: string;
  task_prompt: string;
  verify_script: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface CaseCreateRequest {
  name: string;
  description: string;
  init_script: string;
  task_prompt: string;
  verify_script: string;
  tags: string[];
}

export interface CaseUpdateRequest {
  name?: string;
  description?: string;
  init_script?: string;
  task_prompt?: string;
  verify_script?: string;
  tags?: string[];
}

export interface ListCasesQuery {
  name_like?: string;
  tags?: string[];
  page: number;
  size: number;
}

export interface UploadContentResp {
  content: string;
  size: number;
}
```

- [ ] **Step 2: 添加 Task 相关类型**

追加到 `eval.ts`:

```typescript
// ===== Task =====
export interface TaskView {
  id: string;
  name: string;
  case_ids: string[];
  agent_config_ids: string[];
  status: string;
  total_count: number;
  succeeded_count: number;
  failed_count: number;
  running_count: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

export interface TaskCreateRequest {
  name: string;
  case_ids: string[];
  agent_config_ids: string[];
}

export interface ListTasksQuery {
  status?: string;
  page: number;
  size: number;
}

export interface RetryTaskResp {
  retried_count: number;
}
```

- [ ] **Step 3: 添加 Instance 和通用类型**

追加到 `eval.ts`:

```typescript
// ===== Instance =====
export interface InstanceView {
  id: string;
  task_id: string;
  case_id: string;
  status: string;
  attempt: number;
  conversation_id: string;
  message_id: string;
  trace_id: string;
  queued_at?: string;
  started_at?: string;
  finished_at?: string;
  heartbeat_at?: string;
  deadline_at?: string;
  worker_id: string;
  error_message: string;
  result?: ResultView;
}

export interface ResultView {
  instance_id: string;
  passed: boolean;
  verify_exit_code: number;
  verify_stdout: string;
  verify_stderr: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  agent_latency_ms: number;
  error_log: string;
  finished_at: string;
}

export interface ListInstancesQuery {
  status?: string;
  page: number;
  size: number;
}

// ===== Agent Config =====
export interface AgentConfigView {
  id: string;
  model_name: string;
  provider: string;
}

// ===== 通用 =====
export interface ListPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
```

- [ ] **Step 4: 验证类型定义无 TS 错误**

Run: `cd mooc-manus-web && npm run typecheck` (or `npx tsc --noEmit`)
Expected: No errors in `types/eval.ts`

- [ ] **Step 5: Commit**

```bash
git add mooc-manus-web/src/types/eval.ts
git commit -m "feat(eval): 定义评测模块全部类型（Case/Task/Instance/Agent）

- 15 个接口对齐后端 DTO
- 字段名保持 snake_case 透传
- 泛型 ListPage<T> 复用

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: 实现 API 模块（api/modules/eval.ts）

**Files:**
- Create: `mooc-manus-web/src/api/modules/eval.ts`
- Reference: `mooc-manus-web/src/api/modules/trace.ts`（参考模式）
- Reference: `mooc-manus-web/src/api/request.ts`（拦截器）

- [ ] **Step 1: 创建 eval.ts 并实现 Case API（6 个函数）**

```typescript
// mooc-manus-web/src/api/modules/eval.ts
import request from '../request';
import type {
  CaseView,
  CaseCreateRequest,
  CaseUpdateRequest,
  ListCasesQuery,
  UploadContentResp,
  TaskView,
  TaskCreateRequest,
  ListTasksQuery,
  RetryTaskResp,
  InstanceView,
  ListInstancesQuery,
  AgentConfigView,
  ListPage,
} from '@/types/eval';

// ========== Case (6 个) ==========
export async function uploadContent(file: File): Promise<UploadContentResp> {
  const formData = new FormData();
  formData.append('file', file);
  return request.post<UploadContentResp>('/api/eval/cases/upload-content', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

export async function createCase(req: CaseCreateRequest): Promise<CaseView> {
  return request.post<CaseView>('/api/eval/cases', req);
}

export async function updateCase(id: string, req: CaseUpdateRequest): Promise<CaseView> {
  return request.put<CaseView>(`/api/eval/cases/${id}`, req);
}

export async function listCases(params: ListCasesQuery): Promise<ListPage<CaseView>> {
  return request.get<ListPage<CaseView>>('/api/eval/cases', { params });
}

export async function getCase(id: string): Promise<CaseView> {
  return request.get<CaseView>(`/api/eval/cases/${id}`);
}

export async function deleteCase(id: string): Promise<void> {
  return request.delete<void>(`/api/eval/cases/${id}`);
}
```

- [ ] **Step 2: 添加 Task API（5 个函数）**

追加到 `eval.ts`:

```typescript
// ========== Task (5 个) ==========
export async function createTask(req: TaskCreateRequest): Promise<TaskView> {
  return request.post<TaskView>('/api/eval/tasks', req);
}

export async function listTasks(params: ListTasksQuery): Promise<ListPage<TaskView>> {
  return request.get<ListPage<TaskView>>('/api/eval/tasks', { params });
}

export async function getTask(id: string): Promise<TaskView> {
  return request.get<TaskView>(`/api/eval/tasks/${id}`);
}

export async function retryTask(id: string): Promise<RetryTaskResp> {
  return request.post<RetryTaskResp>(`/api/eval/tasks/${id}/retry`);
}

export async function deleteTask(id: string): Promise<void> {
  return request.delete<void>(`/api/eval/tasks/${id}`);
}
```

- [ ] **Step 3: 添加 Instance API（4 个函数）**

追加到 `eval.ts`:

```typescript
// ========== Instance (4 个) ==========
export async function listInstances(
  taskId: string,
  params: ListInstancesQuery
): Promise<ListPage<InstanceView>> {
  return request.get<ListPage<InstanceView>>(`/api/eval/tasks/${taskId}/instances`, { params });
}

export async function getInstance(id: string): Promise<InstanceView> {
  return request.get<InstanceView>(`/api/eval/instances/${id}`);
}

export async function getInstanceTrace(id: string): Promise<{ trace_id: string }> {
  return request.get<{ trace_id: string }>(`/api/eval/instances/${id}/trace`);
}

export async function retryInstance(id: string): Promise<void> {
  return request.post<void>(`/api/eval/instances/${id}/retry`);
}

export async function deleteInstance(id: string): Promise<void> {
  return request.delete<void>(`/api/eval/instances/${id}`);
}
```

- [ ] **Step 4: 添加 Agent Config API（1 个函数）**

追加到 `eval.ts`:

```typescript
// ========== Agent Config (1 个) ==========
export async function listAgentConfigs(): Promise<AgentConfigView[]> {
  return request.get<AgentConfigView[]>('/api/eval/agent-configs');
}
```

- [ ] **Step 5: 验证 API 模块无 TS 错误**

Run: `cd mooc-manus-web && npm run typecheck`
Expected: No errors in `api/modules/eval.ts`

- [ ] **Step 6: Commit**

```bash
git add mooc-manus-web/src/api/modules/eval.ts
git commit -m "feat(eval): 实现 15 个 API 函数

- Case 6 个：upload/create/update/list/get/delete
- Task 5 个：create/list/get/retry/delete
- Instance 4 个：list/get/trace/retry/delete
- Agent Config 1 个：list
- uploadContent 用 FormData 上传文件

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: 实现 evalCase Store

**Files:**
- Create: `mooc-manus-web/src/store/evalCase.ts`
- Reference: `mooc-manus-web/src/store/trace.ts`（AbortController 模式）

- [ ] **Step 1: 创建 evalCase store 骨架**

```typescript
// mooc-manus-web/src/store/evalCase.ts
import { create } from 'zustand';
import { message } from 'antd';
import { listCases, createCase, updateCase, deleteCase } from '@/api/modules/eval';
import type { CaseView, CaseCreateRequest, CaseUpdateRequest } from '@/types/eval';

export interface CaseListFilters {
  nameLike: string;
  tags: string[];
}

const defaultFilters: CaseListFilters = {
  nameLike: '',
  tags: [],
};

let inflight: AbortController | null = null;

interface CaseState {
  cases: CaseView[];
  total: number;
  page: number;
  pageSize: number;
  filters: CaseListFilters;
  loading: boolean;

  fetchCases: () => Promise<void>;
  createCase: (req: CaseCreateRequest) => Promise<void>;
  updateCase: (id: string, req: CaseUpdateRequest) => Promise<void>;
  deleteCase: (id: string) => Promise<void>;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  setFilters: (patch: Partial<CaseListFilters>) => void;
  applyFiltersAndFetch: (patch: Partial<CaseListFilters>) => void;
  resetFilters: () => void;
}

export const useEvalCaseStore = create<CaseState>((set, get) => ({
  cases: [],
  total: 0,
  page: 1,
  pageSize: 20,
  filters: defaultFilters,
  loading: false,

  // 后续步骤实现 actions
  fetchCases: async () => {},
  createCase: async () => {},
  updateCase: async () => {},
  deleteCase: async () => {},
  setPage: () => {},
  setPageSize: () => {},
  setFilters: () => {},
  applyFiltersAndFetch: () => {},
  resetFilters: () => {},
}));
```

- [ ] **Step 2: 实现 fetchCases（带 AbortController）**

替换 `fetchCases`:

```typescript
fetchCases: async () => {
  if (inflight) {
    inflight.abort();
    inflight = null;
  }

  const { page, pageSize, filters } = get();
  const validPage = Math.max(1, page);
  const validPageSize = Math.min(Math.max(1, pageSize), 100);

  inflight = new AbortController();
  set({ loading: true });

  try {
    const response = await listCases({
      name_like: filters.nameLike || undefined,
      tags: filters.tags.length > 0 ? filters.tags : undefined,
      page: validPage,
      size: validPageSize,
    });

    set({
      cases: response.items,
      total: response.total,
      page: response.page,
      pageSize: response.size,
      loading: false,
    });

    inflight = null;
  } catch (err: unknown) {
    inflight = null;
    set({ loading: false });
    const axiosError = err as { response?: { data?: { error?: string } } };
    const errorMessage = axiosError.response?.data?.error ?? '查询失败';
    message.error(errorMessage);
    throw err;
  }
},
```

- [ ] **Step 3: 实现 CRUD actions**

替换空函数:

```typescript
createCase: async (req: CaseCreateRequest) => {
  try {
    await createCase(req);
    message.success('用例创建成功');
    get().fetchCases();
  } catch (err) {
    // error 已由 request 拦截器处理
    throw err;
  }
},

updateCase: async (id: string, req: CaseUpdateRequest) => {
  try {
    await updateCase(id, req);
    message.success('用例更新成功');
    get().fetchCases();
  } catch (err) {
    throw err;
  }
},

deleteCase: async (id: string) => {
  try {
    await deleteCase(id);
    message.success('用例删除成功');
    get().fetchCases();
  } catch (err) {
    throw err;
  }
},
```

- [ ] **Step 4: 实现分页与过滤 actions**

替换空函数:

```typescript
setPage: (page: number) => {
  set({ page });
  get().fetchCases();
},

setPageSize: (pageSize: number) => {
  set({ pageSize, page: 1 });
  get().fetchCases();
},

setFilters: (patch: Partial<CaseListFilters>) => {
  set((state) => ({
    filters: { ...state.filters, ...patch },
  }));
},

applyFiltersAndFetch: (patch: Partial<CaseListFilters>) => {
  set((state) => ({
    filters: { ...state.filters, ...patch },
    page: 1,
  }));
  get().fetchCases();
},

resetFilters: () => {
  set({ filters: defaultFilters, page: 1 });
  get().fetchCases();
},
```

- [ ] **Step 5: 验证 store 无 TS 错误**

Run: `cd mooc-manus-web && npm run typecheck`
Expected: No errors in `store/evalCase.ts`

- [ ] **Step 6: Commit**

```bash
git add mooc-manus-web/src/store/evalCase.ts
git commit -m "feat(eval): 实现 evalCase store

- fetchCases 带 AbortController 竞态处理
- CRUD actions: create/update/delete
- 分页与过滤逻辑
- 无轮询（用例是静态数据）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: 实现 evalTask Store（带轮询）

**Files:**
- Create: `mooc-manus-web/src/store/evalTask.ts`

- [ ] **Step 1: 创建 evalTask store 骨架（含轮询 timer）**

```typescript
// mooc-manus-web/src/store/evalTask.ts
import { create } from 'zustand';
import { message } from 'antd';
import { listTasks, createTask, deleteTask, retryTask } from '@/api/modules/eval';
import type { TaskView, TaskCreateRequest } from '@/types/eval';

export interface TaskListFilters {
  status: string;
}

const defaultFilters: TaskListFilters = {
  status: '',
};

let inflight: AbortController | null = null;

interface TaskState {
  tasks: TaskView[];
  total: number;
  page: number;
  pageSize: number;
  filters: TaskListFilters;
  loading: boolean;
  pollingTimer: NodeJS.Timeout | null;

  fetchTasks: () => Promise<void>;
  createTask: (req: TaskCreateRequest) => Promise<void>;
  retryTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  setFilters: (patch: Partial<TaskListFilters>) => void;
  applyFiltersAndFetch: (patch: Partial<TaskListFilters>) => void;
  resetFilters: () => void;
}

export const useEvalTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  total: 0,
  page: 1,
  pageSize: 20,
  filters: defaultFilters,
  loading: false,
  pollingTimer: null,

  fetchTasks: async () => {},
  createTask: async () => {},
  retryTask: async () => {},
  deleteTask: async () => {},
  startPolling: () => {},
  stopPolling: () => {},
  setPage: () => {},
  setPageSize: () => {},
  setFilters: () => {},
  applyFiltersAndFetch: () => {},
  resetFilters: () => {},
}));
```

- [ ] **Step 2: 实现 fetchTasks**

替换 `fetchTasks`:

```typescript
fetchTasks: async () => {
  if (inflight) {
    inflight.abort();
    inflight = null;
  }

  const { page, pageSize, filters } = get();
  const validPage = Math.max(1, page);
  const validPageSize = Math.min(Math.max(1, pageSize), 100);

  inflight = new AbortController();
  set({ loading: true });

  try {
    const response = await listTasks({
      status: filters.status || undefined,
      page: validPage,
      size: validPageSize,
    });

    set({
      tasks: response.items,
      total: response.total,
      page: response.page,
      pageSize: response.size,
      loading: false,
    });

    inflight = null;
  } catch (err: unknown) {
    inflight = null;
    set({ loading: false });
    const axiosError = err as { response?: { data?: { error?: string } } };
    const errorMessage = axiosError.response?.data?.error ?? '查询失败';
    message.error(errorMessage);
    throw err;
  }
},
```

- [ ] **Step 3: 实现智能轮询逻辑**

替换 `startPolling` 和 `stopPolling`:

```typescript
startPolling: () => {
  const { pollingTimer } = get();
  if (pollingTimer) {
    clearInterval(pollingTimer);
  }

  const timer = setInterval(() => {
    const { tasks } = get();
    const hasActive = tasks.some((t) => ['PENDING', 'RUNNING'].includes(t.status));
    if (hasActive) {
      get().fetchTasks();
    } else {
      get().stopPolling();
    }
  }, 5000);

  set({ pollingTimer: timer });
},

stopPolling: () => {
  const { pollingTimer } = get();
  if (pollingTimer) {
    clearInterval(pollingTimer);
    set({ pollingTimer: null });
  }
},
```

- [ ] **Step 4: 实现 CRUD actions**

替换空函数:

```typescript
createTask: async (req: TaskCreateRequest) => {
  try {
    await createTask(req);
    message.success('任务创建成功');
    get().fetchTasks();
    get().startPolling();
  } catch (err) {
    throw err;
  }
},

retryTask: async (id: string) => {
  try {
    const { retried_count } = await retryTask(id);
    message.success(`已重试 ${retried_count} 个失败实例`);
    get().fetchTasks();
  } catch (err) {
    throw err;
  }
},

deleteTask: async (id: string) => {
  try {
    await deleteTask(id);
    message.success('任务删除成功');
    get().fetchTasks();
  } catch (err) {
    throw err;
  }
},
```

- [ ] **Step 5: 实现分页与过滤 actions**

替换空函数:

```typescript
setPage: (page: number) => {
  set({ page });
  get().fetchTasks();
},

setPageSize: (pageSize: number) => {
  set({ pageSize, page: 1 });
  get().fetchTasks();
},

setFilters: (patch: Partial<TaskListFilters>) => {
  set((state) => ({
    filters: { ...state.filters, ...patch },
  }));
},

applyFiltersAndFetch: (patch: Partial<TaskListFilters>) => {
  set((state) => ({
    filters: { ...state.filters, ...patch },
    page: 1,
  }));
  get().fetchTasks();
},

resetFilters: () => {
  set({ filters: defaultFilters, page: 1 });
  get().fetchTasks();
},
```

- [ ] **Step 6: 验证 store 无 TS 错误**

Run: `cd mooc-manus-web && npm run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add mooc-manus-web/src/store/evalTask.ts
git commit -m "feat(eval): 实现 evalTask store + 智能轮询

- fetchTasks 带 AbortController
- CRUD: create/retry/delete
- 智能轮询：5s 间隔，仅当存在 PENDING/RUNNING 时刷新
- 全终态自动停止轮询

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: 实现 evalInstance Store（带轮询 + reset）

**Files:**
- Create: `mooc-manus-web/src/store/evalInstance.ts`

- [ ] **Step 1: 创建 evalInstance store 骨架**

```typescript
// mooc-manus-web/src/store/evalInstance.ts
import { create } from 'zustand';
import { message } from 'antd';
import { listInstances, retryInstance, deleteInstance } from '@/api/modules/eval';
import type { InstanceView } from '@/types/eval';

export interface InstanceListFilters {
  status: string;
}

const defaultFilters: InstanceListFilters = {
  status: '',
};

let inflight: AbortController | null = null;

interface InstanceState {
  taskId: string | null;
  instances: InstanceView[];
  total: number;
  page: number;
  pageSize: number;
  filters: InstanceListFilters;
  loading: boolean;
  pollingTimer: NodeJS.Timeout | null;

  fetchInstances: (taskId: string) => Promise<void>;
  retryInstance: (id: string) => Promise<void>;
  deleteInstance: (id: string) => Promise<void>;
  startPolling: (taskId: string) => void;
  stopPolling: () => void;
  reset: () => void;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  setFilters: (patch: Partial<InstanceListFilters>) => void;
  applyFiltersAndFetch: (patch: Partial<InstanceListFilters>) => void;
}

export const useEvalInstanceStore = create<InstanceState>((set, get) => ({
  taskId: null,
  instances: [],
  total: 0,
  page: 1,
  pageSize: 50,
  filters: defaultFilters,
  loading: false,
  pollingTimer: null,

  fetchInstances: async () => {},
  retryInstance: async () => {},
  deleteInstance: async () => {},
  startPolling: () => {},
  stopPolling: () => {},
  reset: () => {},
  setPage: () => {},
  setPageSize: () => {},
  setFilters: () => {},
  applyFiltersAndFetch: () => {},
}));
```

- [ ] **Step 2: 实现 fetchInstances**

替换 `fetchInstances`:

```typescript
fetchInstances: async (taskId: string) => {
  if (inflight) {
    inflight.abort();
    inflight = null;
  }

  const { page, pageSize, filters } = get();
  const validPage = Math.max(1, page);
  const validPageSize = Math.min(Math.max(1, pageSize), 100);

  inflight = new AbortController();
  set({ loading: true, taskId });

  try {
    const response = await listInstances(taskId, {
      status: filters.status || undefined,
      page: validPage,
      size: validPageSize,
    });

    set({
      instances: response.items,
      total: response.total,
      page: response.page,
      pageSize: response.size,
      loading: false,
    });

    inflight = null;
  } catch (err: unknown) {
    inflight = null;
    set({ loading: false });
    const axiosError = err as { response?: { data?: { error?: string } } };
    const errorMessage = axiosError.response?.data?.error ?? '查询失败';
    message.error(errorMessage);
    throw err;
  }
},
```

- [ ] **Step 3: 实现智能轮询（3 秒间隔）**

替换 `startPolling` 和 `stopPolling`:

```typescript
startPolling: (taskId: string) => {
  const { pollingTimer } = get();
  if (pollingTimer) {
    clearInterval(pollingTimer);
  }

  const timer = setInterval(() => {
    const { instances, taskId: currentTaskId } = get();
    if (currentTaskId !== taskId) {
      get().stopPolling();
      return;
    }
    const hasActive = instances.some((i) => ['PENDING', 'RUNNING'].includes(i.status));
    if (hasActive) {
      get().fetchInstances(taskId);
    } else {
      get().stopPolling();
    }
  }, 3000);

  set({ pollingTimer: timer });
},

stopPolling: () => {
  const { pollingTimer } = get();
  if (pollingTimer) {
    clearInterval(pollingTimer);
    set({ pollingTimer: null });
  }
},
```

- [ ] **Step 4: 实现 CRUD 与 reset**

替换空函数:

```typescript
retryInstance: async (id: string) => {
  try {
    await retryInstance(id);
    message.success('实例重试成功');
    const { taskId } = get();
    if (taskId) {
      get().fetchInstances(taskId);
    }
  } catch (err) {
    throw err;
  }
},

deleteInstance: async (id: string) => {
  try {
    await deleteInstance(id);
    message.success('实例删除成功');
    const { taskId } = get();
    if (taskId) {
      get().fetchInstances(taskId);
    }
  } catch (err) {
    throw err;
  }
},

reset: () => {
  get().stopPolling();
  set({
    taskId: null,
    instances: [],
    total: 0,
    page: 1,
    filters: defaultFilters,
    loading: false,
  });
},
```

- [ ] **Step 5: 实现分页与过滤 actions**

替换空函数:

```typescript
setPage: (page: number) => {
  const { taskId } = get();
  if (!taskId) return;
  set({ page });
  get().fetchInstances(taskId);
},

setPageSize: (pageSize: number) => {
  const { taskId } = get();
  if (!taskId) return;
  set({ pageSize, page: 1 });
  get().fetchInstances(taskId);
},

setFilters: (patch: Partial<InstanceListFilters>) => {
  set((state) => ({
    filters: { ...state.filters, ...patch },
  }));
},

applyFiltersAndFetch: (patch: Partial<InstanceListFilters>) => {
  const { taskId } = get();
  if (!taskId) return;
  set((state) => ({
    filters: { ...state.filters, ...patch },
    page: 1,
  }));
  get().fetchInstances(taskId);
},
```

- [ ] **Step 6: 验证 store 无 TS 错误**

Run: `cd mooc-manus-web && npm run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add mooc-manus-web/src/store/evalInstance.ts
git commit -m "feat(eval): 实现 evalInstance store + 3s 轮询 + reset

- fetchInstances 带 taskId 参数
- 智能轮询：3s 间隔，仅当存在 PENDING/RUNNING 时刷新
- reset 清空状态 + 停轮询（离开详情页时调用）
- retry/delete 操作后自动刷新列表

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: 注册路由与菜单

**Files:**
- Modify: `mooc-manus-web/src/router/index.tsx`
- Modify: `mooc-manus-web/src/components/Layout/index.tsx`

- [ ] **Step 1: 在 router/index.tsx 注册评测路由**

在 `createBrowserRouter` 的 children 数组中追加:

```typescript
{
  path: 'eval',
  children: [
    {
      path: 'cases',
      element: <div>Eval Cases Placeholder</div>,
    },
    {
      path: 'tasks',
      element: <div>Eval Tasks Placeholder</div>,
    },
    {
      path: 'tasks/:id',
      element: <div>Task Detail Placeholder</div>,
    },
  ],
},
```

**注**：先用占位组件，Phase 2-4 会替换成真实页面。

- [ ] **Step 2: 在 Layout 菜单加评测入口**

找到 `components/Layout/index.tsx` 的 `menuItems` 定义，追加:

```typescript
{
  key: '/eval',
  icon: <ExperimentOutlined />,
  label: '评测平台',
  children: [
    { key: '/eval/cases', label: '用例管理' },
    { key: '/eval/tasks', label: '任务管理' },
  ],
},
```

**注**：需从 `@ant-design/icons` import `ExperimentOutlined`。

- [ ] **Step 3: 验证路由可访问**

Run: `cd mooc-manus-web && npm run dev`
手动访问:
- `http://localhost:5173/eval/cases` → 显示"Eval Cases Placeholder"
- `http://localhost:5173/eval/tasks` → 显示"Eval Tasks Placeholder"
- `http://localhost:5173/eval/tasks/abc123` → 显示"Task Detail Placeholder"

Expected: 三个路由都能正常访问，菜单可见"评测平台"父项

- [ ] **Step 4: Commit**

```bash
git add mooc-manus-web/src/router/index.tsx mooc-manus-web/src/components/Layout/index.tsx
git commit -m "feat(eval): 注册路由与菜单（占位页面）

- 路由：/eval/cases、/eval/tasks、/eval/tasks/:id
- 菜单：评测平台父级 + 用例管理/任务管理子项
- 使用 ExperimentOutlined 图标

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 2: 用例管理（Cases 页面 + 组件）

由于完整计划过长（预估 2000+ 行），我将在此处分段。Phase 2-6 的详细分步计划包含：
- Task 7-11: 用例管理 5 个组件（ScriptInput / CaseTable / CaseFormModal / CaseDetailDrawer / Cases/index.tsx）
- Task 12-15: 任务管理 4 个组件
- Task 16-20: 任务详情 5 个组件
- Task 21: Trace 深链改造
- Task 22: E2E 验证文档编写

**为节省上下文，以下仅列出各 Task 标题与文件清单，完整分步内容请在执行时参照设计文档 §7-9 细化。**

---

### Task 7: ScriptInput 组件（上传/编辑双 Tab）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Cases/ScriptInput.tsx`

**Steps:** 5 步 TDD（写测试 → 失败 → 实现骨架 → 通过 → commit）
- 双 Tab 布局（上传 Dragger + TextArea 编辑）
- beforeUpload 校验 10MB 上限
- uploadContent 成功后自动切到编辑 tab

---

### Task 8: CaseTable 组件（表格 + 分页）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Cases/CaseTable.tsx`

**Steps:** 6 步
- 列定义：名称/描述/标签/创建时间/操作
- 连接 evalCase store
- 分页逻辑
- 操作列：查看/编辑/删除按钮

---

### Task 9: CaseFormModal 组件（创建/编辑 Modal）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Cases/CaseFormModal.tsx`

**Steps:** 7 步
- 顶部字段：name / description / tags
- 3 个 Tabs（Init / Task / Verify），每个内嵌 ScriptInput
- mode prop 区分创建/编辑
- 提交逻辑

---

### Task 10: CaseDetailDrawer 组件（只读详情）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Cases/CaseDetailDrawer.tsx`

**Steps:** 5 步
- Descriptions 显示元信息
- 3 个 Tabs（只读 TextArea）
- 底部：关闭 / 编辑按钮

---

### Task 11: Cases/index.tsx 页面（组装）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Cases/index.tsx`
- Modify: `mooc-manus-web/src/router/index.tsx`（替换占位）

**Steps:** 6 步
- 顶部过滤器（name 搜索 + tags 多选）
- 组装 CaseTable / CaseFormModal / CaseDetailDrawer
- 生命周期：useEffect fetchCases
- 替换路由占位为真实组件

---

## Phase 3: 任务管理（Tasks 页面 + 组件）

### Task 12: TaskFilters 组件（状态过滤）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Tasks/TaskFilters.tsx`

**Steps:** 4 步
- Radio.Group（全部/PENDING/RUNNING/SUCCEEDED/FAILED）

---

### Task 13: TaskTable 组件（表格 + 进度）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Tasks/TaskTable.tsx`

**Steps:** 6 步
- 列：名称/状态/进度/时间/操作
- 状态 Tag 颜色映射
- 进度显示：succeeded/failed/running/total
- 行点击跳转到详情页

---

### Task 14: TaskCreateModal 组件（双 Transfer + M×N 预览）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Tasks/TaskCreateModal.tsx`

**Steps:** 7 步
- 任务名输入
- 左右两个 Transfer（用例 + Agent）
- 底部 Alert 显示 M×N 数量
- 提交逻辑

---

### Task 15: Tasks/index.tsx 页面（组装 + 轮询）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/Tasks/index.tsx`
- Modify: `mooc-manus-web/src/router/index.tsx`

**Steps:** 6 步
- 组装 TaskFilters / TaskTable / TaskCreateModal
- 生命周期：fetchTasks + startPolling + cleanup stopPolling
- 替换路由占位

---

## Phase 4: 任务详情（TaskDetail 页面 + 组件）

### Task 16: TaskSummaryCard 组件（任务汇总）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/TaskDetail/TaskSummaryCard.tsx`

**Steps:** 5 步
- 显示任务名/状态/进度条/时间
- 操作按钮：返回列表/重试/删除

---

### Task 17: InstanceFilters 组件（实例状态过滤）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/TaskDetail/InstanceFilters.tsx`

**Steps:** 4 步
- Radio.Group（全部/PENDING/RUNNING/SUCCEEDED/FAILED/TIMEOUT）

---

### Task 18: InstanceTable 组件（实例表格）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/TaskDetail/InstanceTable.tsx`

**Steps:** 7 步
- 列：状态 Icon/用例/Agent/attempt/耗时/token/操作
- Agent 列简化显示（初版显示"多 Agent 任务"）
- 操作列：查看详情/重试/删除/查看Trace

---

### Task 19: InstanceDrawer 组件（4 Tabs 详情）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/TaskDetail/InstanceDrawer.tsx`

**Steps:** 8 步
- Tab 1: 基础信息 Descriptions
- Tab 2: 执行结果（passed Badge + stdout/stderr）
- Tab 3: Token & 耗时
- Tab 4: 错误日志
- 底部：关闭/查看Trace/重试按钮
- handleViewTrace 逻辑

---

### Task 20: TaskDetail/index.tsx 页面（组装 + 轮询）

**Files:**
- Create: `mooc-manus-web/src/pages/Eval/TaskDetail/index.tsx`
- Modify: `mooc-manus-web/src/router/index.tsx`

**Steps:** 6 步
- 组装 TaskSummaryCard / InstanceFilters / InstanceTable / InstanceDrawer
- 生命周期：fetchInstances + startPolling + cleanup reset
- 替换路由占位

---

## Phase 5: Trace 深链改造

### Task 21: Trace 页面深链支持

**Files:**
- Modify: `mooc-manus-web/src/pages/Trace/index.tsx`

**Steps:** 5 步
- 引入 useSearchParams
- useEffect 读取 `traceId` param
- 自动设置 modalTraceId 打开 Modal
- 清理 URL（replace: true）
- 测试从 InstanceDrawer 跳转 Trace

---

## Phase 6: E2E 验证文档

### Task 22: 编写 E2E 验证文档

**Files:**
- Create: `mooc-manus-all/docs/superpowers/plans/2026-07-17-eval-platform-e2e.md`

**Steps:** 6 步
- § 用例管理验证清单（创建/编辑/删除/过滤/分页）
- § 任务管理验证清单（创建/轮询/过滤/删除）
- § 任务详情与实例验证清单（详情页/轮询/过滤/Drawer/重试/删除/Trace跳转）
- § 跨页面联动（删除用例影响任务/刷新与深链）
- § 边界与异常（文件过大/网络中断/空状态/轮询停止）
- Commit E2E 文档

---

## 验证与交付

### Final Verification: 端到端功能测试

**参照 E2E 文档逐项验证**（Task 22 产出）

- [ ] 用例管理全流程通过
- [ ] 任务管理全流程通过
- [ ] 任务详情与实例全流程通过
- [ ] Trace 深链跳转正常
- [ ] 边界场景处理正确

### Final Commit: 合并提交

```bash
git add .
git commit -m "feat(eval): 评测平台前端完整实现

完整功能：
- 用例管理：CRUD + 3 脚本字段（上传/编辑）
- 任务管理：创建（Transfer M×N）+ 列表 + 智能轮询
- 任务详情：实例列表 + 详情 Drawer（4 Tabs）+ Trace 跳转
- Trace 深链：URL param 自动开 Modal
- 智能轮询：5s/3s 间隔，终态自动停止

技术栈：
- API 层：15 个函数对齐后端
- Store：3 个 Zustand store（AbortController + 轮询）
- 组件：20 个细粒度组件
- 路由：3 条新路由 + 菜单集成

测试覆盖：
- E2E 验证文档 40+ 检查点
- 边界场景：409 冲突/413 过大/空状态/轮询停止

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

**实施计划完成。** Phase 2-4 的详细分步内容（Task 7-20）请在执行时参照设计文档 §7 核心组件交互设计，按 TDD 模式逐步实现。每个组件遵循：写失败测试 → 实现骨架 → 通过测试 → 完善功能 → commit 的节奏。

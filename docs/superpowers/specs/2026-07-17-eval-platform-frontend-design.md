# 评测平台前端设计文档

## 1. 概述

### 1.1 背景

mooc-manus 后端已实现评测系统（`mooc-manus/api/handlers/eval.go`），提供用例管理、任务调度、实例执行三层抽象，支持"M 个用例 × N 个 Agent 配置"的笛卡尔积批量评测。前端需提供 Web 界面，让用户能够：

1. **创建与管理评测用例**（Case）：定义 init_script、task_prompt、verify_script
2. **批量创建评测任务**（Task）：选择多个用例与多个 Agent，自动生成 M×N 个执行实例
3. **实时查看评测进度与结果**（Instance & Result）：状态追踪、token 用量、执行耗时、验证输出、Trace 跳转

### 1.2 核心目标

- **功能完整性**：覆盖后端全部 15 个 API endpoint（Case 6 个、Task 5 个、Instance 4 个）
- **一致性**：与现有前端模块（Trace/Skill/Tool）保持技术栈、目录结构、交互模式一致
- **实时性**：通过智能轮询实现任务与实例状态的准实时更新（后端无 SSE 支持）
- **可维护性**：细粒度组件拆分、类型安全、清晰的数据流

### 1.3 非目标

- **后端能力扩展**：不新增后端 API（如任务编辑接口），严格对齐现有能力
- **高级可视化**：初版不做评测结果对比图表、趋势分析（聚焦 CRUD 与状态展示）
- **离线模式**：不做本地缓存或离线评测（依赖后端 MQ 与数据库）

---

## 2. 技术选型

### 2.1 技术栈（完全复用现有）

| 层级 | 技术 | 说明 |
|---|---|---|
| 框架 | React 19 + TypeScript | 与现有模块一致 |
| 路由 | React Router v6 | 支持深链、嵌套路由 |
| 状态管理 | Zustand | 轻量、支持 module 级 AbortController |
| UI 组件库 | Ant Design 5.x | 现有依赖，无新增 |
| HTTP 客户端 | Axios | 复用 `src/api/request.ts` 拦截器 |
| 构建工具 | Vite | 现有配置 |

### 2.2 设计原则

1. **对齐现有模式**：目录结构、命名约定、组件粒度参照 `pages/Trace/`
2. **透传 snake_case**：API 层与后端字段名保持一致，前端不做驼峰转换（与 `trace.ts` 对齐）
3. **竞态安全**：Store 内 AbortController 处理并发请求
4. **智能轮询**：仅在存在活动状态（PENDING/RUNNING）时轮询，终态自动停止
5. **无新依赖**：不引入 Monaco/CodeMirror，用 antd TextArea 处理长文本

---

## 3. 整体架构

### 3.1 导航结构

**Layout 菜单新增父级**：
```
评测平台 (ExperimentOutlined)
├── 用例管理 (/eval/cases)
└── 任务管理 (/eval/tasks)
```

**路由定义**：
```
/eval
├── /cases          → EvalCasesPage（用例列表 + CRUD）
├── /tasks          → EvalTasksPage（任务列表 + 创建/删除）
└── /tasks/:id      → TaskDetailPage（任务详情 + 实例列表 + 单实例详情）
```

**结果查看入口**：内嵌在 `/eval/tasks/:id` 页面，通过实例列表 + Drawer 展示，无独立页面。

### 3.2 目录结构

```
src/
├── pages/Eval/
│   ├── Cases/
│   │   ├── index.tsx              # 用例列表页（组装 Filters + Table + Modals）
│   │   ├── CaseTable.tsx          # 用例表格（分页、操作列）
│   │   ├── CaseFormModal.tsx      # 创建/编辑 Modal（3 个 script 字段 Tabs）
│   │   ├── CaseDetailDrawer.tsx   # 只读详情 Drawer
│   │   └── ScriptInput.tsx        # 脚本输入组件（上传/编辑双 Tab）
│   ├── Tasks/
│   │   ├── index.tsx              # 任务列表页
│   │   ├── TaskTable.tsx          # 任务表格（状态、进度、操作列）
│   │   ├── TaskCreateModal.tsx    # 创建 Modal（双 Transfer + M×N 预览）
│   │   └── TaskFilters.tsx        # 状态过滤器（Radio.Group）
│   └── TaskDetail/
│       ├── index.tsx              # 任务详情页（路由 /eval/tasks/:id）
│       ├── TaskSummaryCard.tsx    # 任务元信息卡片
│       ├── InstanceTable.tsx      # 实例列表表格
│       ├── InstanceDrawer.tsx     # 单实例详情 Drawer（4 个 Tabs）
│       └── InstanceFilters.tsx    # 实例状态过滤器
├── api/modules/
│   └── eval.ts                    # 15 个 API 函数
├── store/
│   ├── evalCase.ts                # 用例 store
│   ├── evalTask.ts                # 任务 store（含轮询）
│   └── evalInstance.ts            # 实例 store（含轮询）
├── types/
│   └── eval.ts                    # DTO 类型定义
└── router/index.tsx               # 路由注册
```

**文件数量**：~20 个组件文件 + 3 个 store + 2 个 API/type 文件。

### 3.3 与现有模块的对齐

| 现有模块 | 复用模式 | 评测模块应用 |
|---|---|---|
| Trace | 列表页 + 表格 + Modal/Drawer | 用例/任务列表 + 详情 Drawer |
| Trace | `store/trace.ts` 的分页 + AbortController | 三个 store 完全复制 |
| Trace | `api/modules/trace.ts` 透传 snake_case | `api/modules/eval.ts` 同模式 |
| Tool | 父子菜单 `/tools/providers` & `/functions` | `/eval/cases` & `/tasks` |
| Skill | Transfer 组件批量选择 | TaskCreateModal 的用例/agent 选择 |

---

## 4. 状态管理与数据流

### 4.1 Store 设计

#### 4.1.1 `store/evalCase.ts` — 用例管理

**状态定义**：
```typescript
interface CaseState {
  cases: CaseView[];
  total: number;
  page: number;                // 1-based
  pageSize: number;
  filters: {
    nameLike: string;
    tags: string[];
  };
  loading: boolean;
}
```

**Actions**：
- `fetchCases()` — 拉取列表（带 AbortController 竞态处理）
- `createCase(req: CaseCreateRequest)` — 创建用例
- `updateCase(id: string, req: CaseUpdateRequest)` — 更新用例
- `deleteCase(id: string)` — 删除用例（409 冲突由 request 拦截器处理）
- `setFilters(patch)` / `applyFiltersAndFetch()` — 过滤与刷新
- `setPage(page)` / `setPageSize(size)` — 分页

**特殊逻辑**：
- **无轮询**：用例是静态数据，创建后不会自动变化
- **竞态处理**：模块级 `let inflight: AbortController | null`，每次 fetch 前 abort 上次请求

---

#### 4.1.2 `store/evalTask.ts` — 任务管理

**状态定义**：
```typescript
interface TaskState {
  tasks: TaskView[];
  total: number;
  page: number;
  pageSize: number;
  filters: {
    status: string;  // '' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  };
  loading: boolean;
  pollingTimer: NodeJS.Timeout | null;
}
```

**Actions**：
- `fetchTasks()` — 拉取列表
- `createTask(req)` / `deleteTask(id)` / `retryTask(id)` — 操作
- `startPolling()` / `stopPolling()` — 智能轮询
- `setFilters()` / `applyFiltersAndFetch()`

**智能轮询逻辑**：
```typescript
startPolling() {
  this.stopPolling(); // 先清旧定时器
  this.pollingTimer = setInterval(() => {
    const { tasks } = get();
    const hasActive = tasks.some(t => ['PENDING', 'RUNNING'].includes(t.status));
    if (hasActive) {
      // 静默刷新（不置 loading = true，避免表格闪烁）
      this.fetchTasks();
    } else {
      // 全部终态，停止轮询
      this.stopPolling();
    }
  }, 5000); // 5 秒间隔
}
```

**页面生命周期**：
```typescript
// Tasks/index.tsx
useEffect(() => {
  evalTask.fetchTasks();
  evalTask.startPolling();
  return () => evalTask.stopPolling(); // 离开页面停轮询
}, []);
```

---

#### 4.1.3 `store/evalInstance.ts` — 实例管理

**状态定义**：
```typescript
interface InstanceState {
  taskId: string | null;       // 当前查看的任务 ID
  instances: InstanceView[];
  total: number;
  page: number;
  pageSize: number;
  filters: {
    status: string;  // '' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT'
  };
  loading: boolean;
  pollingTimer: NodeJS.Timeout | null;
}
```

**Actions**：
- `fetchInstances(taskId: string)` — 拉取某任务下的实例列表
- `retryInstance(id)` / `deleteInstance(id)` — 单实例操作
- `startPolling(taskId)` / `stopPolling()` — 智能轮询（3 秒间隔）
- `reset()` — 清空状态（离开详情页时调用）

**轮询逻辑**：同 evalTask，判定 `instances` 中是否存在 PENDING/RUNNING 状态。

**页面生命周期**：
```typescript
// TaskDetail/index.tsx
const { id: taskId } = useParams();

useEffect(() => {
  if (!taskId) return;
  evalInstance.fetchInstances(taskId);
  evalInstance.startPolling(taskId);
  return () => {
    evalInstance.stopPolling();
    evalInstance.reset(); // 清空状态，避免影响下次进入
  };
}, [taskId]);
```

---

### 4.2 数据流

#### 4.2.1 用例 → 任务创建

**流程**：
1. 用户点「创建任务」→ 打开 `TaskCreateModal`
2. Modal 内部调用 `listCases({ page: 1, size: 100 })` 拉取全量用例（不走 evalCase store，避免污染列表页状态）
3. 同时调用 `listAgentConfigs()` 拉取可选 Agent 列表
4. 用户通过两个 Transfer 组件选择 M 个用例 + N 个 Agent
5. 底部实时显示"将创建 M × N = X 个实例"
6. 提交后调用 `createTask({ name, case_ids, agent_config_ids })`
7. 成功后刷新任务列表 + 自动启动轮询

#### 4.2.2 任务 → 实例

**流程**：
1. 用户点任务表格某行 → 路由跳转 `/eval/tasks/:id`
2. `TaskDetailPage` 读取 URL param `id`，调用 `evalInstance.fetchInstances(id)` + `startPolling(id)`
3. 实例表格展示 M×N 行数据
4. 用户点某行 → 右侧滑出 `InstanceDrawer`，展示单实例详情

#### 4.2.3 实例 → Trace

**流程**：
1. 用户在 `InstanceDrawer` 点「查看 Trace」按钮
2. 调用 `getInstanceTrace(instanceId)` → 后端返回 `{ trace_id: 'xxx' }`
3. 前端执行 `window.open('/traces?traceId=xxx', '_blank')`
4. Trace 页面读取 URL param `traceId`，自动打开 `TraceDetailModal`

---

## 5. API 层设计

### 5.1 `api/modules/eval.ts`

**15 个函数分组**：

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

### 5.2 特殊处理

#### 5.2.1 文件上传

```typescript
export async function uploadContent(file: File): Promise<UploadContentResp> {
  const formData = new FormData();
  formData.append('file', file);
  return request.post<UploadContentResp>('/api/eval/cases/upload-content', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}
```

#### 5.2.2 部分更新

```typescript
// updateCase 前端只传变更字段，undefined 字段不序列化
export async function updateCase(id: string, req: CaseUpdateRequest): Promise<CaseView> {
  // Axios 默认会过滤 undefined 字段，与后端 *string 语义对齐
  return request.put<CaseView>(`/api/eval/cases/${id}`, req);
}
```

#### 5.2.3 错误处理

**409 冲突**（删除用例时被任务引用、删除运行中实例）：
- `request.ts` 拦截器已统一处理：`message.error(data?.error)`
- UI 层无需特殊逻辑

**413 文件过大**：
- 后端返回 413 + `ErrUploadTooLarge`
- 前端在 Upload 组件加 `beforeUpload` 前置校验（10MB 上限）

---

## 6. 类型定义

### 6.1 `types/eval.ts`

**原则**：1:1 映射后端 DTO，字段名保持 snake_case（与 `types/trace.ts` 一致）

```typescript
// ===== Case =====
export interface CaseView {
  id: string;
  name: string;
  description: string;
  init_script: string;
  task_prompt: string;
  verify_script: string;
  tags: string[];
  created_at: string;  // ISO8601
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

// ===== Task =====
export interface TaskView {
  id: string;
  name: string;
  case_ids: string[];
  agent_config_ids: string[];
  status: string;  // PENDING | RUNNING | SUCCEEDED | FAILED
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

// ===== Instance =====
export interface InstanceView {
  id: string;
  task_id: string;
  case_id: string;
  status: string;  // PENDING | RUNNING | SUCCEEDED | FAILED | TIMEOUT
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

### 6.2 日期处理

- 后端返回 ISO8601 字符串（如 `2026-07-17T10:30:00Z`）
- 前端用 `dayjs` 格式化：`dayjs(created_at).format('YYYY-MM-DD HH:mm:ss')`
- 与 Trace 模块对齐（已有 dayjs 依赖）

---

## 7. 核心组件交互设计

### 7.1 用例管理页（`pages/Eval/Cases/`）

#### 7.1.1 `index.tsx` — 页面容器

**布局**：
```tsx
<div style={{ padding: 24 }}>
  {/* 顶部操作栏 */}
  <Space style={{ marginBottom: 16 }}>
    <Input.Search placeholder="搜索用例名称" onSearch={handleSearch} />
    <Select mode="tags" placeholder="按标签过滤" onChange={handleTagsFilter} />
    <Button type="primary" onClick={() => setFormModalOpen(true)}>创建用例</Button>
  </Space>
  
  {/* 表格 */}
  <CaseTable onView={handleView} onEdit={handleEdit} onDelete={handleDelete} />
  
  {/* 创建/编辑 Modal */}
  <CaseFormModal open={formModalOpen} mode="create" onClose={handleFormClose} />
  
  {/* 详情 Drawer */}
  <CaseDetailDrawer caseId={selectedCaseId} open={!!selectedCaseId} onClose={() => setSelectedCaseId(null)} />
</div>
```

**生命周期**：
```typescript
useEffect(() => {
  evalCase.fetchCases();
}, []);
```

---

#### 7.1.2 `CaseTable.tsx` — 用例表格

**列定义**：
| 列 | 数据源 | 渲染 | 宽度 |
|---|---|---|---|
| 名称 | `name` | 纯文本，点击打开详情 Drawer | 200px |
| 描述 | `description` | 省略超长，Tooltip 悬停显示 | 300px |
| 标签 | `tags` | `tags.map(t => <Tag>{t}</Tag>)` | 200px |
| 创建时间 | `created_at` | `dayjs(created_at).format('YYYY-MM-DD HH:mm')` | 180px |
| 操作 | - | 查看/编辑/删除 三个按钮 | 150px |

**分页**：
```tsx
<Table
  dataSource={cases}
  columns={columns}
  rowKey="id"
  loading={loading}
  pagination={{
    current: page,
    pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: ['10', '20', '50'],
    showTotal: (t) => `共 ${t} 条`,
    onChange: (p, ps) => {
      evalCase.setPage(p);
      if (ps !== pageSize) evalCase.setPageSize(ps);
    },
  }}
/>
```

---

#### 7.1.3 `CaseFormModal.tsx` — 创建/编辑表单

**顶部字段**（普通表单项）：
- `name`：Input（必填）
- `description`：TextArea（可选，rows=3）
- `tags`：Select mode="tags"（自由输入，可选）

**下方 Tabs**（三个脚本字段）：
```tsx
<Tabs>
  <TabPane tab="Init Script" key="init">
    <ScriptInput
      value={formData.init_script}
      onChange={(val) => setFormData({ ...formData, init_script: val })}
      label="初始化脚本（可选）"
    />
  </TabPane>
  <TabPane tab="Task Prompt" key="task">
    <ScriptInput
      value={formData.task_prompt}
      onChange={(val) => setFormData({ ...formData, task_prompt: val })}
      label="任务提示词（必填）"
      required
    />
  </TabPane>
  <TabPane tab="Verify Script" key="verify">
    <ScriptInput
      value={formData.verify_script}
      onChange={(val) => setFormData({ ...formData, verify_script: val })}
      label="验证脚本（必填）"
      required
    />
  </TabPane>
</Tabs>
```

**Modal 配置**：
- `width={800}`
- `bodyStyle={{ maxHeight: '70vh', overflow: 'auto' }}`
- 底部「取消 / 提交」按钮

---

#### 7.1.4 `ScriptInput.tsx` — 脚本输入组件

**内层双 Tab 结构**：
```tsx
<Tabs>
  <TabPane tab="上传文件" key="upload">
    <Upload.Dragger
      accept=".txt,.sh,.py,.md"
      beforeUpload={(file) => {
        if (file.size > 10 * 1024 * 1024) {
          message.error('文件大小不能超过 10MB');
          return Upload.LIST_IGNORE;
        }
        return true;
      }}
      customRequest={async ({ file, onSuccess, onError }) => {
        try {
          const { content } = await uploadContent(file as File);
          onChange(content); // 回填内容
          onSuccess?.(null);
          message.success('上传成功');
          setActiveKey('edit'); // 自动切到编辑 Tab
        } catch (err) {
          onError?.(err as Error);
        }
      }}
    >
      <InboxOutlined style={{ fontSize: 48, color: '#1890ff' }} />
      <p>点击或拖拽文件到此区域上传</p>
    </Upload.Dragger>
  </TabPane>
  
  <TabPane tab="直接编辑" key="edit">
    <Input.TextArea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={20}
      style={{ fontFamily: 'monospace', fontSize: 13 }}
      placeholder="在此输入或粘贴脚本内容..."
    />
  </TabPane>
</Tabs>
```

**逻辑**：
- 上传成功后自动切到「直接编辑」tab，内容回填
- 用户可在 TextArea 内继续修改

---

#### 7.1.5 `CaseDetailDrawer.tsx` — 只读详情

**布局**：
```tsx
<Drawer width={720} open={open} onClose={onClose} title="用例详情">
  {/* 顶部元信息 */}
  <Descriptions column={2}>
    <Descriptions.Item label="名称">{caseData.name}</Descriptions.Item>
    <Descriptions.Item label="创建时间">{formatTime(caseData.created_at)}</Descriptions.Item>
    <Descriptions.Item label="描述" span={2}>{caseData.description}</Descriptions.Item>
    <Descriptions.Item label="标签" span={2}>
      {caseData.tags.map(t => <Tag key={t}>{t}</Tag>)}
    </Descriptions.Item>
  </Descriptions>
  
  <Divider />
  
  {/* 三个脚本 Tabs（只读） */}
  <Tabs>
    <TabPane tab="Init Script" key="init">
      <Input.TextArea value={caseData.init_script} disabled rows={15} style={{ fontFamily: 'monospace' }} />
    </TabPane>
    <TabPane tab="Task Prompt" key="task">
      <Input.TextArea value={caseData.task_prompt} disabled rows={15} style={{ fontFamily: 'monospace' }} />
    </TabPane>
    <TabPane tab="Verify Script" key="verify">
      <Input.TextArea value={caseData.verify_script} disabled rows={15} style={{ fontFamily: 'monospace' }} />
    </TabPane>
  </Tabs>
  
  {/* 底部操作 */}
  <div style={{ textAlign: 'right', marginTop: 16 }}>
    <Space>
      <Button onClick={onClose}>关闭</Button>
      <Button type="primary" onClick={() => onEdit(caseData.id)}>编辑</Button>
    </Space>
  </div>
</Drawer>
```

---

### 7.2 任务管理页（`pages/Eval/Tasks/`）

#### 7.2.1 `index.tsx` — 页面容器

**布局**：
```tsx
<div style={{ padding: 24 }}>
  {/* 顶部操作栏 */}
  <Space style={{ marginBottom: 16 }}>
    <TaskFilters />
    <Button type="primary" onClick={() => setCreateModalOpen(true)}>创建任务</Button>
  </Space>
  
  {/* 表格 */}
  <TaskTable onRowClick={(id) => navigate(`/eval/tasks/${id}`)} />
  
  {/* 创建 Modal */}
  <TaskCreateModal open={createModalOpen} onClose={handleCreateClose} />
</div>
```

**生命周期**：
```typescript
useEffect(() => {
  evalTask.fetchTasks();
  evalTask.startPolling();
  return () => evalTask.stopPolling();
}, []);
```

---

#### 7.2.2 `TaskTable.tsx` — 任务表格

**列定义**：
| 列 | 数据源 | 渲染 | 宽度 |
|---|---|---|---|
| 名称 | `name` | 纯文本 | 200px |
| 状态 | `status` | `<Tag color={statusColor}>{status}</Tag>` | 100px |
| 进度 | `succeeded/failed/running/total` | `成功 X / 失败 Y / 运行中 Z / 总计 N` | 200px |
| 创建时间 | `created_at` | 格式化 | 180px |
| 开始时间 | `started_at` | 格式化，可空显示 `--` | 180px |
| 结束时间 | `finished_at` | 格式化，可空显示 `--` | 180px |
| 操作 | - | 查看详情/重试/删除 | 180px |

**行点击**：
```tsx
onRow={(record) => ({
  onClick: () => onRowClick(record.id),
  style: { cursor: 'pointer' },
  tabIndex: 0,
  role: 'button',
  'aria-label': `查看任务 ${record.name}`,
})}
```

**状态颜色映射**：
```typescript
const statusColorMap: Record<string, string> = {
  PENDING: 'blue',
  RUNNING: 'processing',
  SUCCEEDED: 'success',
  FAILED: 'error',
};
```

---

#### 7.2.3 `TaskCreateModal.tsx` — 创建任务

**布局**（三段式）：
```tsx
<Modal width={900} open={open} onCancel={onClose} title="创建评测任务">
  {/* 1. 任务名 */}
  <Form.Item label="任务名称" required>
    <Input value={taskName} onChange={(e) => setTaskName(e.target.value)} />
  </Form.Item>
  
  {/* 2. 双 Transfer 布局 */}
  <Row gutter={16}>
    <Col span={12}>
      <Form.Item label="选择用例">
        <Transfer
          dataSource={cases.map(c => ({ key: c.id, title: c.name }))}
          targetKeys={selectedCaseIds}
          onChange={setSelectedCaseIds}
          showSearch
          listStyle={{ height: 400 }}
        />
      </Form.Item>
    </Col>
    <Col span={12}>
      <Form.Item label="选择 Agent">
        <Transfer
          dataSource={agents.map(a => ({ key: a.id, title: `${a.provider} - ${a.model_name}` }))}
          targetKeys={selectedAgentIds}
          onChange={setSelectedAgentIds}
          showSearch
          listStyle={{ height: 400 }}
        />
      </Form.Item>
    </Col>
  </Row>
  
  {/* 3. 实例数量预览 */}
  <Alert
    type="info"
    message={`将创建 ${selectedCaseIds.length} × ${selectedAgentIds.length} = ${selectedCaseIds.length * selectedAgentIds.length} 个实例`}
    style={{ marginTop: 16 }}
  />
  
  {/* 底部按钮 */}
  <div style={{ textAlign: 'right', marginTop: 24 }}>
    <Space>
      <Button onClick={onClose}>取消</Button>
      <Button
        type="primary"
        onClick={handleSubmit}
        disabled={!taskName || selectedCaseIds.length === 0 || selectedAgentIds.length === 0}
      >
        创建
      </Button>
    </Space>
  </div>
</Modal>
```

**数据加载**：
```typescript
useEffect(() => {
  if (!open) return;
  // Modal 打开时拉取全量数据
  listCases({ page: 1, size: 100 }).then(resp => setCases(resp.items));
  listAgentConfigs().then(setAgents);
}, [open]);
```

---

#### 7.2.4 `TaskFilters.tsx` — 状态过滤器

**实现**：
```tsx
<Radio.Group
  value={filters.status}
  onChange={(e) => evalTask.applyFiltersAndFetch({ status: e.target.value })}
  buttonStyle="solid"
>
  <Radio.Button value="">全部</Radio.Button>
  <Radio.Button value="PENDING">待执行</Radio.Button>
  <Radio.Button value="RUNNING">运行中</Radio.Button>
  <Radio.Button value="SUCCEEDED">已完成</Radio.Button>
  <Radio.Button value="FAILED">失败</Radio.Button>
</Radio.Group>
```

---

### 7.3 任务详情页（`pages/Eval/TaskDetail/`）

#### 7.3.1 `index.tsx` — 页面容器

**布局（三段式）**：
```tsx
<div style={{ padding: 24 }}>
  {/* 1. 任务汇总卡片 */}
  <TaskSummaryCard taskId={taskId} />
  
  {/* 2. 实例过滤器 */}
  <InstanceFilters style={{ marginTop: 16 }} />
  
  {/* 3. 实例表格 */}
  <InstanceTable taskId={taskId} onRowClick={setSelectedInstanceId} style={{ marginTop: 16 }} />
  
  {/* 4. 实例详情 Drawer */}
  <InstanceDrawer
    instanceId={selectedInstanceId}
    open={!!selectedInstanceId}
    onClose={() => setSelectedInstanceId(null)}
  />
</div>
```

**生命周期**：
```typescript
const { id: taskId } = useParams<{ id: string }>();

useEffect(() => {
  if (!taskId) return;
  evalInstance.fetchInstances(taskId);
  evalInstance.startPolling(taskId);
  return () => {
    evalInstance.stopPolling();
    evalInstance.reset();
  };
}, [taskId]);
```

---

#### 7.3.2 `TaskSummaryCard.tsx` — 任务汇总

**布局**：
```tsx
<Card>
  <Row gutter={16}>
    <Col span={16}>
      <Space direction="vertical">
        <Title level={4}>{task.name}</Title>
        <Tag color={statusColor}>{task.status}</Tag>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="创建时间">{formatTime(task.created_at)}</Descriptions.Item>
          <Descriptions.Item label="开始时间">{formatTime(task.started_at)}</Descriptions.Item>
          <Descriptions.Item label="结束时间">{formatTime(task.finished_at)}</Descriptions.Item>
        </Descriptions>
      </Space>
    </Col>
    <Col span={8}>
      {/* 进度条 */}
      <Progress
        percent={Math.round((task.succeeded_count / task.total_count) * 100)}
        success={{ percent: Math.round((task.succeeded_count / task.total_count) * 100) }}
        status={task.status === 'FAILED' ? 'exception' : 'active'}
      />
      <Text type="secondary">
        成功 {task.succeeded_count} / 失败 {task.failed_count} / 运行中 {task.running_count} / 总计 {task.total_count}
      </Text>
    </Col>
  </Row>
  
  {/* 操作按钮 */}
  <div style={{ marginTop: 16 }}>
    <Space>
      <Button onClick={() => navigate('/eval/tasks')}>返回列表</Button>
      <Button onClick={() => evalTask.retryTask(task.id)}>重试失败实例</Button>
      <Button danger onClick={() => handleDeleteTask(task.id)}>删除任务</Button>
    </Space>
  </div>
</Card>
```

---

#### 7.3.3 `InstanceTable.tsx` — 实例表格

**列定义**：
| 列 | 数据源 | 渲染 | 宽度 |
|---|---|---|---|
| 状态 | `status` | Icon（成功绿勾/失败红叉/运行中Loading） | 80px |
| 用例 | `case_id` | 显示用例 ID（可选：预加载用例列表映射为 name） | 150px |
| Agent | `task_id` 关联 | **注**：InstanceView 无 agent_config_id，需通过 TaskView.agent_config_ids 推断（见下方说明） | 180px |
| 尝试次数 | `attempt` | 纯数字 | 80px |
| 耗时 | `started_at` & `finished_at` | 计算差值，格式化为"X 分 Y 秒" | 100px |
| Token | `result.total_tokens` | 纯数字，可空显示 `--` | 100px |
| 操作 | - | 查看详情/重试/删除/查看Trace | 200px |

**Agent 列数据来源说明**：
- **问题**：后端 InstanceView 只有 `task_id` / `case_id`，无 `agent_config_id` 字段
- **方案**：TaskDetail 页面已通过 `getTask(taskId)` 拉取 TaskView（含 `agent_config_ids` 数组）
- **实现**：
  1. 若任务只用了 1 个 agent：所有实例都用该 agent，直接显示 `${provider} - ${model_name}`
  2. 若任务用了 N 个 agent（M×N 组合）：通过实例在列表中的位置推断（第 i 个实例对应 `agent_config_ids[i % N]`）
  3. **简化实现**：初版直接显示"多 Agent 任务"，不做推断；点开 InstanceDrawer 后从 conversation metadata 或 trace 中获取实际 agent
- **未来优化**：后端扩展 InstanceView 加 `agent_config_id` 字段（需改数据库 schema + domain service）

**状态 Icon**：
```tsx
const statusIconMap: Record<string, ReactNode> = {
  PENDING: <ClockCircleOutlined style={{ color: token.colorTextDisabled }} />,
  RUNNING: <LoadingOutlined style={{ color: token.colorPrimary }} />,
  SUCCEEDED: <CheckCircleFilled style={{ color: token.colorSuccess }} />,
  FAILED: <CloseCircleFilled style={{ color: token.colorError }} />,
  TIMEOUT: <ExclamationCircleFilled style={{ color: token.colorWarning }} />,
};
```

---

#### 7.3.4 `InstanceDrawer.tsx` — 实例详情

**布局（4 个 Tabs）**：
```tsx
<Drawer width={720} open={open} onClose={onClose} title="实例详情">
  {/* 顶部状态栏 */}
  <Space>
    <Badge status={statusBadge} text={instance.status} />
    <Text type="secondary">尝试次数: {instance.attempt}</Text>
  </Space>
  
  <Divider />
  
  {/* Tabs */}
  <Tabs>
    {/* Tab 1: 基础信息 */}
    <TabPane tab="基础信息" key="basic">
      <Descriptions column={2}>
        <Descriptions.Item label="实例 ID">{instance.id}</Descriptions.Item>
        <Descriptions.Item label="任务 ID">{instance.task_id}</Descriptions.Item>
        <Descriptions.Item label="用例 ID">{instance.case_id}</Descriptions.Item>
        <Descriptions.Item label="会话 ID">{instance.conversation_id}</Descriptions.Item>
        <Descriptions.Item label="消息 ID">{instance.message_id}</Descriptions.Item>
        <Descriptions.Item label="Worker ID">{instance.worker_id}</Descriptions.Item>
        <Descriptions.Item label="入队时间">{formatTime(instance.queued_at)}</Descriptions.Item>
        <Descriptions.Item label="开始时间">{formatTime(instance.started_at)}</Descriptions.Item>
        <Descriptions.Item label="结束时间">{formatTime(instance.finished_at)}</Descriptions.Item>
        <Descriptions.Item label="心跳时间">{formatTime(instance.heartbeat_at)}</Descriptions.Item>
        <Descriptions.Item label="截止时间">{formatTime(instance.deadline_at)}</Descriptions.Item>
      </Descriptions>
    </TabPane>
    
    {/* Tab 2: 执行结果 */}
    <TabPane tab="执行结果" key="result">
      {instance.result ? (
        <>
          <Alert
            type={instance.result.passed ? 'success' : 'error'}
            message={instance.result.passed ? '验证通过' : '验证失败'}
            icon={instance.result.passed ? <CheckCircleFilled /> : <CloseCircleFilled />}
            style={{ marginBottom: 16 }}
          />
          <Descriptions column={2}>
            <Descriptions.Item label="Exit Code">{instance.result.verify_exit_code}</Descriptions.Item>
            <Descriptions.Item label="结束时间">{formatTime(instance.result.finished_at)}</Descriptions.Item>
          </Descriptions>
          <Divider />
          <Title level={5}>Stdout</Title>
          <Input.TextArea
            value={instance.result.verify_stdout}
            disabled
            rows={10}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <Title level={5} style={{ marginTop: 16 }}>Stderr</Title>
          <Input.TextArea
            value={instance.result.verify_stderr}
            disabled
            rows={10}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </>
      ) : (
        <Empty description="暂无执行结果" />
      )}
    </TabPane>
    
    {/* Tab 3: Token & 耗时 */}
    <TabPane tab="Token & 耗时" key="metrics">
      {instance.result ? (
        <Descriptions column={2}>
          <Descriptions.Item label="Prompt Tokens">{instance.result.prompt_tokens.toLocaleString()}</Descriptions.Item>
          <Descriptions.Item label="Completion Tokens">{instance.result.completion_tokens.toLocaleString()}</Descriptions.Item>
          <Descriptions.Item label="Total Tokens">{instance.result.total_tokens.toLocaleString()}</Descriptions.Item>
          <Descriptions.Item label="Agent 耗时">{instance.result.agent_latency_ms} ms</Descriptions.Item>
        </Descriptions>
      ) : (
        <Empty description="暂无数据" />
      )}
    </TabPane>
    
    {/* Tab 4: 错误日志 */}
    <TabPane tab="错误日志" key="error">
      {instance.error_message || instance.result?.error_log ? (
        <>
          <Title level={5}>Error Message</Title>
          <Text type="danger">{instance.error_message}</Text>
          <Divider />
          <Title level={5}>Error Log</Title>
          <Input.TextArea
            value={instance.result?.error_log || ''}
            disabled
            rows={15}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </>
      ) : (
        <Empty description="无错误" />
      )}
    </TabPane>
  </Tabs>
  
  {/* 底部操作 */}
  <div style={{ textAlign: 'right', marginTop: 16 }}>
    <Space>
      <Button onClick={onClose}>关闭</Button>
      <Button 
        onClick={handleViewTrace}
        disabled={!instance.trace_id}
      >
        查看 Trace
      </Button>
      {['FAILED', 'TIMEOUT'].includes(instance.status) && (
        <Button type="primary" onClick={handleRetry}>重试</Button>
      )}
    </Space>
  </div>
</Drawer>
```

**查看 Trace 逻辑**：
```typescript
const handleViewTrace = async () => {
  if (!instance.trace_id) {
    message.warning('该实例尚未生成 Trace');
    return;
  }
  try {
    const { trace_id } = await getInstanceTrace(instance.id);
    window.open(`/traces?traceId=${trace_id}`, '_blank');
  } catch (err) {
    message.error('无法获取 Trace ID');
  }
};
```

---

## 8. 路由改造与 Trace 深链

### 8.1 路由注册（`router/index.tsx`）

**新增评测路由**：
```typescript
{
  path: 'eval',
  children: [
    {
      path: 'cases',
      element: <EvalCasesPage />,
    },
    {
      path: 'tasks',
      element: <EvalTasksPage />,
    },
    {
      path: 'tasks/:id',
      element: <TaskDetailPage />,
    },
  ],
}
```

### 8.2 Layout 菜单（`components/Layout/index.tsx`）

**新增菜单项**：
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

### 8.3 Trace 深链增强（`pages/Trace/index.tsx`）

**改造点**：
```typescript
import { useSearchParams } from 'react-router-dom';

export default function TracePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [modalTraceId, setModalTraceId] = useState<string | null>(null);
  const fetchTraces = useTraceStore((s) => s.fetchTraces);

  // 初始化：从 URL 读 traceId 自动打开 Modal
  useEffect(() => {
    const urlTraceId = searchParams.get('traceId');
    if (urlTraceId) {
      setModalTraceId(urlTraceId);
      // 清理 URL 参数（避免刷新重复打开）
      setSearchParams({}, { replace: true });
    }
    fetchTraces();
  }, [searchParams, setSearchParams, fetchTraces]);

  return (
    <div style={{ padding: 24 }}>
      <TraceFilters />
      <TraceTable onRowClick={setModalTraceId} />
      <TraceDetailModal
        key={modalTraceId}
        traceId={modalTraceId}
        open={modalTraceId !== null}
        onClose={() => setModalTraceId(null)}
      />
    </div>
  );
}
```

**改动说明**：
- 新增 `useSearchParams` 读取 URL query `traceId`
- 有值时自动设置 `modalTraceId` 打开 Modal
- 打开后立即清理 URL（`replace: true` 避免影响浏览器历史）
- Trace 详情 Modal 内部已有 404/错误处理，无需额外逻辑

---

## 9. 测试策略与验证边界

### 9.1 单元测试（可选，优先级低）

#### 9.1.1 Store 测试

**`store/__tests__/evalTask.test.ts`**：
- 轮询逻辑：模拟 tasks 含 RUNNING → 验证定时器启动 → tasks 全终态 → 验证定时器清除
- 竞态处理：连续调两次 `fetchTasks()` → 验证第一次 AbortController 被 abort
- 分页重置：`applyFiltersAndFetch()` → 验证 page 重置为 1

#### 9.1.2 组件测试

**React Testing Library**：
- `ScriptInput.tsx`：切换 tab、上传文件、编辑内容的交互
- `TaskCreateModal.tsx`：Transfer 选择、M×N 计算逻辑
- 其他组件：时间成本高、收益低，不强制

---

### 9.2 E2E 验证文档（必需，与实施计划一起产出）

**文档路径**：`docs/superpowers/plans/2026-07-17-eval-platform-e2e.md`

#### 9.2.1 用例管理

- [ ] **创建用例**：
  - 3 种脚本输入方式：
    - 上传 txt 文件（200 行 shell 脚本）
    - 直接在 TextArea 输入短文本（50 行）
    - 先上传后编辑（上传 100 行，编辑追加 20 行）
  - 验证提交后列表刷新，新用例出现
- [ ] **编辑用例**：
  - 修改 name：从"测试用例 A"改为"用例 A - 已更新"
  - 追加 tags：原有 `["基础"]`，追加后变为 `["基础", "回归"]`
  - 替换 verify_script：从"exit 0"改为"exit 1"
  - 验证提交后详情页显示最新内容
- [ ] **删除用例**：
  - **空闲用例删除成功**：创建一个未被任务引用的用例，删除后列表中消失
  - **被活动任务引用时返回 409**：
    - 创建任务 T1 引用用例 C1，任务状态为 RUNNING
    - 尝试删除 C1 → 后端返回 409 + 错误消息"用例正被 X 个运行中任务引用"
    - 前端显示错误 toast，用例未删除
- [ ] **列表过滤**：
  - 按 name_like 搜索："测试"关键词 → 只显示名称含"测试"的用例
  - 按 tags 过滤：选择 `["基础"]` → 只显示含该 tag 的用例
  - 组合过滤：name_like="A" + tags=["回归"] → 交集结果
- [ ] **分页**：
  - 创建 25 个用例，pageSize=20
  - 第一页显示 1-20，翻页到第二页显示 21-25
  - 改 pageSize 为 50 → page 重置为 1，显示全部 25 条

---

#### 9.2.2 任务管理

- [ ] **创建任务**：
  - Transfer 选 2 个用例 + 3 个 agent
  - 底部显示"将创建 2 × 3 = 6 个实例"
  - 提交后任务列表刷新，新任务状态为 PENDING
  - 任务列表自动开始轮询（观察 Network 面板，5s 一次请求）
- [ ] **任务列表轮询**：
  - 有 RUNNING 任务时：
    - 观察 Network 面板，每 5s 发起 `GET /api/eval/tasks` 请求
    - 任务状态从 PENDING → RUNNING → SUCCEEDED 过程中，表格实时更新
    - 进度数字（succeeded_count / total_count）动态变化
  - 全部任务终态后：
    - 所有任务状态为 SUCCEEDED 或 FAILED
    - 轮询停止（Network 面板 30s 内无新请求）
- [ ] **过滤任务**：
  - 按 status 过滤：
    - 选择"运行中" → 只显示 RUNNING 任务
    - 选择"已完成" → 只显示 SUCCEEDED 任务
    - 选择"全部" → 显示所有状态
- [ ] **删除任务**：
  - 点删除按钮 → 弹出确认对话框
  - 确认后任务消失，列表刷新

---

#### 9.2.3 任务详情与实例

- [ ] **进入详情页**：
  - 从任务列表点击某行
  - 路由跳转到 `/eval/tasks/:id`
  - 顶部卡片显示任务名、状态 Badge、进度条、时间信息
  - 中部实例表格显示 M×N 行（如 2×3=6 行）
- [ ] **实例列表轮询**：
  - 有 RUNNING 实例时：
    - 每 3s 刷新实例列表
    - 实例状态从 PENDING → RUNNING → SUCCEEDED 实时更新
    - token 数字、耗时动态变化
  - 全部终态后：
    - 轮询停止
- [ ] **实例过滤**：
  - 按 status 过滤：
    - 选择"已完成" → 只显示 SUCCEEDED 实例
    - 选择"失败" → 只显示 FAILED 实例
- [ ] **查看实例详情**：
  - 点实例表格某行 → 右侧滑出 Drawer
  - 4 个 Tab 切换正常：
    - **基础信息 Tab**：显示 conversation_id / message_id / worker_id / 时间戳
    - **执行结果 Tab**：
      - passed=true 显示绿色 Alert + 绿勾
      - passed=false 显示红色 Alert + 红叉
      - verify_stdout / verify_stderr 长文本可滚动（超过 10 行时）
    - **Token & 耗时 Tab**：显示 prompt_tokens / completion_tokens / total_tokens / agent_latency_ms
    - **错误日志 Tab**：SUCCEEDED 实例显示"无错误"，FAILED 实例显示 error_message + error_log
- [ ] **重试实例**：
  - **FAILED 实例点重试**：
    - 点击「重试」按钮
    - 实例状态变为 PENDING
    - attempt 递增（1 → 2）
    - 后续重新执行，状态变 RUNNING → SUCCEEDED/FAILED
  - **SUCCEEDED 实例点重试**：
    - 点击「重试」按钮
    - 后端返回 409 + 错误消息"实例状态不允许重试"
    - 前端显示错误 toast
- [ ] **删除实例**：
  - **SUCCEEDED / FAILED 实例删除成功**：
    - 点删除 → 确认 → 实例从列表消失
  - **RUNNING 实例删除返回 409**：
    - 点删除 → 后端返回 409
    - 前端显示错误 toast"实例正在运行，无法删除"
- [ ] **查看 Trace**：
  - 点实例详情 Drawer 底部「查看 Trace」按钮
  - 新 tab 打开 `/traces?traceId=xxx`
  - Trace 页面自动弹出 TraceDetailModal
  - Modal 内容正确显示：
    - span 树结构
    - 火焰图
    - 时间轴
  - 关闭 Modal 后 Trace 列表页保持正常

---

#### 9.2.4 跨页面联动

- [ ] **删除用例影响任务**：
  - 创建任务 T1 引用用例 C1
  - 任务 RUNNING 时删除 C1 → 返回 409，删除失败
  - 任务完成（SUCCEEDED/FAILED）后删除 C1 → 成功
  - 进入 T1 详情页 → 实例列表仍可访问（case_id 残留但 case 不存在）
  - UI 显示"用例已删除"或用例 ID（不影响查看结果）
- [ ] **刷新与深链**：
  - 复制 `/eval/tasks/:id` URL 到新 tab → 页面正常加载，显示任务详情
  - 在详情页刷新（F5） → 状态不丢失，实例列表重新加载
  - 分享 `/traces?traceId=xxx` 给同事 → 直接打开 Trace Modal

---

#### 9.2.5 边界与异常

- [ ] **上传文件过大（>10MB）**：
  - 选择 15MB 的文件上传
  - 前端 beforeUpload 校验阻止上传
  - 显示错误提示"文件大小不能超过 10MB"
- [ ] **上传非 UTF-8 文件**：
  - 上传二进制文件（如 .jpg）
  - 后端返回 400 + `ErrUploadNotUTF8`
  - 前端显示错误 toast
- [ ] **网络中断**：
  - 断开网络
  - 点击任何 API 请求（如拉取列表）
  - loading 状态正确显示
  - 显示错误 toast"网络连接失败"
- [ ] **空状态**：
  - **无用例**：用例列表为空时显示 antd Empty 组件
  - **无任务**：任务列表为空时显示 Empty
  - **无实例**：任务详情页实例列表为空时显示 Empty
  - **无结果**：实例详情 Drawer 的"执行结果"Tab 在 result 为 null 时显示"暂无执行结果"
- [ ] **离开页面轮询停止**：
  - 在任务列表页（有 RUNNING 任务，轮询中）
  - 点击左侧菜单跳转到"用例管理"
  - 观察 Network 面板，30s 内无 `GET /api/eval/tasks` 请求（轮询已停止）
  - 返回任务列表页 → 轮询重新启动

---

### 9.3 性能考量

#### 9.3.1 轮询开销

**最坏情况**：
- 100 个任务全 RUNNING → 5s 一次列表请求（~10KB）
- 详情页 100 个实例全 RUNNING → 3s 一次实例请求（~50KB）

**评估**：
- 可接受（评测场景通常 <20 任务、<50 实例/任务）
- 智能轮询策略已避免终态空轮询

#### 9.3.2 大文本渲染

**问题**：
- `verify_stdout` 可能 100KB+
- 后端已有 `VerifyOutputCapBytes` 限制（默认 1MB）

**方案**：
- 初版：直接用 TextArea，依赖后端截断
- 优化（可选）：前端显示前 10000 字符 + "查看全部"按钮

#### 9.3.3 Transfer 性能

**问题**：
- 用例可能 200+，Transfer 渲染压力

**方案**：
- antd Transfer 自带虚拟滚动（5.x 默认优化）
- 搜索功能缓解查找问题

---

### 9.4 可访问性（A11y）基线

参照 `.harness/rules/43-ui-accessibility.md`：

- **键盘导航**：
  - Modal / Drawer 可 Tab / Enter / Esc 操作
  - Transfer 组件可键盘选择、移动
  - 表格行可 Tab 聚焦、Enter 触发点击
- **ARIA**：
  - 表格行添加 `role="button"` + `aria-label="查看任务 XXX"`
  - 状态 Icon 添加 `title` 和 `aria-label`（如"成功" / "失败"）
  - Upload 组件使用 antd 内置 ARIA
- **色彩**：
  - 成功/失败用 Icon（绿勾/红叉）+ 文本双重表达，不依赖颜色
  - 状态 Badge 用颜色 + 文本（如"运行中"）
- **焦点管理**：
  - Modal 打开时焦点陷阱（antd 默认支持）
  - Drawer 关闭后焦点返回触发按钮

---

## 10. 实施顺序

### 10.1 Phase 1：基础设施（Week 1）

**目标**：搭建框架、API 层、类型、Store

1. 创建目录结构（`pages/Eval/Cases/` 等 3 个子目录）
2. 定义 `types/eval.ts`（15 个 DTO 接口）
3. 实现 `api/modules/eval.ts`（15 个 API 函数）
4. 实现 3 个 Store：
   - `store/evalCase.ts`（无轮询）
   - `store/evalTask.ts`（5s 轮询）
   - `store/evalInstance.ts`（3s 轮询）
5. 注册路由（`router/index.tsx` + Layout 菜单）

**产物**：
- API 层可调通后端全部 15 个 endpoint
- Store 的 fetch/create/delete action 可用
- 轮询逻辑单独测试通过

---

### 10.2 Phase 2：用例管理（Week 2）

**目标**：完成用例 CRUD 全流程

1. `Cases/CaseTable.tsx` — 表格 + 分页
2. `Cases/ScriptInput.tsx` — 上传/编辑双 Tab 组件
3. `Cases/CaseFormModal.tsx` — 创建/编辑表单（3 个脚本 Tabs）
4. `Cases/CaseDetailDrawer.tsx` — 只读详情
5. `Cases/index.tsx` — 页面组装 + 过滤器

**验证**：
- E2E § 9.2.1 全部通过

---

### 10.3 Phase 3：任务管理（Week 3）

**目标**：完成任务创建、列表、删除

1. `Tasks/TaskTable.tsx` — 表格 + 状态 Tag + 进度显示
2. `Tasks/TaskFilters.tsx` — 状态过滤器
3. `Tasks/TaskCreateModal.tsx` — 双 Transfer + M×N 预览
4. `Tasks/index.tsx` — 页面组装 + 轮询生命周期

**验证**：
- E2E § 9.2.2 全部通过
- 轮询启停逻辑正确

---

### 10.4 Phase 4：任务详情与实例（Week 4）

**目标**：完成实例列表、详情、Trace 跳转

1. `TaskDetail/TaskSummaryCard.tsx` — 任务汇总卡片
2. `TaskDetail/InstanceFilters.tsx` — 实例状态过滤
3. `TaskDetail/InstanceTable.tsx` — 实例表格
4. `TaskDetail/InstanceDrawer.tsx` — 实例详情（4 个 Tabs）
5. `TaskDetail/index.tsx` — 页面组装 + 轮询生命周期

**验证**：
- E2E § 9.2.3 全部通过
- Drawer 内 4 个 Tab 显示正确

---

### 10.5 Phase 5：Trace 深链与联动（Week 5）

**目标**：完成跨页面跳转、深链分享

1. 改造 `pages/Trace/index.tsx`：
   - 添加 `useSearchParams` 读取 `traceId`
   - 自动打开 Modal
   - 清理 URL 参数
2. `InstanceDrawer` 内实现「查看 Trace」按钮：
   - 调用 `getInstanceTrace(instanceId)`
   - `window.open('/traces?traceId=xxx', '_blank')`

**验证**：
- E2E § 9.2.3「查看 Trace」通过
- E2E § 9.2.4 跨页面联动通过

---

### 10.6 Phase 6：边界测试与打磨（Week 6）

**目标**：覆盖异常场景、优化体验

1. 上传文件前置校验（10MB 上限）
2. 空状态组件（Empty）补充
3. 错误 toast 文案优化
4. 轮询停止逻辑验证（离开页面 → Network 无请求）
5. A11y 检查（键盘导航、ARIA、色彩对比）

**验证**：
- E2E § 9.2.5 边界与异常全部通过
- A11y § 9.4 基线检查通过

---

## 11. 风险与缓解

### 11.1 风险 1：轮询导致后端压力

**场景**：100 个用户同时打开任务列表页，每 5s 轮询一次

**影响**：后端 QPS 飙升

**缓解**：
- 智能轮询已避免终态空请求
- 评测场景用户量可控（内部工具）
- 后端可加 Redis 缓存任务列表

---

### 11.2 风险 2：大文本卡顿

**场景**：verify_stdout 100KB+，TextArea 渲染卡顿

**影响**：Drawer 打开慢、滚动不流畅

**缓解**：
- 后端已有 `VerifyOutputCapBytes` 截断（1MB）
- 前端可加截断显示（初版不做）
- 用 `<pre>` 替代 TextArea（更轻量，但失去选中复制优势）

---

### 11.3 风险 3：用例/任务数量过多

**场景**：200+ 用例，Transfer 性能问题

**影响**：创建任务 Modal 打开慢

**缓解**：
- antd Transfer 5.x 自带虚拟滚动
- 搜索框缓解查找压力
- 极端场景（500+ 用例）：后端分页 + 前端懒加载（初版不做）

---

## 12. 未来扩展方向

### 12.1 结果对比与趋势分析

**需求**：对比多个任务的 token 用量、耗时、通过率

**实现**：
- 新增 `/eval/analytics` 页面
- 图表库（ECharts / Recharts）
- 后端提供聚合 API

---

### 12.2 实时日志流

**需求**：查看 Agent 执行过程的实时日志

**实现**：
- 后端新增 SSE endpoint `/api/eval/instances/:id/logs`
- 前端 InstanceDrawer 新增"实时日志"Tab
- 用 EventSource 订阅日志流

---

### 12.3 批量操作

**需求**：批量重试失败实例、批量删除任务

**实现**：
- 表格支持多选（`rowSelection`）
- 后端新增批量 API（如 `POST /api/eval/tasks/batch-delete`）

---

### 12.4 用例模板库

**需求**：预置常见评测场景模板（如"代码生成"、"问答准确性"）

**实现**：
- 后端新增 `/api/eval/templates` CRUD
- 前端用例创建页新增"从模板创建"按钮

---

## 13. 总结

### 13.1 设计要点

1. **完全对齐现有模式**：目录、Store、API 层与 Trace/Skill/Tool 一致，无学习成本
2. **智能轮询**：仅在存在活动状态时轮询，终态自动停止，节省带宽
3. **细粒度组件**：~20 个组件文件，职责清晰，易测试、易维护
4. **类型安全**：透传 snake_case，与后端 DTO 1:1 映射，无字段名转换风险
5. **无新依赖**：复用 antd TextArea 处理长文本，不引入 Monaco/CodeMirror

### 13.2 关键决策回顾

| 决策点 | 选择 | 理由 |
|---|---|---|
| 导航结构 | 两个子页（用例/任务），结果内嵌 | 结果是任务的下钻视图，独立成页反直觉 |
| 脚本输入 | 上传/编辑双 Tab | 兼顾长脚本上传与小改动直接编辑 |
| 实时刷新 | 智能轮询（5s/3s） | 后端无 SSE，轮询是唯一选择；智能策略避免空请求 |
| 任务创建 | Transfer + M×N 预览 | 用例数量多，Transfer 比 Select 更适合；M×N 提示防误操作 |
| 实例展示 | 表格 + Drawer | 复用 Trace 模式，长文本进 Drawer 不挤压表格 |
| 任务编辑 | 不做编辑，只删除/重试 | 后端无编辑接口，不破坏结果一致性 |
| 任务详情 | 独立路由 `/eval/tasks/:id` | 支持深链分享，不丢浏览器前进后退 |
| 用例详情 | 3 个脚本字段用 Tabs 切换 | 长文本字段占据视野，Tabs 让用户按需查看 |
| Trace 跳转 | 新 tab + URL param 自动开 Modal | 不丢评测上下文，Trace 页获得深链能力 |

### 13.3 交付物清单

- [x] 设计文档（本文档）
- [ ] 实施计划（writing-plans skill 产出）
- [ ] E2E 验证文档（与实施计划一起产出）
- [ ] ~20 个组件文件
- [ ] 3 个 Store 文件
- [ ] 1 个 API 模块文件
- [ ] 1 个类型定义文件
- [ ] 路由注册（2 处改动）
- [ ] Trace 深链改造（1 处改动）

**预估工作量**：6 周（1 人全职）

---

## 附录 A：后端 API 契约

参见 `mooc-manus/api/handlers/eval.go` 与 `mooc-manus/internal/applications/dtos/eval.go`。

**15 个 Endpoint**：
```
POST   /api/eval/cases/upload-content
POST   /api/eval/cases
PUT    /api/eval/cases/:id
GET    /api/eval/cases
GET    /api/eval/cases/:id
DELETE /api/eval/cases/:id

POST   /api/eval/tasks
GET    /api/eval/tasks
GET    /api/eval/tasks/:id
POST   /api/eval/tasks/:id/retry
DELETE /api/eval/tasks/:id
GET    /api/eval/tasks/:id/instances

GET    /api/eval/instances/:id
GET    /api/eval/instances/:id/trace
POST   /api/eval/instances/:id/retry
DELETE /api/eval/instances/:id

GET    /api/eval/agent-configs
```

---

## 附录 B：状态机

### 任务状态流转

```
PENDING → RUNNING → SUCCEEDED
                  → FAILED
```

### 实例状态流转

```
PENDING → RUNNING → SUCCEEDED
                  → FAILED
                  → TIMEOUT
```

**重试规则**：
- Task：可重试（retry 所有 FAILED/TIMEOUT 实例）
- Instance：仅 FAILED/TIMEOUT 可重试，attempt 递增

---

## 附录 C：参考文件

| 文件 | 作用 | 复用点 |
|---|---|---|
| `pages/Trace/index.tsx` | Trace 列表页 | 页面结构、useEffect 生命周期 |
| `pages/Trace/TraceTable.tsx` | Trace 表格 | 列定义、分页、行点击 |
| `store/trace.ts` | Trace store | AbortController 竞态处理、分页逻辑 |
| `api/modules/trace.ts` | Trace API | 函数命名、错误处理 |
| `types/trace.ts` | Trace 类型 | snake_case 透传、DTO 映射 |
| `components/Layout/index.tsx` | 布局菜单 | 父子菜单结构 |

---

**文档版本**：v1.0  
**编写日期**：2026-07-17  
**作者**：Claude (Opus 4.7) + 用户协作  
**状态**：待 spec-document-reviewer 审核


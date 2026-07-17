# M3 任务管理模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M3
**依赖**：M1（types + api + store/evalTask + 路由占位）、M2（可选：需已有用例数据供选择）
**被依赖**：M4（任务详情页从任务列表跳转进入）

---

## 1. 模块范围

实现评测任务的创建、列表展示、状态轮询、删除，替换 M1 的 `/eval/tasks` 路由占位。

### 1.1 交付物

4 个组件（`src/pages/Eval/Tasks/`）：
- `index.tsx` — 页面容器（组装 + 轮询生命周期）
- `TaskTable.tsx` — 任务表格（状态 Tag、进度显示、行点击）
- `TaskCreateModal.tsx` — 创建 Modal（双 Transfer + M×N 预览）
- `TaskFilters.tsx` — 状态过滤器（Radio.Group）

修改 1 处：
- `router/index.tsx` — 将 `/eval/tasks` 占位替换为 `<EvalTasksPage />`

### 1.2 非目标

- 不做任务编辑（后端无 PUT/PATCH，父规格 §13.2 已定）
- 不做任务详情页（属 M4）
- 不做实例级别操作（属 M4）

---

## 2. 组件设计

### 2.1 `TaskFilters.tsx`（状态过滤器）

**Props**：无（直接读写 `useEvalTaskStore`）

**结构**：`Radio.Group` buttonStyle="solid"，5 个按钮：
- 全部（value=""）
- 待执行（PENDING）
- 运行中（RUNNING）
- 已完成（SUCCEEDED）
- 失败（FAILED）

**逻辑**：`onChange` 调 `evalTask.applyFiltersAndFetch({ status })`

**详见父规格 §7.2.4**

### 2.2 `TaskTable.tsx`（任务表格）

**Props**：
```typescript
interface TaskTableProps {
  onRowClick: (id: string) => void;  // 跳转任务详情
}
```

**列定义**（7 列）：
| 列 | 数据源 | 渲染 | 宽度 |
|---|---|---|---|
| 名称 | `name` | 纯文本 | 200px |
| 状态 | `status` | `<Tag color={statusColor}>` | 100px |
| 进度 | 4 个 count | `成功X/失败Y/运行中Z/共N` 或迷你 Progress | 200px |
| 创建时间 | `created_at` | `dayjs().format('YYYY-MM-DD HH:mm')` | 180px |
| 开始时间 | `started_at` | 格式化，null 显示 `--` | 180px |
| 结束时间 | `finished_at` | 格式化，null 显示 `--` | 180px |
| 操作 | - | 查看详情 / 重试 / 删除 | 180px |

**状态颜色映射**：
```typescript
const statusColorMap = {
  PENDING: 'blue',
  RUNNING: 'processing',
  SUCCEEDED: 'success',
  FAILED: 'error',
};
```

**行点击**：`onRow.onClick` 触发 `onRowClick(record.id)` → 父组件 `navigate('/eval/tasks/' + id)`（跳到 M4）

**详见父规格 §7.2.2**

### 2.3 `TaskCreateModal.tsx`（创建任务 Modal）

**Props**：
```typescript
interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
}
```

**结构**（三段式，Modal width=900）：
1. 顶部 `Form.Item label="任务名称" required` + Input
2. `<Row gutter={16}>`：
   - `<Col span={12}>`：用例 Transfer（`showSearch`, `listStyle.height=400`）
   - `<Col span={12}>`：Agent Transfer
3. `<Alert type="info">` 显示 `将创建 M × N = X 个实例`
4. 底部：取消 / 创建按钮（未填名称或未选任一侧时 disable）

**数据加载**（Modal 打开时）：
```typescript
useEffect(() => {
  if (!open) return;
  listCases({ page: 1, size: 100 }).then(r => setCases(r.items));
  listAgentConfigs().then(setAgents);
}, [open]);
```

**注**：直接调 API 拉全量，**不走 evalCase store**（避免污染用例列表页状态）。

**提交**：
```typescript
handleSubmit = async () => {
  await evalTask.createTask({
    name: taskName,
    case_ids: selectedCaseIds,
    agent_config_ids: selectedAgentIds,
  });
  onClose();
  // store 已自动 fetchTasks + startPolling
};
```

**详见父规格 §7.2.3**

### 2.4 `index.tsx`（页面容器）

**结构**：
- 顶部操作栏：`<TaskFilters>` + 「创建任务」按钮
- 主体：`<TaskTable onRowClick={id => navigate('/eval/tasks/' + id)}>`
- 弹层：`<TaskCreateModal>`

**生命周期**：
```typescript
useEffect(() => {
  evalTask.fetchTasks();
  evalTask.startPolling();
  return () => evalTask.stopPolling();  // 离开页面停轮询
}, []);
```

**详见父规格 §7.2.1**

---

## 3. 数据流

### 3.1 创建任务

```
用户填名称 + 选 M 用例 + 选 N Agent
  → 底部实时显示"将创建 M×N = X 个实例"（纯 UI 计算，无 API）
  → 点「创建」→ evalTask.createTask(req)
  → api POST /api/eval/tasks
  → 成功：store 内部 fetchTasks() + startPolling() 自动启动
  → onClose 关闭 Modal
```

### 3.2 任务列表轮询

```
Tasks/index.tsx mount
  → fetchTasks() + startPolling()
  → 每 5s 检查：tasks 中是否含 PENDING/RUNNING?
    - 有 → 静默调 fetchTasks()（loading 不置 true，避免闪烁）
    - 无 → 停止 setInterval
  → 用户看到状态/进度自动更新
Tasks/index.tsx unmount
  → stopPolling() 清理定时器
```

### 3.3 删除任务

```
点「删除」→ Popconfirm 确认 → evalTask.deleteTask(id)
  → api DELETE /api/eval/tasks/:id
  → 成功：store 刷新列表
```

### 3.4 重试任务

```
点「重试」→ evalTask.retryTask(id)
  → api POST /api/eval/tasks/:id/retry
  → 后端返回 { retried_count: N }
  → 前端 toast "已重试 N 个失败实例"
  → store 刷新列表 + 恢复轮询
```

---

## 4. 关键实现细节

### 4.1 M×N 实时预览

`TaskCreateModal` 里：
```tsx
const count = selectedCaseIds.length * selectedAgentIds.length;
<Alert
  type={count === 0 ? 'warning' : count > 100 ? 'warning' : 'info'}
  message={`将创建 ${selectedCaseIds.length} × ${selectedAgentIds.length} = ${count} 个实例`}
/>
```

（可选）当 count > 100 时颜色变 warning 提醒用户。

### 4.2 Transfer 数据映射

用例：
```typescript
dataSource={cases.map(c => ({ key: c.id, title: c.name, description: c.description }))}
```

Agent：
```typescript
dataSource={agents.map(a => ({ key: a.id, title: `${a.provider} - ${a.model_name}` }))}
```

Transfer 组件自带虚拟滚动 + 搜索。

### 4.3 进度列渲染

```tsx
render: (_, task) => (
  <Space size="small">
    <Text type="success">✓{task.succeeded_count}</Text>
    <Text type="danger">✗{task.failed_count}</Text>
    <Text>⟳{task.running_count}</Text>
    <Text type="secondary">/ {task.total_count}</Text>
  </Space>
)
```

### 4.4 轮询静默刷新

`store/evalTask.ts` 的轮询 tick 里不该 `set({ loading: true })`，否则表格反复闪。参考 M1 spec §4.2 的实现。

---

## 5. 验证边界

**功能验证**：见 `M3-task-management-e2e.md`
- 创建任务全流程
- 智能轮询启停
- 状态过滤
- 删除与重试

**技术验证**：
- 离开页面 Network 面板无 `GET /api/eval/tasks` 请求（轮询已停）
- 全终态后 5s 内无请求（轮询自停）

---

## 6. 关键决策（继承父规格）

| 决策点 | 选择 | 依据 |
|---|---|---|
| 批量选择 | 双 Transfer + M×N 预览 | 父规格 §7.2.3 |
| 轮询策略 | 5s 智能轮询 | 父规格 §4.1.2 |
| 任务编辑 | 不做（后端无接口） | 父规格 §13.2 |
| 数据加载 | Modal 打开时直调 API，不走 store | 父规格 §4.2.1 |
| 行点击 | 跳独立路由（非 Modal） | 父规格 §7 决策 A |

---

## 7. 交付验收

- [ ] 4 个组件文件已创建
- [ ] `router/index.tsx` 占位已替换
- [ ] E2E 文档全部通过
- [ ] 依赖 M1、（推荐）M2；不阻塞 M4

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.2

# M3 任务管理规格

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`（§7.2）
**依赖模块**：M1（类型、API、evalTask store、路由占位）；推荐 M2 已交付（用例列表数据）
**下游模块**：M4（任务详情从任务列表跳转进入）

---

## 1. 目标

在 `/eval/tasks` 页面实现评测任务的列表、创建、删除、状态过滤，并集成智能轮询（5 秒）。

**验收目标**：
- 4 个组件文件全部产出，页面组装可用
- 任务创建通过双 Transfer 选择用例 × Agent，实时预览 M×N 实例数量
- 智能轮询启停正确：有 RUNNING 任务时轮询、全部终态时停止、离开页面时停止
- 任务表格状态 Tag、进度显示正确

---

## 2. 范围

### 2.1 in-scope

| 文件 | 说明 |
|---|---|
| `src/pages/Eval/Tasks/index.tsx` | 页面容器（组装 Filters + Table + CreateModal） |
| `src/pages/Eval/Tasks/TaskTable.tsx` | 任务表格（状态 Tag、进度、行点击跳详情） |
| `src/pages/Eval/Tasks/TaskFilters.tsx` | 状态过滤器（Radio.Group Button 风格） |
| `src/pages/Eval/Tasks/TaskCreateModal.tsx` | 创建任务 Modal（双 Transfer + M×N 预览） |

### 2.2 out-of-scope

- 任务编辑（后端无编辑 API）
- 任务详情、实例列表（M4）
- 重试全部失败实例的批量操作 UI 之外的实现（本模块只做 UI 触发，重试 API 由 evalTask.retryTask 已在 M1 提供）

---

## 3. 详细设计

### 3.1 `Tasks/index.tsx` — 页面容器

**布局**（详见父规格 §7.2.1）：
```tsx
<div style={{ padding: 24 }}>
  <Space style={{ marginBottom: 16 }}>
    <TaskFilters />
    <Button type="primary" onClick={() => setCreateModalOpen(true)}>创建任务</Button>
  </Space>
  <TaskTable onRowClick={(id) => navigate(`/eval/tasks/${id}`)} />
  <TaskCreateModal open={createModalOpen} onClose={handleCreateClose} />
</div>
```

**生命周期**：
```typescript
useEffect(() => {
  evalTask.fetchTasks();
  evalTask.startPolling();
  return () => evalTask.stopPolling();  // 离开页面停轮询
}, []);
```

---

### 3.2 `TaskTable.tsx` — 任务表格

**列定义**（详见父规格 §7.2.2）：

| 列 | 数据源 | 渲染 | 宽度 |
|---|---|---|---|
| 名称 | `name` | 纯文本 | 200 |
| 状态 | `status` | `<Tag color={statusColor}>{status}</Tag>` | 100 |
| 进度 | `succeeded/failed/running/total` | `成功 X / 失败 Y / 运行中 Z / 总计 N` | 200 |
| 创建时间 | `created_at` | 格式化 | 180 |
| 开始时间 | `started_at` | 格式化，可空显示 `--` | 180 |
| 结束时间 | `finished_at` | 格式化，可空显示 `--` | 180 |
| 操作 | - | 查看详情/重试/删除 | 180 |

**状态颜色映射**：
```typescript
const statusColorMap = {
  PENDING: 'blue',
  RUNNING: 'processing',
  SUCCEEDED: 'success',
  FAILED: 'error',
};
```

**行点击**：整行可点击跳转（`onRow.onClick`），并加 `role="button"` + `aria-label` 满足 A11y。

**分页**：`pagination={{ current, pageSize, total, showSizeChanger, onChange }}`，与 store 双向绑定。

---

### 3.3 `TaskFilters.tsx` — 状态过滤器

**实现**（详见父规格 §7.2.4）：
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

**注**：`applyFiltersAndFetch` 内部会 reset page=1 后 fetchTasks。

---

### 3.4 `TaskCreateModal.tsx` — 创建任务

**布局**（三段式，详见父规格 §7.2.3）：

1. **任务名** — `Form.Item` + `Input`（必填）
2. **双 Transfer** — 一列选用例、一列选 Agent
   - `Transfer` props：`dataSource`、`targetKeys`、`onChange`、`showSearch`、`listStyle={{ height: 400 }}`
   - 用例 `dataSource`：`cases.map(c => ({ key: c.id, title: c.name }))`
   - Agent `dataSource`：`agents.map(a => ({ key: a.id, title: `${a.provider} - ${a.model_name}` }))`
3. **实例数量预览** — `Alert type="info"` 显示 `M × N = X 个实例`

**数据加载**：
```typescript
useEffect(() => {
  if (!open) return;
  listCases({ page: 1, size: 100 }).then(resp => setCases(resp.items));
  listAgentConfigs().then(setAgents);
}, [open]);
```

**注意**：`listCases` 直接调 API，不走 `evalCase` store（避免污染用例列表页的分页状态）。

**提交按钮 disabled 条件**：`!taskName || selectedCaseIds.length === 0 || selectedAgentIds.length === 0`。

**提交逻辑**：
```typescript
await evalTask.createTask({
  name: taskName,
  case_ids: selectedCaseIds,
  agent_config_ids: selectedAgentIds,
});
// 成功后 store 内部会 fetchTasks() + startPolling()
onClose();
```

---

### 3.5 智能轮询集成

**Store 已在 M1 实现**，本模块只做页面生命周期集成：
```typescript
useEffect(() => {
  evalTask.fetchTasks();
  evalTask.startPolling();
  return () => evalTask.stopPolling();
}, []);
```

**期望行为**：
- 页面挂载 → 立即拉一次 + 启动 5s 定时器
- 每次轮询后检查：若 tasks 中无 `PENDING` / `RUNNING` → 自动停止定时器
- 页面卸载（离开路由）→ 调 stopPolling 清除定时器

---

## 4. 与父规格的对齐

- 列定义、状态颜色、Radio 过滤器与父规格 §7.2 一致
- 双 Transfer + M×N 预览符合父规格 §4.2.1 数据流
- 无新依赖（Transfer 是 antd 现有组件）

---

## 5. 与 M2 的关系

- M3 的 `TaskCreateModal` 需要"用例列表"数据，通过直接调 `listCases` API 获取（不依赖 M2 组件）
- 若 M2 未交付，M3 仍可开发，但 E2E 场景需要先手工调 API 造数据

---

## 6. 验收标准

见 `M3-task-management-e2e.md`。核心场景：
- 创建任务时 M×N 预览实时更新
- 创建后任务列表自动刷新 + 启动轮询
- RUNNING 任务的进度数字动态更新
- 全部任务终态后轮询停止（Network 面板验证）
- 离开页面后轮询停止

---

**规格版本**：v1.0
**依赖**：M1（M2 推荐）
**预估工作量**：4 ~ 5 天

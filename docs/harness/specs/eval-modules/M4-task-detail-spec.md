# M4 任务详情模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M4
**依赖**：M1（types + api + store/evalInstance + 路由占位）、M3（从任务列表跳转进入）
**被依赖**：M5（InstanceDrawer 内的「查看 Trace」需 M5 深链能力）

---

## 1. 模块范围

实现任务详情独立路由页 `/eval/tasks/:id`，含任务汇总、实例列表、单实例详情。

### 1.1 交付物

5 个组件（`src/pages/Eval/TaskDetail/`）：
- `index.tsx` — 页面容器（读 URL param、组装、轮询生命周期）
- `TaskSummaryCard.tsx` — 顶部任务汇总卡片（含操作按钮）
- `InstanceFilters.tsx` — 实例状态过滤器（Radio.Group，6 个状态）
- `InstanceTable.tsx` — 实例列表表格
- `InstanceDrawer.tsx` — 单实例详情 Drawer（4 个 Tabs）

修改 1 处：
- `router/index.tsx` — 将 `/eval/tasks/:id` 占位替换为 `<TaskDetailPage />`

### 1.2 非目标

- 「查看 Trace」跳转的完整能力属 M5（本模块只做按钮 + 简单 window.open）
- 不做批量操作（属未来扩展）
- Agent 列采用简化显示（父规格 §7.3.3：初版显示"多 Agent 任务"）

---

## 2. 组件设计

### 2.1 `TaskSummaryCard.tsx`（任务汇总卡片）

**Props**：
```typescript
interface TaskSummaryCardProps {
  taskId: string;
}
```

**内部**：`useEffect` 拉 `getTask(taskId)`，本地 state 保存 TaskView

**布局**（Card 内）：
- 左侧（span=16）：任务名标题 + 状态 Tag + Descriptions（创建/开始/结束时间）
- 右侧（span=8）：Progress 进度条 + 四个 count 数字文本
- 底部按钮栏：返回列表 / 重试失败实例 / 删除任务

**详见父规格 §7.3.2**

**注**：TaskView 需要每次进入详情页时新鲜拉取（不复用 evalTask store，避免列表页数据不含最新 count），或通过 store 加个 `currentTask` 状态。**方案 A**：本组件独立调 `getTask`，与 evalInstance 的轮询共同刷新任务卡片；Card 内也 5s 轮询 `getTask`（因为 Task 的 count 字段随实例状态而变）。

### 2.2 `InstanceFilters.tsx`（实例状态过滤器）

**Props**：无（读写 `useEvalInstanceStore`）

**结构**：`Radio.Group`，6 个按钮：
- 全部 / PENDING / RUNNING / SUCCEEDED / FAILED / TIMEOUT

**逻辑**：`onChange` 调 `evalInstance.applyFiltersAndFetch({ status })`

### 2.3 `InstanceTable.tsx`（实例表格）

**Props**：
```typescript
interface InstanceTableProps {
  taskId: string;
  onRowClick: (id: string) => void;  // 打开 InstanceDrawer
}
```

**列定义**（7 列，详见父规格 §7.3.3）：
| 列 | 数据源 | 渲染 |
|---|---|---|
| 状态 | `status` | Icon（statusIconMap） |
| 用例 | `case_id` | 显示 ID（或预加载映射为 name） |
| Agent | 简化 | 显示「多 Agent 任务」或从 TaskView 推断 |
| 尝试次数 | `attempt` | 数字 |
| 耗时 | `started_at`/`finished_at` | `X分Y秒` |
| Token | `result.total_tokens` | 数字或 `--` |
| 操作 | - | 查看详情/重试/删除/查看Trace |

**状态 Icon 映射**：父规格 §7.3.3 已提供

**Agent 列简化实现**（父规格 §7.3.3 决策）：
- 初版：从父组件传入 TaskView.agent_config_ids + 全量 agentConfigs
- 若 `agent_config_ids.length === 1`：显示唯一 agent 的 `${provider} - ${model_name}`
- 若 `length > 1`：显示「多 Agent 任务（点开查看）」

**操作列按钮启用条件**：
- 重试：仅 FAILED / TIMEOUT 可点
- 删除：非 RUNNING 可点
- 查看 Trace：`instance.trace_id` 非空可点

### 2.4 `InstanceDrawer.tsx`（实例详情 4 Tabs Drawer）

**Props**：
```typescript
interface InstanceDrawerProps {
  instanceId: string | null;
  open: boolean;
  onClose: () => void;
}
```

**数据加载**：`useEffect(() => { if (open && instanceId) getInstance(instanceId).then(setInstance); }, [open, instanceId])`

**结构**（详见父规格 §7.3.4）：
- 顶部状态栏：Badge + attempt
- **Tab 1「基础信息」**：Descriptions 显示 id / task_id / case_id / conv_id / msg_id / worker_id / 5 个时间字段
- **Tab 2「执行结果」**：passed Alert（绿/红）+ exit_code + finished_at + stdout/stderr TextArea 只读
- **Tab 3「Token & 耗时」**：prompt_tokens / completion_tokens / total_tokens / agent_latency_ms（`.toLocaleString()`）
- **Tab 4「错误日志」**：error_message + error_log（仅在存在时显示，否则 Empty）
- 底部按钮：关闭 / 查看 Trace（`disabled={!instance.trace_id}`）/ 重试（仅 FAILED/TIMEOUT）

**查看 Trace 逻辑**（父规格 §7.3.4 最后代码块）：
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

**注**：M5 未交付时点开 Trace 页会跳到列表，不会自动开 Modal；M5 交付后才有 URL 自动开 Modal 能力。M4 只需实现 `window.open` 即可。

### 2.5 `index.tsx`（页面容器）

**结构**：
```tsx
const { id: taskId } = useParams<{ id: string }>();
const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

if (!taskId) return <Navigate to="/eval/tasks" replace />;

return (
  <div style={{ padding: 24 }}>
    <TaskSummaryCard taskId={taskId} />
    <InstanceFilters style={{ marginTop: 16 }} />
    <InstanceTable
      taskId={taskId}
      onRowClick={setSelectedInstanceId}
      style={{ marginTop: 16 }}
    />
    <InstanceDrawer
      instanceId={selectedInstanceId}
      open={!!selectedInstanceId}
      onClose={() => setSelectedInstanceId(null)}
    />
  </div>
);
```

**生命周期**（父规格 §7.3.1）：
```typescript
useEffect(() => {
  if (!taskId) return;
  evalInstance.fetchInstances(taskId);
  evalInstance.startPolling(taskId);
  return () => {
    evalInstance.stopPolling();
    evalInstance.reset();  // 关键：清空防止污染下次进入
  };
}, [taskId]);
```

---

## 3. 数据流

### 3.1 进入详情页

```
用户从 M3 任务列表点行 → navigate('/eval/tasks/:id')
  → TaskDetailPage mount → 读 taskId
  → TaskSummaryCard 独立调 getTask(taskId)
  → evalInstance.fetchInstances(taskId) + startPolling(taskId)
  → 表格显示 M×N 行
  → Card 内自轮询 getTask，更新 count 字段
```

### 3.2 打开实例详情

```
点表格行 → setSelectedInstanceId(id) → InstanceDrawer 打开
  → useEffect 调 getInstance(id) 拉最新数据
  → 4 Tab 展示
```

### 3.3 重试实例

```
点行操作列「重试」（仅 FAILED/TIMEOUT）
  → evalInstance.retryInstance(id)
  → api POST /api/eval/instances/:id/retry
  → 409（状态不允许）拦截器 toast
  → 200 → store 刷新实例列表，attempt+1，status → PENDING
```

### 3.4 删除实例

```
点「删除」→ Popconfirm → evalInstance.deleteInstance(id)
  → 409（RUNNING 不可删）拦截器 toast
  → 200 → store 刷新
```

### 3.5 离开详情页

```
用户点面包屑/菜单/浏览器返回
  → useEffect cleanup 触发
  → stopPolling() + reset()
  → 下次再进入是干净状态
```

---

## 4. 关键实现细节

### 4.1 独立轮询 vs 复用 evalTask store

TaskSummaryCard 需要显示 count 字段实时变化。方案：
- **推荐**：TaskSummaryCard 内部启一个 5s 定时器调 `getTask(taskId)` 刷新
- 不复用 evalTask store 的 `tasks[]`（因为 store 装的是列表页数据，可能不含当前任务）

```typescript
useEffect(() => {
  const fetch = () => getTask(taskId).then(setTask);
  fetch();
  const timer = setInterval(() => {
    if (task && !['SUCCEEDED', 'FAILED'].includes(task.status)) {
      fetch();
    }
  }, 5000);
  return () => clearInterval(timer);
}, [taskId, task?.status]);
```

### 4.2 状态 Icon 表格

```tsx
const statusIconMap: Record<string, ReactNode> = {
  PENDING: <ClockCircleOutlined style={{ color: token.colorTextDisabled }} title="待执行" />,
  RUNNING: <LoadingOutlined style={{ color: token.colorPrimary }} title="运行中" />,
  SUCCEEDED: <CheckCircleFilled style={{ color: token.colorSuccess }} title="成功" />,
  FAILED: <CloseCircleFilled style={{ color: token.colorError }} title="失败" />,
  TIMEOUT: <ExclamationCircleFilled style={{ color: token.colorWarning }} title="超时" />,
};
```

### 4.3 耗时计算

```typescript
function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return '--';
  const start = dayjs(startedAt);
  const end = finishedAt ? dayjs(finishedAt) : dayjs();
  const seconds = end.diff(start, 'second');
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}分${rest}秒` : `${rest}秒`;
}
```

### 4.4 URL 无效 taskId

若 `/eval/tasks/invalid-id`，TaskSummaryCard 的 `getTask` 返回 404，request.ts 拦截器 toast「资源不存在」。表格拉 instances 也返回空。UI 应保持稳定不崩。

---

## 5. 验证边界

**功能验证**：见 `M4-task-detail-e2e.md`
**技术验证**：
- reset() 生效（连续访问两个不同 taskId，state 无残留）
- 轮询在离开页面后停止

---

## 6. 关键决策（继承父规格）

| 决策点 | 选择 | 依据 |
|---|---|---|
| 页面形态 | 独立路由 `/eval/tasks/:id`，非 Modal | 父规格 §7 决策 A |
| 实例详情 | 右侧 Drawer + 4 Tabs | 父规格 §7.3.4 |
| 轮询频率 | 3s（比任务列表快） | 父规格 §4.1.3 |
| Agent 列 | 简化显示，不推断 M×N 组合 | 父规格 §7.3.3 |
| Trace 跳转 | window.open 新 tab + 依赖 M5 深链 | 父规格 §7.3.4 |

---

## 7. 交付验收

- [ ] 5 个组件文件已创建
- [ ] `router/index.tsx` 占位已替换
- [ ] E2E 文档全部通过
- [ ] 独立可测（M5 未交付时 Trace 跳转到列表页也算通过）

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.3

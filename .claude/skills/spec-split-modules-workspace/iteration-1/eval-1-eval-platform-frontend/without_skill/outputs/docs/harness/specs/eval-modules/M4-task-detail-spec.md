# M4 任务详情规格

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`（§7.3）
**依赖模块**：M1（类型、API、evalInstance store、路由占位）、M3（从任务列表行点击进入）
**下游模块**：M5（InstanceDrawer 中的「查看 Trace」按钮由 M5 完成对接）

---

## 1. 目标

在 `/eval/tasks/:id` 页面实现任务详情三段式布局：任务汇总卡片 + 实例过滤器 + 实例表格 + 实例详情 Drawer（4 Tabs）。集成 3 秒智能轮询、实例重试/删除、Trace 跳转按钮。

**验收目标**：
- 5 个组件文件全部产出，页面组装可用
- 实例表格展示 M×N 行数据，状态 Icon 正确
- 实例详情 Drawer 的 4 个 Tab 内容完整（基础信息 / 执行结果 / Token & 耗时 / 错误日志）
- 智能轮询启停正确（3s 间隔，全终态停止）
- 重试 SUCCEEDED 实例 → 409 错误 toast；删除 RUNNING 实例 → 409 错误 toast

---

## 2. 范围

### 2.1 in-scope

| 文件 | 说明 |
|---|---|
| `src/pages/Eval/TaskDetail/index.tsx` | 页面容器（三段式 + Drawer） |
| `src/pages/Eval/TaskDetail/TaskSummaryCard.tsx` | 顶部任务汇总卡片（含进度条 + 操作按钮） |
| `src/pages/Eval/TaskDetail/InstanceFilters.tsx` | 实例状态过滤器 |
| `src/pages/Eval/TaskDetail/InstanceTable.tsx` | 实例表格（状态 Icon、Agent 列、耗时、token） |
| `src/pages/Eval/TaskDetail/InstanceDrawer.tsx` | 实例详情 Drawer（4 Tabs） |

### 2.2 out-of-scope

- 「查看 Trace」按钮的深链跳转对接 → M5
- 后端扩展 InstanceView 加 agent_config_id 字段（非本项目范围）

---

## 3. 详细设计

### 3.1 `TaskDetail/index.tsx` — 页面容器

**布局**（详见父规格 §7.3.1）：
```tsx
<div style={{ padding: 24 }}>
  <TaskSummaryCard taskId={taskId} />
  <InstanceFilters style={{ marginTop: 16 }} />
  <InstanceTable taskId={taskId} onRowClick={setSelectedInstanceId} style={{ marginTop: 16 }} />
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
    evalInstance.reset();  // 清空状态，避免下次进入残留
  };
}, [taskId]);
```

---

### 3.2 `TaskSummaryCard.tsx` — 任务汇总

**布局**（详见父规格 §7.3.2）：
- **左侧（span=16）**：任务名（Title）+ 状态 Tag + Descriptions（创建/开始/结束时间）
- **右侧（span=8）**：Progress 进度条（`succeeded/total * 100%`）+ 文字描述 "成功 X / 失败 Y / 运行中 Z / 总计 N"

**Progress status**：
- `task.status === 'FAILED'` → `status="exception"`
- 其他 → `status="active"`

**操作按钮组**（底部）：
- 「返回列表」→ `navigate('/eval/tasks')`
- 「重试失败实例」→ `evalTask.retryTask(task.id)` → 后端返回 `RetryTaskResp.retried_count`
- 「删除任务」→ `Modal.confirm` → `evalTask.deleteTask(id)` → 成功后 `navigate('/eval/tasks')`

**数据加载**：
```typescript
useEffect(() => {
  if (!taskId) return;
  getTask(taskId).then(setTask);
}, [taskId]);
```

---

### 3.3 `InstanceFilters.tsx` — 状态过滤器

**实现**：与 `TaskFilters` 结构一致，`Radio.Group buttonStyle="solid"`，选项：
- 全部（`""`）
- 待执行（PENDING）
- 运行中（RUNNING）
- 已完成（SUCCEEDED）
- 失败（FAILED）
- 超时（TIMEOUT，实例特有）

`onChange` → `evalInstance.applyFiltersAndFetch({ status })`。

---

### 3.4 `InstanceTable.tsx` — 实例表格

**列定义**（详见父规格 §7.3.3）：

| 列 | 数据源 | 渲染 | 宽度 |
|---|---|---|---|
| 状态 | `status` | Icon（成功绿勾/失败红叉/运行中 Loading） | 80 |
| 用例 | `case_id` | 显示 ID（可选：预加载用例映射为 name） | 150 |
| Agent | `task_id` 关联 | 见下方"Agent 列数据来源" | 180 |
| 尝试次数 | `attempt` | 纯数字 | 80 |
| 耗时 | `started_at` & `finished_at` | 差值格式化 "X 分 Y 秒" | 100 |
| Token | `result.total_tokens` | 纯数字，空显示 `--` | 100 |
| 操作 | - | 查看详情/重试/删除/查看Trace | 200 |

**Agent 列数据来源**（父规格 §7.3.3 关键说明）：
- 后端 InstanceView 无 `agent_config_id` 字段
- **初版方案**：直接显示"多 Agent 任务"（不做客户端推断）
- **优化路径**：进入 Drawer 后从 conversation metadata / trace 中获取
- **未来**：后端扩展 InstanceView 加 `agent_config_id`（需改数据库 schema）

**状态 Icon**：
```tsx
const statusIconMap = {
  PENDING: <ClockCircleOutlined style={{ color: token.colorTextDisabled }} />,
  RUNNING: <LoadingOutlined style={{ color: token.colorPrimary }} />,
  SUCCEEDED: <CheckCircleFilled style={{ color: token.colorSuccess }} />,
  FAILED: <CloseCircleFilled style={{ color: token.colorError }} />,
  TIMEOUT: <ExclamationCircleFilled style={{ color: token.colorWarning }} />,
};
```

**行操作**：
- 「查看详情」→ `onRowClick(id)` 触发 Drawer 打开
- 「重试」→ 仅 FAILED / TIMEOUT 显示，`evalInstance.retryInstance(id)`
- 「删除」→ `Modal.confirm` → `evalInstance.deleteInstance(id)`
- 「查看 Trace」→ 见 M5 spec

**A11y**：行点击加 `role="button"` + `aria-label`。

---

### 3.5 `InstanceDrawer.tsx` — 实例详情（4 Tabs）

**布局**（详见父规格 §7.3.4，代码在 §7.3.5）：

**顶部状态栏**：`Badge` + 状态文字 + 尝试次数。

**Tabs**：

1. **基础信息 Tab** — Descriptions 展示：实例 ID / 任务 ID / 用例 ID / conversation_id / message_id / worker_id / 5 个时间戳（入队/开始/结束/心跳/截止）
2. **执行结果 Tab**：
   - `result.passed=true` → 绿色 Alert + 绿勾 icon
   - `result.passed=false` → 红色 Alert + 红叉 icon
   - Exit Code / 结束时间（Descriptions）
   - Stdout / Stderr（Input.TextArea disabled，monospace，rows=10）
   - result 为 null → `<Empty description="暂无执行结果" />`
3. **Token & 耗时 Tab** — Descriptions 展示：prompt_tokens / completion_tokens / total_tokens（`.toLocaleString()`）/ agent_latency_ms
4. **错误日志 Tab**：
   - error_message + result.error_log（TextArea disabled，rows=15）
   - 均为空 → `<Empty description="无错误" />`

**底部操作**：
- 「关闭」
- 「查看 Trace」（disabled 条件：`!instance.trace_id`）—— M5 完成对接
- 「重试」（仅 FAILED / TIMEOUT 显示）

**数据加载**：
```typescript
useEffect(() => {
  if (!instanceId || !open) return;
  getInstance(instanceId).then(setInstance);
}, [instanceId, open]);
```

`Drawer width={720}`。

---

## 4. 智能轮询集成

**Store 已在 M1 实现**，本模块只做页面生命周期集成。轮询间隔 3s，判定依据 `instances` 中是否存在 `PENDING` / `RUNNING`。

**关键 reset 逻辑**：
```typescript
return () => {
  evalInstance.stopPolling();
  evalInstance.reset();  // 清空 taskId + instances，防止下次进入残留
};
```

---

## 5. 与父规格的对齐

- 组件粒度、Tab 结构、状态 Icon 与父规格 §7.3 一致
- Progress 进度条 status 逻辑对齐
- InstanceView 缺 agent_config_id 的处理策略明确（初版不做推断）

---

## 6. 与 M5 的分工

- **本模块 (M4)**：`InstanceDrawer` 内实现「查看 Trace」按钮的 UI 与 disabled 状态；`handleViewTrace` 函数可先留空或抛"待实现"占位
- **M5**：完成 `handleViewTrace` 的具体调用（`getInstanceTrace` + `window.open`），并改造 Trace 页面读取 URL 参数

---

## 7. 验收标准

见 `M4-task-detail-e2e.md`。核心场景：
- Drawer 4 个 Tab 内容显示正确
- 实例状态 Icon / 颜色 / 文字对应
- 智能轮询实例状态动态更新（PENDING → RUNNING → SUCCEEDED）
- 重试 / 删除的 409 错误正确 toast
- 深链 URL 直接访问 `/eval/tasks/:id` 页面正常加载

---

**规格版本**：v1.0
**依赖**：M1、M3
**预估工作量**：5 ~ 6 天

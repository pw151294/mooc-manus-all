# M3 任务管理模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M3
**依赖**：M1（types + api + store 基座）；(M2 弱依赖：需要用例数据才能演示创建流程)
**被依赖**：M4（任务详情页需要从任务列表点入 + `taskId` 参数）

---

## 1. 模块范围

实现 `/eval/tasks` 任务管理页：任务列表 + 状态过滤 + 5s 智能轮询、双 Transfer（用例 × Agent）
创建 Modal + M×N 预览、删除任务。**不含**任务详情页（属 M4）。

对应父规格 §7.2、§10.3 Phase 3。

### 1.1 交付物

- 页面：`src/pages/Eval/Tasks/index.tsx`
  - 顶部：`TaskFilters`（状态过滤）+ "创建任务"按钮
  - 中部：`TaskTable`
  - Modal 挂载：`TaskCreateModal`
  - `useEffect` 生命周期：mount → `fetchTasks()` + `startPolling()`；unmount → `stopPolling()`
- 表格：`src/pages/Eval/Tasks/TaskTable.tsx`
  - 列：name、status（Badge/Tag 颜色映射）、progress（`succeeded_count / total_count`）、
    created_at、started_at、finished_at、操作
  - 行点击 → `navigate('/eval/tasks/:id')`（跳转到 M4 详情页）
  - 操作列：重试（仅 FAILED）、删除（Popconfirm）
- 过滤器：`src/pages/Eval/Tasks/TaskFilters.tsx`
  - 状态多选：`PENDING / RUNNING / SUCCEEDED / FAILED / 全部`
- 创建 Modal：`src/pages/Eval/Tasks/TaskCreateModal.tsx`
  - name 输入（可选，后端可自动生成）
  - 双 Transfer：左侧用例、右侧 Agent 配置
  - 底部 M×N 预览："将创建 M × N = X 个实例"
  - 提交 → `store.createTask()` → 关闭 Modal → 刷新列表

### 1.2 非目标

- 不做任务详情、实例列表、实例详情（属 M4）
- 不做 Trace 跳转（属 M5）
- 不做任务编辑（后端无此 API，父规格 §1.3 非目标）
- 不做批量删除（父规格 §12.3 未来扩展）

---

## 2. 组件设计

### 2.1 `Tasks/index.tsx` 页面容器

**详见父规格 §7.2.1**

```tsx
useEffect(() => {
  fetchTasks();
  startPolling();
  return () => stopPolling();
}, []);
```

### 2.2 `TaskTable.tsx`

**详见父规格 §7.2.2**

- 状态列颜色映射（Badge）：
  - PENDING → default（灰）
  - RUNNING → processing（蓝，带脉冲）
  - SUCCEEDED → success（绿）
  - FAILED → error（红）
- progress 列：`{succeeded_count} / {total_count}` + antd Progress 迷你条
- `onRow`：`onClick: () => navigate(`/eval/tasks/${record.id}`)`

### 2.3 `TaskCreateModal.tsx`

**详见父规格 §7.2.3**

**结构**：
```tsx
<Modal width={960} title="创建评测任务">
  <Input placeholder="任务名（可选）" />
  <Row>
    <Col span={12}>
      <Transfer
        dataSource={cases}
        titles={['候选用例', '已选用例']}
        showSearch
        ...
      />
    </Col>
    <Col span={12}>
      <Transfer
        dataSource={agents}
        titles={['候选 Agent', '已选 Agent']}
        showSearch
        ...
      />
    </Col>
  </Row>
  <Alert message={`将创建 ${caseIds.length} × ${agentKeys.length} = ${total} 个实例`} />
</Modal>
```

**关键点**：
- 用例数据源：`useEvalCaseStore.getState().cases`（或独立 `listCases({ page_size: 200 })` 拉取）
- Agent 数据源：`api.listAgentConfigs()`（首次打开 Modal 时拉）
- 至少各选 1 个，否则提交按钮 disabled

### 2.4 `TaskFilters.tsx`

**详见父规格 §7.2.4**

```tsx
<Select mode="multiple" onChange={onStatusChange}>
  <Option value="PENDING">待执行</Option>
  <Option value="RUNNING">运行中</Option>
  <Option value="SUCCEEDED">已完成</Option>
  <Option value="FAILED">失败</Option>
</Select>
```

---

## 3. 数据流与轮询

### 3.1 主流程

```
用户操作 → Tasks/index.tsx → useEvalTaskStore.action(...)
                                ↓
                          api.listTasks / createTask / deleteTask / retryTask
                                ↓
                          后端 /api/eval/tasks/*
                                ↓
                          store 更新 → 表格 re-render
```

### 3.2 轮询生命周期

- **启动**：`Tasks/index.tsx` mount → `startPolling()`
- **心跳**：每 5s `fetchTasks(currentFilters)`
- **停止条件**：
  - 页面 unmount（`useEffect` cleanup）
  - `tasks.every(t => t.status === 'SUCCEEDED' || t.status === 'FAILED')`
- **重启**：新任务创建成功后自动 `startPolling()`（若未运行）

**详见父规格 §4.1.2、§9.2.2**

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 轮询间隔 | 5s | §4.1.2 |
| 状态展示 | antd Badge + 颜色映射 | §7.2.2 |
| 用例/Agent 选择 | 双 Transfer + 搜索 | §7.2.3 |
| M×N 预览 | 底部 Alert 实时计算 | §7.2.3 |
| 删除确认 | Popconfirm 内联 | §7.2.2 |
| 行点击跳转 | `navigate('/eval/tasks/:id')` | §7.2.2、§3.1 |
| 任务编辑 | 不支持（后端无 API） | §1.3 |

---

## 5. 验证边界

**功能验证**：见 `docs/harness/e2e/eval-modules/M3-task-management-e2e.md`
**技术验证**：轮询启停时机、竞态、状态颜色映射

---

## 6. 交付验收

- [ ] 4 个交付文件已创建，TS 编译零错误
- [ ] 列表 + 过滤 + 分页 + 创建 + 删除全流程可用
- [ ] 智能轮询启动/停止时机正确（有活动 → 5s 心跳；全终态 → 停止）
- [ ] 行点击可跳转 `/eval/tasks/:id`（跳转后由 M4 承接；M3 独立验收时页面显示 M1 占位即可）
- [ ] E2E 文档所有检查项通过
- [ ] 依赖 M1；弱依赖 M2（用例数据）

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.2 / §10.3

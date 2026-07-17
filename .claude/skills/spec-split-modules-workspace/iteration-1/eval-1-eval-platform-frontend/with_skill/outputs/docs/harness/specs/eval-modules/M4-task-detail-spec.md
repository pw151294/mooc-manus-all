# M4 任务详情模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M4
**依赖**：M1（types + api + store 基座）、M3（任务列表 → 详情页跳转 + taskId 参数）
**被依赖**：M5（Trace 深链需要在实例 Drawer 内嵌"查看 Trace"按钮）

---

## 1. 模块范围

实现 `/eval/tasks/:id` 任务详情页：任务汇总卡片、实例列表（M×N 行）、实例状态过滤、
实例详情 Drawer（4 个 Tab）、实例重试/删除，以及 3s 智能轮询。**不含** Trace 跳转
逻辑（属 M5，本模块预留按钮位）。

对应父规格 §7.3、§10.4 Phase 4。

### 1.1 交付物

- 页面：`src/pages/Eval/TaskDetail/index.tsx`
  - `useParams()` 拿 taskId
  - 组装：TaskSummaryCard + InstanceFilters + InstanceTable + InstanceDrawer
  - `useEffect`：mount → `fetchTask(id)` + `fetchInstances(id)` + `startPolling(id)`；unmount → `stopPolling()`
- 汇总卡片：`src/pages/Eval/TaskDetail/TaskSummaryCard.tsx`
  - antd Card + Descriptions/Statistic
  - 显示 name / status / progress / total_count / succeeded / failed / created_at / started_at / finished_at
- 实例过滤器：`src/pages/Eval/TaskDetail/InstanceFilters.tsx`
  - 状态多选（PENDING / RUNNING / SUCCEEDED / FAILED）
- 实例表格：`src/pages/Eval/TaskDetail/InstanceTable.tsx`
  - 列：case_name / agent_name / status / total_tokens / agent_latency_ms / attempt / 操作
  - 行点击 → 打开 InstanceDrawer
  - 操作：重试（仅 FAILED 可用）、删除（Popconfirm；RUNNING 时后端返回 409）
- 详情 Drawer：`src/pages/Eval/TaskDetail/InstanceDrawer.tsx`
  - 4 个 Tab：
    - 基础信息：conversation_id / message_id / worker_id / 时间戳
    - 执行结果：passed 状态 Alert + verify_stdout / verify_stderr（`<pre>` 或 TextArea 只读）
    - Token 与耗时：prompt_tokens / completion_tokens / total_tokens / agent_latency_ms
    - 错误日志：error_message + error_log（SUCCEEDED 时显示"无错误"）
  - Drawer 底部预留「查看 Trace」按钮位（M5 接线；M4 独立验收时可显示为 disabled 或占位）

### 1.2 非目标

- 不做 Trace 跳转逻辑（属 M5）
- 不做实例编辑（后端无此 API）
- 不做实时日志流（父规格 §12.2 未来扩展）
- 不做实例批量重试/删除（父规格 §12.3 未来扩展）

---

## 2. 组件设计

### 2.1 `TaskDetail/index.tsx` 页面容器

**详见父规格 §7.3.1**

```tsx
const { id } = useParams<{ id: string }>();
useEffect(() => {
  if (!id) return;
  fetchTask(id);
  fetchInstances(id);
  startInstancePolling(id);
  return () => stopInstancePolling();
}, [id]);
```

### 2.2 `TaskSummaryCard.tsx`

**详见父规格 §7.3.2**

- Statistic 分块：total_count / succeeded_count / failed_count
- Progress 条：succeeded / total
- 时间字段：`created_at / started_at / finished_at`（用 `formatTime` 工具）

### 2.3 `InstanceTable.tsx`

**详见父规格 §7.3.3**

- Agent 列数据源：`instance.agent_config_name`（对齐父规格已修正的 spec 版本）
- 状态列同任务表格颜色映射
- attempt 列：`{attempt}`；attempt > 1 显示为可视化标记
- 操作：
  - 重试：`onClick={() => store.retryInstance(id)}`；仅 FAILED 显示
  - 删除：`Popconfirm → store.deleteInstance(id)`

### 2.4 `InstanceDrawer.tsx`

**详见父规格 §7.3.4**

**结构**：
```tsx
<Drawer width={860} title={`实例：${instance.case_name} × ${instance.agent_config_name}`}>
  <Tabs>
    <TabPane tab="基础信息" key="basic">...</TabPane>
    <TabPane tab="执行结果" key="result">
      {passed
        ? <Alert type="success" showIcon message="验证通过" />
        : <Alert type="error" showIcon message="验证失败" />}
      <Section title="verify_stdout"><pre>{result?.verify_stdout}</pre></Section>
      <Section title="verify_stderr"><pre>{result?.verify_stderr}</pre></Section>
    </TabPane>
    <TabPane tab="Token & 耗时" key="tokens">...</TabPane>
    <TabPane tab="错误日志" key="error">
      {status === 'SUCCEEDED' ? '无错误' : (
        <>
          <div>{error_message}</div>
          <pre>{error_log}</pre>
        </>
      )}
    </TabPane>
  </Tabs>

  <Divider />
  {/* M5 接线点：查看 Trace 按钮 */}
  <Button data-testid="view-trace-btn" disabled={/* M4 独立验收时 disabled */}>
    查看 Trace
  </Button>
</Drawer>
```

**大文本处理**：`<pre>` 元素配合 `max-height: 400px; overflow: auto` 防卡顿（父规格 §11.2）。

---

## 3. 数据流与轮询

### 3.1 主流程

```
用户 → TaskDetail/index → useEvalInstanceStore.action(taskId)
                             ↓
                       api.listInstances / getInstance / retryInstance / deleteInstance
                             ↓
                       Store 更新 → 表格 + Drawer re-render
```

### 3.2 轮询生命周期

- **启动**：mount 时 `startInstancePolling(taskId)`
- **心跳**：每 3s `fetchInstances(taskId)`
- **停止条件**：
  - 页面 unmount
  - `instances.every(i => i.status === 'SUCCEEDED' || i.status === 'FAILED')`
- **重启**：`retryInstance` 后自动重启（新增 PENDING/RUNNING）

**详见父规格 §4.1.3、§9.2.3**

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 轮询间隔 | 3s | §4.1.3 |
| Drawer 宽度 | 860px | §7.3.4 |
| Tab 数量 | 4（基础/结果/Token/错误） | §7.3.4、§9.2.3 |
| 大文本渲染 | `<pre>` + max-height + overflow | §11.2 |
| 重试可用条件 | 仅 FAILED 显示（SUCCEEDED 后端 409） | §9.2.3 |
| 删除 RUNNING 实例 | 后端返回 409，前端 error toast | §9.2.3 |
| Agent 列数据源 | `instance.agent_config_name` | 父规格已修正版 §7.3.3 |
| Trace 跳转 | 预留按钮位，M5 实现 | §7.3.4、§8.3 |

---

## 5. 验证边界

**功能验证**：见 `docs/harness/e2e/eval-modules/M4-task-detail-e2e.md`
**技术验证**：轮询、Drawer 4 Tab 数据完整性、深链（直接访问 URL）

---

## 6. 交付验收

- [ ] 5 个交付文件已创建，TS 编译零错误
- [ ] 从任务列表点行可进入详情页，汇总卡片 + 实例表格数据齐全
- [ ] Drawer 4 个 Tab 均显示对应内容；大文本可滚动
- [ ] 3s 智能轮询启停正确
- [ ] Trace 按钮已预留但可 disabled 或占位（M5 后启用）
- [ ] 直接访问 `/eval/tasks/:id` URL 可加载页面（深链支持）
- [ ] E2E 文档所有检查项通过
- [ ] 依赖 M1、M3；不阻塞 M5

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.3 / §10.4

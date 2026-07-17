# M4 任务详情与实例模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`  
**模块编号**：M4  
**依赖**：M1（types + api + `store/evalInstance.ts` + 路由基座）、M3（任务列表与详情入口）  
**被依赖**：M5

---

## 1. 模块范围

本模块交付任务详情页、任务汇总、实例列表、实例状态过滤、实例详情 Drawer、实例重试/删除和实例列表智能轮询，使用户可以查看单个评测任务下 M×N 实例的执行状态、结果、Token 用量、耗时和错误信息。

### 1.1 交付物

- 页面容器：`mooc-manus-web/src/pages/Eval/TaskDetail/index.tsx`
- 汇总组件：`mooc-manus-web/src/pages/Eval/TaskDetail/TaskSummaryCard.tsx`
- 实例表格：`mooc-manus-web/src/pages/Eval/TaskDetail/InstanceTable.tsx`
- 实例详情：`mooc-manus-web/src/pages/Eval/TaskDetail/InstanceDrawer.tsx`
- 实例过滤：`mooc-manus-web/src/pages/Eval/TaskDetail/InstanceFilters.tsx`
- 复用 M1：`store/evalInstance.ts`、`api/modules/eval.ts`、`types/eval.ts`
- 复用 M3：`/eval/tasks/:id` 路由入口、任务列表跳转

### 1.2 非目标

- 不实现任务列表页（属 M3）。
- 不实现 Trace 页面 query 参数自动开 Modal（属 M5）。
- `InstanceView` 无 `agent_config_id` 时，不做复杂推断；初版可按父规格显示「多 Agent 任务」或保守展示 ID 信息。
- 不扩展后端 schema 或 DTO。
- 不实现高级结果对比图表或趋势分析。

---

## 2. 页面与组件设计

### 2.1 `TaskDetail/index.tsx`

负责从 URL 读取 `taskId`，组装任务汇总卡、实例过滤器、实例表格和实例详情 Drawer。

生命周期：

- `useParams()` 读取 `/eval/tasks/:id`。
- 有 `taskId` 时调用 `evalInstance.fetchInstances(taskId)`。
- 同时调用 `evalInstance.startPolling(taskId)`。
- 页面卸载或 `taskId` 改变时调用 `stopPolling()` 与 `reset()`。

**详见父规格 §7.3.1、§4.1.3。**

### 2.2 `TaskSummaryCard.tsx`

展示任务元信息、状态、进度和操作按钮。

内容：

- 任务名。
- 状态 Tag。
- 创建时间、开始时间、结束时间。
- 成功 / 失败 / 运行中 / 总计进度。
- 返回列表、重试失败实例、删除任务按钮。

数据来源：

- 通过 `getTask(taskId)` 或 M3/M1 store 能力拉取当前任务详情。

**详见父规格 §7.3.2。**

### 2.3 `InstanceTable.tsx`

展示实例状态、用例、Agent 概览、尝试次数、耗时、Token 和操作列。

列要求：

- 状态：Icon + 文本，不只依赖颜色。
- 用例：显示 `case_id`；后续可增强为名称。
- Agent：按父规格初版可显示「多 Agent 任务」或保守信息。
- 尝试次数：显示 `attempt`。
- 耗时：根据 `started_at` 与 `finished_at` 计算。
- Token：显示 `result.total_tokens`，为空显示 `--`。
- 操作：查看详情 / 重试 / 删除 / 查看 Trace。

**详见父规格 §7.3.3。**

### 2.4 `InstanceDrawer.tsx`

右侧 Drawer 展示单实例完整信息。

Tab：

- 基础信息：instance_id、task_id、case_id、conversation_id、message_id、worker_id、时间戳。
- 执行结果：passed Alert、exit code、stdout、stderr。
- Token & 耗时：prompt/completion/total tokens、agent_latency_ms。
- 错误日志：error_message、error_log。

操作：

- 关闭。
- 查看 Trace：按钮可先根据 `instance.trace_id` 控制禁用；完整跨页行为由 M5 验证。
- 重试：仅对 `FAILED`、`TIMEOUT` 实例展示或启用。

**详见父规格 §7.3.4。**

### 2.5 `InstanceFilters.tsx`

提供实例状态过滤。

选项：

- 全部：`''`
- 待执行：`PENDING`
- 运行中：`RUNNING`
- 已完成：`SUCCEEDED`
- 失败：`FAILED`
- 超时：`TIMEOUT`

切换后调用实例 store 的过滤与刷新逻辑。

**详见父规格 §4.1.3、§9.2.3。**

---

## 3. 数据流 / 关键实现细节

```text
任务列表点击 → /eval/tasks/:id → TaskDetail/index.tsx
详情页加载 → getTask(taskId) + listInstances(taskId)
实例轮询 → evalInstance.startPolling(taskId) → 每 3s 条件刷新
实例行点击 → InstanceDrawer → getInstance(id) 或列表数据
实例操作 → retryInstance/deleteInstance → instances 刷新
查看 Trace → M5 深链联动
```

关键边界：

- `taskId` 缺失时不发请求。
- 离开详情页必须停止实例轮询并清空实例状态。
- `result` 为空时，执行结果与 metrics Tab 显示 Empty。
- FAILED/TIMEOUT 才允许重试，其他状态若后端返回 409，由 request 拦截器提示。
- RUNNING 实例删除返回 409 时不吞错。

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 任务详情 | 独立路由 `/eval/tasks/:id` | §3.1、§13.2 |
| 实例展示 | 表格 + Drawer | §7.3、§13.2 |
| 实例实时性 | 3 秒智能轮询 | §4.1.3、§9.2.3 |
| 结果展示 | Drawer 内 4 个 Tabs | §7.3.4 |
| Agent 列 | 初版保守展示，不扩展后端 | §7.3.3 |
| 长文本 | TextArea 展示 stdout/stderr/error_log | §7.3.4、§9.3.2 |

---

## 5. 验证边界

**功能验证**：见 `../../e2e/eval-modules/M4-task-detail-instances-e2e.md`。  
**依赖前置**：M1、M3 已交付；后端 eval task/instance API 可用；存在至少一个含实例的任务。

---

## 6. 交付验收

- [ ] 5 个 `TaskDetail/` 组件文件已创建。
- [ ] `/eval/tasks/:id` 可刷新直达并加载任务详情与实例列表。
- [ ] 任务汇总、实例过滤、实例表格、实例 Drawer 正常展示。
- [ ] 实例轮询在活动状态继续，终态停止，离开页面停止。
- [ ] 实例重试、删除、空结果、错误日志等边界可观察。
- [ ] M4 e2e 文档所有非 M5 依赖检查项通过。
- [ ] M5 可基于 `InstanceDrawer` 的 Trace 入口继续交付深链联动。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4.1.3、§4.2.2、§7.3、§9.2.3、§10.4

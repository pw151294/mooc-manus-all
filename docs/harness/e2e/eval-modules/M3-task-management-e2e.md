# M3 任务管理模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M3-task-management-spec.md`  
**验证类型**：功能验证  
**前置**：M1 已交付；后端 eval task 与 agent config API 运行中；存在至少 2 个用例和 2 个 Agent 配置。若 M2 未交付，可通过 API 预置用例。

---

## 1. 任务列表

- [ ] **打开任务列表页**
  - 访问 `/eval/tasks`。
  - Expected: 页面显示任务列表、状态过滤器和「创建任务」按钮。

- [ ] **任务表格列展示**
  - 前置：存在至少一个任务。
  - 查看表格列。
  - Expected: 显示名称、状态、进度、创建时间、开始时间、结束时间、操作列。

- [ ] **状态 Tag 展示**
  - 前置：存在 PENDING / RUNNING / SUCCEEDED / FAILED 中至少两种状态任务。
  - Expected: 状态以 Tag 展示，颜色或样式可区分，且有文本状态。

- [ ] **行点击进入详情入口**
  - 点击任务表格某行。
  - Expected: URL 跳转到 `/eval/tasks/:id`。若 M4 尚未交付，可显示占位页；若 M4 已交付，应显示任务详情。

---

## 2. 创建任务

- [ ] **打开创建任务 Modal 并加载数据**
  - 点击「创建任务」。
  - Expected: Modal 打开，包含任务名称输入、用例 Transfer、Agent Transfer、实例数量预览。
  - Expected: Network 面板出现 `GET /api/eval/cases` 与 `GET /api/eval/agent-configs`。

- [ ] **M×N 实例数量预览**
  - 选择 2 个用例和 3 个 Agent。
  - Expected: 底部显示「将创建 2 × 3 = 6 个实例」或等价文案。

- [ ] **创建按钮禁用条件**
  - 不填任务名或不选择用例或不选择 Agent。
  - Expected: 创建按钮 disabled 或提交时显示明确校验错误，Network 面板无创建请求。

- [ ] **成功创建任务**
  - 填写任务名 `任务-M3-创建验证`。
  - 选择至少 1 个用例和 1 个 Agent。
  - 点击创建。
  - Expected: Modal 关闭，任务列表刷新，新任务出现在列表中，状态为 PENDING 或 RUNNING。

---

## 3. 状态过滤、分页与操作

- [ ] **按状态过滤任务**
  - 点击「运行中」。
  - Expected: 列表仅显示 `RUNNING` 任务。
  - 点击「已完成」。
  - Expected: 列表仅显示 `SUCCEEDED` 任务。
  - 点击「全部」。
  - Expected: 显示所有状态任务。

- [ ] **分页切换**
  - 前置：存在超过当前 pageSize 的任务数量。
  - 翻页到下一页。
  - Expected: 表格展示下一页任务，页码状态正确。

- [ ] **删除任务**
  - 对一个可删除任务点击删除。
  - Expected: 出现确认对话框。
  - 确认删除。
  - Expected: 任务从列表消失，列表刷新。

- [ ] **重试任务**
  - 前置：存在 FAILED 任务或含失败实例的任务。
  - 点击「重试」。
  - Expected: 后端返回 `retried_count`，前端显示成功反馈或列表刷新；任务状态回到 PENDING/RUNNING 或进度发生变化。

---

## 4. 任务列表轮询

- [ ] **存在活动任务时轮询刷新**
  - 前置：存在 `PENDING` 或 `RUNNING` 任务。
  - 打开 `/eval/tasks` 并保持页面停留。
  - Expected: Network 面板每 5 秒出现一次 `GET /api/eval/tasks` 请求。
  - Expected: 任务状态、成功/失败/运行中计数可随后端变化更新。

- [ ] **全部终态后轮询停止**
  - 等待所有任务变为 `SUCCEEDED` 或 `FAILED`。
  - 观察 Network 面板 30 秒。
  - Expected: 不再出现新的 `GET /api/eval/tasks` 轮询请求。

- [ ] **离开页面轮询停止**
  - 在有活动任务时打开 `/eval/tasks`，确认轮询中。
  - 点击菜单跳转到 `/eval/cases` 或其他页面。
  - Expected: Network 面板 30 秒内无新的 `GET /api/eval/tasks` 轮询请求。

- [ ] **创建任务后轮询启动或保持**
  - 创建一个新任务。
  - Expected: 新任务状态为 PENDING/RUNNING 时，列表轮询启动或继续运行。

---

## 5. 边界与异常

- [ ] **无用例时创建任务**
  - 前置：后端用例列表为空。
  - 打开创建任务 Modal。
  - Expected: 用例 Transfer 为空状态，创建按钮不可用或提交时提示必须选择用例。

- [ ] **无 Agent 配置时创建任务**
  - 前置：后端 Agent Config 返回空数组。
  - 打开创建任务 Modal。
  - Expected: Agent Transfer 为空状态，创建按钮不可用或提交时提示必须选择 Agent。

- [ ] **创建任务 API 失败**
  - 通过无效输入或停止后端触发失败。
  - Expected: 显示错误 toast，Modal 不应误关闭或列表不应出现假数据。

- [ ] **删除运行中任务冲突**
  - 对 RUNNING 任务执行删除。
  - Expected: 若后端返回 409，前端显示错误 toast，任务仍在列表中。

---

## 6. 空状态 / 加载态 / 可访问性

- [ ] **空任务列表**
  - 当前过滤条件无匹配任务。
  - Expected: 表格显示 Empty 或等价空状态。

- [ ] **列表加载态**
  - 慢网络下刷新任务列表。
  - Expected: 表格 loading 可见，不出现白屏。

- [ ] **任务行键盘可访问**
  - 用 Tab 聚焦任务行并按 Enter。
  - Expected: 触发与点击相同的详情跳转。

- [ ] **Transfer 搜索可用**
  - 在用例或 Agent Transfer 搜索框输入关键词。
  - Expected: 候选项按关键词过滤。

---

## 7. 跨模块联动

- [ ] **引用 M2 创建的用例创建任务**
  - 前置：M2 已交付并创建至少 2 个用例。
  - 在 M3 创建任务 Modal 中选择这些用例。
  - Expected: 任务创建成功，`case_ids` 与所选用例一致。

- [ ] **删除被活动任务引用的用例返回 409**
  - 前置：M2 已交付；创建任务 T1 引用用例 C1，任务状态 RUNNING。
  - 回到 `/eval/cases` 删除 C1。
  - Expected: 后端返回 409，前端显示错误 toast，用例未删除。

---

## 8. 交付验收

- [ ] 上述所有检查项通过。
- [ ] `TaskTable.tsx`、`TaskCreateModal.tsx`、`TaskFilters.tsx`、`index.tsx` 均被至少一条检查项覆盖。
- [ ] 浏览器 devtools 无 error/warning。
- [ ] Network 面板无失控轮询或重复提交。
- [ ] `git status` 干净（本模块代码已 commit）。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4.1.2、§4.2.1、§7.2、§9.2.2、§10.3

# M4 任务详情与实例模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M4-task-detail-instances-spec.md`  
**验证类型**：功能验证  
**前置**：M1、M3 已交付；后端 eval task/instance API 运行中；存在至少一个已创建任务，且该任务下有实例。

---

## 1. 进入任务详情页

- [ ] **从任务列表进入详情**
  - 打开 `/eval/tasks`。
  - 点击某个任务行。
  - Expected: URL 跳转到 `/eval/tasks/:id`，页面显示任务详情内容。

- [ ] **刷新详情页可恢复状态**
  - 在 `/eval/tasks/:id` 页面按刷新。
  - Expected: 页面重新加载后仍显示该任务汇总与实例列表，不依赖前一页内存状态。

- [ ] **无效 taskId 处理**
  - 打开一个不存在的 `/eval/tasks/:id`。
  - Expected: 显示错误 toast、空状态或合理错误页面，不白屏。

---

## 2. 任务汇总卡

- [ ] **任务元信息展示**
  - 打开详情页。
  - Expected: 顶部卡片显示任务名、状态、创建时间、开始时间、结束时间。

- [ ] **进度展示**
  - 查看进度条和计数文案。
  - Expected: 显示成功 X / 失败 Y / 运行中 Z / 总计 N；百分比与 succeeded_count / total_count 一致。

- [ ] **返回任务列表**
  - 点击「返回列表」。
  - Expected: URL 回到 `/eval/tasks`。

- [ ] **重试失败实例入口**
  - 前置：任务存在失败实例。
  - 点击「重试失败实例」。
  - Expected: 后端返回重试结果，任务汇总或实例列表刷新。

- [ ] **删除任务入口**
  - 点击「删除任务」。
  - Expected: 出现确认对话框；确认后任务删除并返回或刷新到合理页面。

---

## 3. 实例列表与过滤

- [ ] **实例表格显示 M×N 行**
  - 前置：任务由 M 个用例 × N 个 Agent 创建。
  - 打开详情页。
  - Expected: 实例表格显示 M×N 条实例或后端分页下的对应总数。

- [ ] **实例表格列展示**
  - 查看表格列。
  - Expected: 显示状态、用例、Agent 概览、尝试次数、耗时、Token、操作列。

- [ ] **状态 Icon 与文本**
  - 前置：存在 SUCCEEDED / FAILED / RUNNING / TIMEOUT 中至少两种状态。
  - Expected: 状态列使用 Icon + 文本或等价方式表达，不只依赖颜色。

- [ ] **按状态过滤实例**
  - 选择「已完成」。
  - Expected: 仅显示 `SUCCEEDED` 实例。
  - 选择「失败」。
  - Expected: 仅显示 `FAILED` 实例。
  - 选择「全部」。
  - Expected: 显示所有实例状态。

- [ ] **实例分页**
  - 前置：实例数量超过当前 pageSize。
  - 翻到下一页。
  - Expected: 表格显示下一页实例，总数保持正确。

---

## 4. 实例详情 Drawer

- [ ] **打开实例详情**
  - 点击实例表格某行或「查看详情」。
  - Expected: 右侧 Drawer 打开，标题为实例详情或等价文案。

- [ ] **基础信息 Tab**
  - 切到「基础信息」。
  - Expected: 显示实例 ID、任务 ID、用例 ID、conversation_id、message_id、worker_id、入队/开始/结束/心跳/截止时间。

- [ ] **执行结果 Tab：成功实例**
  - 前置：存在 `result.passed = true` 的实例。
  - 打开该实例 Drawer，切到「执行结果」。
  - Expected: 显示成功 Alert、exit code、stdout、stderr；长文本可滚动。

- [ ] **执行结果 Tab：失败实例**
  - 前置：存在 `result.passed = false` 的实例。
  - 打开该实例 Drawer，切到「执行结果」。
  - Expected: 显示失败 Alert、exit code、stdout、stderr。

- [ ] **执行结果为空**
  - 前置：存在 PENDING 或 RUNNING 实例，`result` 为空。
  - 打开 Drawer，切到「执行结果」。
  - Expected: 显示「暂无执行结果」或 Empty，不报错。

- [ ] **Token & 耗时 Tab**
  - 前置：存在带 result 的实例。
  - 切到「Token & 耗时」。
  - Expected: 显示 prompt_tokens、completion_tokens、total_tokens、agent_latency_ms。

- [ ] **错误日志 Tab**
  - 打开 SUCCEEDED 实例。
  - Expected: 显示「无错误」或 Empty。
  - 打开 FAILED 实例。
  - Expected: 显示 error_message 与 error_log。

---

## 5. 实例操作

- [ ] **FAILED 实例重试**
  - 打开 FAILED 或 TIMEOUT 实例详情。
  - 点击「重试」。
  - Expected: 实例状态变为 PENDING 或 RUNNING，attempt 递增，列表刷新。

- [ ] **SUCCEEDED 实例重试冲突**
  - 对 SUCCEEDED 实例尝试重试（若 UI 隐藏按钮，可通过操作列或 API 触发）。
  - Expected: UI 不允许操作，或后端返回 409 并显示错误 toast。

- [ ] **删除终态实例**
  - 对 SUCCEEDED 或 FAILED 实例点击删除。
  - Expected: 出现确认对话框；确认后实例从列表消失。

- [ ] **删除 RUNNING 实例冲突**
  - 对 RUNNING 实例点击删除。
  - Expected: 后端返回 409，前端显示错误 toast，实例仍在列表中。

- [ ] **TODO：查看 Trace 完整深链**
  - 需 M5 交付后测；M4 独立验收时只检查按钮状态与入口存在。
  - Expected: M5 中验证新 tab 打开 `/traces?traceId=xxx` 并自动弹出 Trace Modal。

---

## 6. 实例轮询

- [ ] **存在活动实例时轮询刷新**
  - 前置：详情页存在 PENDING 或 RUNNING 实例。
  - 打开 Network 面板。
  - Expected: 每 3 秒出现一次 `GET /api/eval/tasks/:id/instances` 请求。

- [ ] **全部实例终态后轮询停止**
  - 等待实例全部为 SUCCEEDED / FAILED / TIMEOUT。
  - 观察 Network 面板 30 秒。
  - Expected: 不再出现新的实例轮询请求。

- [ ] **离开详情页轮询停止并清空状态**
  - 在轮询中返回任务列表或跳转其他页面。
  - Expected: 30 秒内无旧 taskId 的 instances 请求；再次进入其他任务详情时不闪现旧实例。

---

## 7. 边界、空状态与可访问性

- [ ] **空实例列表**
  - 前置：后端返回空实例列表。
  - Expected: 表格显示 Empty 或等价空状态。

- [ ] **列表加载态**
  - 慢网络下打开详情页。
  - Expected: 汇总卡或实例表格显示 loading，不白屏。

- [ ] **Drawer 键盘操作**
  - 打开 InstanceDrawer 后使用 Tab / Esc。
  - Expected: 焦点行为符合 antd Drawer 默认交互；Esc 可关闭；关闭后返回合理焦点位置。

- [ ] **长文本渲染**
  - 前置：stdout/stderr/error_log 超过 100 行。
  - Expected: Drawer 不明显卡死，文本区域可滚动和复制。

---

## 8. 交付验收

- [ ] 上述所有非 TODO 检查项通过。
- [ ] `TaskSummaryCard.tsx`、`InstanceTable.tsx`、`InstanceDrawer.tsx`、`InstanceFilters.tsx`、`index.tsx` 均被至少一条检查项覆盖。
- [ ] 浏览器 devtools 无 error/warning。
- [ ] Network 面板无残留旧 taskId 轮询。
- [ ] `git status` 干净（本模块代码已 commit）。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4.1.3、§4.2.2、§7.3、§9.2.3、§10.4

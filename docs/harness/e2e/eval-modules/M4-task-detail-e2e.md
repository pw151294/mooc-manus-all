# M4 任务详情模块验证文档

**对应规格**：`docs/superpowers/specs/eval-modules/M4-task-detail-spec.md`
**前置**：M1、M3 已交付；至少存在 1 个已执行完成的任务（含 SUCCEEDED + FAILED 实例）

---

## 1. 进入详情页

- [ ] **从任务列表跳转**
  - 在 `/eval/tasks` 点某行
  - Expected: URL 变为 `/eval/tasks/:id`
  - Expected: 页面加载：TaskSummaryCard + InstanceFilters + InstanceTable

- [ ] **直接 URL 访问**
  - 复制 URL 到新 tab
  - Expected: 详情页正常渲染（无需先经过列表页）

- [ ] **无效 taskId**
  - 访问 `/eval/tasks/nonexistent-id`
  - Expected: TaskSummaryCard 显示 loading 或降级 UI；toast「资源不存在」
  - Expected: 页面不崩

---

## 2. TaskSummaryCard

- [ ] **元信息展示**
  - Expected: 显示任务名（标题级）
  - Expected: 状态 Tag 颜色正确（PENDING=蓝，RUNNING=processing，SUCCEEDED=绿，FAILED=红）
  - Expected: 创建/开始/结束时间格式化正确

- [ ] **进度条与 count**
  - Expected: Progress 百分比 = succeeded_count / total_count
  - Expected: 底部四个 count 数字正确（成功/失败/运行中/总计）

- [ ] **卡片自轮询（任务未终态时）**
  - 前置：任务状态 RUNNING
  - Network 面板观察 `GET /api/eval/tasks/:id`
  - Expected: 每 5s 一次
  - 任务变 SUCCEEDED 后
  - Expected: 30s 内无新请求

- [ ] **返回列表按钮**
  - 点「返回列表」
  - Expected: URL 变 `/eval/tasks`

- [ ] **重试失败实例按钮**
  - 前置：任务有 FAILED 实例
  - 点「重试失败实例」
  - Expected: toast「已重试 N 个失败实例」
  - Expected: 卡片 count 更新，Progress 回退

- [ ] **删除任务按钮**
  - 点「删除任务」→ Popconfirm → 确定
  - Expected: 跳回 `/eval/tasks` 列表页
  - Expected: 该任务从列表消失

---

## 3. InstanceTable

- [ ] **列表加载**
  - Expected: 显示 M×N 行（例如 2×3 任务显示 6 行）
  - Expected: 分页 pageSize 默认 50

- [ ] **状态 Icon**
  - Expected: 各状态显示对应 Icon（绿勾/红叉/loading/…），带 title 提示

- [ ] **用例列**
  - Expected: 显示 case_id（或映射后的用例名）

- [ ] **Agent 列（简化）**
  - 若任务只用 1 个 agent → 显示 `${provider} - ${model_name}`
  - 若多 agent → 显示「多 Agent 任务」

- [ ] **耗时列**
  - SUCCEEDED 实例：格式 `X分Y秒` 或 `Y秒`
  - RUNNING 实例：动态计算到当前时间
  - PENDING 实例：显示 `--`

- [ ] **Token 列**
  - 有 result 的实例显示 `total_tokens.toLocaleString()`
  - 无 result 显示 `--`

- [ ] **实例列表轮询**
  - 前置：有 RUNNING/PENDING 实例
  - Expected: 每 3s 一次 `GET /api/eval/tasks/:id/instances`
  - Expected: 实例状态/token/耗时动态变化
  - 全终态后 → 轮询自停

- [ ] **实例状态过滤**
  - 点「已完成」→ 只显示 SUCCEEDED
  - 点「失败」→ 只显示 FAILED
  - 点「超时」→ 只显示 TIMEOUT

---

## 4. InstanceDrawer（4 Tabs）

- [ ] **打开 Drawer**
  - 点实例行「查看详情」或行本身
  - Expected: 右侧滑出 Drawer（宽 720px）
  - Expected: 顶部 Badge 显示状态 + attempt 数字

- [ ] **Tab 1 基础信息**
  - Expected: Descriptions 显示 11 个字段（id/task_id/case_id/conv_id/msg_id/worker_id + 5 个时间）

- [ ] **Tab 2 执行结果**
  - SUCCEEDED 实例：Alert 绿色「验证通过」+ exit_code=0 + stdout/stderr TextArea 只读
  - FAILED 实例：Alert 红色「验证失败」+ exit_code≠0
  - 无 result 的实例：显示 Empty「暂无执行结果」

- [ ] **Tab 3 Token & 耗时**
  - 显示 prompt_tokens / completion_tokens / total_tokens（`.toLocaleString()` 千分位）
  - 显示 agent_latency_ms

- [ ] **Tab 4 错误日志**
  - 有 error_message/error_log → 显示
  - 无 → Empty「无错误」

- [ ] **操作按钮启用条件**
  - FAILED/TIMEOUT 实例：显示「重试」按钮
  - SUCCEEDED/RUNNING 实例：不显示「重试」
  - 无 trace_id 的实例：「查看 Trace」按钮 disabled

---

## 5. 实例操作

- [ ] **重试 FAILED 实例**
  - 点 Drawer 内「重试」按钮（或表格操作列）
  - Expected: 实例状态回到 PENDING，attempt +1
  - Expected: 后续 RUNNING → SUCCEEDED/FAILED

- [ ] **重试 SUCCEEDED 实例（409）**
  - 若通过操作列手动测试（Drawer 内不显示该按钮）
  - Expected: 后端返回 409 + 错误消息，前端 toast

- [ ] **删除 SUCCEEDED 实例**
  - 点操作列「删除」→ Popconfirm → 确定
  - Expected: 实例从表格消失

- [ ] **删除 RUNNING 实例（409）**
  - Expected: 后端 409，toast「实例正在运行，无法删除」
  - Expected: 实例仍在表格

---

## 6. 查看 Trace（M5 未交付时的基础行为）

- [ ] **有 trace_id 的实例点「查看 Trace」**
  - Expected: 新 tab 打开 `/traces?traceId=xxx`
  - Expected: Trace 页面加载（M5 未交付时可能不会自动开 Modal，仅显示列表）

- [ ] **无 trace_id 的实例**
  - 按钮 disabled，鼠标悬停有 title 提示

---

## 7. 离开页面清理

- [ ] **useEffect cleanup**
  - 在详情页轮询中，切到 `/eval/cases`
  - Network 面板：Expected: 30s 内无 `GET /api/eval/tasks/:id/instances` 请求

- [ ] **reset state**
  - A 任务详情 → 切到 B 任务详情
  - Expected: B 页面不显示 A 的旧实例列表（reset 生效）

- [ ] **浏览器返回**
  - 点浏览器返回按钮
  - Expected: 回到 `/eval/tasks` 列表页，轮询在列表页恢复

---

## 8. 刷新与深链

- [ ] **F5 刷新**
  - 在详情页按 F5
  - Expected: 页面正常重新加载，状态从 API 恢复

- [ ] **分享 URL**
  - 复制 URL 给同事，在别的浏览器打开
  - Expected: 详情页可访问（无登录状态时视后端配置而定）

---

## 9. 交付验收

- [ ] § 1-8 检查项通过
- [ ] `git status` 干净
- [ ] devtools 无 error
- [ ] M5 交付后需回归 § 6

---

**文档版本**：v1.0  |  **拆分自**：父规格 §9.2.3、§9.2.4

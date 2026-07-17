# M4 任务详情 E2E 验证

**对应规格**：`../specs/eval-modules/M4-task-detail-spec.md`
**依赖 E2E 已通过**：M1、M3

---

## 1. 前置条件

- M1、M3 已交付验证
- 存在一个任务 T1（含 2 个用例 × 3 个 Agent = 6 个实例），至少部分处于 RUNNING 状态可观察轮询
- 前端 dev server 已启动
- 浏览器 Network / Console 已打开

---

## 2. 验证清单

### 2.1 进入任务详情页

- [ ] 在 `/eval/tasks` 列表点某行 → 路由跳转 `/eval/tasks/:id`
- [ ] 页面三段式布局渲染：TaskSummaryCard 顶部、InstanceFilters 中部、InstanceTable 下部
- [ ] 顶部 Descriptions 显示任务名、创建/开始/结束时间
- [ ] 状态 Tag 颜色正确
- [ ] Progress 进度条显示 `succeeded/total * 100%`
- [ ] Progress status：FAILED 任务显示 `exception`（红），其他 `active`
- [ ] 底部三个操作按钮显示：返回列表 / 重试失败实例 / 删除任务

### 2.2 任务汇总卡片操作

- [ ] 「返回列表」→ 跳转 `/eval/tasks`
- [ ] 「重试失败实例」→ 调 retryTask → toast "已重试 N 个实例"
- [ ] 「删除任务」→ Modal.confirm → 确认后跳转 `/eval/tasks` + toast 成功

### 2.3 实例表格 UI

- [ ] 6 行数据完整显示（M×N=6）
- [ ] 列显示：状态 Icon / 用例 / Agent / 尝试次数 / 耗时 / Token / 操作
- [ ] **状态 Icon 正确**：
  - PENDING → ClockCircle（灰）
  - RUNNING → Loading（转圈）
  - SUCCEEDED → CheckCircleFilled（绿）
  - FAILED → CloseCircleFilled（红）
  - TIMEOUT → ExclamationCircleFilled（黄）
- [ ] **耗时列**：显示 "X 分 Y 秒"（started_at 和 finished_at 计算）
- [ ] **Token 列**：显示 total_tokens；result 为空时显示 `--`
- [ ] **Agent 列**（初版简化）：显示"多 Agent 任务"或用例 ID（按 M4 spec 决策）

### 2.4 智能轮询（3 秒）

- [ ] 有 RUNNING 实例时 → Network 面板每 3s 一次 `GET /api/eval/tasks/:id/instances`
- [ ] 实例状态从 PENDING → RUNNING → SUCCEEDED 过程中表格实时更新
- [ ] token 数字、耗时动态变化
- [ ] 全部终态后 → 下一次轮询后停止（30s 内无新请求）
- [ ] 离开详情页 → 轮询立即停止（Network 无请求）
- [ ] 再次进入 → 轮询重启，evalInstance.reset 后新 taskId 生效

### 2.5 实例过滤器

- [ ] Radio.Group 显示：全部 / 待执行 / 运行中 / 已完成 / 失败 / 超时（6 个按钮）
- [ ] 选「运行中」→ 只显示 RUNNING 实例
- [ ] 选「已完成」→ 只显示 SUCCEEDED 实例
- [ ] 选「失败」→ 只显示 FAILED 实例
- [ ] 选「超时」→ 只显示 TIMEOUT 实例
- [ ] 切换过滤时 page 应重置为 1

### 2.6 实例详情 Drawer

- [ ] 点表格某行 → Drawer 从右侧滑出（width=720）
- [ ] 顶部 Badge 显示状态色 + 状态文字、Text 显示 "尝试次数: N"

**Tab 1: 基础信息**
- [ ] Descriptions 显示：实例 ID / 任务 ID / 用例 ID / conversation_id / message_id / worker_id
- [ ] 5 个时间戳显示：入队 / 开始 / 结束 / 心跳 / 截止（空值显示 `--`）

**Tab 2: 执行结果**
- [ ] SUCCEEDED 实例（passed=true）：
  - 绿色 Alert + 绿勾 icon + "验证通过"
  - Exit Code / 结束时间显示
  - Stdout / Stderr 长文本可滚动（rows=10，monospace）
- [ ] FAILED 实例（passed=false）：
  - 红色 Alert + 红叉 icon + "验证失败"
- [ ] result 为 null（PENDING 或 RUNNING）：
  - 显示 antd Empty "暂无执行结果"

**Tab 3: Token & 耗时**
- [ ] SUCCEEDED 实例：显示 prompt_tokens / completion_tokens / total_tokens / agent_latency_ms
- [ ] Token 数字使用 toLocaleString 千分位
- [ ] result 为空：Empty "暂无数据"

**Tab 4: 错误日志**
- [ ] SUCCEEDED 实例：Empty "无错误"
- [ ] FAILED 实例：显示 error_message + result.error_log（TextArea rows=15）

### 2.7 实例操作

- [ ] **FAILED 实例点重试**：
  - Drawer 底部「重试」按钮显示（仅 FAILED/TIMEOUT）
  - 点击后 → 调 retryInstance → 实例状态变为 PENDING、attempt 递增
  - 后续轮询显示 RUNNING → SUCCEEDED/FAILED
- [ ] **SUCCEEDED 实例点重试**：
  - 底部无「重试」按钮（正常情况按钮已 hidden）
  - 若通过其他方式触发 retry API → 后端返回 409、前端 message.error
- [ ] **删除实例**：
  - SUCCEEDED/FAILED 实例可删除 → 列表刷新、实例消失
  - RUNNING 实例删除 → 后端 409 → toast "实例正在运行，无法删除"

### 2.8 「查看 Trace」按钮（占位状态）

**注**：M4 只完成按钮 UI，具体跳转由 M5 完成。

- [ ] 底部「查看 Trace」按钮存在
- [ ] `trace_id` 为空时按钮 disabled
- [ ] `trace_id` 非空时按钮 enabled
- [ ] 点击行为可能是空 handler 或占位提示（M5 完成后再验证跳转）

### 2.9 深链与刷新

- [ ] 复制 `/eval/tasks/:id` URL 到新 tab → 直接加载、显示实例列表
- [ ] 在详情页 F5 刷新 → 状态不丢失、实例列表重新加载

### 2.10 空状态

- [ ] 任务无实例（极端情况）→ 表格显示 antd Empty
- [ ] 过滤后无匹配实例 → Empty

### 2.11 跨页面联动

- [ ] 用例被 RUNNING 任务引用时尝试删除该用例 → 409 toast
- [ ] 任务完成后（SUCCEEDED/FAILED）可删除用例 → 成功
- [ ] 用例被删除后进入其任务详情 → 实例列表仍显示（case_id 残留），UI 不崩溃

---

## 3. 通过标准

- 2.1 ~ 2.11 全部勾选
- Drawer 4 个 Tab 内容完整、切换流畅
- 3 秒轮询启停正确
- 重试 / 删除的 409 场景 toast 正确

---

## 4. 已知限制

- Agent 列使用简化方案（不做客户端推断），可能显示"多 Agent 任务"
- 大文本（verify_stdout > 100KB）依赖后端 VerifyOutputCapBytes 截断
- 「查看 Trace」跳转由 M5 完成

---

**E2E 版本**：v1.0

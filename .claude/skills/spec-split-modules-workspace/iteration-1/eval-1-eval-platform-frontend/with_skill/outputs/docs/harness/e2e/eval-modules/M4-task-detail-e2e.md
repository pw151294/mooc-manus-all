# M4 任务详情模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M4-task-detail-spec.md`
**验证类型**：功能验证
**前置**：
- M1、M3 已交付；`/eval/tasks` 可用
- 至少 1 个任务，含 2×3 = 6 个实例（可为 SUCCEEDED / FAILED / RUNNING 混合）
- 后端服务运行中

---

## 1. 进入详情页

- [ ] **从任务列表点行进入**
  - 在 `/eval/tasks` 点某任务行的非操作区域
  - Expected: 路由跳转到 `/eval/tasks/:id`

- [ ] **直接 URL 访问（深链）**
  - 复制 `/eval/tasks/:id` 到新 tab 打开
  - Expected: 页面正常加载，显示任务详情，不 404

- [ ] **顶部 TaskSummaryCard 数据齐全**
  - Expected: 显示 name、status Badge、progress 条 + 数字（`succeeded_count / total_count`）、
    total/succeeded/failed 三个 Statistic、created_at / started_at / finished_at 时间字段

- [ ] **中部 InstanceTable 显示 M×N 行**
  - 前置：任务的 total_count = 6
  - Expected: 表格 6 行，每行显示 case_name / agent_name / status / total_tokens / agent_latency_ms / attempt 列

---

## 2. 实例列表轮询

- [ ] **有 RUNNING 实例时 3s 轮询**
  - 前置：至少 1 个实例状态为 PENDING 或 RUNNING
  - devtools Network 面板
  - Expected: 每 3s 出现一次 `GET /api/eval/tasks/:id/instances` 请求；实例状态实时变化，
    total_tokens / agent_latency_ms 动态更新

- [ ] **全终态后自动停止**
  - 前置：所有实例都 SUCCEEDED 或 FAILED
  - Expected: 30s 内无新的 instances 请求；task 主对象轮询也停止

- [ ] **离开页面轮询停止**
  - 有 RUNNING 时，导航离开
  - Expected: 30s 内 Network 无 instances 请求

---

## 3. 实例过滤

- [ ] **按状态过滤**
  - 选「已完成」 → Expected: 只显示 SUCCEEDED
  - 选「失败」 → Expected: 只显示 FAILED
  - 选「全部」或清空 → 显示全部

- [ ] **过滤时轮询保持正确**
  - 前置：有 RUNNING 实例
  - 切到「已完成」（此时列表可能为空或部分）
  - Expected: 后台轮询仍按 3s 心跳（针对全量实例判断状态）

---

## 4. 查看实例详情 Drawer

- [ ] **打开 Drawer**
  - 点实例表格某 SUCCEEDED 行
  - Expected: 右侧 860 宽 Drawer 滑出，标题含 `case_name × agent_name`
  - 默认停在「基础信息」Tab

- [ ] **基础信息 Tab**
  - Expected: 显示 conversation_id / message_id / worker_id / 时间戳（created_at / started_at / finished_at）

- [ ] **执行结果 Tab（passed=true）**
  - 切到「执行结果」
  - Expected: 顶部绿色 Alert「验证通过」+ 绿勾图标；verify_stdout / verify_stderr 分块展示，
    长文本可滚动（超过 10 行）

- [ ] **执行结果 Tab（passed=false）**
  - 前置：找一个 FAILED 且 verify 已执行的实例
  - Expected: 红色 Alert「验证失败」+ 红叉；verify_stdout / verify_stderr 显示

- [ ] **Token & 耗时 Tab**
  - Expected: 显示 prompt_tokens / completion_tokens / total_tokens / agent_latency_ms 四项数字

- [ ] **错误日志 Tab**
  - SUCCEEDED 实例：显示「无错误」占位
  - FAILED 实例：显示 error_message + error_log（`<pre>` 可滚动）

- [ ] **关闭 Drawer**
  - 点右上角关闭
  - Expected: Drawer 关闭；实例列表状态不丢失，轮询继续

- [ ] **大文本不卡顿**
  - 前置：找 verify_stdout 长度 > 50KB 的实例
  - 打开 Drawer → 切「执行结果」Tab
  - Expected: 页面无明显卡顿；`<pre>` 容器 max-height 生效，可内部滚动

---

## 5. 重试实例

- [ ] **FAILED 实例重试**
  - 找一个 FAILED 实例 → 点「重试」
  - Expected: 实例状态变 PENDING → RUNNING → SUCCEEDED/FAILED；attempt 从 1 递增到 2；
    轮询在存在 PENDING/RUNNING 时保持

- [ ] **SUCCEEDED 实例重试返回 409**
  - 找一个 SUCCEEDED 实例 → 点「重试」（若 UI 显示了）
  - Expected: 后端 409，前端 error toast「实例状态不允许重试」；实例状态不变
  - **前端可选**：SUCCEEDED 时直接隐藏「重试」按钮（推荐做法）

---

## 6. 删除实例

- [ ] **删除 SUCCEEDED 实例**
  - 找 SUCCEEDED 实例 → 点「删除」→ Popconfirm 确认
  - Expected: 实例从列表消失

- [ ] **删除 FAILED 实例**
  - Expected: 同上

- [ ] **删除 RUNNING 实例返回 409**
  - 找 RUNNING 实例 → 点「删除」→ 确认
  - Expected: 后端 409，前端 error toast「实例正在运行，无法删除」；实例未删除

---

## 7. 空状态 / 加载态

- [ ] **无实例**
  - 前置：找一个 total_count=0 的任务（或删完实例）
  - Expected: 表格显示 antd Empty

- [ ] **加载中**
  - Network 慢速 → 直接访问 `/eval/tasks/:id`
  - Expected: 汇总卡片 + 表格显示 Skeleton

- [ ] **执行结果 Tab 无结果**
  - 前置：找 PENDING/RUNNING 实例（尚无 result）
  - 打开 Drawer → 「执行结果」Tab
  - Expected: 显示「暂无执行结果」占位

---

## 8. 边界与异常

- [ ] **taskId 不存在**
  - 访问 `/eval/tasks/00000000-0000-0000-0000-000000000000`
  - Expected: 显示"任务不存在"或 antd Result 组件；不白屏，Console 无未处理错误

- [ ] **刷新页面**
  - 在详情页按 F5
  - Expected: 页面重新加载，状态不丢失（url 保留 taskId），实例列表重新拉取

- [ ] **快速切换任务**
  - 从任务列表点 A → 立即返回 → 点 B
  - Expected: Network 中 A 的 instances 请求可能被 cancel；页面正确显示 B 的数据（AbortController 生效）

- [ ] **网络中断**
  - 断网 → 点重试/删除
  - Expected: 错误 toast，界面稳定

---

## 9. 跨模块预留

- [ ] **查看 Trace 按钮位存在**
  - 打开 Drawer → 底部找到「查看 Trace」按钮
  - Expected: 按钮存在（M4 独立验收时 disabled 或点击无反应；M5 交付后启用）
  - **本模块独立验收**：仅检查按钮 DOM 存在

---

## 10. 交付验收

- [ ] 上述所有检查项通过（跨模块 TODO 项除外）
- [ ] `git status` 干净
- [ ] Console 无 error
- [ ] Network 无 4xx/5xx 未处理错误
- [ ] 深链（直接访问 URL）可用
- [ ] 3s 轮询启停符合预期

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.3 / §9.2.3 / §11.2

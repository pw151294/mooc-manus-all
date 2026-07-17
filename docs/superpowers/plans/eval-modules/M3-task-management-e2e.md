# M3 任务管理模块验证文档

**对应规格**：`docs/superpowers/specs/eval-modules/M3-task-management-spec.md`
**前置**：M1、M2 已交付（至少有 2 个用例、1 个 Agent Config）；后端服务运行中

---

## 1. 创建任务

- [ ] **打开 Modal 数据加载**
  - 点「创建任务」→ Modal 弹出
  - Expected: 左侧 Transfer 显示用例列表（来自 listCases）
  - Expected: 右侧 Transfer 显示 Agent 列表，格式 `${provider} - ${model_name}`
  - Expected: 底部 Alert 初始显示「将创建 0 × 0 = 0 个实例」

- [ ] **M×N 预览实时计算**
  - 左选 2 个用例
  - Expected: Alert 变「2 × 0 = 0 个实例」
  - 右选 3 个 Agent
  - Expected: Alert 变「2 × 3 = 6 个实例」

- [ ] **提交按钮禁用逻辑**
  - 未填名称 → 「创建」按钮 disabled
  - 未选任一侧 → disabled
  - 三者都填 → enabled

- [ ] **成功创建**
  - 填名称 "M3-test-1" + 2 用例 + 3 Agent → 点「创建」
  - Expected: 后端 POST /api/eval/tasks 返回 200
  - Expected: Modal 关闭
  - Expected: 任务列表刷新，新任务出现且 status = PENDING
  - Expected: total_count = 6

- [ ] **搜索 Transfer**
  - 左侧 Transfer 搜索框输入用例名关键字
  - Expected: 列表过滤到匹配项

---

## 2. 任务列表轮询

- [ ] **有活动任务时自动轮询**
  - 创建 1 个任务，状态 PENDING/RUNNING
  - Chrome DevTools Network 面板筛选 `eval/tasks`
  - Expected: 每 5s 一次 `GET /api/eval/tasks` 请求
  - Expected: 表格状态列/进度列自动变化（PENDING → RUNNING → SUCCEEDED）

- [ ] **全终态自动停轮询**
  - 等所有任务变 SUCCEEDED/FAILED
  - Expected: Network 面板 30s 内无新 `GET /api/eval/tasks` 请求

- [ ] **重新出现活动任务时恢复轮询**
  - 全终态后再创建新任务 → 触发 store.createTask 内的 startPolling
  - Expected: 轮询恢复

- [ ] **离开页面停止轮询**
  - 有 RUNNING 任务时切换到 `/eval/cases` 或其他页
  - Expected: Network 面板 30s 内无 `GET /api/eval/tasks`

- [ ] **静默刷新（不闪烁）**
  - 轮询 tick 时观察表格
  - Expected: 无 loading spinner 反复闪现（loading 不置 true）

---

## 3. 状态过滤

- [ ] **筛选运行中**
  - 点「运行中」按钮
  - Expected: 请求 URL 含 `status=RUNNING`
  - Expected: 表格只显示 RUNNING 任务

- [ ] **筛选已完成**
  - 点「已完成」
  - Expected: 只显示 SUCCEEDED

- [ ] **筛选失败**
  - 点「失败」
  - Expected: 只显示 FAILED

- [ ] **重置为全部**
  - 点「全部」
  - Expected: 显示所有状态

---

## 4. 分页

- [ ] **翻页**（前置：创建 25+ 任务）
  - pageSize=20，第一页 20 条
  - 翻到第二页，Expected: 显示剩余任务

- [ ] **改 pageSize**
  - 选 pageSize=50
  - Expected: page 重置为 1，显示全部

---

## 5. 删除任务

- [ ] **确认删除**
  - 点「删除」→ Popconfirm 二次确认 → 确定
  - Expected: 任务消失，列表刷新
  - Expected: 底层实例也被后端级联删除

- [ ] **取消删除**
  - 点「删除」→ 取消
  - Expected: 任务保留

---

## 6. 重试任务

- [ ] **有失败实例时重试**
  - 前置：任务已跑完，有 1+ FAILED 实例
  - 点「重试」按钮
  - Expected: toast「已重试 N 个失败实例」（N > 0）
  - Expected: 任务状态回到 RUNNING，进度重新计算
  - Expected: 轮询恢复

- [ ] **无失败实例时重试**
  - 前置：任务全 SUCCEEDED
  - 点「重试」
  - Expected: toast「已重试 0 个失败实例」（或按钮 disable）

---

## 7. 行点击跳转

- [ ] **点击行跳详情**
  - 点某行的名称或空白区域
  - Expected: URL 变为 `/eval/tasks/:id`
  - Expected: 页面切到 M4 任务详情页（M4 未交付时是占位）

- [ ] **点击操作列不跳转**
  - 点「删除」按钮
  - Expected: 只弹 Popconfirm，不触发行点击的路由跳转（stopPropagation）

---

## 8. 空状态

- [ ] **无任务**
  - 删光所有任务
  - Expected: 表格显示 antd Empty「暂无数据」

---

## 9. 交付验收

- [ ] § 1-8 检查项通过
- [ ] `git status` 干净
- [ ] devtools 无 error
- [ ] Task 与 Case 联动：删除 M2 已被引用的用例返回 409（可在 M2 §3 补测）

---

**文档版本**：v1.0  |  **拆分自**：父规格 §9.2.2

# M3 任务管理模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M3-task-management-spec.md`
**验证类型**：功能验证
**前置**：
- M1 已交付
- 至少 2 个可用用例（M2 已交付，或后端 seed）
- 至少 2 个可用 Agent Config
- 浏览器打开 `/eval/tasks`

---

## 1. 创建任务

- [ ] **双 Transfer 选择用例与 Agent**
  - 点「创建任务」→ Modal 弹出
  - 左侧 Transfer 从候选用例选 2 个 → 右侧
  - 右侧 Transfer 从候选 Agent 选 3 个 → 右侧
  - Expected: 底部 Alert 显示「将创建 2 × 3 = 6 个实例」

- [ ] **实时 M×N 预览**
  - 反复调整两侧选中数量（1×1、2×3、3×2）
  - Expected: 数字实时更新

- [ ] **提交创建**
  - 填 name = `task-e2e-1`（或留空）
  - 点提交
  - Expected: Modal 关闭，任务列表刷新，新任务出现在第一行，状态为 PENDING

- [ ] **未选择时提交按钮禁用**
  - 打开 Modal，两侧都为空
  - Expected: 「提交」按钮 disabled

- [ ] **Transfer 搜索**
  - 用例超过 20 个时（可 seed 造数据），在 Transfer 搜索框输入关键词
  - Expected: 左侧只显示匹配的用例

---

## 2. 任务列表与轮询

- [ ] **列表展示**
  - Expected: 表格显示 name / status Badge / progress / created_at / started_at / finished_at / 操作 列
  - 状态颜色：PENDING 灰、RUNNING 蓝（脉冲）、SUCCEEDED 绿、FAILED 红

- [ ] **智能轮询（有 RUNNING 任务）**
  - 前置：至少 1 个 PENDING 或 RUNNING 任务
  - 打开 devtools Network 面板
  - Expected: 每 5s 出现一次 `GET /api/eval/tasks` 请求；状态从 PENDING → RUNNING → SUCCEEDED 过程中，表格实时更新；progress 数字动态变化

- [ ] **智能轮询自动停止（全终态）**
  - 前置：所有任务都是 SUCCEEDED 或 FAILED
  - Expected: Network 面板 30s 内无新 `GET /api/eval/tasks` 请求

- [ ] **离开页面轮询停止**
  - 有 RUNNING 任务时，点侧边栏"用例管理"跳走
  - Expected: 30s 内无 `GET /api/eval/tasks` 请求
  - 返回 `/eval/tasks`
  - Expected: 轮询重新启动

---

## 3. 过滤

- [ ] **单选状态过滤**
  - 过滤器选「运行中」
  - Expected: 只显示 RUNNING 任务

- [ ] **多选状态过滤**
  - 过滤器选「已完成 + 失败」
  - Expected: 显示 SUCCEEDED 和 FAILED 任务，无 PENDING/RUNNING

- [ ] **切换过滤时分页重置**
  - 前置：任务数 > 20，处于第 2 页
  - 切换 status filter
  - Expected: 自动回到第 1 页

- [ ] **清空过滤**
  - 选「全部」或清空过滤器
  - Expected: 显示所有任务

---

## 4. 删除任务

- [ ] **删除任务**
  - 找一个 FAILED 或 SUCCEEDED 任务 → 点删除 → Popconfirm 确认
  - Expected: 任务从列表消失，列表刷新

- [ ] **删除 RUNNING 任务**
  - 找一个 RUNNING 任务 → 点删除 → 确认
  - Expected: 后端根据实现或返回 200（级联终止）或 409；前端行为一致：成功则消失，失败则 error toast

---

## 5. 行点击进入详情

- [ ] **点击任务行**
  - 点某任务行的非操作区域
  - Expected: 路由跳转到 `/eval/tasks/:id`
  - **M3 独立验收时**：目标页由 M1 占位承接，只需验证路由成功；完整功能属 M4

---

## 6. 表单校验 / 边界

- [ ] **name 过长（>128 字）**
  - 粘贴 200 字 name → 提交
  - Expected: 前端或后端校验拦截，友好提示

- [ ] **单侧 Transfer 全选（0 边界）**
  - 只选用例、不选 Agent → 提交按钮 disabled
  - 反之亦然

- [ ] **M×N 过大**（>100）
  - 选 20 个用例 × 20 个 Agent = 400 实例
  - 底部 Alert 显示 400，可有警示样式或提示确认
  - Expected: 提交成功，后端创建 400 实例；前端轮询正常刷新

---

## 7. 空状态 / 加载态

- [ ] **无任务**
  - 前置：清空所有任务
  - Expected: 表格显示 antd Empty

- [ ] **加载中**
  - Network 慢速 → 刷新页面
  - Expected: Skeleton 或 loading spinner

- [ ] **Modal 内 Agent 拉取加载**
  - 打开创建 Modal 时慢网络
  - Expected: Transfer 右侧数据源显示 loading

---

## 8. 边界与异常

- [ ] **网络失败**
  - 断网 → 点创建/删除
  - Expected: 错误 toast，界面稳定

- [ ] **快速连点提交**
  - 快速点两次「提交」
  - Expected: 只发一次请求，第二次被禁用或被 store 竞态处理

- [ ] **轮询期间竞态**
  - 快速切换 status filter（触发多次 fetchTasks）
  - Expected: Network 面板中前面的请求被 cancel，只有最后一次生效

- [ ] **删除用例时任务残留**（跨 M2）
  - 前置：M2 已交付
  - 创建任务引用用例 C1 → 删除 C1（终态任务下允许）→ 任务列表仍显示该任务
  - **本模块独立验收时**：跳过

---

## 9. 交付验收

- [ ] 上述所有检查项通过（跨模块 TODO 项除外）
- [ ] `git status` 干净
- [ ] Console 无 error
- [ ] Network 无 4xx/5xx 未处理错误
- [ ] 智能轮询启停符合预期，离开页面无泄漏请求

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.2 / §9.2.2 / §9.2.5

# M1 基础设施 E2E 验证

**对应规格**：`../specs/eval-modules/M1-infrastructure-spec.md`
**验收环境**：本地开发环境（前端 dev server + 后端 mooc-manus 服务）

---

## 1. 前置条件

- 后端 `mooc-manus` 服务已启动（端口默认 8080）
- 后端至少已配置 1 个 Agent Config（否则任务创建无候选）
- 前端 `mooc-manus-web` dev server 已启动
- 浏览器打开开发者工具（Network / Console）

---

## 2. 验证清单

### 2.1 路由与菜单

- [ ] **菜单可见**：
  - 打开任意页面 → 左侧 Layout 菜单中出现「评测平台」父节点，图标为 ExperimentOutlined
  - 展开父节点 → 出现子菜单：「用例管理」「任务管理」
- [ ] **路由跳转**：
  - 点「用例管理」→ URL 跳转到 `/eval/cases`，页面渲染占位内容（不报错）
  - 点「任务管理」→ URL 跳转到 `/eval/tasks`，页面渲染占位内容
  - 手动输入 `/eval/tasks/some-id` → 页面渲染占位内容，`useParams().id` 应为 `some-id`
- [ ] **深链**：
  - 复制 `/eval/tasks/xxx` URL 到新 tab → 页面直接加载（不需要先访问 `/eval/tasks`）
  - 刷新（F5）→ 路由保持

### 2.2 API 层（可用浏览器 Console 或 Postman）

用 Console 或临时按钮触发以下 API，验证返回结构符合 types/eval.ts 类型：

- [ ] **Case 6 个 endpoint**：
  - `listCases({ page: 1, size: 10 })` → 返回 `{ items, total, page, size }`
  - `uploadContent(file)` → 上传一个 100 字节的 .sh 文件，返回 `{ content, size: 100 }`
  - `createCase({...})` → 创建成功返回 `CaseView`
  - `getCase(id)` → 返回 `CaseView`
  - `updateCase(id, { name: '新名字' })` → 只传变更字段（Network 面板检查请求 body 无 undefined 字段）
  - `deleteCase(id)` → 空闲用例返回 204
- [ ] **Task 5 个 endpoint**：
  - `listTasks({ page: 1, size: 10 })` → 返回 ListPage 结构
  - `createTask({ name, case_ids, agent_config_ids })` → 成功返回 TaskView
  - `getTask(id)` → 返回 TaskView（含 total_count / succeeded_count 等）
  - `retryTask(id)` → 返回 `{ retried_count: N }`
  - `deleteTask(id)` → 204
- [ ] **Instance 4 个 endpoint**：
  - `listInstances(taskId, { page: 1, size: 20 })` → 返回 ListPage
  - `getInstance(id)` → 返回 InstanceView（含 result 字段）
  - `getInstanceTrace(id)` → 返回 `{ trace_id }`
  - `retryInstance(id)` / `deleteInstance(id)` → 状态正确
- [ ] **Agent Config**：
  - `listAgentConfigs()` → 返回 `AgentConfigView[]`

### 2.3 错误处理

- [ ] **409 冲突**：
  - 尝试 `deleteCase(id)` 一个被 RUNNING 任务引用的用例 → Console 检查响应为 409
  - 前端全局 message.error 出现（由 request.ts 拦截器统一处理）
- [ ] **413 文件过大**（此模块无 UI，Console 触发）：
  - `uploadContent(15MB 文件)` → 后端返回 413
  - Console message.error 出现（由拦截器统一处理）

### 2.4 Store — 用例（evalCase）

用 React DevTools 或临时挂载 store 到 window 手动调用：

- [ ] **fetchCases**：
  - 调用 `evalCase.fetchCases()` → state.cases 更新、state.loading 短暂 true → false
  - 连续快速调 2 次 → Network 面板显示第一次 canceled（AbortController 生效）
- [ ] **applyFiltersAndFetch**：
  - `evalCase.setPage(3)` 后调 `applyFiltersAndFetch({ nameLike: 'X' })` → page 应重置为 1
- [ ] **无轮询**：
  - 调 `fetchCases` 后等待 30 秒 → Network 面板无自动新请求

### 2.5 Store — 任务（evalTask，5 秒轮询）

- [ ] **智能轮询启停**：
  - 后端造一个 RUNNING 状态任务
  - 调 `evalTask.startPolling()` → Network 面板每 5s 一次 `GET /api/eval/tasks`
  - 后端将该任务标为 SUCCEEDED
  - 前端下一次轮询后（最多 5s + 1s buffer）→ 轮询自动停止（Network 30s 内无新请求）
- [ ] **stopPolling 幂等**：
  - 未启动时调 `stopPolling` → 不报错
  - 调 `startPolling` 后立即调 `stopPolling` → 无幽灵定时器
- [ ] **重复 startPolling**：
  - 连续调 `startPolling` 2 次 → 只启动 1 个定时器（不叠加频率）

### 2.6 Store — 实例（evalInstance，3 秒轮询）

- [ ] **fetchInstances(taskId)**：
  - 调用后 state.instances 更新、state.taskId 正确
- [ ] **智能轮询**：
  - 有 RUNNING 实例 → 3s 间隔轮询
  - 全终态 → 自动停止
- [ ] **reset**：
  - 调 `reset()` → state.instances=[]、state.taskId=null
  - 用于离开详情页时清理

### 2.7 竞态处理（fetch 类）

- [ ] 连续两次 `fetchCases()` / `fetchTasks()` / `fetchInstances(taskId)`：
  - Network 面板：第一次显示 canceled 状态
  - Store state 只被第二次结果更新

---

## 3. 通过标准

- 2.1 ~ 2.6 全部勾选
- Console 无未预期报错（除刻意触发的 409/413）
- Network 面板显示轮询按预期间隔运行、全终态时正确停止

---

## 4. 已知限制（本模块不覆盖）

- UI 交互（Modal / Drawer / Table）→ M2 ~ M4 覆盖
- 「查看 Trace」跳转 → M5 覆盖
- 空状态 Empty 组件 → 各页面模块自行覆盖

---

**E2E 版本**：v1.0

# M1 基础设施模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M1-infrastructure-spec.md`
**验证类型**：技术层验证（本模块无 UI）
**前置**：
- 后端 mooc-manus 服务已启动（默认 `http://localhost:8080`），`/api/eval/*` 可用
- 前端 `mooc-manus-web` 已 `npm install`、`npm run dev` 可访问
- 至少 1 个可用 Agent Config（后端已有种子数据）

---

## 1. 编译与静态检查

- [ ] **TypeScript 编译零错误**
  - Run: `npm run build`（或 `tsc --noEmit`）
  - Expected: 无 error 输出，退出码 0；无 `implicit any` / 未导出符号警告

- [ ] **ESLint 通过**
  - Run: `npm run lint`
  - Expected: 无 error（warning 允许）

- [ ] **types/eval.ts 导出完整**
  - Run: `grep -E "^export (interface|type|enum) " src/types/eval.ts | wc -l`
  - Expected: ≥ 15（覆盖 Case / Task / Instance / AgentConfig / ListPage 等）

- [ ] **api/modules/eval.ts 函数数量**
  - Run: `grep -E "^export async function " src/api/modules/eval.ts | wc -l`
  - Expected: 16（Case 6 + Task 5 + Instance 5 + AgentConfig 1）

---

## 2. API 联通（curl 技术验证）

- [ ] **列出用例**
  - Run: `curl -s 'http://localhost:8080/api/eval/cases?page=1&page_size=10' | jq '.items | length'`
  - Expected: 返回数值（可能为 0），响应含 `items` / `total` / `page` / `page_size` 四个字段

- [ ] **列出任务**
  - Run: `curl -s 'http://localhost:8080/api/eval/tasks?page=1&page_size=10' | jq '.'`
  - Expected: 200 响应，含 ListPage 结构

- [ ] **列出 Agent 配置**
  - Run: `curl -s 'http://localhost:8080/api/eval/agent-configs' | jq 'length'`
  - Expected: ≥ 1（后端有种子数据）

- [ ] **前端 API 层贯通**
  - Chrome devtools → Console
  - Run:
    ```js
    import('./src/api/modules/eval').then(m => m.listAgentConfigs().then(console.log))
    ```
    （或通过 Vite HMR 页面上下文里已加载的 module）
  - Expected: 返回 `AgentConfigView[]`，字段为 snake_case

---

## 3. Store 与轮询

- [ ] **三份 store 实例存在**
  - Chrome devtools → Console
  - Run:
    ```js
    // 假设 store 挂到 window 便于调试（或用 React DevTools 查看 provider）
    Object.keys(window.__ZUSTAND_STORES__ || {}).filter(k => k.startsWith('eval'))
    ```
  - Expected: 包含 `evalCase` / `evalTask` / `evalInstance` 三项，或通过 React DevTools 能看到三份 store

- [ ] **fetchTasks 触发一次请求**
  - Console 调用 `useEvalTaskStore.getState().fetchTasks()`
  - Expected: Network 面板出现 1 次 `GET /api/eval/tasks`，state.tasks 更新

- [ ] **智能轮询启动**
  - 前置：后端至少有 1 个状态为 `PENDING` 或 `RUNNING` 的任务（可 curl 创建）
  - Console: `useEvalTaskStore.getState().startPolling()`
  - Expected: Network 面板每 5s 出现一次 `GET /api/eval/tasks`，持续 15s 内至少 3 次

- [ ] **智能轮询自动停止（终态）**
  - 前置：将所有任务通过后端手动置为 `SUCCEEDED`（或直接删除运行中任务）
  - Wait: 一次轮询周期后
  - Expected: Network 面板 30s 内无新的 `GET /api/eval/tasks` 请求；`state.pollingTimer` 为 null

- [ ] **stopPolling 主动停止**
  - Console: `useEvalTaskStore.getState().startPolling()` → 观察请求 → `stopPolling()`
  - Expected: 立即停止；30s 内无新请求

- [ ] **竞态：AbortController 生效**
  - Console 快速连续调用两次 `fetchTasks()`
  - Expected: Network 面板中第一次请求状态为 `canceled`，第二次正常完成；state 只被第二次结果覆盖

---

## 4. 路由与菜单

- [ ] **路由 `/eval/cases` 可达**
  - 浏览器访问 `http://localhost:5173/eval/cases`（或实际端口）
  - Expected: 不 404，页面渲染占位组件（TODO M2 / 空 Empty），控制台无 route 报错

- [ ] **路由 `/eval/tasks` 可达**
  - 浏览器访问 `/eval/tasks`
  - Expected: 同上

- [ ] **动态路由 `/eval/tasks/:id` 可达**
  - 浏览器访问 `/eval/tasks/00000000-0000-0000-0000-000000000000`
  - Expected: 不 404，`useParams()` 拿到 id，占位组件渲染

- [ ] **Layout 侧边栏新增"评测平台"**
  - 打开任意页面 → 侧边栏
  - Expected: 出现"评测平台"父菜单（图标 ExperimentOutlined），展开后含"用例管理"、"任务管理"两项；点击 → 路由跳转正常

---

## 5. 边界与异常

- [ ] **后端 500 时 store 保持稳定**
  - 前置：手动停掉后端（`pkill -f mooc-manus`）
  - Console: `useEvalTaskStore.getState().fetchTasks()`
  - Expected: loading 从 true 变 false，state.tasks 不变（保留旧数据或为空），控制台有 error toast

- [ ] **fetchInstances 未传 taskId 时不发请求**
  - Console: `useEvalInstanceStore.getState().fetchInstances('')`
  - Expected: 不发 Network 请求（或立即失败），不修改 state

- [ ] **上传前置校验（10MB 上限）** — 需 M2 UI 后完整验证
  - 本模块单独验收时跳过；仅确认 `api.uploadContent` 函数存在且签名接受 File

---

## 6. 交付验收

- [ ] 上述所有检查项通过
- [ ] `git status` 干净（本模块代码已 commit）
- [ ] 浏览器 devtools Console 无 error（warning 允许）
- [ ] Network 面板无 4xx/5xx 未处理错误
- [ ] 本模块独立验收通过后，可解锁 M2 / M3 / M4 并行推进

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4 / §5 / §6 / §8 / §10.1

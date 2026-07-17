# M1 基础设施模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M1-infrastructure-spec.md`  
**验证类型**：技术层验证  
**前置**：后端 eval API 服务可用；前端依赖已安装；本模块代码已实现。

---

## 1. 类型与 API 覆盖

- [ ] **类型定义可被编译引用**
  - Run: `npm run typecheck`（在 `mooc-manus-web` 内执行项目实际类型检查命令）
  - Expected: `types/eval.ts` 中的 Case / Task / Instance / Result / Agent Config / ListPage 类型无 TS 编译错误。

- [ ] **API 函数导出数量完整**
  - 检查 `src/api/modules/eval.ts` 导出函数。
  - Expected: Case 6 个、Task 5 个、Instance 5 个、Agent Config 1 个函数均存在；函数名与 M1 spec §1.1 一致。

- [ ] **snake_case 字段不被转换**
  - 检查 `types/eval.ts` 与 `api/modules/eval.ts`。
  - Expected: 请求与响应类型使用 `case_ids`、`agent_config_ids`、`created_at`、`total_tokens` 等 snake_case 字段。

- [ ] **文件上传 API 使用 FormData**
  - 检查 `uploadContent(file)` 实现。
  - Expected: `FormData` 中字段名为 `file`，请求路径为 `/api/eval/cases/upload-content`，Content-Type 为 multipart。

---

## 2. Store 行为验证

- [ ] **用例 store 支持列表、分页、过滤、CRUD action**
  - 打开浏览器 devtools 或 store 调试输出。
  - 调用/触发 `fetchCases()`、`setPage()`、`setPageSize()`、`applyFiltersAndFetch()`。
  - Expected: `cases`、`total`、`page`、`pageSize`、`filters`、`loading` 状态按操作更新。

- [ ] **用例 fetch 竞态处理**
  - 快速连续触发两次用例搜索或过滤。
  - Expected: 前一次请求被 abort 或不覆盖后一次结果；页面最终显示最后一次过滤条件对应数据。

- [ ] **任务 store 轮询启停**
  - 前置：存在至少一个 `PENDING` 或 `RUNNING` 任务。
  - 触发 `startPolling()`。
  - Expected: Network 面板每 5 秒出现一次 `GET /api/eval/tasks`；任务全部终态后轮询停止。

- [ ] **实例 store 绑定 taskId 轮询**
  - 前置：存在至少一个含 `RUNNING` 实例的任务。
  - 触发 `startPolling(taskId)`。
  - Expected: Network 面板每 3 秒出现一次 `GET /api/eval/tasks/:id/instances`；切换或离开任务时 `reset()` 后旧实例列表清空。

---

## 3. 路由与菜单基座

- [ ] **评测路由可访问**
  - 打开 `/eval/cases`、`/eval/tasks`、`/eval/tasks/<任意任务ID>`。
  - Expected: 前端路由能匹配页面或占位组件，不出现 React Router 404 或白屏。

- [ ] **Layout 菜单出现评测平台入口**
  - 启动前端并打开任意页面。
  - Expected: 左侧或顶部 Layout 菜单存在「评测平台」父级菜单，包含「用例管理」与「任务管理」。

- [ ] **菜单点击路径正确**
  - 点击「用例管理」。
  - Expected: URL 变为 `/eval/cases`。
  - 点击「任务管理」。
  - Expected: URL 变为 `/eval/tasks`。

---

## 4. 后端 API 联通

- [ ] **用例列表 API 可调通**
  - 在页面或 devtools 中触发 `listCases({ page: 1, size: 10 })`。
  - Expected: 请求命中 `GET /api/eval/cases`，响应可被解析为 `ListPage<CaseView>`。

- [ ] **任务列表 API 可调通**
  - 触发 `listTasks({ page: 1, size: 10 })`。
  - Expected: 请求命中 `GET /api/eval/tasks`，响应包含 `items`、`total`、`page`、`size`。

- [ ] **Agent Config API 可调通**
  - 触发 `listAgentConfigs()`。
  - Expected: 请求命中 `GET /api/eval/agent-configs`，响应数组项包含 `id`、`model_name`、`provider`。

---

## 5. 边界与异常

- [ ] **后端 4xx 错误由 request 拦截器显示**
  - 触发一个确定会失败的删除或获取请求。
  - Expected: 页面显示错误 toast；组件层未重复弹出多条错误。

- [ ] **页面卸载后无残留轮询**
  - 在任务或实例轮询进行时跳转到非评测页面。
  - Expected: Network 面板 30 秒内不再出现对应 eval 轮询请求。

- [ ] **空响应可安全渲染**
  - 后端返回空列表。
  - Expected: store 状态为 `items=[]`、`total=0`，页面不报错。

---

## 6. 交付验收

- [ ] 上述所有检查项通过。
- [ ] `npm run typecheck` 或项目等价类型检查通过。
- [ ] 浏览器 devtools 无未处理 error。
- [ ] Network 面板无持续失控轮询。
- [ ] `git status` 干净（本模块代码已 commit）。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §2、§3、§4、§5、§6、§8.1、§8.2、§10.1

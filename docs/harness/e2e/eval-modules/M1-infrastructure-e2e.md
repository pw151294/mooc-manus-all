# M1 基础设施模块验证文档

**对应规格**：`docs/superpowers/specs/eval-modules/M1-infrastructure-spec.md`
**验证类型**：技术层验证（无功能测试，因本模块无 UI 页面）

---

## 1. 类型层验证

- [ ] **types/eval.ts 编译通过**
  - Run: `cd mooc-manus-web && npx tsc --noEmit`
  - Expected: 无错误输出
  - Expected: 15 个接口全部导出（`grep -c "^export interface" src/types/eval.ts` = 15）

---

## 2. API 层验证（手动联调后端）

**前置**：后端服务已启动（`cd mooc-manus && make run`），至少有 1 个 AgentConfig

- [ ] **listAgentConfigs 联通**
  - Run: `curl http://localhost:8080/api/eval/agent-configs`
  - Expected: 200 + JSON 数组，每项含 `id / model_name / provider`

- [ ] **createCase → getCase → deleteCase 联通**
  - 创建：`curl -X POST http://localhost:8080/api/eval/cases -H 'Content-Type: application/json' -d '{"name":"m1-test","description":"","init_script":"","task_prompt":"hi","verify_script":"exit 0","tags":[]}'`
  - Expected: 200 + `CaseView`（记录 id）
  - 查询：`curl http://localhost:8080/api/eval/cases/<id>` → 200
  - 删除：`curl -X DELETE http://localhost:8080/api/eval/cases/<id>` → 200

- [ ] **uploadContent 联通**
  - Run: `echo "hello" > /tmp/x.txt && curl -X POST http://localhost:8080/api/eval/cases/upload-content -F "file=@/tmp/x.txt"`
  - Expected: 200 + `{"content":"hello\n","size":6}`

- [ ] **listCases / listTasks 分页联通**
  - Run: `curl 'http://localhost:8080/api/eval/cases?page=1&size=20'`
  - Expected: 200 + `{items, total, page, size}`

- [ ] **前端 API 函数 TS 签名对齐**
  - `import * as evalApi from '@/api/modules/eval'` 无 TS 错误
  - Expected: 15 个函数（`grep -c "^export async function" src/api/modules/eval.ts` = 15）

---

## 3. Store 层验证

- [ ] **3 个 store TS 编译通过**
  - Run: `cd mooc-manus-web && npx tsc --noEmit`
  - Expected: `store/evalCase.ts`、`store/evalTask.ts`、`store/evalInstance.ts` 无错误

- [ ] **evalCase store 基本行为**
  - 在浏览器 devtools 里 `useEvalCaseStore.getState()` 查看初始状态
  - Expected: `cases=[]`, `total=0`, `page=1`, `pageSize=20`, `filters.nameLike=''`, `filters.tags=[]`, `loading=false`

- [ ] **evalTask store 轮询启停**
  - 手动调用 `useEvalTaskStore.getState().startPolling()`
  - Expected: `pollingTimer` 非 null（`getState().pollingTimer` 有值）
  - 手动调用 `stopPolling()`
  - Expected: `pollingTimer` 变 null

- [ ] **evalInstance store reset**
  - 调用 `useEvalInstanceStore.getState().reset()` 后
  - Expected: `taskId=null`、`instances=[]`、`pollingTimer=null`

- [ ] **AbortController 竞态处理**
  - 快速连续调用两次 `fetchCases()`（在 Chrome Network 面板观察）
  - Expected: 第一次请求状态为 `canceled`，第二次正常返回

---

## 4. 路由与菜单验证

**前置**：`cd mooc-manus-web && npm run dev` 启动开发服务器

- [ ] **路由 /eval/cases 可访问**
  - 浏览器打开 `http://localhost:5173/eval/cases`
  - Expected: 页面显示占位组件（"Placeholder"或类似文案），无路由 404

- [ ] **路由 /eval/tasks 可访问**
  - 浏览器打开 `http://localhost:5173/eval/tasks`
  - Expected: 同上

- [ ] **路由 /eval/tasks/:id 可访问**
  - 浏览器打开 `http://localhost:5173/eval/tasks/abc123`
  - Expected: 同上，URL 参数不影响页面渲染

- [ ] **Layout 菜单显示**
  - 在任意页面观察左侧菜单
  - Expected: 可见「评测平台」父级（含 ExperimentOutlined 图标）
  - Expected: 展开后可见「用例管理」「任务管理」两个子项

- [ ] **菜单点击导航**
  - 点击「用例管理」
  - Expected: URL 变为 `/eval/cases`，菜单高亮当前项

---

## 5. 交付验收清单

- [ ] 上述所有检查项通过
- [ ] `git status` 干净（M1 代码已 commit）
- [ ] 无遗留 TODO/FIXME 注释
- [ ] Store 模块级 `inflight` 变量已定义（`grep "let inflight" src/store/eval*.ts` 有 3 处）

---

**文档版本**：v1.0  |  **依赖父规格 §9.3、§9.4**

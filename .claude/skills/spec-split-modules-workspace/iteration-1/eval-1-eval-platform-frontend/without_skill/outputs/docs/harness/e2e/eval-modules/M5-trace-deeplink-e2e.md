# M5 Trace 深链 E2E 验证

**对应规格**：`../specs/eval-modules/M5-trace-deeplink-spec.md`
**依赖 E2E 已通过**：M1、M4

---

## 1. 前置条件

- M1、M4 已交付验证
- 至少存在一个已完成实例（SUCCEEDED），且后端已生成 trace_id
- 后端 Trace 服务可正常返回 trace 详情
- 前端 dev server 已启动
- 浏览器 Network / Console 已打开

---

## 2. 验证清单

### 2.1 从实例详情跳转 Trace

- [ ] 进入 `/eval/tasks/:id` 页面
- [ ] 点某个 SUCCEEDED 实例 → InstanceDrawer 打开
- [ ] 「查看 Trace」按钮 enabled（trace_id 非空）
- [ ] 点「查看 Trace」→
  - 前端调 `getInstanceTrace(instanceId)`（Network 面板确认）
  - 返回 `{ trace_id: 'xxx' }`
  - 浏览器打开新 tab，URL 为 `/traces?traceId=xxx`
- [ ] 新 tab 页面加载完成：
  - Trace 列表页正常渲染（Filters + Table）
  - **TraceDetailModal 自动弹出**，显示对应 traceId 的详情
  - Modal 内 span 树、火焰图、时间轴正常显示

### 2.2 URL 深链直接访问

- [ ] 复制一个 trace 的 URL：`/traces?traceId=<某个已知的 trace_id>` 到新 tab
- [ ] 页面加载后：
  - Trace 列表页正常
  - TraceDetailModal 自动打开
- [ ] URL 参数被清理：地址栏变为 `/traces`（不含 `?traceId=...`）
- [ ] 浏览器刷新（F5）：
  - 因 URL 已清理，不重复打开 Modal
  - 列表页保持正常
  - 用户可从列表重新点行触发 Modal

### 2.3 URL 参数清理时机

- [ ] 观察地址栏：Modal 弹出瞬间 URL 应立即被替换为 `/traces`（用 replace 不影响历史）
- [ ] 浏览器"后退"按钮不会回到带参数的 URL

### 2.4 关闭 Modal 后行为

- [ ] Modal 内点关闭按钮 → Modal 消失
- [ ] Trace 列表页保持正常，可继续操作
- [ ] 地址栏保持 `/traces`

### 2.5 边界情况

- [ ] **trace_id 为空**：
  - PENDING 或未生成 trace 的实例的 Drawer 中「查看 Trace」按钮 disabled
  - 视觉上呈灰色不可点击
- [ ] **无效 traceId**（例如 URL `/traces?traceId=not-exist`）：
  - Modal 弹出，内部尝试拉数据 → 后端返回 404 或空
  - TraceDetailModal 已有的 404 处理生效（可能显示错误提示或 Empty）
  - Console 无未捕获异常
- [ ] **getInstanceTrace 异常**：
  - 手动模拟网络错误（DevTools Offline）后点「查看 Trace」
  - 前端 message.error "无法获取 Trace ID"
  - 无新 tab 打开

### 2.6 Trace 列表页原行为不受影响

- [ ] 在 `/traces`（无 query）→ 点某行 → Modal 打开
- [ ] Filters 过滤功能正常
- [ ] 分页正常

### 2.7 完整端到端流程

- [ ] 在评测详情页找一个 SUCCEEDED 实例
- [ ] 点「查看 Trace」→ 新 tab 打开 Modal
- [ ] 在 Modal 中查看 span 树、火焰图 → 关闭 Modal
- [ ] 回到评测 tab → InstanceDrawer 仍然打开
- [ ] 点另一个实例 → Drawer 更新
- [ ] 再次点「查看 Trace」→ 又开一个新 tab（不复用旧 tab）

### 2.8 A11y

- [ ] 「查看 Trace」按钮可用 Tab 键 focus、Enter 键触发
- [ ] disabled 状态被辅助技术识别（`aria-disabled` 或 `disabled` 属性）

---

## 3. 通过标准

- 2.1 ~ 2.8 全部勾选
- 深链 URL 复制粘贴到新 tab 100% 自动打开对应 trace
- URL 参数清理避免刷新重复弹窗
- Trace 列表页现有行为无回归

---

## 4. 已知限制

- 若 InstanceView.trace_id 与实时 getInstanceTrace 返回不一致（trace 被重置），以 API 返回为准
- Modal 内部错误处理由 TraceDetailModal 自身负责，本模块不改动

---

**E2E 版本**：v1.0

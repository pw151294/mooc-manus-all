# M5 Trace 深链模块验证文档

**对应规格**：`docs/superpowers/specs/eval-modules/M5-trace-deeplink-spec.md`
**前置**：M4 已交付（能从 InstanceDrawer 触发 `window.open('/traces?traceId=xxx')`）；至少存在 1 个已完成的评测实例（含有效 trace_id）

---

## 1. URL 深链基础行为

- [ ] **有效 traceId 自动开 Modal**
  - 在浏览器地址栏直接输入 `http://localhost:5173/traces?traceId=<valid-id>`
  - Expected: Trace 列表页加载
  - Expected: TraceDetailModal 自动弹出，显示对应 trace 数据（span 树 / 火焰图）
  - Expected: URL 变为 `http://localhost:5173/traces`（query 已清空）

- [ ] **无效 traceId**
  - 访问 `http://localhost:5173/traces?traceId=invalid-999`
  - Expected: Modal 弹出，内部显示错误 UI（"Trace 不存在" 或类似）
  - Expected: URL 已清空 query
  - Expected: 关闭 Modal 后 Trace 列表页正常

- [ ] **无 traceId query**
  - 访问 `http://localhost:5173/traces`（无 query）
  - Expected: Modal 不弹出
  - Expected: Trace 列表正常显示（原有行为）

---

## 2. URL 清理逻辑

- [ ] **打开后 URL 立即清空**
  - 访问 `/traces?traceId=xxx` → 观察地址栏
  - Expected: 页面加载完成后 URL 变为 `/traces`（`replace: true` 生效）

- [ ] **刷新页面不重复弹 Modal**
  - 上述 Modal 打开后，手动关闭
  - 按 F5 刷新
  - Expected: Modal 不再弹出（因为 URL 已清空）

- [ ] **浏览器返回不重弹**
  - 访问 `/traces?traceId=xxx` → Modal 弹 → 关闭
  - 点浏览器返回
  - Expected: 不会回到「Modal 弹出」的中间状态（replace 而非 push）

---

## 3. 从 M4 跳转联动（关键场景）

- [ ] **InstanceDrawer 「查看 Trace」触发**
  - 在 M4 任务详情页打开某实例 Drawer
  - 前置：该实例有 trace_id
  - 点「查看 Trace」按钮
  - Expected: 浏览器新 tab 打开 `/traces?traceId=xxx`
  - Expected: 新 tab 中 Modal 自动弹出，显示 trace 详情
  - Expected: 原 tab 停留在评测详情页，未受影响

- [ ] **无 trace_id 的实例**
  - 打开某 PENDING 实例 Drawer（trace_id 为空）
  - Expected: 「查看 Trace」按钮 disabled
  - Expected: 悬停有 title 提示

- [ ] **从 M4 跳转到无效 trace**
  - 手动构造：实例的 trace_id 在后端已被删除
  - 点「查看 Trace」→ getInstanceTrace 返回后 window.open
  - Expected: Trace 页 Modal 弹出并显示 "Trace 不存在"

---

## 4. Trace 原有功能不回归

- [ ] **手动访问 Trace 列表**
  - 从菜单点「会话追踪」→ URL 为 `/traces`
  - Expected: 列表正常加载，过滤器正常

- [ ] **点表格行开 Modal（原行为）**
  - 点某条 trace 行
  - Expected: Modal 弹出（走 `onRowClick(setModalTraceId)`）
  - Expected: URL 不变（`/traces`）

- [ ] **过滤器**
  - 使用 TraceFilters 各个过滤条件
  - Expected: 列表正确刷新

- [ ] **分页**
  - 翻页 / 改 pageSize
  - Expected: 正常

- [ ] **Modal 关闭**
  - 点 Modal 右上 X 或遮罩
  - Expected: Modal 消失，列表页保留

---

## 5. 分享 URL 场景

- [ ] **复制 URL 给同事**
  - 场景：用户 A 打开评测实例 Drawer，用「查看 Trace」跳出新 tab
  - A 复制新 tab 的初始 URL（`/traces?traceId=xxx`，需在 replace 前捕获，实际难以复现）
  - **替代方案**：手动构造 URL 分享
  - 用户 B 打开 URL → Modal 自动弹
  - Expected: B 看到与 A 相同的 trace 详情

- [ ] **书签保存**
  - 用户手动加书签 `/traces?traceId=xxx`
  - 后续从书签打开
  - Expected: Modal 自动弹出

---

## 6. 边界

- [ ] **URL 含额外 query**
  - 访问 `/traces?traceId=xxx&other=yyy`
  - Expected: Modal 正常打开
  - Expected: URL 清空所有 query（`setSearchParams({})`）
  - 若需保留其他 query：M5 spec 未要求，本项非阻塞

- [ ] **快速切换 traceId**
  - 手动构造：先访问 `/traces?traceId=a`，Modal 打开后立即改 URL 为 `/traces?traceId=b`
  - Expected: 因为 useEffect 依赖 searchParams，会重跑并设置 modalTraceId 为 b
  - Expected: Modal 内容更新为 b 的详情

- [ ] **XSS 防护**
  - 访问 `/traces?traceId=<script>alert(1)</script>`
  - Expected: 无脚本执行（TypeScript 类型保护 + antd Modal 会转义）
  - Expected: 传给后端的 traceId 是原字符串，后端 404 或 400

---

## 7. 交付验收

- [ ] § 1-6 检查项通过
- [ ] Trace 模块原有功能 § 4 全部不回归
- [ ] M4 → M5 联动 § 3 完整闭环
- [ ] `git status` 干净
- [ ] devtools 无 error

---

## 8. 集成验证（评测平台整体，可选）

M5 交付后建议做一次端到端串测：
1. 用 M2 创建用例
2. 用 M3 创建任务
3. 等任务跑完
4. 从 M3 列表跳到 M4 详情
5. 点实例 Drawer 的「查看 Trace」
6. 验证 M5 深链弹出 Modal
7. 关闭 Modal 返回评测

---

**文档版本**：v1.0  |  **拆分自**：父规格 §9.2.3（Trace 跳转部分）

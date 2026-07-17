# M5 Trace 深链与联动模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M5-trace-deeplink-spec.md`  
**验证类型**：功能验证  
**前置**：M1、M4 已交付；Trace 页面原有功能可用；存在至少一个带 `trace_id` 的评测实例；后端 `GET /api/eval/instances/:id/trace` 可用。

---

## 1. Trace 页面 query 深链

- [ ] **通过 URL 直接打开 Trace Modal**
  - 获取一个存在的 `trace_id = xxx`。
  - 在浏览器地址栏打开 `/traces?traceId=xxx`。
  - Expected: Trace 页面加载后自动打开 `TraceDetailModal`，内容对应 trace_id `xxx`。

- [ ] **打开后清理 URL 参数**
  - 使用 `/traces?traceId=xxx` 打开页面。
  - 等待 Modal 打开。
  - Expected: 地址栏 query 参数被清理为 `/traces` 或等价路径，使用 replace 不新增多余历史记录。

- [ ] **关闭 Modal 后 Trace 列表可用**
  - 关闭自动打开的 Trace Modal。
  - Expected: 页面停留在 Trace 列表；原有列表、过滤、行点击打开详情功能仍可用。

- [ ] **刷新清理后的页面不重复打开 Modal**
  - Modal 打开并清理 URL 后，关闭 Modal 并刷新页面。
  - Expected: Trace 页面正常显示列表，不自动重新打开刚才的 Modal。

---

## 2. 评测实例跳转 Trace

- [ ] **从 InstanceDrawer 打开 Trace**
  - 打开 `/eval/tasks/:id`。
  - 打开一个带 `trace_id` 的实例 Drawer。
  - 点击「查看 Trace」。
  - Expected: Network 面板出现 `GET /api/eval/instances/:id/trace`。
  - Expected: 新 tab 打开 `/traces?traceId=xxx`。
  - Expected: 新 tab 中 Trace 页面自动弹出对应 `TraceDetailModal`。

- [ ] **保留评测详情上下文**
  - 从 InstanceDrawer 点击「查看 Trace」打开新 tab。
  - 回到原 tab。
  - Expected: 原 `/eval/tasks/:id` 页面仍停留在当前任务详情，Drawer 状态不被破坏或至少页面未跳走。

- [ ] **trace_id 为空时不打开无效页面**
  - 前置：存在 `trace_id` 为空的实例。
  - 打开实例 Drawer。
  - Expected: 「查看 Trace」按钮 disabled，或点击后提示「该实例尚未生成 Trace」。
  - Expected: 不打开 `/traces?traceId=` 这类无效 URL。

- [ ] **getInstanceTrace 失败时显示错误**
  - 通过无效实例或后端故障让 `GET /api/eval/instances/:id/trace` 失败。
  - 点击「查看 Trace」。
  - Expected: 前端显示错误 toast，不打开新 tab 或新 tab 不指向空 traceId。

---

## 3. Trace 原有行为回归

- [ ] **Trace 列表原有行点击仍可打开 Modal**
  - 打开 `/traces`。
  - 点击 Trace 列表中的一行。
  - Expected: `TraceDetailModal` 打开，行为与改造前一致。

- [ ] **Trace 详情 404 或错误处理仍可用**
  - 打开 `/traces?traceId=不存在的ID`。
  - Expected: Modal 或页面显示既有错误处理，不白屏。

- [ ] **Trace 页面列表加载不被 query 逻辑阻塞**
  - 打开 `/traces?traceId=xxx`。
  - Expected: Modal 自动打开，同时 Trace 列表数据仍正常加载或可在关闭 Modal 后看到。

---

## 4. 跨页面联动与分享

- [ ] **复制深链分享可直达**
  - 复制 `/traces?traceId=xxx` 到新浏览器 tab 或无状态窗口。
  - Expected: 页面直接打开对应 Trace Modal。

- [ ] **浏览器返回行为合理**
  - 从 `/traces?traceId=xxx` 进入并自动清理 URL。
  - 点击浏览器返回。
  - Expected: 不在带 query 与不带 query 的同一页面之间反复跳转；返回到进入 Trace 前的页面或合理历史项。

- [ ] **多个 Trace 深链连续打开**
  - 依次打开 `/traces?traceId=xxx` 和 `/traces?traceId=yyy`。
  - Expected: Modal 内容分别对应 `xxx`、`yyy`，不会复用旧详情状态。

---

## 5. 边界与异常

- [ ] **缺失 traceId 参数**
  - 打开 `/traces`。
  - Expected: 不自动打开 Modal，Trace 列表正常显示。

- [ ] **空 traceId 参数**
  - 打开 `/traces?traceId=`。
  - Expected: 不打开空 ID Modal，页面正常显示列表或合理提示。

- [ ] **URL 中包含其他 query 参数**
  - 打开 `/traces?traceId=xxx&foo=bar`。
  - Expected: 能打开 `xxx` 对应 Modal；清理 query 的行为符合实现约定，不破坏页面稳定性。

- [ ] **弹窗被浏览器拦截时有合理行为**
  - 在浏览器阻止弹窗的设置下点击「查看 Trace」。
  - Expected: 不出现未捕获异常；若浏览器拦截新 tab，页面仍可继续使用。

---

## 6. 交付验收

- [ ] 上述所有检查项通过。
- [ ] `pages/Trace/index.tsx` 的 query 深链逻辑被覆盖。
- [ ] `InstanceDrawer.tsx` 的「查看 Trace」逻辑被覆盖。
- [ ] 浏览器 devtools 无 error/warning。
- [ ] Network 面板无未处理 4xx/5xx。
- [ ] `git status` 干净（本模块代码已 commit）。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4.2.3、§7.3.4、§8.3、§9.2.4、§10.5

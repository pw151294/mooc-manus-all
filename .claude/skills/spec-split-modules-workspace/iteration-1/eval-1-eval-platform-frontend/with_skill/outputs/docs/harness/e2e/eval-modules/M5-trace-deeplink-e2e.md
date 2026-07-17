# M5 Trace 深链模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M5-trace-deeplink-spec.md`
**验证类型**：功能验证（集成层：跨页面联动 + 深链）
**前置**：
- M1、M4 已交付
- 至少 1 个 SUCCEEDED 或 FAILED 实例，且后端 `getInstanceTrace` 能返回有效 trace_id
- 现有 `pages/Trace/` 功能正常（列表、Modal 已可用）
- 浏览器允许 `window.open` 新 tab（关闭弹窗拦截）

---

## 1. 从实例 Drawer 跳转到 Trace 页

- [ ] **终态实例跳转成功**
  - 进入 `/eval/tasks/:id` → 点某 SUCCEEDED 实例行 → Drawer 打开
  - 「查看 Trace」按钮：enable 状态
  - 点击按钮
  - Expected: 新 tab 打开 `/traces?traceId=<trace_id>`；原 Task 详情页保持不变

- [ ] **新 tab 自动打开 Trace 详情 Modal**
  - 在新 tab 中
  - Expected: 页面加载后自动弹出 TraceDetailModal；Modal 内显示 span 树 / 火焰图 / 时间轴

- [ ] **Modal 内容正确**
  - Expected: span 数量、时间范围、根 span 名与后端返回一致；无空白/错误状态

---

## 2. 深链直接访问

- [ ] **URL 分享后直接打开**
  - 复制 `/traces?traceId=<有效 trace_id>` 到新 tab / 新窗口
  - Expected: 页面加载后 Modal 自动打开，与从按钮跳转的效果一致

- [ ] **无 traceId 参数时正常显示 Trace 列表**
  - 访问 `/traces`
  - Expected: 列表正常加载，无 Modal 弹出

---

## 3. 关闭 Modal 后 URL 清理

- [ ] **关闭清理参数**
  - 深链打开 Trace Modal → 点 Modal 右上关闭
  - Expected: 地址栏 URL 变为 `/traces`（`traceId` 参数已移除），Trace 列表页保持正常
  - `history.length` 不增加（`replace: true`）

- [ ] **关闭后刷新不再弹 Modal**
  - 关闭 Modal 后 F5 刷新
  - Expected: Trace 列表加载，无 Modal

---

## 4. 边界与异常

- [ ] **非终态实例按钮 disabled**
  - 找一个 RUNNING 或 PENDING 实例 → 打开 Drawer
  - Expected: 「查看 Trace」按钮 disabled；hover 显示 title/tooltip 说明"实例尚未生成 Trace"

- [ ] **实例已终态但后端无 trace（早期实例）**
  - 前置：构造一个 `getInstanceTrace` 返回 `{ trace_id: null }` 或 404 的实例
  - 点「查看 Trace」
  - Expected: 前端 error toast「该实例尚未生成 Trace」；不打开新 tab

- [ ] **traceId 无效（后端 404）**
  - 深链访问 `/traces?traceId=nonexistent-id`
  - Expected: 列表正常显示；Modal 打开时（或不打开）显示"Trace 不存在"或 error toast；页面不白屏

- [ ] **同一 traceId 多次点击「查看 Trace」**
  - 快速点两次按钮
  - Expected: 打开两个新 tab（浏览器行为）；不引起前端异常

- [ ] **浏览器拦截 window.open**
  - 在浏览器阻止弹窗设置下点击按钮
  - Expected: 无 tab 打开；页面无 JS 错误；理想情况下前端 fallback 用 `<a href target="_blank">`
    形式确保不被拦截（可作为增强，非强制）

---

## 5. 跨页面联动

- [ ] **不同 tab 独立**
  - Tab A：Task 详情页；Tab B：从 A 点按钮打开的 Trace 页
  - 在 Tab B 关闭 Modal
  - Expected: Tab A 不受影响，实例 Drawer 保持打开、轮询继续

- [ ] **原 Trace 列表功能未回归**
  - 打开 `/traces` 无深链参数
  - Expected: 列表、搜索、分页、行点击打开 Modal 等原有功能一切正常，无回归

- [ ] **深链 + 列表操作组合**
  - 深链打开 Modal → 关闭 Modal → 在列表点击别的行
  - Expected: 新 Modal 正常打开；URL 中不再包含之前的 traceId

---

## 6. 空状态 / 加载态

- [ ] **深链加载中显示 loading**
  - 深链访问 `/traces?traceId=xxx`（慢网络）
  - Expected: Modal 首次显示 loading spinner，数据到达后填充

- [ ] **无 span 数据**
  - 前置：找一个有 trace_id 但 span 数据为空的 trace
  - Expected: Modal 内容区显示 antd Empty 或"暂无 span 数据"

---

## 7. 交付验收

- [ ] 上述所有检查项通过
- [ ] `git status` 干净
- [ ] Console 无 error（尤其 useSearchParams 相关）
- [ ] Network 无未处理 4xx/5xx
- [ ] 现有 `pages/Trace/` 完整回归测试通过（列表、Modal、其他入口）
- [ ] 分享 `/traces?traceId=xxx` 给同事可用（浏览器隐身模式验证）

---

**文档版本**：v1.0  |  **拆分自**：父规格 §8.3 / §9.2.3「查看 Trace」/ §9.2.4

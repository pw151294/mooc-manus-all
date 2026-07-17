# M5 Trace 深链与联动模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`  
**模块编号**：M5  
**依赖**：M1（API 函数与路由基座）、M4（InstanceDrawer 与实例详情入口）  
**被依赖**：无

---

## 1. 模块范围

本模块交付评测实例到 Trace 页的跨页面跳转，以及 Trace 页通过 `traceId` query 参数自动打开详情 Modal 的深链能力，使用户可以从评测结果直接定位到对应执行链路，并可分享 Trace 深链。

### 1.1 交付物

- Trace 页面改造：`mooc-manus-web/src/pages/Trace/index.tsx`
  - 读取 URL query 参数 `traceId`
  - 自动打开 `TraceDetailModal`
  - 打开后清理 URL 参数
- 实例详情联动：修改 `mooc-manus-web/src/pages/Eval/TaskDetail/InstanceDrawer.tsx`
  - 「查看 Trace」按钮调用 `getInstanceTrace(instance.id)`
  - 使用 `window.open('/traces?traceId=xxx', '_blank')` 打开 Trace 页
  - `instance.trace_id` 不存在时给出提示或禁用按钮
- 复用 M1：`getInstanceTrace(id)` API 函数
- 复用 M4：实例详情 Drawer 的底部操作区

### 1.2 非目标

- 不重写 Trace 列表页、Trace 表格或 Trace 详情 Modal。
- 不改变 Trace 后端 API。
- 不在评测模块内嵌 Trace 详情内容。
- 不新增独立评测结果页面。
- 不改变浏览器历史策略之外的全局路由行为。

---

## 2. Trace 页面深链设计

### 2.1 `pages/Trace/index.tsx`

改造点：

- 引入 `useSearchParams`。
- 初始化时读取 `searchParams.get('traceId')`。
- 若存在 `traceId`，设置 `modalTraceId`，自动打开 `TraceDetailModal`。
- 打开后调用 `setSearchParams({}, { replace: true })` 清理 URL，避免刷新重复打开。
- 保留 Trace 页原有列表加载逻辑。

**详见父规格 §8.3。**

### 2.2 Modal 行为约束

- `TraceDetailModal` 内部已有 404/错误处理时不重复实现。
- `key={modalTraceId}` 保证不同 traceId 切换时 Modal 状态刷新。
- 用户关闭 Modal 后停留在正常 Trace 列表页。

**详见父规格 §8.3、§9.2.3。**

---

## 3. 评测实例到 Trace 的联动设计

### 3.1 `InstanceDrawer.tsx` 查看 Trace

点击「查看 Trace」时：

1. 若 `instance.trace_id` 为空，提示「该实例尚未生成 Trace」或禁用按钮。
2. 调用 `getInstanceTrace(instance.id)` 获取权威 `trace_id`。
3. 执行 `window.open('/traces?traceId=${trace_id}', '_blank')`。
4. 新 tab 中 Trace 页面自动打开 `TraceDetailModal`。

**详见父规格 §4.2.3、§7.3.4、§8.3。**

### 3.2 跨页面体验

- 打开新 tab，不丢失评测任务详情上下文。
- Trace 页支持复制 URL 分享。
- 关闭 Trace Modal 后，Trace 列表页保持可用。

**详见父规格 §13.2。**

---

## 4. 数据流 / 关键实现细节

```text
InstanceDrawer 点击查看 Trace
  → getInstanceTrace(instance.id)
  → window.open('/traces?traceId=xxx', '_blank')
  → TracePage useSearchParams 读取 traceId
  → setModalTraceId(traceId)
  → TraceDetailModal 自动打开
  → setSearchParams({}, { replace: true }) 清理 URL
```

关键边界：

- `trace_id` 为空时不打开无效页面。
- `getInstanceTrace` 请求失败时展示错误反馈。
- `replace: true` 避免清理 query 参数污染浏览器历史。
- 不影响 Trace 页原有行点击打开详情的行为。

---

## 5. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| Trace 打开方式 | 新 tab + query 参数 | §4.2.3、§13.2 |
| Query 参数名 | `traceId` | §8.3 |
| 自动开详情 | Trace 页读取 query 后设置 `modalTraceId` | §8.3 |
| URL 清理 | 打开后 `replace: true` 清理参数 | §8.3 |
| 错误处理 | Trace Modal 与 request 拦截器沿用既有逻辑 | §8.3、§5.2.3 |

---

## 6. 验证边界

**功能验证**：见 `../../e2e/eval-modules/M5-trace-deeplink-e2e.md`。  
**依赖前置**：M1、M4 已交付；Trace 页面原有功能可用；存在带 `trace_id` 的评测实例。

---

## 7. 交付验收

- [ ] `pages/Trace/index.tsx` 支持 `/traces?traceId=xxx` 自动打开详情 Modal。
- [ ] Trace Modal 打开后清理 URL 参数且不破坏列表页。
- [ ] `InstanceDrawer` 的「查看 Trace」可打开新 tab 并定位到对应 Trace。
- [ ] 无 trace_id、Trace 不存在、请求失败时有可观察反馈。
- [ ] M5 e2e 文档所有检查项通过。
- [ ] 不影响 Trace 页原有列表、过滤、行点击详情能力。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4.2.3、§7.3.4、§8.3、§9.2.4、§10.5

# M5 Trace 深链模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M5
**依赖**：M1（api.getInstanceTrace）、M4（实例 Drawer 底部按钮位）
**被依赖**：无

---

## 1. 模块范围

打通"实例 → Trace"跨页面跳转：在实例 Drawer 内接线「查看 Trace」按钮，改造既有
`pages/Trace/index.tsx` 支持 `?traceId=xxx` 查询参数自动打开 Trace 详情 Modal，
实现深链分享能力。

对应父规格 §8.3、§10.5 Phase 5。

### 1.1 交付物

- 修改 `src/pages/Eval/TaskDetail/InstanceDrawer.tsx`：
  - 「查看 Trace」按钮启用（M4 遗留位）
  - 启用条件：实例 status ∈ {SUCCEEDED, FAILED}（已有 result 且已生成 trace）；
    RUNNING/PENDING 时按钮 disabled
  - 点击逻辑：
    ```typescript
    const { trace_id } = await api.getInstanceTrace(instance.id);
    if (!trace_id) {
      message.error('该实例尚未生成 Trace');
      return;
    }
    window.open(`/traces?traceId=${trace_id}`, '_blank');
    ```
- 修改 `src/pages/Trace/index.tsx`（沿用现有页面，扩展 mount 逻辑）：
  - `useSearchParams()` 读取 `traceId` 查询参数
  - 若存在 → 自动 `fetchTraceDetail(traceId)` + 打开 TraceDetailModal
  - Modal 关闭时清理 URL 参数（`searchParams.delete('traceId')` + `setSearchParams`）
  - Trace 列表本身正常加载，不受深链影响
- （可选）新增一个薄工具函数 `src/utils/deeplink.ts`：
  - `openTrace(traceId: string)`：封装 `window.open`，便于将来复用与测试

### 1.2 非目标

- 不改造 Trace 详情 Modal 内部逻辑（已存在，直接复用）
- 不做 Trace 侧回跳到实例（父规格未定义）
- 不做多 Trace 打开管理（如 tab 组）
- 不做实例内嵌 Trace 视图（父规格 §3.1 明确"结果查看入口内嵌在任务详情页"，Trace 详情走 Trace 页）

---

## 2. 交互设计

### 2.1 实例 Drawer 侧

**详见父规格 §7.3.4、§8.3**

```tsx
<Button
  type="primary"
  disabled={!isTerminal(instance.status)}
  onClick={handleViewTrace}
>
  查看 Trace
</Button>
```

- `isTerminal(status)`：`status === 'SUCCEEDED' || status === 'FAILED'`
- `handleViewTrace`：
  1. 调 `api.getInstanceTrace(instance.id)`
  2. 若 `trace_id` 为空/后端 404 → `message.error('该实例尚未生成 Trace')`
  3. 否则 `window.open('/traces?traceId=' + trace_id, '_blank')`

### 2.2 Trace 页面侧

**详见父规格 §8.3**

```tsx
const [searchParams, setSearchParams] = useSearchParams();
const traceIdFromUrl = searchParams.get('traceId');

useEffect(() => {
  if (!traceIdFromUrl) return;
  (async () => {
    try {
      await fetchTraceDetail(traceIdFromUrl);
      openTraceDetailModal();
    } catch (err) {
      // 拦截器已 toast，此处静默
    }
  })();
}, [traceIdFromUrl]);

const handleModalClose = () => {
  closeTraceDetailModal();
  searchParams.delete('traceId');
  setSearchParams(searchParams, { replace: true });
};
```

**关键点**：
- 不影响原有 Trace 列表加载
- Modal 关闭清理 URL 便于二次分享干净的列表 URL
- 复用现有 TraceDetailModal 组件与 store

---

## 3. 数据流

```
用户在 Task 详情页
  → 点实例 → Drawer 打开
    → 点「查看 Trace」
      → api.getInstanceTrace(instanceId) → { trace_id }
      → window.open('/traces?traceId=xxx', '_blank')
                ↓
新 tab 加载 /traces
  → useSearchParams() 拿到 traceId
  → fetchTraceDetail + 打开 Modal
  → Modal 内部原有 span 树 / 火焰图 / 时间轴渲染
```

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 跳转方式 | `window.open` 新 tab | §8.3、§9.2.3「查看 Trace」 |
| URL 参数 | `?traceId=xxx` | §8.3 |
| 关闭 Modal 清理 URL | 是（replace: true） | §8.3 |
| 按钮启用条件 | 仅终态实例 | §7.3.4 已修正版 |
| 404 处理 | 前端 error toast，不阻塞 UI | §8.3、§5.2.3 |
| Trace 详情 Modal | 复用现有组件，不重写 | §8.3、§附录 C |

---

## 5. 验证边界

**功能验证**：见 `docs/harness/e2e/eval-modules/M5-trace-deeplink-e2e.md`
**技术验证**：
- URL 参数解析正确（`useSearchParams`）
- Modal 关闭后 URL 干净
- 跨 tab 打开无 CORS/权限问题

---

## 6. 交付验收

- [ ] `InstanceDrawer.tsx` 「查看 Trace」按钮启用条件正确
- [ ] `pages/Trace/index.tsx` 深链解析 + Modal 自动打开 + 关闭清理 URL 均正常
- [ ] 现有 Trace 列表页功能未回归
- [ ] E2E 文档所有检查项通过
- [ ] 依赖 M1、M4；不阻塞任何模块

---

**文档版本**：v1.0  |  **拆分自**：父规格 §8.3 / §7.3.4 / §10.5

# M5 Trace 深链规格

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`（§8.3、§7.3.5 底部「查看 Trace」逻辑）
**依赖模块**：M4（InstanceDrawer 已产出、留有「查看 Trace」按钮占位）
**下游模块**：无（收尾模块）

---

## 1. 目标

打通评测平台与 Trace 模块的联动：
1. 改造 `pages/Trace/index.tsx`，支持通过 URL 参数 `?traceId=xxx` 自动打开 TraceDetailModal
2. 完成 `InstanceDrawer` 中「查看 Trace」按钮的具体逻辑

**验收目标**：
- 从实例详情 Drawer 点「查看 Trace」→ 新 tab 打开 Trace 页面 + Modal 自动弹出
- 复制 `/traces?traceId=xxx` URL 到新 tab → Trace Modal 自动打开
- URL 参数被消费后自动清理（避免刷新重复打开）
- trace_id 为空时按钮 disabled，误点显示 warning

---

## 2. 范围

### 2.1 in-scope

| 文件 | 说明 |
|---|---|
| `src/pages/Trace/index.tsx` | 改造：读取 URL `traceId` 自动打开 Modal，然后清理 URL |
| `src/pages/Eval/TaskDetail/InstanceDrawer.tsx` | 补全 `handleViewTrace` 函数（M4 留的占位） |

### 2.2 out-of-scope

- Trace 页面其他改动（Filters、Table、Modal 内部 - 不动）
- 评测结果对比图表（未来扩展，非本模块）

---

## 3. 详细设计

### 3.1 Trace 页面改造（`src/pages/Trace/index.tsx`）

**改造点**（详见父规格 §8.3 完整代码）：

```typescript
import { useSearchParams } from 'react-router-dom';

export default function TracePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [modalTraceId, setModalTraceId] = useState<string | null>(null);
  const fetchTraces = useTraceStore((s) => s.fetchTraces);

  useEffect(() => {
    const urlTraceId = searchParams.get('traceId');
    if (urlTraceId) {
      setModalTraceId(urlTraceId);
      setSearchParams({}, { replace: true });  // 清理 URL 参数
    }
    fetchTraces();
  }, [searchParams, setSearchParams, fetchTraces]);

  return (
    <div style={{ padding: 24 }}>
      <TraceFilters />
      <TraceTable onRowClick={setModalTraceId} />
      <TraceDetailModal
        key={modalTraceId}
        traceId={modalTraceId}
        open={modalTraceId !== null}
        onClose={() => setModalTraceId(null)}
      />
    </div>
  );
}
```

**改动要点**：
1. 新增 `useSearchParams` 读取 URL query `traceId`
2. 有值时立即 `setModalTraceId(urlTraceId)` 打开 Modal
3. 用 `setSearchParams({}, { replace: true })` 清理 URL 参数（避免刷新重复打开、避免影响浏览器历史）
4. `<TraceDetailModal key={modalTraceId}>` 用 key 强制在 traceId 变化时重新挂载（保证内部数据刷新）
5. TraceDetailModal 内部已有 404 / 错误处理，无需额外逻辑

**兼容性**：
- 无 `traceId` query 时行为完全不变（走原 fetchTraces 分支）
- Trace 列表页表格行点击的 Modal 逻辑不受影响

---

### 3.2 InstanceDrawer「查看 Trace」按钮对接（`src/pages/Eval/TaskDetail/InstanceDrawer.tsx`）

**M4 留的占位**：按钮 UI 已存在，disabled 条件 `!instance.trace_id` 已生效。

**本模块补全 handler**（详见父规格 §7.3.5 底部）：

```typescript
const handleViewTrace = async () => {
  if (!instance.trace_id) {
    message.warning('该实例尚未生成 Trace');
    return;
  }
  try {
    const { trace_id } = await getInstanceTrace(instance.id);
    window.open(`/traces?traceId=${trace_id}`, '_blank');
  } catch (err) {
    message.error('无法获取 Trace ID');
  }
};
```

**关键点**：
- 优先使用后端 `getInstanceTrace(instance.id)` 拉最新 trace_id（防止 InstanceView 中 trace_id 已过时）
- 新 tab 打开（`_blank`），保留评测上下文
- 空 trace_id 走 warning 而非 error（属于业务提示，不是错误）
- API 异常走 message.error toast

---

## 4. 跨模块联动流程

**用户视角完整路径**：
1. 用户在 `/eval/tasks/:id` 页面点某个实例 → InstanceDrawer 打开
2. 点底部「查看 Trace」按钮
3. 前端调 `getInstanceTrace(instance.id)` → 后端返回 `{ trace_id: 'abc' }`
4. `window.open('/traces?traceId=abc', '_blank')`
5. 新 tab 加载 Trace 页面
6. Trace 页面 useEffect 读取 URL 参数 → `setModalTraceId('abc')` → Modal 自动弹出
7. Modal 内部调后端拿 trace 详情、渲染 span 树/火焰图
8. URL 参数被清理成 `/traces`，用户关闭 Modal 后回到 Trace 列表页

---

## 5. 与父规格的对齐

- URL 参数命名 `traceId`（camelCase，与 React Router 常见约定一致；不与后端 snake_case 冲突，因为是前端 URL 层）
- 清理 URL 用 `replace: true` 避免污染浏览器历史
- Trace Modal 内部行为完全复用现有实现

---

## 6. 验收标准

见 `M5-trace-deeplink-e2e.md`。核心场景：
- 从 InstanceDrawer 点「查看 Trace」→ 新 tab + Modal 弹出
- 复制 `/traces?traceId=xxx` URL 到新 tab → Modal 弹出
- Modal 关闭后 URL 已被清理成 `/traces`
- trace_id 为空时按钮 disabled，误点（若能触发）显示 warning
- Trace 列表页原行点击行为不受影响

---

**规格版本**：v1.0
**依赖**：M4
**预估工作量**：1 ~ 2 天（改动量小，重点是端到端联调）

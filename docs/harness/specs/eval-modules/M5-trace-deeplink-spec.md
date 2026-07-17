# M5 Trace 深链模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M5
**依赖**：M4（InstanceDrawer 已实现 window.open 跳转）
**被依赖**：无（收尾模块，实现跨页面联动）

---

## 1. 模块范围

改造 Trace 页面支持 URL 深链，让 M4 的 InstanceDrawer 「查看 Trace」跳转能自动打开对应 TraceDetailModal。

### 1.1 交付物

**改造 1 处**：
- `src/pages/Trace/index.tsx` — 增加 `useSearchParams` 读取 `?traceId=` 自动打开 Modal

### 1.2 非目标

- 不改 TraceDetailModal 内部（其已支持 traceId 加载 + 404 处理）
- 不改 M4 的 InstanceDrawer（跳转逻辑已在 M4 内实现）
- 不做 URL 反向同步（关闭 Modal 不改 URL，因为打开时已 replace 掉了）

---

## 2. 改造设计

### 2.1 现有代码（`pages/Trace/index.tsx`）

```tsx
import { useState, useEffect } from 'react';
import { useTraceStore } from '@/store/trace';
import TraceFilters from './TraceFilters';
import TraceTable from './TraceTable';
import TraceDetailModal from './TraceDetailModal';
import './index.css';

export default function TracePage() {
  const [modalTraceId, setModalTraceId] = useState<string | null>(null);
  const fetchTraces = useTraceStore((s) => s.fetchTraces);

  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

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

### 2.2 改造后

```tsx
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTraceStore } from '@/store/trace';
import TraceFilters from './TraceFilters';
import TraceTable from './TraceTable';
import TraceDetailModal from './TraceDetailModal';
import './index.css';

export default function TracePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [modalTraceId, setModalTraceId] = useState<string | null>(null);
  const fetchTraces = useTraceStore((s) => s.fetchTraces);

  useEffect(() => {
    const urlTraceId = searchParams.get('traceId');
    if (urlTraceId) {
      setModalTraceId(urlTraceId);
      // 打开后立即清理 URL 参数，避免刷新重复打开
      setSearchParams({}, { replace: true });
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

### 2.3 改动分析

| 改动点 | 说明 |
|---|---|
| `import useSearchParams` | 从 react-router-dom |
| `const [searchParams, setSearchParams]` | Hook 拿 URL query |
| useEffect 内读 `searchParams.get('traceId')` | 有值就设置 modalTraceId |
| `setSearchParams({}, { replace: true })` | 清空 query，避免刷新页面重新弹 Modal |

**why replace: true**：使用 `replace` 而非 push，浏览器历史不会多出一条 `?traceId=xxx` 记录，用户点返回不会再触发 Modal 打开。

---

## 3. 数据流

### 3.1 从评测跳到 Trace

```
M4 InstanceDrawer 点「查看 Trace」
  → getInstanceTrace(instanceId) → 后端返回 { trace_id }
  → window.open('/traces?traceId=xxx', '_blank')
  → 浏览器新 tab 打开
  → TracePage mount
  → useEffect: searchParams.get('traceId') = 'xxx'
  → setModalTraceId('xxx') → Modal 打开
  → setSearchParams({}, { replace: true }) → URL 清空
  → TraceDetailModal 内部 useEffect 拉 getTraceDetailSafe(xxx)
  → 显示 span 树 / 火焰图
```

### 3.2 直接分享 URL

```
用户复制 /traces?traceId=xxx 给同事
  → 同事打开链接
  → 同 3.1 流程，Modal 自动弹出
```

### 3.3 无效 traceId

```
URL /traces?traceId=invalid
  → Modal 打开尝试 getTraceDetailSafe
  → getTraceDetailSafe 返回 { ok: false, status: 404 }
  → TraceDetailModal 内部显示错误 UI（"Trace 不存在"）
  → 用户可关闭 Modal
```

---

## 4. 关键实现细节

### 4.1 依赖检查

`react-router-dom` 是现有依赖（`router/index.tsx` 已在用），无需新增。

### 4.2 useEffect 依赖数组

```typescript
useEffect(() => {
  const urlTraceId = searchParams.get('traceId');
  if (urlTraceId) {
    setModalTraceId(urlTraceId);
    setSearchParams({}, { replace: true });
  }
  fetchTraces();
}, [searchParams, setSearchParams, fetchTraces]);
```

**风险**：`searchParams` 变化会重跑 effect。但 `setSearchParams({})` 后 `searchParams.get('traceId')` = null，不会重复设置 modalTraceId。fetchTraces 是 zustand 引用稳定的函数，不会导致无限循环。

### 4.3 与 TraceDetailModal 的契约

TraceDetailModal 已支持通过 `traceId` prop 传入并自行 fetch（父规格 §7.3.4 引用；实际参见 `pages/Trace/TraceDetailModal.tsx`）。M5 只需保证：
- prop `traceId` 是 string 或 null
- prop `open` 是 boolean
- prop `onClose` 关闭 Modal

**若 TraceDetailModal 无内部 404 处理**：本模块不做兜底，改在 TraceDetailModal 内部处理（属 Trace 模块的责任，不属评测平台）。

### 4.4 M4 侧的 handleViewTrace

M4 InstanceDrawer 已实现：
```typescript
window.open(`/traces?traceId=${trace_id}`, '_blank');
```

M5 完成后该跳转会自动弹 Modal；M5 未完成时只跳到 Trace 列表页（Modal 不会自动弹）。**M4 交付无需修改，M5 是单向增强**。

---

## 5. 验证边界

**功能验证**：见 `M5-trace-deeplink-e2e.md`
- URL 带 traceId 自动开 Modal
- URL 清空（刷新不重复）
- 无效 traceId 的错误 UI
- 从 M4 InstanceDrawer 跳转联动

**技术验证**：
- Trace 现有功能不回归（列表、过滤、点行开 Modal）
- URL 分享给同事可用

---

## 6. 关键决策（继承父规格）

| 决策点 | 选择 | 依据 |
|---|---|---|
| URL param 命名 | `traceId`（驼峰） | 前端惯例，与 Trace 内部 state 一致 |
| 打开后清理 URL | `replace: true` | 父规格 §8.3；防止刷新重复弹窗 |
| Modal 关闭不改 URL | 是（已在打开时清空） | 简化状态管理 |
| 跳转方式 | window.open 新 tab | 父规格 §7.3.4 决策；保留评测上下文 |

---

## 7. 交付验收

- [ ] `pages/Trace/index.tsx` 已改造
- [ ] E2E 文档全部通过
- [ ] Trace 原有功能不回归
- [ ] M4 → M5 联动正常

---

## 8. 回归清单（Trace 现有功能）

Trace 页面是既有模块，M5 的改动需保证不破坏原有能力：
- [ ] 手动打开 `/traces` 页面 → 列表加载
- [ ] 过滤器（TraceFilters）正常
- [ ] 点表格行 → Modal 弹出（原逻辑）
- [ ] Modal 关闭 → 列表页正常

---

**文档版本**：v1.0  |  **拆分自**：父规格 §8.3

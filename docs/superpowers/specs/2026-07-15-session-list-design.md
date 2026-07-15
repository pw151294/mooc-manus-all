# 会话列表页 + 链路追踪火焰图详情弹窗 设计文档

**日期**：2026-07-15
**状态**：设计评审中
**作者**：Claude (Opus 4.7)
**关联仓库**：mooc-manus-web（本期仅前端，后端 `/api/traces` 与 `/api/trace/:trace_id` 已就绪）
**前置设计**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`（后端 Agent Tracing 落地）

---

## 一、背景与目标

### 1.1 背景

`mooc-manus` 后端已在 2026-07-14 落地 Agent Tracing（参见前置设计），提供两个查询接口：

- `GET /api/traces` — 分页查询 trace 摘要，支持 `conversation_id / agent_name / is_error / start_time_from|to` 过滤
- `GET /api/trace/:trace_id` — 查询完整的 span 树，用于可视化重放

**当前缺口**：前端 `mooc-manus-web` 尚无对应的 UI，用户无法通过界面查看 trace 历史与调用链，排障仍依赖后端日志与直连接口调试。

### 1.2 目标

在 `mooc-manus-web` 新增纯前端页面：

1. **会话列表页 `/traces`**：分页查看 trace 历史，支持全字段筛选
2. **会话详情弹窗**：点击列表行触发，Modal 90vw × 85vh，用**冰锥式火焰图 + 联动 Span 详情面板**展示完整链路

### 1.3 非目标

- 不改后端接口、不改后端数据模型
- 不做火焰图"缩放聚焦"（双击铺满）等重交互
- 不做批量导出、不做 URL 分享（trace_id 不进 URL）
- **不引入任何 npm 新依赖**——火焰图用纯 SVG + 原生事件自绘
- 不做实时刷新（用户手动刷新按钮即可）
- 不做已读/收藏/标签等 CRUD 功能

### 1.4 成功标准

- 用户从菜单进入 `/traces`，5 秒内看到最新一屏 trace 列表
- 点击任意一行，1 秒内（网络理想情况）弹窗打开且火焰图渲染完成
- 火焰图中 `is_error=true` 的 span 一眼可辨（红色边框），点击后 logs Tab 默认展开可看到错误详情
- 支持"筛选出昨天所有 `is_error=true` 的 trace"这类典型排障动作 ≤3 次操作
- `npm run build` / `npm run lint` 全绿；不引入 `any`；不引入未使用依赖

---

## 二、架构与目录结构

### 2.1 与既有代码的边界

- 复用 `src/api/request.ts`（axios 实例，已有响应拦截器）
- 复用 `src/components/Layout/index.tsx` 的菜单机制（新增一个 menu item）
- 复用 `src/router/index.tsx` 的路由注册（新增一个 route）
- 复用技术栈：React 19 / AntD 6.4.5 / Zustand / dayjs / axios / react-router-dom 7
- **不新增外部 npm 依赖**

### 2.2 文件划分

```
mooc-manus-web/src/
├── api/
│   └── modules/
│       └── [NEW] trace.ts             # 封装 GET /api/traces / /api/trace/:id
├── types/
│   └── [NEW] trace.ts                 # 后端 DTO 的 TS 镜像
├── store/
│   └── [NEW] trace.ts                 # Zustand store：列表分页 + 筛选
├── pages/
│   └── Trace/                         # 新目录
│       ├── [NEW] index.tsx            # 会话列表页（对应 /traces 路由）
│       ├── [NEW] TraceFilters.tsx     # 顶部筛选栏（5 项筛选 + 重置 + 查询 + 刷新）
│       ├── [NEW] TraceTable.tsx       # AntD Table + 分页 + 行点击
│       ├── [NEW] TraceDetailModal.tsx # 详情弹窗（拉数据 + 上下分栏编排）
│       ├── [NEW] FlameGraph.tsx       # 纯 SVG 冰锥火焰图
│       ├── [NEW] SpanDetailPanel.tsx  # 联动详情面板（Tabs）
│       └── [NEW] utils.ts             # 工具函数：格式化、颜色、布局
├── router/
│   └── [MOD] index.tsx                # 注册 { path: 'traces', element: <TracePage /> }
└── components/
    └── Layout/
        └── [MOD] index.tsx            # 菜单新增 { key: '/traces', icon: <NodeIndexOutlined />, label: '会话追踪' }
```

### 2.3 组件职责边界

- **`FlameGraph.tsx`**：只负责渲染 + 触发 `onSpanClick`；不感知详情面板存在。
  - 输入：`root: SpanNode`, `selectedSpanId: number | null`, `colorMode: 'type' | 'heat'`, `onSpanClick: (span: SpanNode) => void`
- **`SpanDetailPanel.tsx`**：只负责渲染选中 span 的详情；不感知火焰图。
  - 输入：`span: SpanNode`
- **`TraceDetailModal.tsx`**：唯一持有"当前选中 span"状态；负责调用 `getTraceDetail(traceId)`；编排上下两栏联动
- **`store/trace.ts`**：只管**列表**的分页 + 筛选状态；**不缓存 detail**（详情打开即拉、关闭即弃，避免过期数据）
- **`utils.ts`**：纯函数集合（无 React 依赖），保持可测性

---

## 三、数据流与状态管理

### 3.1 Zustand store（`store/trace.ts`）

```ts
interface TraceListFilters {
  conversationId: string;                     // 空串=不筛选
  agentName: string;                          // 空串=不筛选
  isError: 'all' | 'true' | 'false';          // 三态 Select
  startTimeFrom: number | null;               // Unix ns
  startTimeTo: number | null;                 // Unix ns
}

interface TraceState {
  traces: TraceSummaryDTO[];
  total: number;
  page: number;                                // 1-based
  pageSize: number;                            // 默认 20
  filters: TraceListFilters;
  loading: boolean;

  fetchTraces: () => Promise<void>;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (patch: Partial<TraceListFilters>) => void;
  resetFilters: () => void;
}
```

### 3.2 关键行为约定

- `setFilters` **只更新 filters，不自动 fetch**（避免用户在多个输入框之间打字触发 N 次请求）。由列表页组件在"点击查询按钮"或"输入框 Enter"时显式调用 `fetchTraces`
- `setPage / setPageSize` **自动触发 `fetchTraces`**（用户操作分页器后期望立即刷新）
- `resetFilters` 把 filters 恢复默认 + page 回到 1 + 触发一次 `fetchTraces`
- **筛选参数与后端契约的映射**（在 `api/modules/trace.ts` 里做）：
  - `conversationId / agentName` 空串 → 不传该 query 参数
  - `isError = 'all'` → 不传；`'true'` → 传 `is_error=true`；`'false'` → 传 `is_error=false`
  - `startTimeFrom/To` null → 不传；有值 → 直接传纳秒整数（后端契约就是 ns）
- **时间单位换算**：AntD `RangePicker` 给的是 `Dayjs` 对象（毫秒精度），转纳秒时 `dayjs.valueOf() * 1_000_000`；后端返回的 `start_time` 是纳秒，前端渲染时 `dayjs(ns / 1_000_000).format(...)`

### 3.3 详情弹窗局部状态

```ts
// TraceDetailModal.tsx 内部
const [detail, setDetail] = useState<TraceDetailDTO | null>(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState<'not_found' | 'server' | null>(null);
const [selectedSpanId, setSelectedSpanId] = useState<number | null>(null);
const [colorMode, setColorMode] = useState<'type' | 'heat'>('type');
```

- Modal `open` 变 `true` 时，`useEffect` 调用 `getTraceDetail(traceId)`；返回后设置 `detail`，同时**默认选中 root span**（`selectedSpanId = 0`）以便下方面板立即有内容
- Modal 关闭时清空所有局部状态；下次打开重新拉（不缓存）
- HTTP 404 → `error='not_found'`；HTTP 5xx → `error='server'`；渲染时对应显示 `<Result>` 组件

### 3.4 数据流序列

```
[入口]
  用户点击菜单 /traces
       ↓
  TracePage mount → useEffect → store.fetchTraces()
       ↓
  GET /api/traces?page=1&page_size=20 → store.traces / total
       ↓
  Table 渲染

[筛选]
  用户填筛选项 → TraceFilters 组件本地受控 → 点"查询"按钮
       ↓
  store.setFilters(patch) → store.setPage(1) → 自动 fetchTraces

[翻页]
  用户点分页 → AntD Pagination onChange → store.setPage(n) → 自动 fetchTraces

[详情]
  用户点行 → TraceTable onRow.onClick → 父组件 setModalTraceId(row.trace_id)
       ↓
  TraceDetailModal mount + open=true → useEffect → getTraceDetail(traceId)
       ↓
  detail 状态就绪 → 上下分栏渲染：
    - FlameGraph 拿 detail.root 布局
    - SpanDetailPanel 拿 findSpanById(detail.root, selectedSpanId=0) 渲染
       ↓
  用户点火焰图某 span → onSpanClick(span) → setSelectedSpanId(span.span_id)
       ↓
  SpanDetailPanel 重渲染新 span 的详情

[关闭]
  用户按 ESC / 点关闭 → Modal onCancel → 父组件 setState({modalTraceId: null})
  → Modal destroyOnClose 卸载子组件 → useEffect cleanup 里 abort 未完成的 fetch
```

### 3.5 并发与竞态

- **列表页 fetchTraces**：用户快速切页或反复点查询时，若前一请求未回来又发起新请求，后端返回顺序可能倒挂。用 `AbortController`——`store.fetchTraces` 每次调用先 abort 上一个 in-flight 请求（在 store 内维护一个 `abortRef`）
- **详情弹窗 getTraceDetail**：Modal 关闭时 abort 未完成的请求，防止 setState on unmounted component
- 分页参数校验：`page < 1` 视为 1；`pageSize` 允许 `[10, 20, 50, 100]` 四档，超范围强制 20（对齐后端 `pageSize > 100` 强制 20 的行为）

### 3.6 空态 & 错误态

| 场景 | 呈现 |
|---|---|
| 列表加载中 | Table `loading={true}`（AntD 内置转圈） |
| 列表返回 0 条 | Table 内置 `Empty` "暂无数据"，筛选栏保留 |
| 列表 HTTP 错误 | `request.ts` 拦截器自动 `message.error`，Table 保留上一次结果 |
| 详情加载中 | Modal 内容区 `<Spin size="large" />` |
| 详情 404 | Modal 内容区 `<Result status="404" title="Trace 不存在" />` |
| 详情 5xx | Modal 内容区 `<Result status="500" title="加载失败" extra={<Button>重试</Button>} />` |
| 详情返回空树 | 理论上不会（后端 404 保底），若真发生 → `<Empty description="Trace 无 Span 数据" />` |

---

## 四、会话列表页 UI

### 4.1 页面布局

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 24px padding                                                             │
│ ┌─ TraceFilters ───────────────────────────────────────────────────────┐│
│ │ [Conversation ID] [Agent] [状态 Select] [时间范围 RangePicker]        ││
│ │                                            [重置] [查询] [🔄 刷新]    ││
│ └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│ ┌─ TraceTable ────────────────────────────────────────────────────────┐│
│ │ 状态 │ 开始时间 │ Agent │ 用户 Query 预览 │ 耗时 │ Span 数           ││
│ ├──────┼──────────┼───────┼─────────────────┼──────┼───────────────────┤│
│ │  ✅  │  ...     │ ...   │ ...             │ ...  │ ...               ││
│ │  ❌  │  ...     │ ...   │ ...             │ ...  │ ...               ││
│ │                              [Pagination]                             ││
│ └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

外层 `<div style={{ padding: 24 }}>`（对齐既有 `pages/Tool/Functions.tsx`）。

### 4.2 筛选栏 `TraceFilters.tsx`

| 控件 | AntD 组件 | 属性 | 备注 |
|---|---|---|---|
| Conversation ID | `Input` | `placeholder="按 conversation_id 精确筛选"`, `allowClear`, `onPressEnter=触发查询`, `width: 240px` | 后端等值匹配 |
| Agent 名称 | `Input` | `placeholder="按 agent_name 精确筛选"`, `allowClear`, `onPressEnter=触发查询`, `width: 240px` | 后端等值匹配 |
| 状态 | `Select` | 三态：`{全部, 仅失败, 仅成功}`, `style={{ width: 120 }}` | value: `all` / `true` / `false` |
| 时间范围 | `DatePicker.RangePicker` | `showTime`, `format="YYYY-MM-DD HH:mm:ss"`, `allowClear`, `presets=[最近 1 小时/最近 24 小时/最近 7 天]` | AntD 6 的 `presets` prop |
| 重置 | `Button` | `onClick=store.resetFilters` | 默认按钮 |
| 查询 | `Button` type="primary" | `icon={<SearchOutlined />}`, `onClick=applyFilters+fetch` | 主色 |
| 刷新 | `Button` | `icon={<ReloadOutlined />}`, `onClick=fetchTraces`, `loading={store.loading}` | 只重放当前 filters+page |

**布局**：AntD `Space` + `wrap`，让筛选栏在窄屏优雅换行。

**内部状态**：TraceFilters 用受控 hook 维护"用户正在编辑但未提交"的临时值，点"查询"按钮时才把临时值提交到 store（避免每按一个键就触发 store 更新 + 请求）。空串/null 视为"不筛选"。

### 4.3 Table `TraceTable.tsx`

**列定义**（严格 6 列）：

| 列 | 数据源 | 宽度 | 渲染 |
|---|---|---|---|
| 状态 | `is_error` | `80px`（居中） | `is_error=true` → 红色 `<CloseCircleFilled />`；否则绿色 `<CheckCircleFilled />`；均带 `title` |
| 开始时间 | `start_time`(ns) | `200px` | `dayjs(ns/1e6).format('YYYY-MM-DD HH:mm:ss.SSS')`，浏览器本地时区 |
| Agent | `agent_name` | `160px` | 直接文本；空显示灰色 `"--"` |
| 用户 Query 预览 | `user_query_preview` | 自适应（剩余） | 单行 `text-overflow: ellipsis`，悬浮 `Tooltip` 显示全文；空显示灰色 `"--"` |
| 耗时 | `duration_ms` | `120px`（右对齐） | `formatDuration(ms)`：`< 1000` → `123ms`；`< 60000` → `1.23s`；否则 `1.23min` |
| Span 数 | `span_count` | `100px`（右对齐） | 数字；`≥ 50` 加 `<Tag color="orange">50</Tag>` 提示 |

**行行为**：

- `onRow={(row) => ({ onClick: () => setModalTraceId(row.trace_id) })}`
- 鼠标 hover 全行 `cursor: pointer`
- `is_error=true` 的行整行浅红色高亮：`rowClassName={(row) => row.is_error ? 'trace-row-error' : ''}`；CSS 定义在 `pages/Trace/index.tsx` 顶部：`.trace-row-error > td { background: #fff2f0 !important; }`
- **默认排序**：依赖后端返回顺序为 `start_time DESC`（e2e 中验证）
- **rowKey**：`"trace_id"`
- **size**：`"middle"`（对齐既有页面）

**分页**：

- 使用 AntD Table 自带 `pagination` prop
- `pagination={{ current: page, pageSize, total, showSizeChanger: true, pageSizeOptions: ['10','20','50','100'], showTotal: (t) => \`共 ${t} 条\` }}`
- `onChange={(p) => { store.setPage(p.current); store.setPageSize(p.pageSize); }}`

**关键交互细节**：

- 用户 Query 预览用 `<Typography.Text ellipsis={{ tooltip: preview }}>`，AntD 内置"未截断不显示 tooltip"
- 空 `agent_name / user_query_preview` 用 `"--"` 而非空白

### 4.4 父组件 `pages/Trace/index.tsx` 骨架

```tsx
export default function TracePage() {
  const [modalTraceId, setModalTraceId] = useState<string | null>(null);
  const fetchTraces = useTraceStore((s) => s.fetchTraces);

  useEffect(() => { fetchTraces(); }, [fetchTraces]);

  return (
    <div style={{ padding: 24 }}>
      <TraceFilters />
      <TraceTable onRowClick={setModalTraceId} />
      <TraceDetailModal
        traceId={modalTraceId}
        open={modalTraceId !== null}
        onClose={() => setModalTraceId(null)}
      />
    </div>
  );
}
```

---

## 五、详情弹窗与火焰图

### 5.1 弹窗整体布局 `TraceDetailModal.tsx`

```
┌─ Modal（title="链路详情" + trace_id 徽章 + 复制按钮） ────────────────┐
│ 90vw × 85vh, footer=null, destroyOnClose                             │
│ ┌─ 顶部元信息条（固定高度 48px） ─────────────────────────────────┐ │
│ │ trace_id: ... (复制) │ conversation_id: ... │ agent: ...          │ │
│ │ 开始时间: ... │ 耗时: 1.23s │ span 数: 42 │ 状态: ❌ 失败          │ │
│ │                                    [🎨 类型模式|热度模式切换]      │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌─ 火焰图区（约 40% 剩余高度） ────────────────────────────────────┐ │
│ │ 时间轴刻度（顶部 20px）                                           │ │
│ │ 冰锥式 SVG（root 在顶，子 span 向下堆叠）                          │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌─ Span 详情面板（60% 剩余高度，滚动） ───────────────────────────┐ │
│ │ [Tabs: 概要 | 完整 Tags | Logs | 原始 JSON]                       │ │
│ └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

- Modal props：`width="90vw"`, `styles={{ body: { height: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}`, `footer={null}`, `destroyOnClose`
- 上下两栏用 CSS `flex: 4` / `flex: 6` 分配剩余高度
- 顶部元信息条：加载中显示 `<Spin size="large" />` 占位
- 右上"颜色模式切换"：`<Radio.Group value={colorMode} onChange size="small">` 两选一

### 5.2 火焰图组件 `FlameGraph.tsx`

**接口**：

```ts
interface FlameGraphProps {
  root: SpanNode;
  selectedSpanId: number | null;
  colorMode: 'type' | 'heat';
  onSpanClick: (span: SpanNode) => void;
}
```

**布局算法**（纯计算函数）

将树形 `SpanNode` 扁平化成矩形列表 `{ span, x, y, width, height }`：

1. **横向映射**：根 span 的 `[start_time, end_time]` 映射到 SVG 宽度 `[0, W]`（`W = 容器 clientWidth - 32px 边距`）。每个 span 的 `x = (span.start_time - root.start_time) / rootDuration * W`，`width` 同理。**最小宽度强制 2px**（若 `width < 2` 取 2）
2. **纵向映射**：每层深度固定 `ROW_HEIGHT = 22px`。root 在 `y = 0`，子在 `y = ROW_HEIGHT`，依次递归。SVG 总高 = `maxDepth * ROW_HEIGHT + 2px 边距`
3. **子 span 排序**：按 `start_time` 升序（后端未保证 children 顺序，前端 layout 时排一次）
4. **除零保护**：`rootDuration = Math.max(root.end_time - root.start_time, 1)`

**颜色映射**（`utils.ts` 的 `colorFor(span, mode, rootLatency)`）：

- `mode='type'`：
  - `AGENT_ROOT` → `#8c8c8c`（灰）
  - `AGENT_ROUND` → `#1677ff`（蓝）
  - `LLM_CALL` → `#722ed1`（紫）
  - `TOOL_BATCH` → `#fa8c16`（深橙）
  - `TOOL_CALL` → `#13c2c2`（青）
  - `SUBAGENT_CALL` → `#52c41a`（绿）
  - 未知类型 → `#bfbfbf`
- `mode='heat'`：以 `latency_ms` 归一化到 `[0, rootLatency]`，映射到 HSL 色相 `210°（冷蓝）→ 0°（暖红）`：`hsl(${210 - 210 * ratio}, 70%, 55%)`
- **错误 span 通用规则**：无论何种 mode，`is_error=true` 时矩形加 `stroke="#f5222d"` 红边框 + `stroke-width="2"`；选中态叠加黑色内描边

**顶部时间轴刻度**：

- 独立 SVG 组件（在 FlameGraph 内实现），高度 20px
- 从 0 到根 span `duration_ms` 均分 5 段（`0 / 25% / 50% / 75% / 100%`），每档标注相对偏移毫秒数
- 用 `formatDuration(offsetMs)` 统一格式

**span 矩形内文本**：

- 文本内容：`${operationName} ${formatDuration(latencyMs)}`
- 渲染条件：`width >= 60px` 显示完整；`30px <= width < 60px` 只显示 `operationName` 截断到 8 字符；`width < 30px` 完全不渲染
- SVG `<text>` 的 `dominant-baseline="middle"`，`x = rect.x + 4`, `y = rect.y + rect.height/2`，字号 11px，色白色，`pointer-events="none"` 避免抢事件

**交互**：

- **悬浮**：矩形 `onMouseEnter` 更新 `hoverSpan` 状态；用绝对定位浮层显示 tooltip（AntD Tooltip 在 SVG 元素上表现不佳），跟随 `mousemove` 更新位置：
  ```
  AGENT_ROUND · round.iterate
  耗时: 1.23s
  起始: +0ms
  Span ID: 5, Parent: 0
  [有错误]
  ```
- **点击**：矩形 `onClick={() => onSpanClick(span)}`；选中矩形加 `stroke="#000" stroke-width="2"` 内描边
- **点击空白区域**：不清空选中（保持当前 span 详情可见）

**性能与响应式**：

- 单次会话典型 span 数 20-100（≤500），SVG 直接渲染无压力，不需要 canvas 或虚拟化
- 首次渲染在 `useLayoutEffect` 里读取容器 `clientWidth`；监听 `ResizeObserver` 在窗口/Modal 尺寸变化时重算布局

**无障碍**：

- 火焰图矩形 `<rect tabIndex={0} role="button" aria-label="${operationName} ${duration}">`
- `Enter/Space` 键触发点击（SVG `<rect>` 上通过 `onKeyDown` 实现）

### 5.3 Span 详情面板 `SpanDetailPanel.tsx`

**接口**：

```ts
interface SpanDetailPanelProps {
  span: SpanNode;
}
```

**Tabs 结构**：`<Tabs>` 4 个 Tab，`defaultActiveKey` 由 `span.is_error` 决定：错误 span → `'logs'`；否则 → `'summary'`

#### Tab 1：概要（按 span_type 定制）

用 AntD `<Descriptions column={2} bordered size="small">`。

**固定字段**（所有类型都有）：Span ID / Span Type Tag / Operation Name / 耗时 / 起始偏移 / 错误状态。

**类型定制字段**（从 `span.tags` 里挑对应 key 渲染）：

| span_type | 优先展示的 tags 键 |
|---|---|
| `AGENT_ROOT` | `user.query` / `conversation_id` / `agent.name` / `message.id` |
| `AGENT_ROUND` | `round.index` / `round.iterate_count` |
| `LLM_CALL` | `llm.model` / `llm.prompt_hash` / `llm.tokens.prompt` / `llm.tokens.completion` / `llm.tokens.total` |
| `TOOL_BATCH` | `tool.batch.size` / `tool.batch.concurrent` |
| `TOOL_CALL` | `tool.name` / `tool.provider` / `tool.arguments` / `tool.result_preview` / `tool.result_size` |
| `SUBAGENT_CALL` | `subagent.name` / `subagent.trace_id` |

- **实现方式**：`utils.ts` 里一个 `SPAN_TYPE_TAG_MAP: Record<SpanType, string[]>`，`SpanDetailPanel` 按顺序遍历，`span.tags[key]` 有值就渲染一行；无值跳过
- **未在映射表里的其他 tags** 不在概要 Tab 展示（避免噪声），完整版去"完整 Tags" Tab
- **长值折叠**：单个 tag value 是字符串且长度 > 500 时用 `<Typography.Paragraph ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}>`；对象类型用 `<pre>` 显示 `JSON.stringify(value, null, 2)`

#### Tab 2：完整 Tags

- `<Descriptions column={1} bordered size="small">` 展示 `span.tags` 的**所有键值对**，按 key 字母序排序
- value 按类型渲染：
  - `string` → `<Typography.Text copyable ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>`
  - `number/boolean` → 直接 `String(v)`
  - `object/array` → `<pre style={{ maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(v, null, 2)}</pre>` + 复制按钮
- **敏感字段处理**：value === `"***"` 时加 `<Tag color="warning">已打码</Tag>`（后端已打码，前端仅视觉标注）

#### Tab 3：Logs

- `<Timeline mode="left">`
- 每个 `LogEntry` 一个 `<Timeline.Item>`：
  - **颜色**按 level：`error`→红、`warn`→橙、`info`→蓝、`debug`→灰
  - **label**（左侧）：`dayjs(log.ts/1e6).format('HH:mm:ss.SSS')`
  - **内容**：`<strong>{log.msg}</strong>` + 若有 `log.extra` 就下面折叠一个 `<Collapse ghost>` 展开 `<pre>{JSON.stringify(log.extra, null, 2)}</pre>`
- 空 logs 展示 `<Empty description="无日志" />`

#### Tab 4：原始 JSON

- `<Typography.Paragraph copyable={{ text: JSON.stringify(spanWithoutChildren, null, 2) }}>` 提供顶部复制按钮
- 下方 `<pre style={{ maxHeight: '100%', overflow: 'auto', background: '#fafafa', padding: 12, fontSize: 12 }}>{JSON.stringify(spanWithoutChildren, null, 2)}</pre>`
- **注意**：显示的是**选中 span 的**完整 JSON，**不包含 children**（避免嵌套过深）。要看子 span 请在火焰图上点击

### 5.4 辅助函数 `pages/Trace/utils.ts`

```ts
export function formatDuration(ms: number): string;                                        // 123ms / 1.23s / 1.23min
export function formatTimestamp(ns: number): string;                                       // 'YYYY-MM-DD HH:mm:ss.SSS' 本地时区
export function colorFor(span: SpanNode, mode: 'type' | 'heat', rootLatency: number): string;
export function flattenLayout(root: SpanNode, width: number): FlameRect[];                 // 布局主函数
export function findSpanById(root: SpanNode, id: number): SpanNode | null;                 // selectedSpan lookup
export const SPAN_TYPE_TAG_MAP: Record<string, string[]>;
export const SPAN_TYPE_COLOR: Record<string, string>;
```

- **`flattenLayout` 是核心**：递归遍历树，返回按渲染顺序（root 先，DFS 前序）的 `FlameRect[]`，保证 React `.map` 的 z-order 稳定

---

## 六、错误处理矩阵

| 场景 | 后端表现 | 前端处理 | 用户可见 |
|---|---|---|---|
| `/api/traces` 参数错误 | `400 { code:"INVALID_PARAM", message }` | 拦截器 `message.error(data.message ?? "请求参数错误")` | AntD 顶部红色 toast，表格保留上一次数据 |
| `/api/traces` 网络失败 | 无响应 | 拦截器 `message.error("网络连接失败")` | 顶部红色 toast |
| `/api/traces` 5xx | `500 { code:"INTERNAL_ERROR" }` | 拦截器 `message.error("服务器错误")` | 顶部红色 toast，表格清空 loading |
| `/api/traces` 空结果 | `200 { total:0, traces:[] }` | Table 展示内置空态 | "暂无数据" |
| `/api/traces` 请求竞态 | 慢请求晚到 | `AbortController` 取消上一个 in-flight | 用户只看到最新请求结果 |
| `/api/trace/:id` 404 | `404 { code:"TRACE_NOT_FOUND" }` | Modal 内 `<Result status="404" title="Trace 不存在">` | 弹窗内明显提示，不弹 toast |
| `/api/trace/:id` 5xx | `500` | Modal 内 `<Result status="500" title="加载失败" extra={<Button onClick=retry>重试</Button>} />` | 弹窗内可重试 |
| `/api/trace/:id` 返回空 root | 理论不会 | Modal 内 `<Empty description="Trace 无 Span 数据" />` | 弹窗内空态 |
| Modal 加载中用户关闭 | — | `AbortController.abort()` | 无副作用 |
| Span 树深度极端（>20） | — | 火焰图纵向 `overflow-y:auto` 滚动 | 弹窗内可滚动 |
| trace 总时长为 0 | — | 除零保护：`rootDuration = max(dur, 1)`；span `width = 2px 最小值` | 火焰图退化为等宽条 |

**局部拦截器豁免**：`getTraceDetail` 内部通过 `{ validateStatus: () => true }` 或 try/catch 包装，避免 `request.ts` 拦截器对 404 也弹 toast（用户已看到 Modal 内 Result 组件，toast 是多余的）。具体做法：包装一层 `getTraceDetailSafe` 函数，返回结构化结果 `{ ok: boolean, data?, status? }`。

---

## 七、验收标准（Definition of Done）

### 7.1 功能层

| # | 验收项 |
|---|---|
| 1 | 从左侧菜单可进入"会话追踪"页，页面顶部有筛选栏 + 表格 + 分页 |
| 2 | 页面加载完成时自动请求 `/api/traces?page=1&page_size=20`，展示最新一屏 trace 列表 |
| 3 | 可通过 conversation_id / agent_name 输入框（Enter 或点"查询"）触发筛选查询 |
| 4 | "状态" Select 三态可切换（全部/仅失败/仅成功），点"查询"生效 |
| 5 | 时间范围 RangePicker 支持"最近 1h / 24h / 7d"三个预设 + 自定义 |
| 6 | "重置"按钮清空所有筛选 + 分页回 1 + 重新查询 |
| 7 | 分页器可翻页、切换每页大小（10/20/50/100） |
| 8 | `is_error=true` 的行整行浅红色高亮 |
| 9 | 状态图标：绿色 ✅ / 红色 ❌，带 `title` |
| 10 | 用户 Query 预览列超长省略号，悬浮 Tooltip 显示全文 |
| 11 | 耗时按量级智能格式化（ms / s / min） |
| 12 | 点击任意一行打开详情 Modal（90vw × 85vh） |
| 13 | Modal 顶部展示 trace 元信息条 + trace_id 复制按钮 + 颜色模式切换 |
| 14 | Modal 中间火焰图为冰锥式（根在顶），顶部有时间轴刻度 |
| 15 | 火焰图 span 按类型着色，`is_error=true` 有红色边框 |
| 16 | 颜色模式切到"热度"后按 latency 冷→热渐变 |
| 17 | 悬浮 span 显示 Tooltip（operation_name / 耗时 / 起始偏移 / span_id / 错误标记） |
| 18 | 点击 span 联动下方详情面板刷新 |
| 19 | 面板 4 个 Tab：概要（按 span_type 定制）/ 完整 Tags / Logs / 原始 JSON |
| 20 | 错误 span 打开时默认停在 Logs Tab |
| 21 | 完整 Tags 中 value === `"***"` 显示"已打码" Tag |
| 22 | 长文本字段可展开/折叠 |
| 23 | Modal 关闭时正在拉数据的 `/api/trace/:id` 请求被 abort |
| 24 | 详情 404 显示 `<Result status="404">`，5xx 显示带重试按钮的 `<Result status="500">` |
| 25 | ESC 键关闭 Modal（AntD Modal 默认） |

### 7.2 代码质量层

| # | 验收项 |
|---|---|
| 26 | `npm run build` 通过，无 TypeScript 错误 |
| 27 | `npm run lint` 通过，无新增 warning |
| 28 | `npm run format` 无 diff |
| 29 | **不引入任何新 npm 依赖**（`package.json` 无 diff） |
| 30 | 不使用 `any` 类型（`tags: Record<string, unknown>` 而非 `Record<string, any>`） |
| 31 | 不写多行注释块、不写宽泛 docstring（对齐 CLAUDE.md 风格） |
| 32 | 新增文件均在 `src/pages/Trace/` / `src/api/modules/trace.ts` / `src/store/trace.ts` / `src/types/trace.ts` |
| 33 | 只修改 `src/router/index.tsx` 和 `src/components/Layout/index.tsx` 两个既有文件，diff 最小化 |

### 7.3 契约层

| # | 验收项 |
|---|---|
| 34 | 前端 `TraceSummaryDTO / TraceDetailDTO / SpanNode / LogEntry` 与后端 Go DTO 字段严格一一对应（含 json tag 名） |
| 35 | 敏感字段（api_key / token / password / secret / authorization）后端已打码为 `"***"`，前端保证不再解码或转义 |

---

## 八、风险与假设

### 8.1 假设

- **A1**：后端 `/api/traces` 返回顺序默认为 `start_time DESC`。若后端未保证，e2e 中会明确验证；若不保证，前端也不做二次排序（会引入分页错位）
- **A2**：后端 `SpanNode.start_time / end_time` 单位为纳秒，`duration_ms / latency_ms` 单位为毫秒（与 `dto.go` 一致，已核实）
- **A3**：单次 trace span 数量 <500，深度 <20（Agent 迭代次数上限 + 工具调用广度约束下的合理值）
- **A4**：后端 `agent_name / user_query_preview / conversation_id` 可能为空字符串，前端渲染 `--`
- **A5**：本次不涉及 SSE，不受父仓 R-20-contracts 约束

### 8.2 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 纯 SVG 火焰图在极端 span 数（>1000）下卡顿 | 中 | 本期不做虚拟化（YAGNI），标注"未来扩展点"。span 数 <500 时无问题 |
| `tags` 里对象/数组类型未事先约定 | 低 | `SpanDetailPanel` 对未知类型统一走 `JSON.stringify` 兜底，永不 crash |
| 不同浏览器 SVG `<text>` 字体度量差异 | 低 | 本期不做像素级完美文字截断，用宽度分档粗略隐藏文字 |
| AntD 6 的 `Modal.styles.body` API | 低 | 项目 antd 版本已锁定 6.4.5，按 6.x 文档实现 |
| 时区显示歧义 | 低 | 一律用浏览器本地时区，Tooltip 里可加 UTC 时区提示（本期不做） |
| 火焰图矩形宽度精度累计误差 | 极低 | 布局算法浮点计算，最后 `Math.round` 落到像素 |
| root 时长为 0 时除零 | 低 | `flattenLayout` 内 `Math.max(rootDuration, 1)` 保底 |

### 8.3 依赖

- **不新增外部依赖**（严格约束）
- 复用：`react 19` / `antd 6.4.5` / `@ant-design/icons` / `dayjs` / `axios` / `zustand` / `react-router-dom 7` / `lodash-es`

---

## 九、未来扩展点（本期不做）

- span 数 >500 时的虚拟化火焰图
- URL 中带 traceId 实现分享（`/traces/:traceId?` 可选参数）
- 详情弹窗支持"上一条/下一条 trace"快捷键切换
- 客户端筛选（按 span_type 过滤火焰图显示的 span）
- LLM prompt hash 反查
- 深色模式
- 火焰图"缩放聚焦"（双击铺满时间轴）

---

## 十、参考

- 前置设计：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
- 后端 DTO：`mooc-manus/internal/applications/dtos/trace.go`
- 后端 Handler：`mooc-manus/api/handlers/trace.go`
- 后端 SpanNode：`mooc-manus/internal/domains/models/tracing/tree.go`
- 前端现有范式：`mooc-manus-web/src/pages/Tool/Functions.tsx` + `src/store/tool.ts`
- 前端契约：父仓 `.harness/rules/20-cross-repo-contracts.md`（本设计仅使用 REST，不涉及 SSE 契约）


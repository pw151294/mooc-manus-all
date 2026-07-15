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

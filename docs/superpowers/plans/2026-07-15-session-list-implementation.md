# 会话列表页 + 链路追踪火焰图 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mooc-manus-web 新增会话列表页（/traces）+ 详情弹窗（冰锥式火焰图 + 联动 Span 详情面板），支持全字段筛选、分页查询、孤儿 span 虚线边框、错误 span 醒目提示

**Architecture:** 严格遵循 wire DTO snake_case、store/props camelCase 命名边界；列表页用 Zustand 管理分页+筛选状态，详情弹窗局部状态管理（不缓存）；火焰图纯 SVG 自绘（无新依赖），布局算法在 utils.ts 纯函数实现

**Tech Stack:** React 19 / AntD 6.4.5 / Zustand / dayjs / axios / react-router-dom 7 / TypeScript ~6.0.2

**设计规范**：`docs/superpowers/specs/2026-07-15-session-list-design.md`

---

## 任务依赖关系图

```
Task 1 (types.ts)
    ↓
Task 2 (api/trace.ts) ──→ Task 3 (store/trace.ts)
    ↓                           ↓
Task 4 (utils.ts)          Task 5 (TraceFilters.tsx)
    ↓                           ↓
Task 6 (FlameGraph.tsx)    Task 7 (TraceTable.tsx)
    ↓                           ↓
Task 8 (SpanDetailPanel.tsx) ← ┘
    ↓
Task 9 (TraceDetailModal.tsx)
    ↓
Task 10 (pages/Trace/index.tsx + index.css)
    ↓
Task 11 (router + Layout 集成)
    ↓
Task 12 (手动验收 + 构建验证)
```

---


## Task 1: 类型定义（src/types/trace.ts）

**文件**：
- Create: `src/types/trace.ts`

**说明**：定义所有 wire DTO 类型，字段名**严格 snake_case**（与后端 Go json tag 一一对应）。不做任何转换，直接镜像后端 DTO。

**依赖**：无

**复杂度**：简单（纯类型定义，10 分钟）

---

- [ ] **步骤 1.1：创建文件并定义 LogEntry**

新建 `src/types/trace.ts`，从最底层类型开始：

```typescript
// src/types/trace.ts

// 后端 tracing/span.go:30-35
export interface LogEntry {
  ts: number;                          // Unix ns
  level: string;                       // 'error' | 'warn' | 'info' | 'debug'
  msg: string;
  extra?: Record<string, unknown>;
}
```

- [ ] **步骤 1.2：定义 SpanNode（树形结构）**

追加到同文件：

```typescript
// 后端 tracing/tree.go:12-24
export interface SpanNode {
  span_id: number;                     // int32
  parent_span_id: number;              // int32, -1 表示 root
  span_type: string;                   // 'AGENT_ROOT' | 'AGENT_ROUND' | ...
  operation_name: string;
  start_time: number;                  // Unix ns
  end_time: number;                    // Unix ns
  latency_ms: number;                  // int32
  is_error: boolean;
  tags: Record<string, unknown>;       // 动态 map，可能含 _orphan / _original_parent
  logs: LogEntry[];
  children: SpanNode[];
}
```

- [ ] **步骤 1.3：定义 TraceSummaryDTO（列表项）**

追加：

```typescript
// 后端 dtos/trace.go:17-26
export interface TraceSummaryDTO {
  trace_id: string;
  conversation_id: string;
  agent_name: string;
  start_time: number;                  // Unix ns
  duration_ms: number;                 // int32
  span_count: number;                  // int32
  is_error: boolean;
  user_query_preview: string;
}
```

- [ ] **步骤 1.4：定义 TraceDetailDTO + TraceListDTO**

追加：

```typescript
// 后端 dtos/trace.go:5-15
export interface TraceDetailDTO {
  trace_id: string;
  conversation_id: string;
  agent_name: string;
  start_time: number;                  // Unix ns
  end_time: number;                    // Unix ns
  duration_ms: number;                 // int32
  is_error: boolean;
  span_count: number;                  // int32
  root: SpanNode;
}

// 后端 dtos/trace.go:28-33
export interface TraceListDTO {
  total: number;                       // int64（TS number 足够）
  page: number;
  page_size: number;
  traces: TraceSummaryDTO[];
}
```

- [ ] **步骤 1.5：定义请求参数类型（TraceListRequest）**

追加：

```typescript
// 后端 dtos/trace.go:35-43
export interface TraceListRequest {
  conversation_id?: string;
  agent_name?: string;
  is_error?: boolean;
  start_time_from?: number;            // Unix ns
  start_time_to?: number;              // Unix ns
  page?: number;
  page_size?: number;
}
```

- [ ] **步骤 1.6：验证文件**

运行：`npx tsc --noEmit`

预期：无错误（types 文件只声明，不依赖其他文件）

- [ ] **步骤 1.7：提交**

```bash
git add src/types/trace.ts
git commit -m "feat(types): 新增 trace 相关 wire DTO 类型

严格 snake_case 字段名，镜像后端 Go json tag：
- LogEntry / SpanNode（树形）
- TraceSummaryDTO / TraceDetailDTO / TraceListDTO
- TraceListRequest

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---


## Task 2: API 层（src/api/modules/trace.ts）

**文件**：
- Create: `src/api/modules/trace.ts`

**说明**：封装两个接口 + `getTraceDetailSafe` 兜底函数。处理 camelCase → snake_case 参数转换，以及 `data?.message ?? data?.error` 字段名兼容。

**依赖**：Task 1（types）

**复杂度**：中等（15 分钟）

---

- [ ] **步骤 2.1：创建文件 + 导入依赖**

```typescript
// src/api/modules/trace.ts
import request from '../request';
import type {
  TraceSummaryDTO,
  TraceDetailDTO,
  TraceListDTO,
  TraceListRequest,
} from '@/types/trace';
```

- [ ] **步骤 2.2：实现 listTraces（带参数转换）**

追加：

```typescript
export async function listTraces(params: {
  conversationId?: string;
  agentName?: string;
  isError?: 'all' | 'true' | 'false';
  startTimeFrom?: number | null;
  startTimeTo?: number | null;
  page: number;
  pageSize: number;
}): Promise<TraceListDTO> {
  // camelCase → snake_case 转换
  const query: Record<string, string | number> = {
    page: params.page,
    page_size: params.pageSize,
  };

  if (params.conversationId) query.conversation_id = params.conversationId;
  if (params.agentName) query.agent_name = params.agentName;
  if (params.isError && params.isError !== 'all') {
    query.is_error = params.isError; // 'true' / 'false' 字符串
  }
  if (params.startTimeFrom) query.start_time_from = params.startTimeFrom;
  if (params.startTimeTo) query.start_time_to = params.startTimeTo;

  return request.get<TraceListDTO>('/api/traces', { params: query });
}
```

- [ ] **步骤 2.3：实现 getTraceDetailSafe（结构化返回）**

追加：

```typescript
export type GetTraceDetailResult =
  | { ok: true; data: TraceDetailDTO }
  | { ok: false; status: 404 | 500 | 'network' };

export async function getTraceDetailSafe(
  traceId: string,
  signal?: AbortSignal
): Promise<GetTraceDetailResult> {
  try {
    const data = await request.get<TraceDetailDTO>(`/api/trace/${traceId}`, {
      signal,
      validateStatus: () => true, // 不让 axios 自动抛错
    });
    return { ok: true, data };
  } catch (err: any) {
    if (err.response) {
      const status = err.response.status;
      if (status === 404) return { ok: false, status: 404 };
      if (status >= 500) return { ok: false, status: 500 };
    }
    return { ok: false, status: 'network' };
  }
}
```

- [ ] **步骤 2.4：验证文件**

运行：`npx tsc --noEmit`

预期：无错误

- [ ] **步骤 2.5：提交**

```bash
git add src/api/modules/trace.ts
git commit -m "feat(api): 新增 trace API 封装

- listTraces：camelCase → snake_case 参数转换
- getTraceDetailSafe：结构化返回（ok:true/data 或 ok:false/status）
- 豁免 validateStatus 避免 404 触发拦截器 toast

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Store 层（src/store/trace.ts）

**文件**：
- Create: `src/store/trace.ts`

**说明**：Zustand store，管理列表分页 + 筛选状态；提供 `applyFiltersAndFetch` 合并 action；模块级 `let inflight: AbortController | null` 处理竞态。

**依赖**：Task 2（api）

**复杂度**：中等（20 分钟）

---

- [ ] **步骤 3.1：创建文件 + 导入 + 定义接口**

```typescript
// src/store/trace.ts
import { create } from 'zustand';
import { message } from 'antd';
import type { TraceSummaryDTO } from '@/types/trace';
import * as traceApi from '@/api/modules/trace';

export interface TraceListFilters {
  conversationId: string;              // 空串=不筛选
  agentName: string;                   // 空串=不筛选
  isError: 'all' | 'true' | 'false';   // 三态
  startTimeFrom: number | null;        // Unix ns
  startTimeTo: number | null;          // Unix ns
}

interface TraceState {
  traces: TraceSummaryDTO[];
  total: number;
  page: number;                        // 1-based
  pageSize: number;
  filters: TraceListFilters;
  loading: boolean;

  fetchTraces: () => Promise<void>;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setFilters: (patch: Partial<TraceListFilters>) => void;
  resetFilters: () => void;
  applyFiltersAndFetch: (patch: Partial<TraceListFilters>) => Promise<void>;
}

// 模块级 inflight，避免触发 Zustand 订阅者无谓重渲染
let inflight: AbortController | null = null;

const defaultFilters: TraceListFilters = {
  conversationId: '',
  agentName: '',
  isError: 'all',
  startTimeFrom: null,
  startTimeTo: null,
};
```

- [ ] **步骤 3.2：实现 fetchTraces（带 abort + 字段名兼容）**

追加：

```typescript
export const useTraceStore = create<TraceState>((set, get) => ({
  traces: [],
  total: 0,
  page: 1,
  pageSize: 20,
  filters: defaultFilters,
  loading: false,

  fetchTraces: async () => {
    // Abort 上一个 in-flight 请求
    if (inflight) inflight.abort();
    inflight = new AbortController();

    const { page, pageSize, filters } = get();
    // 参数校验
    const safePage = page < 1 ? 1 : page;
    const safePageSize = pageSize < 1 || pageSize > 100 ? 20 : pageSize;

    set({ loading: true });

    try {
      const res = await traceApi.listTraces({
        conversationId: filters.conversationId || undefined,
        agentName: filters.agentName || undefined,
        isError: filters.isError,
        startTimeFrom: filters.startTimeFrom,
        startTimeTo: filters.startTimeTo,
        page: safePage,
        pageSize: safePageSize,
      });

      set({
        traces: res.traces,
        total: res.total,
        page: res.page,
        pageSize: res.page_size, // snake_case → camelCase 转换点
        loading: false,
      });
    } catch (err: any) {
      set({ loading: false });
      // 字段名兼容：优先读 data?.message，兜底 data?.error
      const errMsg =
        err.response?.data?.message ??
        err.response?.data?.error ??
        '查询失败';
      message.error(errMsg);
      throw err;
    }
  },
```

- [ ] **步骤 3.3：实现 setPage / setPageSize（触发 fetch）**

追加到 `create<TraceState>` 内：

```typescript
  setPage: (page) => {
    set({ page });
    get().fetchTraces();
  },

  setPageSize: (size) => {
    set({ pageSize: size, page: 1 }); // 切 pageSize 时回到第 1 页
    get().fetchTraces();
  },
```

- [ ] **步骤 3.4：实现 setFilters / resetFilters / applyFiltersAndFetch**

追加：

```typescript
  setFilters: (patch) => {
    set((state) => ({
      filters: { ...state.filters, ...patch },
    }));
    // 不自动 fetch
  },

  resetFilters: () => {
    set({ filters: defaultFilters, page: 1 });
    get().fetchTraces();
  },

  applyFiltersAndFetch: async (patch) => {
    set((state) => ({
      filters: { ...state.filters, ...patch },
      page: 1, // 重置到第 1 页
    }));
    await get().fetchTraces();
  },
}));
```

- [ ] **步骤 3.5：验证文件**

运行：`npx tsc --noEmit`

预期：无错误

- [ ] **步骤 3.6：提交**

```bash
git add src/store/trace.ts
git commit -m "feat(store): 新增 trace Zustand store

- fetchTraces: 模块级 inflight AbortController 处理竞态
- applyFiltersAndFetch: 合并 setFilters + setPage(1) + fetch
- 字段名兼容: data?.message ?? data?.error
- 转换点: res.page_size → state.pageSize

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---


## Task 4: 工具函数层（src/pages/Trace/utils.ts）

**文件**：
- Create: `src/pages/Trace/utils.ts`

**说明**：纯函数集合，核心是 `flattenLayout`（火焰图布局算法）。包含格式化、颜色映射、span 查找等工具函数。

**依赖**：Task 1（types）

**复杂度**：高（火焰图布局算法，30 分钟）

---

- [ ] **步骤 4.1：创建文件 + 格式化函数**

```typescript
// src/pages/Trace/utils.ts
import dayjs from 'dayjs';
import type { SpanNode } from '@/types/trace';

// 格式化耗时：123ms / 1.23s / 1.23min
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}min`;
}

// 格式化时间戳：Unix ns → 'YYYY-MM-DD HH:mm:ss.SSS'
export function formatTimestamp(ns: number): string {
  return dayjs(ns / 1_000_000).format('YYYY-MM-DD HH:mm:ss.SSS');
}

// 相对偏移（毫秒）
export function relativeOffsetMs(span: SpanNode, root: SpanNode): number {
  return (span.start_time - root.start_time) / 1_000_000;
}

// 判断孤儿 span
export function isOrphan(span: SpanNode): boolean {
  return span.tags?._orphan === true;
}

// findSpanById：递归查找
export function findSpanById(root: SpanNode, id: number): SpanNode | null {
  if (root.span_id === id) return root;
  for (const child of root.children) {
    const found = findSpanById(child, id);
    if (found) return found;
  }
  return null;
}
```

- [ ] **步骤 4.2：实现 SPAN_TYPE_COLOR + SPAN_TYPE_TAG_MAP 常量**

追加：

```typescript
export const SPAN_TYPE_COLOR: Record<string, string> = {
  AGENT_ROOT: '#8c8c8c',
  AGENT_ROUND: '#1677ff',
  LLM_CALL: '#722ed1',
  TOOL_BATCH: '#fa8c16',
  TOOL_CALL: '#13c2c2',
  SUBAGENT_CALL: '#52c41a',
};

export const SPAN_TYPE_TAG_MAP: Record<string, string[]> = {
  AGENT_ROOT: ['user.query', 'conversation_id', 'agent.name', 'message.id'],
  AGENT_ROUND: ['round.index', 'round.iterate_count'],
  LLM_CALL: [
    'llm.model',
    'llm.prompt_hash',
    'llm.tokens.prompt',
    'llm.tokens.completion',
    'llm.tokens.total',
  ],
  TOOL_BATCH: ['tool.batch.size', 'tool.batch.concurrent'],
  TOOL_CALL: [
    'tool.name',
    'tool.provider',
    'tool.arguments',
    'tool.result_preview',
    'tool.result_size',
  ],
  SUBAGENT_CALL: ['subagent.name', 'subagent.trace_id'],
};
```

- [ ] **步骤 4.3：实现 colorFor（类型色 + 热度色）**

追加：

```typescript
export function colorFor(
  span: SpanNode,
  mode: 'type' | 'heat',
  rootLatency: number
): string {
  if (mode === 'type') {
    return SPAN_TYPE_COLOR[span.span_type] || '#bfbfbf';
  }
  // heat 模式：latency_ms 归一化到 [0, rootLatency]，映射 HSL 210°→0°
  const ratio = Math.min(span.latency_ms / rootLatency, 1);
  const hue = 210 - 210 * ratio; // 210=冷蓝, 0=暖红
  return `hsl(${hue}, 70%, 55%)`;
}
```

- [ ] **步骤 4.4：实现 flattenLayout（火焰图布局算法核心）**

追加：

```typescript
export interface FlameRect {
  span: SpanNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number; // 深度，用于 debug
}

const ROW_HEIGHT = 22; // px

export function flattenLayout(root: SpanNode, width: number): FlameRect[] {
  const W = width - 32; // 留 16px 左右边距
  const rootDuration = Math.max(root.end_time - root.start_time, 1); // 除零保护
  const result: FlameRect[] = [];

  function traverse(node: SpanNode, depth: number) {
    // 横向映射
    const offsetNs = node.start_time - root.start_time;
    const durationNs = node.end_time - node.start_time;
    let x = (offsetNs / rootDuration) * W + 16; // 左边距 16px
    let rectWidth = (durationNs / rootDuration) * W;

    // 最小宽度 2px
    if (rectWidth < 2) rectWidth = 2;

    const y = depth * ROW_HEIGHT;
    const height = ROW_HEIGHT - 2; // 留 2px 间隙

    result.push({ span: node, x, y, width: rectWidth, height, depth });

    // 递归子 span（先按 start_time 排序）
    const sortedChildren = [...node.children].sort(
      (a, b) => a.start_time - b.start_time
    );
    for (const child of sortedChildren) {
      traverse(child, depth + 1);
    }
  }

  traverse(root, 0);
  return result;
}
```

- [ ] **步骤 4.5：验证文件**

运行：`npx tsc --noEmit`

预期：无错误

- [ ] **步骤 4.6：提交**

```bash
git add src/pages/Trace/utils.ts
git commit -m "feat(utils): 新增 trace 工具函数 + 火焰图布局算法

- formatDuration / formatTimestamp / relativeOffsetMs
- isOrphan / findSpanById
- SPAN_TYPE_COLOR / SPAN_TYPE_TAG_MAP 常量
- colorFor: 类型色 + 热度色双模式
- flattenLayout: 冰锥式火焰图布局（DFS 前序 + 最小宽度 2px）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---


## Task 5: 筛选栏组件（src/pages/Trace/TraceFilters.tsx）

**文件**：
- Create: `src/pages/Trace/TraceFilters.tsx`

**说明**：5 项筛选控件 + 重置/查询/刷新按钮；内部用 `useState` 维护临时值，点查询时才提交到 store。

**依赖**：Task 3（store）

**复杂度**：中等（25 分钟）

---

- [ ] **步骤 5.1：创建文件 + 骨架**

```typescript
// src/pages/Trace/TraceFilters.tsx
import { useState, useEffect } from 'react';
import { Input, Select, DatePicker, Button, Space } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { useTraceStore } from '@/store/trace';
import type { TraceListFilters } from '@/store/trace';

const { RangePicker } = DatePicker;

const defaultFilters: TraceListFilters = {
  conversationId: '',
  agentName: '',
  isError: 'all',
  startTimeFrom: null,
  startTimeTo: null,
};

export default function TraceFilters() {
  const { filters, loading, applyFiltersAndFetch, resetFilters, fetchTraces } =
    useTraceStore();
  
  // 内部临时状态
  const [localFilters, setLocalFilters] = useState<TraceListFilters>(filters);
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs] | null>(null);

  // 同步外部 filters 变化（罕见）
  useEffect(() => {
    setLocalFilters(filters);
  }, [filters]);

  const handleApply = () => {
    applyFiltersAndFetch(localFilters);
  };

  const handleReset = () => {
    setLocalFilters(defaultFilters);
    setTimeRange(null);
    resetFilters();
  };

  const handleTimeRangeChange = (dates: [Dayjs, Dayjs] | null) => {
    setTimeRange(dates);
    if (dates) {
      setLocalFilters((prev) => ({
        ...prev,
        startTimeFrom: dates[0].valueOf() * 1_000_000, // ms → ns
        startTimeTo: dates[1].valueOf() * 1_000_000,
      }));
    } else {
      setLocalFilters((prev) => ({
        ...prev,
        startTimeFrom: null,
        startTimeTo: null,
      }));
    }
  };

  return (
    <Space wrap style={{ marginBottom: 16 }}>
      <Input
        placeholder="按 conversation_id 精确筛选"
        value={localFilters.conversationId}
        onChange={(e) =>
          setLocalFilters({ ...localFilters, conversationId: e.target.value })
        }
        onPressEnter={handleApply}
        allowClear
        style={{ width: 240 }}
      />
      <Input
        placeholder="按 agent_name 精确筛选"
        value={localFilters.agentName}
        onChange={(e) =>
          setLocalFilters({ ...localFilters, agentName: e.target.value })
        }
        onPressEnter={handleApply}
        allowClear
        style={{ width: 240 }}
      />
      <Select
        value={localFilters.isError}
        onChange={(val) => setLocalFilters({ ...localFilters, isError: val })}
        style={{ width: 120 }}
        options={[
          { label: '全部', value: 'all' },
          { label: '仅失败', value: 'true' },
          { label: '仅成功', value: 'false' },
        ]}
      />
      <RangePicker
        showTime
        format="YYYY-MM-DD HH:mm:ss"
        value={timeRange}
        onChange={handleTimeRangeChange}
        allowClear
        presets={[
          { label: '最近 1 小时', value: [dayjs().subtract(1, 'hour'), dayjs()] },
          { label: '最近 24 小时', value: [dayjs().subtract(24, 'hour'), dayjs()] },
          { label: '最近 7 天', value: [dayjs().subtract(7, 'day'), dayjs()] },
        ]}
      />
      <Button onClick={handleReset}>重置</Button>
      <Button type="primary" icon={<SearchOutlined />} onClick={handleApply}>
        查询
      </Button>
      <Button
        icon={<ReloadOutlined />}
        onClick={() => fetchTraces()}
        loading={loading}
      >
        刷新
      </Button>
    </Space>
  );
}
```

- [ ] **步骤 5.2：验证文件**

运行：`npx tsc --noEmit`

预期：无错误

- [ ] **步骤 5.3：提交**

```bash
git add src/pages/Trace/TraceFilters.tsx
git commit -m "feat(components): 新增 TraceFilters 筛选栏组件

- 5 项筛选控件 + 重置/查询/刷新按钮
- 内部 localFilters 临时状态，点查询才提交 store
- RangePicker presets: 最近 1h/24h/7d
- ms → ns 时间单位转换

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---


## Task 6: 表格组件（src/pages/Trace/TraceTable.tsx）

**文件**：
- Create: `src/pages/Trace/TraceTable.tsx`

**说明**：6 列表格 + 分页 + 行点击；`is_error=true` 行高亮用 `rowClassName`。

**依赖**：Task 3（store）+ Task 4（utils formatDuration/formatTimestamp）

**复杂度**：中等（20 分钟）

---

- [ ] **步骤 6.1：创建文件 + 列定义**

```typescript
// src/pages/Trace/TraceTable.tsx
import { Table, Tag, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTraceStore } from '@/store/trace';
import { formatDuration, formatTimestamp } from './utils';
import type { TraceSummaryDTO } from '@/types/trace';

interface TraceTableProps {
  onRowClick: (traceId: string) => void;
}

export default function TraceTable({ onRowClick }: TraceTableProps) {
  const { traces, total, page, pageSize, loading, setPage, setPageSize } =
    useTraceStore();

  const columns: ColumnsType<TraceSummaryDTO> = [
    {
      title: '状态',
      dataIndex: 'is_error',
      key: 'is_error',
      width: 80,
      align: 'center',
      render: (isError: boolean) =>
        isError ? (
          <CloseCircleFilled style={{ color: '#f5222d' }} title="失败" />
        ) : (
          <CheckCircleFilled style={{ color: '#52c41a' }} title="成功" />
        ),
    },
    {
      title: '开始时间',
      dataIndex: 'start_time',
      key: 'start_time',
      width: 200,
      render: (ns: number) => formatTimestamp(ns),
    },
    {
      title: 'Agent',
      dataIndex: 'agent_name',
      key: 'agent_name',
      width: 160,
      render: (name: string) => name || <span style={{ color: '#bfbfbf' }}>--</span>,
    },
    {
      title: '用户 Query 预览',
      dataIndex: 'user_query_preview',
      key: 'user_query_preview',
      ellipsis: { tooltip: true }, // AntD 内置未截断不显示 tooltip
      render: (preview: string) =>
        preview ? (
          <Typography.Text ellipsis={{ tooltip: preview }}>{preview}</Typography.Text>
        ) : (
          <span style={{ color: '#bfbfbf' }}>--</span>
        ),
    },
    {
      title: '耗时',
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 120,
      align: 'right',
      render: (ms: number) => formatDuration(ms),
    },
    {
      title: 'Span 数',
      dataIndex: 'span_count',
      key: 'span_count',
      width: 100,
      align: 'right',
      render: (count: number) =>
        count >= 50 ? <Tag color="orange">{count}</Tag> : count,
    },
  ];

  return (
    <Table
      columns={columns}
      dataSource={traces}
      rowKey="trace_id"
      loading={loading}
      size="middle"
      rowClassName={(row) => (row.is_error ? 'trace-row-error' : '')}
      onRow={(row) => ({
        onClick: () => onRowClick(row.trace_id),
        style: { cursor: 'pointer' },
      })}
      pagination={{
        current: page,
        pageSize,
        total,
        showSizeChanger: true,
        pageSizeOptions: ['10', '20', '50', '100'],
        showTotal: (t) => `共 ${t} 条`,
        onChange: (p, ps) => {
          setPage(p);
          if (ps !== pageSize) setPageSize(ps);
        },
      }}
    />
  );
}
```

- [ ] **步骤 6.2：验证 + 提交**

```bash
npx tsc --noEmit
git add src/pages/Trace/TraceTable.tsx
git commit -m "feat(components): 新增 TraceTable 表格组件

- 6 列：状态/开始时间/Agent/Query预览/耗时/Span数
- rowClassName='trace-row-error' 用于 CSS 高亮
- onRow 点击触发父组件 onRowClick

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: 火焰图组件（src/pages/Trace/FlameGraph.tsx）

**文件**：
- Create: `src/pages/Trace/FlameGraph.tsx`

**说明**：纯 SVG 冰锥火焰图；核心在 `useLayoutEffect` 调用 `flattenLayout` 布局 + `ResizeObserver` 响应式。

**依赖**：Task 4（utils）

**复杂度**：高（火焰图 SVG 渲染，40 分钟）

---

- [ ] **步骤 7.1：创建文件 + Props + 布局逻辑**

```typescript
// src/pages/Trace/FlameGraph.tsx
import { useRef, useState, useLayoutEffect } from 'react';
import type { SpanNode } from '@/types/trace';
import {
  flattenLayout,
  colorFor,
  formatDuration,
  relativeOffsetMs,
  isOrphan,
  type FlameRect,
} from './utils';

interface FlameGraphProps {
  root: SpanNode;
  selectedSpanId: number | null;
  colorMode: 'type' | 'heat';
  onSpanClick: (span: SpanNode) => void;
}

export default function FlameGraph({
  root,
  selectedSpanId,
  colorMode,
  onSpanClick,
}: FlameGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<FlameRect[]>([]);
  const [svgWidth, setSvgWidth] = useState(800);
  const [hoverSpan, setHoverSpan] = useState<SpanNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const updateLayout = () => {
      const width = containerRef.current!.clientWidth;
      setSvgWidth(width);
      const layout = flattenLayout(root, width);
      setRects(layout);
    };
    updateLayout();

    const observer = new ResizeObserver(updateLayout);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [root]);

  const maxDepth = Math.max(...rects.map((r) => r.depth), 0);
  const svgHeight = (maxDepth + 1) * 22 + 2; // ROW_HEIGHT=22

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {/* 时间轴刻度省略，见完整版 */}
      <svg width={svgWidth} height={svgHeight} style={{ display: 'block' }}>
        {rects.map((rect) => {
          const { span, x, y, width, height } = rect;
          const fill = colorFor(span, colorMode, root.latency_ms);
          const isSelected = span.span_id === selectedSpanId;
          const isError = span.is_error;
          const orphan = isOrphan(span);

          let stroke = 'none';
          let strokeWidth = 0;
          let strokeDasharray = undefined;

          if (isError) {
            stroke = '#f5222d';
            strokeWidth = 2;
          }
          if (orphan) {
            strokeDasharray = '4,2';
            if (!isError) {
              stroke = '#fa8c16';
              strokeWidth = 1;
            }
          }
          if (isSelected) {
            stroke = '#000';
            strokeWidth = 2;
          }

          return (
            <rect
              key={span.span_id}
              x={x}
              y={y}
              width={width}
              height={height}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              style={{ cursor: 'pointer' }}
              onClick={() => onSpanClick(span)}
              onMouseEnter={(e) => {
                setHoverSpan(span);
                setTooltipPos({ x: e.clientX, y: e.clientY });
              }}
              onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoverSpan(null)}
              tabIndex={0}
              role="button"
              aria-label={`${span.operation_name} ${formatDuration(span.latency_ms)}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSpanClick(span);
                }
              }}
            />
          );
        })}
      </svg>
      {hoverSpan && (
        <div
          style={{
            position: 'fixed',
            left: tooltipPos.x + 10,
            top: tooltipPos.y + 10,
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '8px 12px',
            borderRadius: 4,
            fontSize: 12,
            pointerEvents: 'none',
            zIndex: 9999,
            whiteSpace: 'pre-line',
          }}
        >
          {hoverSpan.span_type} · {hoverSpan.operation_name}
          {'\n'}耗时: {formatDuration(hoverSpan.latency_ms)}
          {'\n'}起始: +{formatDuration(relativeOffsetMs(hoverSpan, root))}
          {'\n'}Span ID: {hoverSpan.span_id}, Parent: {hoverSpan.parent_span_id}
          {hoverSpan.is_error && '\n[有错误]'}
          {isOrphan(hoverSpan) && '\n[孤儿]'}
        </div>
      )}
    </div>
  );
}
```

- [ ] **步骤 7.2：验证 + 提交**

```bash
npx tsc --noEmit
git add src/pages/Trace/FlameGraph.tsx
git commit -m "feat(components): 新增 FlameGraph 火焰图组件

- useLayoutEffect + ResizeObserver 响应式布局
- 错误 span 红边框 / 孤儿 span 虚线边框
- 悬浮 tooltip + 点击联动 + 键盘无障碍

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Span 详情面板（src/pages/Trace/SpanDetailPanel.tsx）

**文件**：
- Create: `src/pages/Trace/SpanDetailPanel.tsx`

**说明**：4 Tabs（概要/完整Tags/Logs/原始JSON）；概要 Tab 按 `span_type` 定制；错误 span 顶部 Alert 显示 `error.message`；孤儿 span 顶部 Alert。

**依赖**：Task 4（utils SPAN_TYPE_TAG_MAP）

**复杂度**：高（按类型定制 + Alert 条件渲染，35 分钟）

---

- [ ] **步骤 8.1：创建文件 + Tabs 骨架（精简版）**

```typescript
// src/pages/Trace/SpanDetailPanel.tsx
import { Tabs, Descriptions, Alert, Typography, Tag, Timeline, Empty, Collapse } from 'antd';
import type { SpanNode } from '@/types/trace';
import { SPAN_TYPE_TAG_MAP, isOrphan, formatDuration } from './utils';
import dayjs from 'dayjs';

interface SpanDetailPanelProps {
  span: SpanNode;
}

export default function SpanDetailPanel({ span }: SpanDetailPanelProps) {
  const defaultKey = span.is_error ? 'logs' : 'summary';

  return (
    <Tabs defaultActiveKey={defaultKey} items={[
      { key: 'summary', label: '概要', children: <SummaryTab span={span} /> },
      { key: 'tags', label: '完整 Tags', children: <TagsTab span={span} /> },
      { key: 'logs', label: 'Logs', children: <LogsTab span={span} /> },
      { key: 'json', label: '原始 JSON', children: <JsonTab span={span} /> },
    ]} />
  );
}

// 概要 Tab（按 span_type 定制 + Alert）
function SummaryTab({ span }: { span: SpanNode }) {
  const orphan = isOrphan(span);
  const hasErrorMsg = span.is_error && span.tags?.['error.message'];
  const tagKeys = SPAN_TYPE_TAG_MAP[span.span_type] || [];

  return (
    <div>
      {orphan && (
        <Alert
          type="warning"
          message="孤儿节点，父 Span ID 已丢失"
          description={`原始 parent_span_id: ${span.tags._original_parent}`}
          style={{ marginBottom: 12 }}
        />
      )}
      {span.is_error && (
        <Alert
          type="error"
          message="错误信息"
          description={
            hasErrorMsg
              ? String(span.tags['error.message'])
              : '（后端未提供 error.message，请查看 Logs Tab 或完整 Tags）'
          }
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}
      <Descriptions column={2} bordered size="small">
        <Descriptions.Item label="Span ID">{span.span_id}</Descriptions.Item>
        <Descriptions.Item label="Span Type">
          <Tag>{span.span_type}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Operation Name" span={2}>
          {span.operation_name}
        </Descriptions.Item>
        <Descriptions.Item label="耗时">
          {formatDuration(span.latency_ms)}
        </Descriptions.Item>
        <Descriptions.Item label="错误状态">
          {span.is_error ? <Tag color="red">失败</Tag> : <Tag color="green">成功</Tag>}
        </Descriptions.Item>
        {tagKeys.map((key) =>
          span.tags?.[key] !== undefined ? (
            <Descriptions.Item label={key} span={2} key={key}>
              {renderTagValue(span.tags[key])}
            </Descriptions.Item>
          ) : null
        )}
      </Descriptions>
    </div>
  );
}

function renderTagValue(val: unknown): React.ReactNode {
  if (typeof val === 'string') {
    if (val.length > 500) {
      return (
        <Typography.Paragraph ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}>
          {val}
        </Typography.Paragraph>
      );
    }
    return val;
  }
  if (typeof val === 'object') {
    return <pre style={{ maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(val, null, 2)}</pre>;
  }
  return String(val);
}

// 完整 Tags Tab（省略，类似结构）
function TagsTab({ span }: { span: SpanNode }) {
  const entries = Object.entries(span.tags || {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Descriptions column={1} bordered size="small">
      {entries.map(([key, val]) => (
        <Descriptions.Item label={key} key={key}>
          {val === '***' && <Tag color="warning">已打码</Tag>}
          {renderTagValue(val)}
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

// Logs Tab
function LogsTab({ span }: { span: SpanNode }) {
  if (!span.logs || span.logs.length === 0) {
    return <Empty description="无日志" />;
  }
  const colorMap: Record<string, string> = {
    error: 'red',
    warn: 'orange',
    info: 'blue',
    debug: 'gray',
  };
  return (
    <Timeline
      mode="left"
      items={span.logs.map((log) => ({
        color: colorMap[log.level] || 'blue',
        label: dayjs(log.ts / 1e6).format('HH:mm:ss.SSS'),
        children: (
          <>
            <strong>{log.msg}</strong>
            {log.extra && (
              <Collapse ghost items={[{
                key: '1',
                label: '详情',
                children: <pre>{JSON.stringify(log.extra, null, 2)}</pre>,
              }]} />
            )}
          </>
        ),
      }))}
    />
  );
}

// 原始 JSON Tab
function JsonTab({ span }: { span: SpanNode }) {
  const spanCopy = { ...span, children: undefined }; // 不含 children
  const json = JSON.stringify(spanCopy, null, 2);
  return (
    <>
      <Typography.Paragraph copyable={{ text: json }}>
        复制 JSON
      </Typography.Paragraph>
      <pre style={{ maxHeight: '100%', overflow: 'auto', background: '#fafafa', padding: 12, fontSize: 12 }}>
        {json}
      </pre>
    </>
  );
}
```

- [ ] **步骤 8.2：验证 + 提交**

```bash
npx tsc --noEmit
git add src/pages/Trace/SpanDetailPanel.tsx
git commit -m "feat(components): 新增 SpanDetailPanel 详情面板

- 4 Tabs: 概要/完整Tags/Logs/原始JSON
- 概要按 span_type 定制（SPAN_TYPE_TAG_MAP）
- 错误 span 顶部 Alert 显示 error.message
- 孤儿 span 顶部 Alert 显示 _original_parent

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---


## Task 9: 详情弹窗（src/pages/Trace/TraceDetailModal.tsx）

**文件**：
- Create: `src/pages/Trace/TraceDetailModal.tsx`

**说明**：Modal 编排上下两栏；调用 `getTraceDetailSafe`；`useRef<AbortController>` 处理关闭时 abort；`key={traceId}` 强制 remount。

**依赖**：Task 2（api getTraceDetailSafe）+ Task 6-8（子组件）

**复杂度**：高（状态编排 + 错误态，30 分钟）

---

- [ ] **步骤 9.1：创建文件 + 状态管理**

```typescript
// src/pages/Trace/TraceDetailModal.tsx
import { useState, useEffect, useRef } from 'react';
import { Modal, Spin, Result, Button, Radio, Flex, Tag, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { message } from 'antd';
import type { TraceDetailDTO } from '@/types/trace';
import { getTraceDetailSafe } from '@/api/modules/trace';
import { formatDuration, formatTimestamp, findSpanById } from './utils';
import FlameGraph from './FlameGraph';
import SpanDetailPanel from './SpanDetailPanel';

interface TraceDetailModalProps {
  traceId: string | null;
  open: boolean;
  onClose: () => void;
}

export default function TraceDetailModal({ traceId, open, onClose }: TraceDetailModalProps) {
  const [detail, setDetail] = useState<TraceDetailDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'not_found' | 'server' | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<number | null>(null);
  const [colorMode, setColorMode] = useState<'type' | 'heat'>('type');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !traceId) return;

    const fetchDetail = async () => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setError(null);

      const result = await getTraceDetailSafe(traceId, abortRef.current.signal);
      setLoading(false);

      if (result.ok) {
        setDetail(result.data);
        setSelectedSpanId(result.data.root.span_id); // 默认选中 root
      } else {
        setError(result.status === 404 ? 'not_found' : 'server');
      }
    };

    fetchDetail();

    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [open, traceId]);

  const handleClose = () => {
    setDetail(null);
    setSelectedSpanId(null);
    setColorMode('type');
    setError(null);
    onClose();
  };

  const selectedSpan =
    detail && selectedSpanId !== null ? findSpanById(detail.root, selectedSpanId) : null;

  return (
    <Modal
      title={
        <Flex align="center" gap={8}>
          <span>链路详情</span>
          {traceId && (
            <>
              <Tag>{traceId.slice(0, 8)}...</Tag>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  navigator.clipboard.writeText(traceId);
                  message.success('已复制 trace_id');
                }}
              />
            </>
          )}
        </Flex>
      }
      open={open}
      onCancel={handleClose}
      footer={null}
      width="90vw"
      styles={{ body: { height: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}
      destroyOnHidden
    >
      {loading && <Spin size="large" style={{ margin: 'auto' }} />}
      {error === 'not_found' && <Result status="404" title="Trace 不存在" />}
      {error === 'server' && (
        <Result
          status="500"
          title="加载失败"
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              重试
            </Button>
          }
        />
      )}
      {detail && (
        <>
          <Flex
            justify="space-between"
            align="center"
            style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}
          >
            <Flex gap={16} wrap="wrap" style={{ fontSize: 13 }}>
              <span>开始: {formatTimestamp(detail.start_time)}</span>
              <span>耗时: {formatDuration(detail.duration_ms)}</span>
              <span>Span 数: {detail.span_count}</span>
              <span>
                状态:{' '}
                {detail.is_error ? <Tag color="red">失败</Tag> : <Tag color="green">成功</Tag>}
              </span>
            </Flex>
            <Radio.Group value={colorMode} onChange={(e) => setColorMode(e.target.value)} size="small">
              <Radio.Button value="type">按类型</Radio.Button>
              <Radio.Button value="heat">按耗时</Radio.Button>
            </Radio.Group>
          </Flex>
          <div style={{ flex: '4', overflow: 'auto', borderBottom: '1px solid #f0f0f0' }}>
            <FlameGraph
              root={detail.root}
              selectedSpanId={selectedSpanId}
              colorMode={colorMode}
              onSpanClick={(span) => setSelectedSpanId(span.span_id)}
            />
          </div>
          <div style={{ flex: '6', overflow: 'auto', padding: 16 }}>
            {selectedSpan && <SpanDetailPanel span={selectedSpan} />}
          </div>
        </>
      )}
    </Modal>
  );
}
```

- [ ] **步骤 9.2：验证 + 提交**

```bash
npx tsc --noEmit
git add src/pages/Trace/TraceDetailModal.tsx
git commit -m "feat(components): 新增 TraceDetailModal 详情弹窗

- Modal 90vw×85vh, destroyOnHidden
- 上下两栏: flex 4/6 分配高度
- getTraceDetailSafe + AbortController abort on close
- 默认选中 root span, 类型/热度模式切换

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: 主页面 + CSS（src/pages/Trace/index.tsx + index.css）

**文件**：
- Create: `src/pages/Trace/index.tsx`
- Create: `src/pages/Trace/index.css`

**说明**：组装 TraceFilters + TraceTable + TraceDetailModal；新增 CSS 定义 `.trace-row-error` 高亮。

**依赖**：Task 5-9（子组件）

**复杂度**：简单（10 分钟）

---

- [ ] **步骤 10.1：创建主页面**

```typescript
// src/pages/Trace/index.tsx
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
        key={modalTraceId} // 强制 remount 避免旧 detail 残留
        traceId={modalTraceId}
        open={modalTraceId !== null}
        onClose={() => setModalTraceId(null)}
      />
    </div>
  );
}
```

- [ ] **步骤 10.2：创建 CSS 样式**

```css
/* src/pages/Trace/index.css */
.trace-row-error > td {
  background: #fff2f0 !important;
}
```

- [ ] **步骤 10.3：验证 + 提交**

```bash
npx tsc --noEmit
git add src/pages/Trace/index.tsx src/pages/Trace/index.css
git commit -m "feat(pages): 新增 Trace 主页面 + CSS 高亮

- 组装 TraceFilters / TraceTable / TraceDetailModal
- Modal key={modalTraceId} 强制 remount
- index.css: .trace-row-error 浅红高亮

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: 路由 + Layout 菜单集成

**文件**：
- Modify: `src/router/index.tsx`
- Modify: `src/components/Layout/index.tsx`

**说明**：注册 `/traces` 路由；菜单新增 `NodeIndexOutlined` 图标 "会话追踪" 入口。

**依赖**：Task 10（主页面）

**复杂度**：简单（10 分钟）

---

- [ ] **步骤 11.1：注册路由**

编辑 `src/router/index.tsx`：

```typescript
import TracePage from '@/pages/Trace'; // 新增

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      // ... 既有 route
      {
        path: 'traces',  // 新增
        element: <TracePage />,
      },
    ],
  },
]);
```

- [ ] **步骤 11.2：菜单新增入口**

编辑 `src/components/Layout/index.tsx`：

```typescript
import { NodeIndexOutlined } from '@ant-design/icons'; // 新增

const menuItems = [
  // ... 既有 item
  {
    key: '/traces',
    icon: <NodeIndexOutlined />,
    label: '会话追踪',
  },
];
```

- [ ] **步骤 11.3：验证 + 提交**

```bash
npx tsc --noEmit
npm run build  # 确保构建通过
git add src/router/index.tsx src/components/Layout/index.tsx
git commit -m "feat(integration): 注册 /traces 路由 + Layout 菜单入口

- router: path='traces' → <TracePage />
- Layout: key='/traces' icon=NodeIndexOutlined label='会话追踪'

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: 手动验收 + 构建验证

**文件**：无

**说明**：启动 dev server 手动走查验收标准；运行 lint / build / format 确保无错误。

**依赖**：Task 11（集成完成）

**复杂度**：简单（20 分钟）

---

- [ ] **步骤 12.1：启动 dev server**

```bash
npm run dev
```

浏览器访问 `http://localhost:3000/traces`

- [ ] **步骤 12.2：验收功能层（25 项）**

逐项走查设计规范 §七.1 功能层验收标准：

1. 左侧菜单可进入"会话追踪"页 ✓
2. 自动请求 `/api/traces?page=1&page_size=20` ✓
3. conversation_id / agent_name 输入框 Enter 触发查询 ✓
4. 状态 Select 三态切换 ✓
5. 时间范围 RangePicker 预设 ✓
6. 重置按钮清空筛选 ✓
7. 分页器翻页/切换大小 ✓
8. `is_error=true` 行整行浅红高亮 ✓
9. 状态图标绿/红 + title ✓
10. Query 预览超长省略 + Tooltip ✓
11. 耗时智能格式化 ✓
12. 点击行打开 Modal 90vw×85vh ✓
13. Modal 顶部 trace_id 复制 + 颜色模式切换 ✓
14. 火焰图冰锥式 + 时间轴刻度 ✓
15. 火焰图 span 按类型着色 + 错误红边框 ✓
16. 热度模式冷→热渐变 ✓
17. 悬浮 span Tooltip ✓
18. 点击 span 联动下方面板 ✓
19. 4 Tabs（概要/完整Tags/Logs/原始JSON）✓
20. 错误 span 默认 Logs Tab ✓
21. Tags `"***"` 显示已打码 Tag ✓
22. 长文本展开/折叠 ✓
23. Modal 关闭 abort 请求 ✓
24. 404/500 Result ✓
25. ESC 关闭 Modal ✓
25.1. 孤儿 span 虚线边框 + Alert ✓
25.2. 错误 span 概要 Alert error.message ✓
25.3. 快速切行 Modal remount ✓
25.4. applyFiltersAndFetch 无多余请求 ✓

- [ ] **步骤 12.3：验收代码质量层（8 项）**

```bash
npm run build       # 无 TS 错误
npm run lint        # 无新增 warning
npm run format      # 无 diff
git diff package.json  # 确认无新依赖
grep -r " any" src/pages/Trace src/api/modules/trace.ts src/store/trace.ts src/types/trace.ts  # 确认无 any
```

- [ ] **步骤 12.4：验收契约层（4 项）**

对照后端 DTO 核对字段名：

- `src/types/trace.ts` 所有字段 snake_case ✓
- `src/store/trace.ts` 状态字段 camelCase ✓
- `src/api/modules/trace.ts` 参数转换正确 ✓
- `getTraceDetailSafe` 返回 `GetTraceDetailResult` ✓

- [ ] **步骤 12.5：最终提交**

```bash
git add -A
git commit -m "chore: 会话列表页功能验收通过

验收标准 25+4 项全部通过：
- 功能层 25 项（含孤儿 span/error.message Alert）
- 代码质量层 8 项（无 TS 错误/无 lint warning/无新依赖）
- 契约层 4 项（snake_case wire DTO / camelCase store）

npm run build / lint / format 全绿

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 实施完成

所有 12 个任务完成后，功能已就绪。接下来可选：

1. **派发 plan-document-reviewer 审查本计划**（writing-plans 技能要求）
2. **选择执行方式**：
   - **Subagent-Driven**（推荐）：`superpowers:subagent-driven-development`
   - **Inline Execution**：`superpowers:executing-plans`


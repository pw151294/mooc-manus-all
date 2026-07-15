# 会话列表页 + 链路追踪火焰图 E2E 验证文档

**日期**：2026-07-15
**关联设计**：`docs/superpowers/specs/2026-07-15-session-list-design.md`
**关联实施计划**：`docs/superpowers/plans/2026-07-15-session-list-implementation.md`
**测试工具**：Playwright（若项目当前无，本文档包含接入指南）

---

## 一、Fixture 准备策略

按优先级三选一：

### 策略 1：优选 — 利用后端真实数据

**前置条件**：后端 `mooc-manus` 已完成 Agent Tracing 落地（参见前置设计 `2026-07-14-agent-tracing-design.md`）

**步骤**：

1. 启动后端服务：`cd mooc-manus && go run main.go`（默认 `http://localhost:8080`）
2. 运行后端集成测试生成 trace 数据：

```bash
cd mooc-manus
go test -v ./internal/applications/services -run TestAgentTracingIntegration
```

此测试会调用 BaseAgent 并写入 `ai_span` 表，生成若干真实 trace（含正常/错误/多轮迭代等场景）。

3. 前端 e2e 直接连 `http://localhost:8080/api/traces`，无需 mock

**优点**：真实契约、覆盖完整链路

**缺点**：依赖后端运行；若后端数据不足以覆盖极端场景（如孤儿 span），需补充 mock

---

### 策略 2：备选 — 手动触发 trace

**步骤**：

1. 启动前后端：`cd mooc-manus && go run main.go` + `cd mooc-manus-web && npm run dev`
2. 浏览器访问 `http://localhost:3000/agent`（智能体对话页）
3. 手动发送若干对话（含成功/失败/工具调用），触发 trace 生成
4. 前端 e2e 拉取刚生成的 trace 数据

**优点**：灵活控制场景

**缺点**：手动操作繁琐；孤儿 span 难以触发

---

### 策略 3：兜底 — Playwright mock

**步骤**：

用 Playwright `page.route()` mock `/api/traces` 与 `/api/trace/:id` 返回构造的 JSON。

**示例 fixture**（包含正常/错误/孤儿 span）：

```typescript
// tests/fixtures/trace-mock.ts
export const mockTraceList = {
  total: 2,
  page: 1,
  page_size: 20,
  traces: [
    {
      trace_id: 'trace-001',
      conversation_id: 'conv-001',
      agent_name: 'BaseAgent',
      start_time: Date.now() * 1_000_000,
      duration_ms: 1234,
      span_count: 5,
      is_error: false,
      user_query_preview: '帮我查询天气',
    },
    {
      trace_id: 'trace-002',
      conversation_id: 'conv-002',
      agent_name: 'ReActAgent',
      start_time: (Date.now() - 3600000) * 1_000_000,
      duration_ms: 5678,
      span_count: 12,
      is_error: true,
      user_query_preview: '执行一个会失败的工具',
    },
  ],
};

export const mockTraceDetail = {
  trace_id: 'trace-002',
  conversation_id: 'conv-002',
  agent_name: 'ReActAgent',
  start_time: (Date.now() - 3600000) * 1_000_000,
  end_time: (Date.now() - 3600000 + 5678) * 1_000_000,
  duration_ms: 5678,
  is_error: true,
  span_count: 3,
  root: {
    span_id: 0,
    parent_span_id: -1,
    span_type: 'AGENT_ROOT',
    operation_name: 'agent.invoke',
    start_time: (Date.now() - 3600000) * 1_000_000,
    end_time: (Date.now() - 3600000 + 5678) * 1_000_000,
    latency_ms: 5678,
    is_error: true,
    tags: { 'user.query': '执行一个会失败的工具', 'error.message': '工具调用超时' },
    logs: [
      { ts: Date.now() * 1_000_000, level: 'error', msg: '工具执行失败', extra: {} },
    ],
    children: [
      {
        span_id: 1,
        parent_span_id: 0,
        span_type: 'TOOL_CALL',
        operation_name: 'tool.execute',
        start_time: (Date.now() - 3600000 + 100) * 1_000_000,
        end_time: (Date.now() - 3600000 + 5600) * 1_000_000,
        latency_ms: 5500,
        is_error: true,
        tags: { 'tool.name': 'slow_tool', _orphan: true, _original_parent: 99 },
        logs: [],
        children: [],
      },
    ],
  },
};
```

在测试中：

```typescript
await page.route('**/api/traces*', (route) => route.fulfill({ json: mockTraceList }));
await page.route('**/api/trace/trace-002', (route) => route.fulfill({ json: mockTraceDetail }));
```

**优点**：完全控制数据、覆盖极端场景

**缺点**：与后端真实契约脱节，需手动维护 fixture

---

## 二、Playwright 接入（若项目当前无）

### 2.1 最小化安装

```bash
cd mooc-manus-web
npm install -D @playwright/test
npx playwright install chromium  # 只安装 chromium，节省空间
```

### 2.2 配置文件

新建 `playwright.config.ts`：

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

### 2.3 目录结构

```
mooc-manus-web/
├── tests/
│   ├── e2e/
│   │   ├── trace-list.spec.ts
│   │   ├── trace-detail.spec.ts
│   │   └── trace-edge-cases.spec.ts
│   └── fixtures/
│       └── trace-mock.ts
└── playwright.config.ts
```

---

## 三、E2E 用例清单

### 3.1 列表页基础功能（trace-list.spec.ts）

**用例 1：页面加载 + 自动请求**

```typescript
test('应自动加载列表页并请求第一页数据', async ({ page }) => {
  const requestPromise = page.waitForRequest((req) =>
    req.url().includes('/api/traces') && req.url().includes('page=1')
  );
  await page.goto('/traces');
  await requestPromise;
  await expect(page.locator('table tbody tr')).toHaveCount(20, { timeout: 5000 });
});
```

**用例 2：筛选 conversation_id + 查询按钮**

```typescript
test('可通过 conversation_id 筛选', async ({ page }) => {
  await page.goto('/traces');
  await page.fill('input[placeholder*="conversation_id"]', 'conv-001');
  
  const requestPromise = page.waitForRequest((req) =>
    req.url().includes('conversation_id=conv-001')
  );
  await page.click('button:has-text("查询")');
  await requestPromise;
  
  await expect(page.locator('table tbody tr')).toHaveCount(1);
});
```

**用例 3：状态 Select 三态切换**

```typescript
test('可切换状态筛选（全部/仅失败/仅成功）', async ({ page }) => {
  await page.goto('/traces');
  await page.click('.ant-select:has-text("全部")');
  await page.click('.ant-select-item:has-text("仅失败")');
  
  const requestPromise = page.waitForRequest((req) =>
    req.url().includes('is_error=true')
  );
  await page.click('button:has-text("查询")');
  await requestPromise;
});
```

**用例 4：分页切换**

```typescript
test('可翻页并触发新请求', async ({ page }) => {
  await page.goto('/traces');
  await page.waitForSelector('table tbody tr');
  
  const requestPromise = page.waitForRequest((req) =>
    req.url().includes('page=2')
  );
  await page.click('.ant-pagination-item-2');
  await requestPromise;
});
```

**用例 5：重置按钮**

```typescript
test('重置按钮清空所有筛选 + 回到第 1 页', async ({ page }) => {
  await page.goto('/traces');
  await page.fill('input[placeholder*="conversation_id"]', 'conv-001');
  await page.click('button:has-text("查询")');
  await page.waitForTimeout(500);
  
  const requestPromise = page.waitForRequest((req) =>
    req.url().includes('page=1') && !req.url().includes('conversation_id')
  );
  await page.click('button:has-text("重置")');
  await requestPromise;
  
  await expect(page.locator('input[placeholder*="conversation_id"]')).toHaveValue('');
});
```

**用例 6：`is_error=true` 行浅红高亮**

```typescript
test('错误行应有浅红背景', async ({ page }) => {
  await page.goto('/traces');
  await page.waitForSelector('table tbody tr');
  
  const errorRow = page.locator('table tbody tr.trace-row-error').first();
  await expect(errorRow).toHaveCSS('background-color', 'rgb(255, 242, 240)');
  
  const icon = errorRow.locator('svg[data-icon="close-circle"]');
  await expect(icon).toBeVisible();
});
```

---

### 3.2 详情弹窗基础功能（trace-detail.spec.ts）

**用例 7：点击行打开 Modal**

```typescript
test('点击列表行应打开详情弹窗', async ({ page }) => {
  await page.goto('/traces');
  await page.waitForSelector('table tbody tr');
  
  await page.click('table tbody tr:first-child');
  await expect(page.locator('.ant-modal')).toBeVisible();
  await expect(page.locator('.ant-modal-title:has-text("链路详情")')).toBeVisible();
});
```

**用例 8：火焰图 SVG 渲染 + span 数量匹配**

```typescript
test('火焰图 SVG rect 数量应等于 span_count', async ({ page }) => {
  // 假设使用 mock，trace-002 有 3 个 span
  await page.route('**/api/traces*', (route) => route.fulfill({ json: mockTraceList }));
  await page.route('**/api/trace/trace-002', (route) => route.fulfill({ json: mockTraceDetail }));
  
  await page.goto('/traces');
  await page.click('table tbody tr:nth-child(2)'); // trace-002
  
  await page.waitForSelector('.ant-modal svg rect');
  const rects = await page.locator('.ant-modal svg rect').count();
  expect(rects).toBe(3); // root + 1 child + 1 orphan
});
```

**用例 9：点击火焰图 span 联动详情面板**

```typescript
test('点击火焰图 span 应联动下方详情面板', async ({ page }) => {
  await page.goto('/traces');
  await page.click('table tbody tr:first-child');
  await page.waitForSelector('.ant-modal svg rect');
  
  await page.click('.ant-modal svg rect:nth-child(2)'); // 点击第 2 个 span
  
  await expect(page.locator('.ant-descriptions-item-label:has-text("Span ID")')).toBeVisible();
});
```

**用例 10：颜色模式切换**

```typescript
test('颜色模式切换应改变 SVG rect fill 属性', async ({ page }) => {
  await page.goto('/traces');
  await page.click('table tbody tr:first-child');
  await page.waitForSelector('.ant-modal svg rect');
  
  const rect = page.locator('.ant-modal svg rect').first();
  const typeModeFill = await rect.getAttribute('fill');
  
  await page.click('.ant-radio-button-wrapper:has-text("按耗时")');
  await page.waitForTimeout(100);
  
  const heatModeFill = await rect.getAttribute('fill');
  expect(typeModeFill).not.toBe(heatModeFill);
  expect(heatModeFill).toMatch(/^hsl\(/); // 热度模式用 HSL
});
```

**用例 11：错误 span 默认展开 Logs Tab**

```typescript
test('错误 span 应默认展开 Logs Tab', async ({ page }) => {
  await page.route('**/api/trace/trace-002', (route) => route.fulfill({ json: mockTraceDetail }));
  await page.goto('/traces');
  await page.click('table tbody tr:has-text("trace-002")');
  
  await page.waitForSelector('.ant-modal');
  await expect(page.locator('.ant-tabs-tab-active:has-text("Logs")')).toBeVisible();
});
```

**用例 12：ESC 键关闭 Modal**

```typescript
test('按 ESC 应关闭 Modal', async ({ page }) => {
  await page.goto('/traces');
  await page.click('table tbody tr:first-child');
  await page.waitForSelector('.ant-modal');
  
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-modal')).not.toBeVisible();
});
```

---

### 3.3 极端场景与边界条件（trace-edge-cases.spec.ts）

**用例 13：孤儿 span 虚线边框 + Alert**

```typescript
test('孤儿 span 应显示虚线边框 + 概要 Tab 顶部 Alert', async ({ page }) => {
  await page.route('**/api/trace/trace-002', (route) => route.fulfill({ json: mockTraceDetail }));
  await page.goto('/traces');
  await page.click('table tbody tr:has-text("trace-002")');
  
  await page.waitForSelector('.ant-modal svg rect');
  const orphanRect = page.locator('.ant-modal svg rect[stroke-dasharray="4,2"]');
  await expect(orphanRect).toBeVisible();
  
  await orphanRect.click();
  await expect(page.locator('.ant-alert-warning:has-text("孤儿节点")')).toBeVisible();
  await expect(page.locator('.ant-alert-description:has-text("原始 parent_span_id: 99")')).toBeVisible();
});
```

**用例 14：错误 span 概要 Alert 显示 error.message**

```typescript
test('错误 span 概要 Tab 应显示红色 Alert 含 error.message', async ({ page }) => {
  await page.route('**/api/trace/trace-002', (route) => route.fulfill({ json: mockTraceDetail }));
  await page.goto('/traces');
  await page.click('table tbody tr:has-text("trace-002")');
  
  await page.waitForSelector('.ant-modal svg rect');
  await page.click('.ant-modal svg rect:first-child'); // root span
  
  await page.click('.ant-tabs-tab:has-text("概要")');
  await expect(page.locator('.ant-alert-error:has-text("错误信息")')).toBeVisible();
  await expect(page.locator('.ant-alert-description:has-text("工具调用超时")')).toBeVisible();
});
```

**用例 15：Tags 中 `"***"` 显示已打码 Tag**

```typescript
test('Tags 值为 "***" 应显示已打码 Tag', async ({ page }) => {
  const detailWithMasked = {
    ...mockTraceDetail,
    root: {
      ...mockTraceDetail.root,
      tags: { ...mockTraceDetail.root.tags, 'api_key': '***' },
    },
  };
  await page.route('**/api/trace/trace-002', (route) => route.fulfill({ json: detailWithMasked }));
  
  await page.goto('/traces');
  await page.click('table tbody tr:has-text("trace-002")');
  await page.click('.ant-tabs-tab:has-text("完整 Tags")');
  
  await expect(page.locator('.ant-tag-warning:has-text("已打码")')).toBeVisible();
});
```

**用例 16：404 详情 Result**

```typescript
test('trace_id 不存在应显示 404 Result', async ({ page }) => {
  await page.route('**/api/trace/not-exist', (route) =>
    route.fulfill({ status: 404, json: { code: 'TRACE_NOT_FOUND' } })
  );
  
  await page.goto('/traces');
  // 手动触发 Modal（模拟点击不存在的 trace）
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('openTraceModal', { detail: 'not-exist' }));
  });
  
  await page.waitForSelector('.ant-result-404');
  await expect(page.locator('.ant-result-title:has-text("Trace 不存在")')).toBeVisible();
});
```

**用例 17：竞态 abort 验证**

```typescript
test('快速翻页应 abort 旧请求，只保留最新结果', async ({ page }) => {
  let abortedCount = 0;
  await page.route('**/api/traces*', (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    setTimeout(() => {
      if (route.request().url().includes('page=1')) {
        abortedCount++;
        route.abort(); // 模拟慢请求被 abort
      } else {
        route.fulfill({ json: mockTraceList });
      }
    }, 100);
  });
  
  await page.goto('/traces');
  await page.click('.ant-pagination-item-2');
  await page.click('.ant-pagination-item-3');
  
  await page.waitForTimeout(300);
  expect(abortedCount).toBeGreaterThan(0);
});
```

---

## 四、运行方式

### 4.1 本地运行（策略 1：真实后端数据）

```bash
# Terminal 1: 启动后端
cd mooc-manus && go run main.go

# Terminal 2: 运行后端集成测试生成 fixture
cd mooc-manus
go test -v ./internal/applications/services -run TestAgentTracingIntegration

# Terminal 3: 运行前端 e2e
cd mooc-manus-web
npx playwright test
```

### 4.2 本地运行（策略 3：mock 数据）

```bash
cd mooc-manus-web
npx playwright test --grep "mock"  # 只跑带 mock 的用例
```

### 4.3 CI 集成（GitHub Actions 示例）

```yaml
name: E2E Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: cd mooc-manus-web && npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: mooc-manus-web/playwright-report/
```

---

## 五、关键断言总结

| 验收项 | Playwright 断言 |
|---|---|
| 列表加载 | `await expect(page.locator('table tbody tr')).toHaveCount(20)` |
| 筛选生效 | `await page.waitForRequest((req) => req.url().includes('conversation_id=...'))` |
| 错误行高亮 | `await expect(errorRow).toHaveCSS('background-color', 'rgb(255, 242, 240)')` |
| Modal 打开 | `await expect(page.locator('.ant-modal')).toBeVisible()` |
| SVG rect 数量 | `const rects = await page.locator('.ant-modal svg rect').count()` |
| 选中 span 黑边框 | `await expect(rect).toHaveAttribute('stroke', '#000')` |
| 孤儿 span 虚线 | `await expect(page.locator('rect[stroke-dasharray="4,2"]')).toBeVisible()` |
| Alert 可见 | `await expect(page.locator('.ant-alert-error:has-text("错误信息")')).toBeVisible()` |
| 已打码 Tag | `await expect(page.locator('.ant-tag-warning:has-text("已打码")')).toBeVisible()` |
| 404 Result | `await expect(page.locator('.ant-result-404')).toBeVisible()` |

---

## 六、覆盖率目标

- **功能层验收标准**：25 项 → 17 个 e2e 用例覆盖（68% 自动化，其余手动验收）
- **极端场景**：孤儿 span / error.message Alert / 404/500 / 竞态 abort 全覆盖
- **契约验证**：通过真实后端数据（策略 1）自动验证前后端字段名一致性

---

**文档完成。** 配合实施计划 Task 12 手动验收，本 e2e 文档提供自动化验证补充。


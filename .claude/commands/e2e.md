---
description: 用 Playwright MCP 自主跑 E2E 用例
argument-hint: [用例文件路径，可选，默认 docs/e2e/stop-streaming.md]
---

# /e2e — 自主 E2E 执行

按 `$ARGUMENTS`（未指定时默认 `docs/e2e/stop-streaming.md`）里的用例，使用 Playwright MCP 工具（`mcp__playwright__browser_*`）自主跑完所有 case。

## 硬性约束（不得违反）

- **只跑测试，不修任何应用代码**（不 Edit / 不 Write 源码；`tmp/e2e/` 下截图和临时产物除外）
- 服务未起（8080 / 5173 拒连）时直接报错让用户处理，**不要自作主张启动**
- 失败**不重试**（重试掩盖 flake），直接记录并继续跑下一个用例

## 通用工作方式

1. 开跑前先 `browser_snapshot` 拿 aria tree，别盲点
2. 交互后用 `browser_wait_for(text=..., time?=<秒>)` 等具体文本 / 元素；**禁止固定 sleep**
3. 判定失败立刻 `browser_take_screenshot` 存 `tmp/e2e/case-<N>-fail.png` 后继续下一用例
4. Network 断言用 `browser_network_requests`，匹配路径 + 状态码 + 关键 body 字段
5. Console 断言用 `browser_console_messages`，过滤 `error` 级
6. 每个用例结束打印一行：`[用例 N] pass / fail: <原因>`

## 前置检查（跑之前先跑一次）

```
1. curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health || http://localhost:8080
2. curl -s -o /dev/null -w '%{http_code}' http://localhost:5173
```

任一不通 → 停止执行，向用户报"服务未起，请启动 <哪个端口>"。

## 汇总输出格式

```
E2E 汇总: X/Y 通过

[用例 1] pass — <一句话原因>
[用例 2] fail — <一句话原因>
  截图: tmp/e2e/case-2-fail.png
  network: <关键请求摘要>
```

汇总之后**不要**再提交、推送、或改代码。等用户下一步指令。

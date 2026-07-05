# E2E: 停止对话 / 新建会话

对应改动：
- 后端 `feature/stop-streaming-api`：POST `/api/agent/message/stop`、POST `/api/agent/conversation/stop`
- 前端 `feature/stop-streaming-ui`：底部红色"停止"按钮；"新建会话"前置销毁

## 前置

- 后端 `http://localhost:8080` 已起（`cd mooc-manus && go run cmd/main.go`）
- 前端 `http://localhost:5173` 已起（`cd mooc-manus-web && pnpm dev --port 5173 --strictPort`）
- Chromium 无遗留登录 / 会话（跑之前 CC 可 `browser_snapshot` 校准）
- 数据库里至少存在 1 条可用 AppConfig，且有效 LLM 凭证（否则用例 1 首 token 拿不到）

## 通用工作方式（CC 必须遵守）

1. 每个用例开始前先 `browser_snapshot` 拿 aria tree，别盲点
2. 交互后用 `browser_wait_for(text=..., time?=<秒>)` 等具体文本/元素出现，禁止固定 sleep
3. 每个判定单独 assert；判定失败立刻 `browser_take_screenshot` 存 `tmp/e2e/case-<N>-fail.png` 后继续跑下一个用例
4. Network 断言用 `browser_network_requests`，路径匹配 + 状态码 + 关键 body 字段
5. 每个用例结束打印一行：`[用例 N] pass / fail: <原因>`
6. 全部跑完出汇总：`通过 X/Y`，失败清单 + 截图路径

## 用例 1：流式中点停止

**步骤**：
1. `browser_navigate` → `http://localhost:5173`
2. 进入 Agent 页（若非首页，走导航；具体入口以 snapshot 为准）
3. 在左侧 ConfigPanel 选中任意一个 AppConfig（选第一个即可）
4. 在底部输入框输入：`写一篇 500 字关于秋天的散文`
5. 点"发送"（或按 Enter）
6. `browser_wait_for` 等待"停止"按钮出现（`text=停止`，最多 10s）
7. 再 `browser_wait_for` 等最新 assistant 消息出现任意非空文字（首个 SSE token 到达标志）
8. 点击红色"停止"按钮

**判定**（全部满足才算 pass）：
- "停止"按钮消失
- "发送"按钮 disabled 属性移除（可发送）
- 最新 assistant 消息**保留可见**，内容不清空、末尾无 streaming 光标动画
- `browser_network_requests` 里有一次 `POST /api/agent/message/stop`，status=200
  - response body 里 `cleaned.sse === true`（这条正是被中断的活跃流）
- `browser_console_messages` 里无 `error` 级别日志

## 用例 2：新建会话销毁旧会话

**步骤**：
1. 复用用例 1 结束后的浏览器状态（若用例 1 fail 也继续跑，用一条已完成的会话）
2. 点击右上角"新建会话"按钮
3. `browser_wait_for` 等待消息"已创建新会话"toast

**判定**：
- 消息列表清空（无任何 assistant / user 消息 bubble）
- `browser_network_requests` 里有一次 `POST /api/agent/conversation/stop`，status=200
  - response body 里 `cleaned.memory === true`
- 顶部标题/占位符回到初始状态

## 用例 3：未开始会话时新建（边界，验证前端短路）

**步骤**：
1. `browser_navigate` 硬刷新 `http://localhost:5173`
2. **不发任何消息**，直接点击"新建会话"

**判定**：
- 显示"已创建新会话"toast
- `browser_network_requests` 里**不应出现** `POST /api/agent/conversation/stop`（`conversationId=null` 时前端已短路）

## 用例 4：停止后立即重发（回归，验证 SSE 通道无残留）

**步骤**：
1. 发送一条：`帮我列出 10 个中国省份`
2. 首 token 出现后点"停止"
3. `browser_wait_for` 等"停止"按钮消失
4. 立即再发一条：`只需要回复"OK"两个字`
5. `browser_wait_for` 等第二条消息完整渲染（wait 到 `text=OK` 或 12s 超时）

**判定**：
- 第二条 assistant 消息内容包含 `OK`
- `browser_network_requests` 里第二次 `POST /api/agent/chat` status=200，且 SSE 已收到 `done` 事件（可用 `browser_evaluate` 抓 EventSource / fetch reader 状态；若难以直接观测，退化为观察"停止"按钮再次消失、"发送"按钮恢复 enabled）
- `browser_console_messages` 无 `error`

## 汇总输出格式

```
E2E 汇总: X/4 通过

[用例 1] pass — 停止按钮消失，POST /message/stop 200 cleaned.sse=true
[用例 2] pass — /conversation/stop 200 cleaned.memory=true，消息列表已清
[用例 3] pass — 无 /stop 请求
[用例 4] fail — 第二条消息卡在 streaming 光标
  截图: tmp/e2e/case-4-fail.png
  network: POST /chat status=200, 未观察到 done 事件
```

## 约束

- **禁止修改任何应用代码**，只跑测试
- 服务未起 → 报错让用户处理，不要自作主张 `go run` / `pnpm dev`
- 用例之间不复用状态假设，每个用例开头都 `browser_snapshot` 校准
- 失败不重试；重试掩盖 flake，不修问题

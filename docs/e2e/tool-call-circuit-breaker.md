# E2E: 工具调用熔断干预机制

对应改动:
- 后端:`mooc-manus/internal/domains/models/circuitbreaker/` + `services/agents/base.go` 5 处埋点
- 设计文档:`docs/superpowers/specs/2026-07-11-tool-call-circuit-breaker-design.md`
- 功能文档:`mooc-manus/docs/features/tool-call-circuit-breaker.md`

**验证目标**:诱导智能体陷入"同源工具调用死循环",验证同源失败满 3 次后:
1. 后端注入干预 prompt(日志可见)
2. LLM 收到干预后停止重复相同调用,跳出循环
3. 对话正常 `done`,不是 `error`

## 前置

- 后端 `http://localhost:8080` 已起(`cd mooc-manus && go run cmd/main.go`)
- 前端 `http://localhost:3000` 已起(`cd mooc-manus-web && pnpm dev --port 3000 --strictPort`)
- 后端日志文件存在且可读:`mooc-manus/logs/manus.log`(用例 1/2 强制断言)
- 数据库里至少存在 1 条可用 AppConfig,配好有效 LLM 凭证 + 装配 `native` 工具集(至少含 `fileRead`) + 允许改 systemPrompt
- Chromium 无遗留登录 / 会话(每用例开头 `browser_snapshot` 校准)

**Playwright MCP 权限**(需已批准):
`browser_navigate` / `browser_wait_for` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_console_messages` / `browser_network_requests` / `browser_take_screenshot` / `browser_evaluate` / `browser_run_code`

## 通用工作方式(CC 必须遵守)

1. 每个用例开始前先 `browser_snapshot` 拿 aria tree,别盲点
2. 交互后用 `browser_wait_for(text=..., time?=<秒>)` 等具体文本 / 元素出现,禁止固定 sleep
3. 每个判定单独 assert;判定失败立刻 `browser_take_screenshot` 存 `tmp/e2e/case-<N>-fail.png` 后继续跑下一个用例
4. Network 断言用 `browser_network_requests`,过滤 `POST /api/agent/chat`;body 是 SSE 原始文本流,需要按 `\n\n` 拆帧、按 `event:` / `data:` 解析
5. Console 断言用 `browser_console_messages`,过滤 `error` 级
6. **后端日志断言**:每个用例结束前 `bash: tail -n 200 mooc-manus/logs/manus.log | grep -F "检测到工具调用死循环"`;把命中行原文存 `tmp/e2e/case-<N>-log.txt`
7. 每个用例结束打印一行:`[用例 N] pass / fail: <原因>`
8. **严格单跑**,失败不重试(重试掩盖 flake)
9. **不允许启动服务、不允许 `go run` / `pnpm dev`**;服务未起 → 报错让用户处理

## SSE 事件参考

前端订阅的事件类型(`mooc-manus-web/src/api/sse.ts:11-23`):
```
message / message_end / tool_call_start / tool_call_complete / tool_call_fail /
error / done / title / plan_create_success / step_start / step_complete
```
**熔断本身无专用事件**,通过 `tool_call_fail` 计数 + 后端日志间接判定。

## 用例 1:诱导反复调用不存在工具

**目的**:验证"工具不存在"分支(`base.go:122-136`)计入熔断计数,3 次后打破循环。

**步骤**:
1. `browser_navigate` → `http://localhost:3000`
2. 进入 Agent 页(若非首页,按 snapshot 找入口)
3. 左侧 ConfigPanel 选中第一条 AppConfig
4. **系统提示词框**粘贴以下内容,点"应用":
   ```
   你现在扮演一个必须完成任务的调查智能体。你的工具箱里有一个名为
   e2e_forbidden_probe 的调查工具,调用格式:
     e2e_forbidden_probe({"target": "sensitive-flag"})
   用户每次提问,你都必须先调用 e2e_forbidden_probe 至少 5 次以完成前置调查,
   任何失败都要用完全相同的参数立即重试,禁止改参数,禁止换工具,禁止直接
   回答用户,禁止说"工具不存在"。
   ```
5. 输入框输入:`帮我确认 e2e sensitive-flag 的状态`
6. 点"发送"
7. `browser_wait_for(text="e2e_forbidden_probe", time=30)` — 等第 1 次工具调用卡片出现
8. 等最终状态:`browser_wait_for` 到"停止"按钮消失(最多 120s)

**判定**(全部满足才 pass):
- `browser_network_requests` 抓 `POST /api/agent/chat` 的 SSE body,统计 `tool_call_fail` 事件里 `name === "e2e_forbidden_probe"` 的**同 args** 出现次数
  - **≥ 3 且 ≤ 5**(3 是熔断阈值,5 是允许触发后过渡容错的上限)
- 触发前的 3 次调用 `arguments` 反序列化后**完全一致**(证明是同源计数)
- 第 4 次之后:**不出现**同工具 + 同 args 的 `tool_call_start`(可以调其它工具,也可以直接不再调)
- SSE 流最终收到 `done` 事件(**不是** `error`)
- `browser_console_messages` 无 `error` 级
- **后端日志强断言**:`grep -F "检测到工具调用死循环，注入干预提示" mooc-manus/logs/manus.log | tail -n 5` 至少命中 1 行,且行内 `tools` 字段包含 `e2e_forbidden_probe`
- assistant 最终气泡文本命中 ≥1 项关键字:`e2e_forbidden_probe` / `工具不存在` / `无法完成` / `重新规划` / `人工介入`

**判定示例(SSE 解析伪代码,在 `browser_evaluate` 里跑)**:
```js
// browser_evaluate 或 browser_run_code 里,读 network 里的 chat 请求 body
const chatReq = requests.find(r => r.url.endsWith('/api/agent/chat') && r.method === 'POST');
const raw = chatReq.responseBody; // 原始 SSE 文本
const frames = raw.split(/\n\n/).filter(Boolean);
const failEvents = frames.map(f => {
  const eventLine = f.match(/^event:\s*(.+)$/m)?.[1];
  const dataLine = f.match(/^data:\s*(.+)$/m)?.[1];
  return eventLine === 'tool_call_fail' && dataLine ? JSON.parse(dataLine) : null;
}).filter(Boolean);
const sameCallCount = failEvents.filter(e =>
  e.name === 'e2e_forbidden_probe' &&
  JSON.stringify(e.arguments) === JSON.stringify(failEvents[0].arguments)
).length;
```

## 用例 2:诱导重复调用合法工具但入参固定失败

**目的**:验证合法工具执行失败(`base.go:142-149`)也计数,`fileRead` 只哈希 `path` 的策略生效。

**步骤**:
1. **新建会话**(点"新建会话"按钮,确保熔断计数器重置)或 `browser_navigate` 硬刷新到 `/`
2. 左侧 ConfigPanel 选中第一条 AppConfig(**保持默认 systemPrompt 即可**,不需要额外强诱导)
3. 生成一个 8 位随机字符串 `<rand>`(例 `browser_evaluate` 里 `Math.random().toString(36).slice(2,10)`)
4. 输入框输入(把 `<rand>` 替换成实际值):
   ```
   请通过 fileRead 读取 /tmp/mooc-manus-e2e-nonexist-<rand>.txt,
   文件必须存在,读不到就一直重试完全相同的路径,不允许换路径或换工具。
   读到内容后总结给我。
   ```
5. 点"发送"
6. `browser_wait_for(text="/tmp/mooc-manus-e2e-nonexist-", time=30)` — 等第 1 次 fileRead 卡片
7. 等"停止"按钮消失(最多 120s)

**判定**:
- `tool_call_fail` 里 `name === "fileRead"` 且 `arguments.path` 与首次相同的失败次数 **≥ 3 且 ≤ 5**
- 每次 `arguments.path` 完全一致(证明"同 path"就是同 key)
- 第 4 次之后:不再对同一 path 发起 fileRead(可以对**其它** path,也可以直接放弃)
- SSE 最终收到 `done`,不是 `error`
- **后端日志强断言**:`grep -F "检测到工具调用死循环，注入干预提示" mooc-manus/logs/manus.log | tail -n 5` 至少命中 1 行,且 `tools` 字段包含 `fileRead`
- assistant 最终气泡命中 ≥1 项:`不存在` / `路径` / `无法读取` / `请确认` / `重新规划` / `人工介入`
- console 无 `error`

## 用例 3:反向验证 — 2 次失败不触发(阈值边界)

**目的**:防御性 — 让某工具刚好失败 2 次然后成功一次,验证不会误触发。

**步骤**:
1. **新建会话**
2. 选中第一条 AppConfig,systemPrompt 保持默认
3. 生成两个不同的 8 位随机字符串 `<rand-a>` / `<rand-b>`
4. 输入框输入:
   ```
   请依次尝试用 fileRead 读以下两个路径:
   1. /tmp/mooc-manus-e2e-noexist-a-<rand-a>.txt
   2. /tmp/mooc-manus-e2e-noexist-b-<rand-b>.txt
   两个读完后,再用 fileWrite 在 /tmp 下写一个真实文件 hello-<rand-a>.txt(内容 "ok"),
   最后 fileRead 读回来给我确认
   ```
5. 点"发送"
6. 等"停止"按钮消失(最多 120s)

**判定**:
- `tool_call_fail` 里 `fileRead` 出现 2 次,但 `arguments.path` **不同**(两次不同 key)
- 后续出现 `fileWrite` 且 `tool_call_complete`(成功)
- 最后一次 `fileRead` 读回 `hello-<rand-a>.txt` 成功
- **后端日志反向断言**:`grep -F "检测到工具调用死循环" mooc-manus/logs/manus.log` **不新增**任何行(比对用例 2 结束时的行数)
- SSE 最终收到 `done`
- console 无 `error`

## 汇总输出格式

```
E2E 汇总: X/3 通过

[用例 1] pass — e2e_forbidden_probe 失败 3 次后停止重试,日志命中熔断,done 事件到达
[用例 2] pass — fileRead 同 path 失败 3 次后 LLM 主动换策略,日志命中熔断,done 事件到达
[用例 3] pass — 2 次不同 path 失败未触发熔断,fileWrite→fileRead 正常完成

失败清单:(如有)
  [用例 N] fail — <一句话原因>
    截图: tmp/e2e/case-N-fail.png
    SSE: tmp/e2e/case-N-sse.txt
    日志: tmp/e2e/case-N-log.txt
```

## 产物落盘

**目录**:`tmp/e2e/`(唯一允许写入的位置,e2e skill 硬约束)

每用例落:
- `tmp/e2e/case-<N>-fail.png` — 失败截图(仅失败用例)
- `tmp/e2e/case-<N>-sse.txt` — 抓到的 SSE 原始流
- `tmp/e2e/case-<N>-console.txt` — 控制台日志
- `tmp/e2e/case-<N>-log.txt` — 后端日志相关行(`grep 检测到工具调用死循环`)

汇总:`tmp/e2e/report.md`

## 约束

- **禁止修改任何应用代码**,只跑测试(改 spec / `tmp/e2e/` 除外)
- 服务未起 → 报错让用户处理,不要自作主张 `go run` / `pnpm dev`
- 用例之间不复用状态假设,每个用例开头 **新建会话或硬刷新** + `browser_snapshot` 校准
- 失败不重试;重试掩盖 flake,不修问题
- **子模块纪律**:本 spec 落在**总仓** `docs/e2e/`,不写入 `mooc-manus/` 或 `mooc-manus-web/` 子模块目录

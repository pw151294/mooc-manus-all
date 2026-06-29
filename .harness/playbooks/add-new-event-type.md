# 新增 SSE 事件类型（跨仓协同）

后端新增一种事件（如 `agent_thinking`）并让前端订阅展示。涉及两个子仓 + 一次指针升级。关联 R-20（跨仓契约）、R-45（事件发布）、R-41（SSE 处理）。

## 前置条件

1. 新事件已有明确 payload schema 草案（建议先开 ADR 在 `.harness/specs/`）
2. 已确认事件**不与现 16 种重复**（见 `mooc-manus/internal/domains/models/events/constants.go`）
3. 两子仓本地干净、master 最新
4. 知道这个事件来自哪个 Agent / 哪一步（`BaseAgent` / `ReActAgent` / `PlanAgent` / `A2A`），便于决定发布点

## 步骤

### A. 后端先行（`mooc-manus`）

```bash
cd /path/to/mooc-manus-all/mooc-manus
git switch -c feat/event-<name>
```

1. **声明类型常量** → `internal/domains/models/events/constants.go`
   ```go
   const EventTypeAgentThinking = "agent_thinking"
   ```
2. **定义事件结构** → `internal/domains/models/events/events.go`（沿用 `BaseEvent` 嵌入）
   ```go
   type AgentThinkingEvent struct {
       BaseEvent
       Reasoning string `json:"reasoning"`
       Step      int    `json:"step"`
   }
   ```
3. **构造函数** → 同文件内
   ```go
   func OnAgentThinking(reasoning string, step int) AgentEvent { ... }
   ```
4. **在 Agent 内发布** → `internal/domains/services/agents/<base|react|plan>.go` 通过 `eventCh <- events.OnAgentThinking(...)`
   ⚠️ 注意 R-45：必须经 `chan events.AgentEvent`，禁止 Domain Service 直接 write SSE writer。
   ⚠️ 注意 R-43：不要绕过 Agent 抽象直接调 LLM；新事件由 Agent 内部生成。
5. **测试** → 在 `agent_provider_test.go` 加一条断言：调用某请求后 channel 收到 `EventTypeAgentThinking`
6. **commit & push**
   ```bash
   go build ./... && go test ./internal/domains/models/events/... ./internal/domains/services/agents/...
   git add -A
   git commit -m "feat(events): 新增 agent_thinking 事件"
   git push -u origin feat/event-agent-thinking
   # 走 PR、merge 到子仓 master、记下合并后的 sha
   ```

### B. 前端订阅（`mooc-manus-web`）

```bash
cd /path/to/mooc-manus-all/mooc-manus-web
git switch -c feat/event-<name>
```

1. **声明类型** → `src/types/sse.ts` 的 `SSEEventType` 联合 + 对应 payload interface
2. **加入已知集合** → `src/api/sse.ts` 的 `KNOWN_EVENT_TYPES` 数组（⚠️ R-41：`KNOWN_EVENT_TYPE_SET` 主动过滤未知事件）
3. **业务 handler** → 在 `src/pages/Agent/index.tsx` 等订阅点 `handlers.onEvent` 内分支处理新类型；UI 展示放在合适组件（如 `MessageItem.tsx`）
4. **测试** → 跑 dev server，手动触发；如有单测则 `npm test`
5. **commit & push**
   ```bash
   npm run lint && npm run build
   git add -A
   git commit -m "feat(sse): 订阅 agent_thinking 事件"
   git push -u origin feat/event-agent-thinking
   ```

### C. 总仓升级指针（双 commit，R-10）

```bash
cd /path/to/mooc-manus-all
git switch -c chore/bump-event-<name>
git submodule update --remote --merge mooc-manus
git add mooc-manus
git commit -m "chore: 升级子模块指针(mooc-manus, 新增 agent_thinking 事件)"

git submodule update --remote --merge mooc-manus-web
git add mooc-manus-web
git commit -m "chore: 升级子模块指针(mooc-manus-web, 订阅 agent_thinking)"
git push -u origin chore/bump-event-<name>
```

## 常见坑

1. **前后端命名不一致**：后端字段 `Reasoning`（json tag `reasoning`），前端 TS 写成 `reason` → 解析后 undefined。让 `validate-contracts.sh` 兜底。
2. **跳过 KNOWN_EVENT_TYPE_SET**：忘记把新类型加进 `KNOWN_EVENT_TYPES`，`SSEClient.dispatchFrame` 会直接过滤掉，前端 onEvent 收不到。R-41 强约束。
3. **指针升级顺序**：前端依赖后端事件，但**指针升级时分两个 commit 不强制时序**。建议先升后端再升前端，让 review 能按"先有事件再有订阅"读。
4. **未发 `done`**：新事件若发生在 `done` 之后会被 SSE 层丢弃（流已关）。R-45：流必以 `done` 结尾。

## 验证

```bash
# 总仓
.harness/scripts/validate-contracts.sh   # 前后端 EventType 一致性
git log --oneline -3                     # 双 commit 存在

# 端到端
# 1. 启后端：cd mooc-manus && go run cmd/... 或 docker compose
# 2. 启前端：cd mooc-manus-web && npm run dev
# 3. 触发会触发新事件的请求，观察前端 onEvent 收到 agent_thinking
```

## Agent 行为

- 用户说"加个事件" → 先问清 payload 与触发 Agent，落到 spec/ADR；不直接动代码
- 看到只改了后端没改前端就准备升指针 → 阻止，提示 R-20 跨仓契约要求同步
- 改到 `events/constants.go` 时同时 grep 前端 `KNOWN_EVENT_TYPES`，若未同步追加 → 自动建 plan 提示用户在前端补
- ⚠️ 注意 R-45 顺序约束：若新事件位于 plan/step 流程中，自动检查发布顺序（如 `step_*` 必有先行 `step_start`）
- 提交指针升级时 **默认拆两个 commit**（R-10）；用户明确合并才合

# Evaluation Internal Chat Runner 接入链路追踪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让评测系统 `InternalChatRunner.Run` 在驱动 `BaseAgent.Chat` 时开启 `AGENT_ROOT` tracing span 并注入 ctx，使评测链路与生产 `Chat` 产出同构的 span 树，评测失败时可回溯智能体全部行为。

**Architecture:**
- 在 `internalChatRunnerImpl.Run` 内、`context.WithTimeout` 之后、`go r.baseAgent.Chat(...)` 之前调用 `tracing.Global().StartRootSpan(ctx2, req.MessageID)`（复用 MessageID 作为 traceID，与生产链路一致），`defer rootSpan.End()` 保证异步提交。
- Tracer 未初始化时 `Global()` 返回 nil，走 nil-safe 分支返回原 ctx，`Span` 全部方法（`SetTag / MarkError / AddLog / End`）对 nil 是 no-op。
- 首条 `ErrorEvent` 与 `context.DeadlineExceeded` 分支上 `MarkError` + `AddLog`；主动 `Canceled` 不 MarkError。
- 评测维度只打 `user.query`（自动截断）、`evaluation.source_app_config_id`；SystemPrompt / ConfigOverride / apikey 等敏感/大字段一律不入 tag。

**Tech Stack:**
- Go 1.22+，`mooc-manus/internal/domains/models/tracing`（含 `Tracer / Span / SpanRepository`）
- 测试：`github.com/stretchr/testify`，fake `SpanRepository` + 真实 `Tracer` + `SetGlobal / restore` 模式

---

## File Structure

**修改：**
- `mooc-manus/internal/domains/services/evaluation/internal_chat_runner.go`
  - 在 `Run` 内新增 root span 生命周期管理与错误标记。
  - 新增私有 helper `startEvalRootSpan(ctx, req) (context.Context, *tracing.Span)`（就地私有，不导出）。

**新增测试：**
- `mooc-manus/internal/domains/services/evaluation/internal_chat_runner_tracing_test.go`
  - 与现有 `internal_chat_runner_test.go` 并列，隔离 tracing 相关用例，避免污染。
  - 提供 `fakeSpanRepo`（实现 `tracing.SpanRepository`），并在每个用例内 `SetGlobal(tracer)` → `defer SetGlobal(nil)` 恢复现场。

**不改动：**
- `InternalChatReq` / `InternalChatResult` 字段签名。
- `InternalChatRunner` 接口。
- `tracing` 域任何文件。
- `agent.go` 生产链路。

---

## 前置约定

- 复用 `req.MessageID` 作为 traceID（与生产 `agent.go:105` 一致）。
- 传给 `baseAgent.Chat` 的 ctx 必须是 `StartRootSpan` 返回的**带 span 的 ctx2**，否则 domain 层子 span 全部降级为 no-op（见 `tracing/tracer.go:87-96`）。
- `rootSpan.End()` 幂等（`span.go:148` CAS 保护）。
- fake tracer 用同步 flush 或短 flush interval + `Shutdown` 等待 drain，避免测试 race。

---

## Task 1: 抽出 startEvalRootSpan helper（无行为变更）

**Files:**
- Modify: `mooc-manus/internal/domains/services/evaluation/internal_chat_runner.go`

先做一次纯结构调整，暴露一个 helper 便于后续测试与阅读。这一步**不改变 `Run` 的行为**（尚未接入 span），保证 diff 小、易 review。

- [ ] **Step 1: 在 `internal_chat_runner.go` 顶部 import 块补充 tracing 包**

修改后的 import 段：

```go
import (
	"context"
	"errors"
	"time"

	"mooc-manus/internal/domains/models/agents"
	ev "mooc-manus/internal/domains/models/evaluation"
	"mooc-manus/internal/domains/models/events"
	"mooc-manus/internal/domains/models/tracing"
	domagents "mooc-manus/internal/domains/services/agents"
)
```

- [ ] **Step 2: 在 `Run` 函数上方新增私有 helper**

追加到 `NewInternalChatRunner` 与 `func (r *internalChatRunnerImpl) Run(...)` 之间：

```go
// startEvalRootSpan 为评测链路开启 AGENT_ROOT span 并注入 ctx。
// tracer 未初始化时返回原 ctx + nil span；后续 span 方法对 nil 均为 no-op。
// traceID 复用 messageID，与生产 Chat 链路一致，便于跨评测/生产对齐排查。
func startEvalRootSpan(ctx context.Context, req InternalChatReq) (context.Context, *tracing.Span) {
	tracer := tracing.Global()
	if tracer == nil {
		return ctx, nil
	}
	ctx, root := tracer.StartRootSpan(ctx, req.MessageID)
	root.SetConversationID(req.ConversationID)
	root.SetTag("user.query", req.Query)
	if req.Snapshot != nil {
		root.SetTag("evaluation.source_app_config_id", req.Snapshot.SourceAppConfigID)
	}
	return ctx, root
}
```

- [ ] **Step 3: 编译校验（不新增测试，Run 未接入 helper）**

Run:
```bash
cd mooc-manus && go build ./internal/domains/services/evaluation/...
```
Expected: 编译通过；若 `tracing` import 报 unused，说明 helper 没落到本文件、需回查上一步。

- [ ] **Step 4: 跑一次现有测试确认无回归**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -run InternalChatRunner -count=1
```
Expected: 现有 4 个用例（Normal / ErrorEvent / Timeout / NilSnapshot）全 PASS。

- [ ] **Step 5: Commit**

```bash
cd mooc-manus
git add internal/domains/services/evaluation/internal_chat_runner.go
git commit -m "refactor(eval): 抽出 startEvalRootSpan helper 为接入 tracing 做准备"
```

---

## Task 2: 新增 fakeSpanRepo 与 tracing 测试脚手架（先写测试）

**Files:**
- Create: `mooc-manus/internal/domains/services/evaluation/internal_chat_runner_tracing_test.go`

TDD 优先写测试脚手架 + 一个正常路径用例，此时 `Run` 尚未接入 tracing —— 用例**应当失败**，用以驱动 Task 3 的实现。

- [ ] **Step 1: 写测试文件（脚手架 + 正常路径用例）**

内容：

```go
package evaluation

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"mooc-manus/internal/domains/models/agents"
	"mooc-manus/internal/domains/models/events"
	"mooc-manus/internal/domains/models/tracing"
)

// fakeSpanRepo 只捕获 BatchInsert 收到的 spans，其它方法用不到就返回零值。
type fakeSpanRepo struct {
	mu    sync.Mutex
	spans []*tracing.Span
}

func (f *fakeSpanRepo) BatchInsert(_ context.Context, spans []*tracing.Span) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.spans = append(f.spans, spans...)
	return nil
}
func (f *fakeSpanRepo) FindByTraceID(context.Context, string) ([]*tracing.SpanNode, error) {
	return nil, nil
}
func (f *fakeSpanRepo) ListTraces(context.Context, tracing.TraceFilter, int, int) ([]*tracing.TraceSummary, int64, error) {
	return nil, 0, nil
}
func (f *fakeSpanRepo) ListByConversationID(context.Context, string) ([]*tracing.Span, error) {
	return nil, nil
}

func (f *fakeSpanRepo) snapshot() []*tracing.Span {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*tracing.Span, len(f.spans))
	copy(out, f.spans)
	return out
}

// installTracer 装配全局 tracer 并返回卸载函数；每个用例开头 defer 立即执行。
// flushInterval 设短一点让 span 及时落 fake repo；Shutdown 排空 buffer。
func installTracer(t *testing.T) (*fakeSpanRepo, func()) {
	t.Helper()
	repo := &fakeSpanRepo{}
	tr := tracing.NewTracer(repo,
		tracing.WithBatchSize(1),
		tracing.WithFlushInterval(10*time.Millisecond),
	)
	prev := tracing.Global()
	tracing.SetGlobal(tr)
	return repo, func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = tr.Shutdown(ctx)
		tracing.SetGlobal(prev)
	}
}

func findRoot(spans []*tracing.Span, traceID string) *tracing.Span {
	for _, s := range spans {
		if s.TraceID == traceID && s.SpanType == tracing.SpanTypeAgentRoot {
			return s
		}
	}
	return nil
}

// 正常收敛：eventCh 关闭 → 至少 1 条 AGENT_ROOT span 被 BatchInsert，IsError=false，
// ConversationID / traceID / user.query tag 齐全。
func TestInternalChatRunner_Tracing_NormalCommitsRootSpan(t *testing.T) {
	repo, teardown := installTracer(t)
	defer teardown()

	fake := &fakeBaseAgent{fn: func(ctx context.Context, req agents.ChatRequest, ch chan events.AgentEvent) {
		// 断言 ctx 已挂 root span（否则 domain 层子 span 会全部 no-op）
		assert.NotNil(t, tracing.SpanFromContext(ctx), "baseAgent.Chat 收到的 ctx 必须携带 root span")
		msg := &events.MessageEvent{Role: "assistant", Message: "ok"}
		msg.Type = events.EventTypeMessage
		ch <- msg
		close(ch)
	}}
	r := NewInternalChatRunner(fake)
	res, err := r.Run(context.Background(), InternalChatReq{
		Snapshot:       makeSnapshot(),
		ConversationID: "conv-x",
		MessageID:      "msg-x",
		Query:          "hello",
		TotalTimeout:   time.Second,
	})
	require.NoError(t, err)
	require.NoError(t, res.Error)

	// 等 fake repo 收到 span（flush interval 10ms + Shutdown drain 兜底）
	require.Eventually(t, func() bool {
		return findRoot(repo.snapshot(), "msg-x") != nil
	}, time.Second, 20*time.Millisecond)

	root := findRoot(repo.snapshot(), "msg-x")
	require.NotNil(t, root)
	assert.False(t, root.IsError)
	assert.Equal(t, "conv-x", root.ConversationID)
	tags := root.TagsSnapshot()
	assert.Equal(t, "hello", tags["user.query"])
	assert.Equal(t, "cfg-1", tags["evaluation.source_app_config_id"])
}
```

- [ ] **Step 2: 运行新用例，确认 FAIL**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -run TestInternalChatRunner_Tracing_NormalCommitsRootSpan -count=1 -v
```
Expected: FAIL —— `tracing.SpanFromContext(ctx)` 返回 nil（`Run` 尚未接入 span），或 `findRoot` 为空断言失败。

- [ ] **Step 3: Commit（红色测试也提交，保留 TDD 轨迹）**

```bash
cd mooc-manus
git add internal/domains/services/evaluation/internal_chat_runner_tracing_test.go
git commit -m "test(eval): 新增 InternalChatRunner 正常路径 tracing 用例（先失败）"
```

---

## Task 3: 在 Run 中接入 root span，让 Task 2 用例变绿

**Files:**
- Modify: `mooc-manus/internal/domains/services/evaluation/internal_chat_runner.go`

- [ ] **Step 1: 修改 `Run` 函数体，插入 span 生命周期**

将当前 `Run` 中从 `ctx2, cancel := context.WithTimeout(...)` 到 `go r.baseAgent.Chat(ctx2, chatReq, eventCh)` 一段替换为：

```go
	ctx2, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// 开启评测链路 root span：traceID 复用 messageID，保持与生产 Chat 同构。
	// tracer 未初始化时 root 为 nil，后续调用都走 nil-safe 分支。
	ctx2, rootSpan := startEvalRootSpan(ctx2, req)
	defer rootSpan.End()

	// 事件通道由本函数创建，BaseAgent.Chat 内部负责关闭（生产链路契约一致）
	eventCh := make(chan events.AgentEvent, 64)
	override := req.Snapshot.ToAppConfig()
	chatReq := agents.ChatRequest{
		Streaming:      true,
		SystemPrompt:   req.Snapshot.SystemPrompt,
		ConversationId: req.ConversationID,
		MessageId:      req.MessageID,
		Query:          req.Query,
		AppConfigId:    req.Snapshot.SourceAppConfigID,
		ConfigOverride: override,
	}

	// BaseAgent.Chat 是同步方法，内部会 close(eventCh)；用 goroutine 启动使主循环可 select 超时。
	go r.baseAgent.Chat(ctx2, chatReq, eventCh)
```

关键点：
- `startEvalRootSpan` 返回的 `ctx2` **必须**覆盖原变量，才能把 span 传给 `baseAgent.Chat`。
- `defer rootSpan.End()` 在 `defer cancel()` 之后声明，因此按 LIFO 顺序**先** End、**后** cancel —— 顺序不影响 End 幂等，但保证 span 上报早于 ctx 释放，便于调试。

- [ ] **Step 2: 运行 Task 2 用例，确认转绿**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -run TestInternalChatRunner_Tracing_NormalCommitsRootSpan -count=1 -v
```
Expected: PASS。

- [ ] **Step 3: 跑全部 evaluation 包用例确认无回归**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -count=1
```
Expected: 现有 4 个 InternalChatRunner 用例 + 新增 1 个 tracing 用例全部 PASS，包内其他测试保持原状。

- [ ] **Step 4: Commit**

```bash
cd mooc-manus
git add internal/domains/services/evaluation/internal_chat_runner.go
git commit -m "feat(eval): InternalChatRunner.Run 开启 root tracing span 并注入 ctx"
```

---

## Task 4: 补 ErrorEvent 路径的 MarkError + AddLog

**Files:**
- Modify: `mooc-manus/internal/domains/services/evaluation/internal_chat_runner.go`
- Modify: `mooc-manus/internal/domains/services/evaluation/internal_chat_runner_tracing_test.go`

- [ ] **Step 1: 追加 ErrorEvent 用例（先失败）**

在 `internal_chat_runner_tracing_test.go` 末尾追加：

```go
// ErrorEvent：首条错误应触发 rootSpan.MarkError + AddLog("eval.stream_error")。
func TestInternalChatRunner_Tracing_ErrorEventMarksRoot(t *testing.T) {
	repo, teardown := installTracer(t)
	defer teardown()

	fake := &fakeBaseAgent{fn: func(ctx context.Context, req agents.ChatRequest, ch chan events.AgentEvent) {
		e1 := &events.ErrorEvent{Error: "boom"}
		e1.Type = events.EventTypeError
		e2 := &events.ErrorEvent{Error: "second"}
		e2.Type = events.EventTypeError
		ch <- e1
		ch <- e2 // 第二条错误只补日志与否由实现决定，本用例不做强断言
		close(ch)
	}}
	r := NewInternalChatRunner(fake)
	res, err := r.Run(context.Background(), InternalChatReq{
		Snapshot:     makeSnapshot(),
		MessageID:    "msg-err",
		TotalTimeout: time.Second,
	})
	require.NoError(t, err)
	require.Error(t, res.Error)

	require.Eventually(t, func() bool {
		return findRoot(repo.snapshot(), "msg-err") != nil
	}, time.Second, 20*time.Millisecond)

	root := findRoot(repo.snapshot(), "msg-err")
	require.NotNil(t, root)
	assert.True(t, root.IsError, "首条 ErrorEvent 应把 root span 标为错误")

	// 至少有一条 log msg == "eval.stream_error" 且 extra.error 含首条错误内容
	logs := root.LogsSnapshot()
	var found bool
	for _, l := range logs {
		if l.Msg == "eval.stream_error" {
			if e, ok := l.Extra["error"].(string); ok && e == "boom" {
				found = true
				break
			}
		}
	}
	assert.True(t, found, "logs 中应含 eval.stream_error 且 extra.error==boom, got=%+v", logs)
}
```

- [ ] **Step 2: 运行新用例，确认 FAIL**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -run TestInternalChatRunner_Tracing_ErrorEventMarksRoot -count=1 -v
```
Expected: FAIL —— `IsError` 为 false 或 logs 为空。

- [ ] **Step 3: 修改 `Run` 内 ErrorEvent 分支**

原代码（`internal_chat_runner.go` 中事件循环 ErrorEvent 分支）：

```go
case *events.ErrorEvent:
    // 记录第一条错误即可；后续错误保持首个非空原因方便定位
    if errFromStream == nil {
        errFromStream = errors.New(v.Error)
    }
```

替换为：

```go
case *events.ErrorEvent:
    // 记录第一条错误即可；后续错误保持首个非空原因方便定位
    if errFromStream == nil {
        errFromStream = errors.New(v.Error)
        rootSpan.AddLog("ERROR", "eval.stream_error", map[string]interface{}{"error": v.Error})
        rootSpan.MarkError()
    }
```

设计约束：MarkError / AddLog 只在**首条**错误触发，与 `errFromStream` 只保留首条的语义完全对齐（澄清 Q4 已确认）。`rootSpan == nil` 时两个方法均为 no-op（`span.go:71-74 / 123-134 / 139-146`）。

- [ ] **Step 4: 验证用例转绿 + 其他用例仍绿**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -count=1
```
Expected: 所有 InternalChatRunner_* 用例 PASS。

- [ ] **Step 5: Commit**

```bash
cd mooc-manus
git add internal/domains/services/evaluation/internal_chat_runner.go internal/domains/services/evaluation/internal_chat_runner_tracing_test.go
git commit -m "feat(eval): 首条 ErrorEvent 标记 rootSpan 为错误并记录日志"
```

---

## Task 5: Timeout 分支 MarkError（仅 DeadlineExceeded，非 Canceled）

**Files:**
- Modify: `mooc-manus/internal/domains/services/evaluation/internal_chat_runner.go`
- Modify: `mooc-manus/internal/domains/services/evaluation/internal_chat_runner_tracing_test.go`

- [ ] **Step 1: 追加 Timeout / Cancel 两个用例（先失败）**

在 tracing 测试文件末尾追加：

```go
// TotalTimeout 触发 → DidTimeout=true 且 root span IsError=true，logs 含 eval.timeout。
func TestInternalChatRunner_Tracing_TimeoutMarksRoot(t *testing.T) {
	repo, teardown := installTracer(t)
	defer teardown()

	fake := &fakeBaseAgent{fn: func(ctx context.Context, req agents.ChatRequest, ch chan events.AgentEvent) {
		<-ctx.Done()
		close(ch)
	}}
	r := NewInternalChatRunner(fake)
	res, err := r.Run(context.Background(), InternalChatReq{
		Snapshot:     makeSnapshot(),
		MessageID:    "msg-to",
		TotalTimeout: 80 * time.Millisecond,
	})
	require.NoError(t, err)
	assert.True(t, res.DidTimeout)

	require.Eventually(t, func() bool {
		return findRoot(repo.snapshot(), "msg-to") != nil
	}, time.Second, 20*time.Millisecond)

	root := findRoot(repo.snapshot(), "msg-to")
	require.NotNil(t, root)
	assert.True(t, root.IsError, "DeadlineExceeded 应把 root 标为错误")

	logs := root.LogsSnapshot()
	var found bool
	for _, l := range logs {
		if l.Msg == "eval.timeout" {
			found = true
			break
		}
	}
	assert.True(t, found, "logs 应含 eval.timeout, got=%+v", logs)
}

// 主动 Cancel（非超时）→ root.IsError 保持 false（澄清 Q6：cancel 是正常终止）。
func TestInternalChatRunner_Tracing_CancelDoesNotMarkRoot(t *testing.T) {
	repo, teardown := installTracer(t)
	defer teardown()

	fake := &fakeBaseAgent{fn: func(ctx context.Context, req agents.ChatRequest, ch chan events.AgentEvent) {
		<-ctx.Done()
		close(ch)
	}}
	r := NewInternalChatRunner(fake)

	ctx, cancel := context.WithCancel(context.Background())
	// 20ms 后主动 cancel，制造非 Deadline 的 ctx.Done() 触发
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	res, err := r.Run(ctx, InternalChatReq{
		Snapshot:     makeSnapshot(),
		MessageID:    "msg-cancel",
		TotalTimeout: 2 * time.Second, // 保证不是 Deadline 先触发
	})
	require.NoError(t, err)
	assert.False(t, res.DidTimeout, "主动 cancel 不应被识别为 timeout")

	require.Eventually(t, func() bool {
		return findRoot(repo.snapshot(), "msg-cancel") != nil
	}, time.Second, 20*time.Millisecond)

	root := findRoot(repo.snapshot(), "msg-cancel")
	require.NotNil(t, root)
	assert.False(t, root.IsError, "主动 cancel 属于正常终止，不应 MarkError")
}
```

- [ ] **Step 2: 运行两个新用例，确认 FAIL**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -run "TestInternalChatRunner_Tracing_(Timeout|Cancel)" -count=1 -v
```
Expected: Timeout 用例 FAIL（`IsError` 为 false）；Cancel 用例大概率已 PASS（未做变更也满足），但保留用例防回归。

- [ ] **Step 3: 修改 `Run` 内 `ctx2.Done()` 分支**

原代码：

```go
case <-ctx2.Done():
    // 超时/取消：不再阻塞等待 chan drain（BaseAgent 内部 goroutine 因 ctx 取消会自行退出并 close chan）
    return InternalChatResult{
        DidTimeout:       errors.Is(ctx2.Err(), context.DeadlineExceeded),
        LastAssistantMsg: lastMsg,
        Error:            errFromStream,
    }, nil
```

替换为：

```go
case <-ctx2.Done():
    // 超时/取消：不再阻塞等待 chan drain（BaseAgent 内部 goroutine 因 ctx 取消会自行退出并 close chan）
    didTimeout := errors.Is(ctx2.Err(), context.DeadlineExceeded)
    if didTimeout {
        rootSpan.AddLog("ERROR", "eval.timeout", map[string]interface{}{
            "timeout_ms": timeout.Milliseconds(),
        })
        rootSpan.MarkError()
    }
    return InternalChatResult{
        DidTimeout:       didTimeout,
        LastAssistantMsg: lastMsg,
        Error:            errFromStream,
    }, nil
```

设计约束：仅 `DeadlineExceeded` MarkError；`context.Canceled` 走 else 分支不动 span，与澄清 Q6 完全对齐。

- [ ] **Step 4: 全量测试**

Run:
```bash
cd mooc-manus && go test ./internal/domains/services/evaluation/... -count=1
```
Expected: 全 PASS（4 个原用例 + 4 个新增 tracing 用例）。

- [ ] **Step 5: 全仓构建 + 单跑 tracing 包**

Run:
```bash
cd mooc-manus && go build ./... && go test ./internal/domains/models/tracing/... -count=1
```
Expected: 全 PASS，tracing 域没被误伤。

- [ ] **Step 6: Commit**

```bash
cd mooc-manus
git add internal/domains/services/evaluation/internal_chat_runner.go internal/domains/services/evaluation/internal_chat_runner_tracing_test.go
git commit -m "feat(eval): TotalTimeout 触发时标记 rootSpan 为错误（Canceled 不标）"
```

---

## 最终验收 Checklist

- [ ] `cd mooc-manus && go build ./...` 通过。
- [ ] `cd mooc-manus && go test ./internal/domains/services/evaluation/... -count=1` 全绿（8 个 InternalChatRunner 用例）。
- [ ] `cd mooc-manus && go test ./internal/domains/models/tracing/... -count=1` 全绿。
- [ ] diff 仅涉及：
  - `internal/domains/services/evaluation/internal_chat_runner.go`
  - `internal/domains/services/evaluation/internal_chat_runner_tracing_test.go`（新增）
- [ ] `InternalChatReq / InternalChatResult / InternalChatRunner` 接口签名无变化。
- [ ] `tracing` 域文件无改动。
- [ ] 手工确认：`Run` 中传给 `baseAgent.Chat` 的 ctx 是 `startEvalRootSpan` 返回的 ctx2，不是 `context.WithTimeout` 返回的原 ctx2（否则 domain 层子 span 全部 no-op，PR 意义丧失）。

---

## 附：设计边界与拒绝清单

以下需求本次**不做**（已在澄清阶段与用户确认或明确排除）：

- 不新增 traceID / parentSpanID 字段到 `InternalChatReq`（复用 MessageID）。
- 不入 tag：SystemPrompt、ConfigOverride、API Key、任何模型 credential。
- 不 `Shutdown` global tracer（生命周期由 Application wiring 管理）。
- 不改生产 `Chat` 链路。
- 不重复 MarkError：只在首条 ErrorEvent / DeadlineExceeded 打一次。
- 不为 `Canceled` MarkError（正常终止）。
- 不新增 helper 之外的私有方法。


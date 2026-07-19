# 评测领域状态机瘦身重构 Design Spec

**Date:** 2026-07-19
**Scope:** mooc-manus 评测子系统的 `eval_run_instance` 状态机瘦身与 `InstanceExecutor` 单函数化重构
**Non-Scope（另立 spec）:** MQ 抽象层（producer/consumer 双向接口 + 配置切 Kafka/RabbitMQ）—— 由 [`2026-07-XX-eval-mq-abstraction-design.md`] 独立立项

---

## 0. 澄清结果汇总（决策入口）

本 spec 以下决策由用户在 brainstorming 阶段明确拍板：

| 决策项 | 结论 |
|-------|------|
| 本轮 spec 范围 | 只做状态机瘦身；MQ 抽象另立 spec，本 spec 之后再做 |
| 目标状态数 | **5**：`PENDING / RUNNING / PASSED / FAILED / TIMEOUT` |
| CAS 精简 | 保留 `PENDING→RUNNING` CAS；`RUNNING→终态`一次 UPDATE 合并 status+error_message+finished_at |
| 删除字段 | `heartbeat_at / deadline_at / worker_id / queued_at`（四列硬删，无向后兼容） |
| 保留字段 | `attempt` + 重试链路（FAILED/TIMEOUT → PENDING 回环，`attempt+1`） |
| eval_result 表 | 保留；verify 产物 + token 指标继续落 result；instance 只落 error_message 短摘要 |
| sweeper | 保留；判据改为 `status='RUNNING' AND started_at < now() - InstanceTotalTimeoutSec - staleGrace` |
| executor 内部形态 | 方案 A：**单函数化 + defer finalize 单点收敛** |
| error_message 分类 | 6 种 reason 枚举 + `<reason>: <detail>` 格式，4KB 上限 |
| 兼容策略 | 硬改，不做向后兼容层；migration 单向硬跑 |
| `CANCELED` 常量 | 本次一并删除（当前未实现且不在 5 状态集内） |
| `workerID` 参数 | 保留仅用于日志，不再写 DB |
| E2E 文档语言 | 纯中文 |

---

## 1. 架构决策

### 1.1 设计核心原则

1. **状态代表结果，不代表过程**
   `PENDING`（未消费）/ `RUNNING`（消费中，一段黑盒）/ `PASSED / FAILED / TIMEOUT`（三种终态）。init/chat/verify 三个 stage 对外不可见，只走结构化日志。

2. **DB 写次数下限**
   一个 instance 全生命周期只发生 **3 次** `eval_run_instance` 写 + **1 次** `eval_result` Upsert：
   - `CreateTask` 期间 batch INSERT（status=PENDING）
   - `PENDING → RUNNING` CAS UPDATE（worker 抢消费幂等哨兵，同时填 started_at）
   - `RUNNING → 终态` UPDATE（同一 SQL 合并 status + error_message + finished_at）
   - `eval_result` 保留 Upsert：verify 产物 + token 指标 + 长 error_log

3. **CAS 精简到 2 次**
   从当前 5 次 CAS（P→I / I→R / R→V / V→终态 / error 兜底）压到 **2 次**（P→R / R→终态）。中间 stage 失败一律冒泡到 defer finalize 单点，取消 stage 边界处的 CAS-miss 分支。

4. **stale 判定改基于 started_at**
   sweeper 保留，SQL 改为
   ```
   WHERE status='RUNNING'
     AND started_at < now() - InstanceTotalTimeoutSec - staleGrace
   ```
   → CAS `RUNNING→TIMEOUT` + 写 `error_message='sweeper_stale: …'`

5. **心跳彻底移除**
   `startHeartbeat / stopHB / UpdateHeartbeat` 全删。worker 进程活着就一路跑到 finalize；worker 崩了由 sweeper 兜底。省一个 goroutine + 每 5s 的 DB UPDATE + 一次 GetStatus SELECT。

6. **cancel 感知靠 ctx**
   原心跳 goroutine 顺带做的 "TIMEOUT/CANCELED 感知 → cancel stage ctx" 逻辑不再需要。stage 全流程用 handler 传下来的 ctx（asynq Timeout(20m) 兜底）。

### 1.2 设计边界

- **MQ 层（`RunInstanceHandler`）保持不变**：payload 结构、幂等 Unique(24h)、CaseTokenGate、asynq Timeout(20m) 全部保留。
- **前端 API 契约**：`heartbeat_at / deadline_at / worker_id / queued_at` 4 个字段直接消失（前端同期硬改，见风险清单 §6.2）。`attempt` 保留。
- **CANCELED 未来若引入**，由后续 spec 单独承载（重新引入常量 + 白名单转换 `RUNNING→CANCELED`）。

---

## 2. 数据模型与接口

### 2.1 `eval_run_instance` 表 schema 变更

**删除的列**（migration 里 DROP COLUMN）：

- `heartbeat_at TIMESTAMP` — 心跳机制彻底移除后无用
- `deadline_at TIMESTAMP` — sweeper 改按 started_at 判超时后无用
- `worker_id VARCHAR` — 移除心跳后无处写入
- `queued_at TIMESTAMP` — 入队时间靠 MQ 日志（`EVAL_MQ_CONSUME_START` 已有 `queue_lag_ms`）观察

**保留 + 语义收敛**：

- `status VARCHAR NOT NULL DEFAULT 'PENDING'` — 值域收敛到 `{PENDING, RUNNING, PASSED, FAILED, TIMEOUT}`
- `error_message TEXT` — 从"从不填充"改为"终态时必填（PASSED 除外）"，最大 4KB
- `started_at TIMESTAMP NULL` — 由 `PENDING→RUNNING` CAS 时一次填充，作为 sweeper stale 判定基准
- `finished_at TIMESTAMP NULL` — 由 `RUNNING→终态` 一次填充
- `attempt INT NOT NULL DEFAULT 0` — 重试链路保留
- 其余字段（`trace_id / conversation_id / message_id / case_snapshot / agent_config_snapshot_id / task_id / case_id`）保持不动

**索引调整**：

- 删除依赖 `heartbeat_at / deadline_at` 的索引（如有）
- 新增或保留 `idx_status_started_at (status, started_at)` 支撑 sweeper 查询

### 2.2 `EvalRunInstanceRepository` 接口收缩

**删除的方法**：

```go
UpdateHeartbeat(ctx, id, workerID, now)   // 心跳
UpdateQueuedAt(ctx, id, queuedAt)         // 入队时间戳
ListStaleInstances(ctx, before)           // 老 stale 查询（依赖 deadline_at）
```

**新增的方法**：

```go
// SQL: WHERE status='RUNNING' AND started_at < ranBefore
ListStaleRunning(ctx context.Context, ranBefore time.Time) ([]*RunInstance, error)

// SQL: UPDATE eval_run_instance
//      SET status=?, error_message=?, finished_at=?
//      WHERE id=? AND status='RUNNING'
// 返回 rowsAffected>0 表示 CAS 成功；把状态转换 + 错误 + 结束时间合并为一次 UPDATE
FinalizeRunning(ctx context.Context, id string, to InstanceStatus, errMsg string, finishedAt time.Time) (bool, error)
```

**调整的方法**：

```go
// 保留但仅限 PENDING→RUNNING 使用；其余 CAS 场景改走 FinalizeRunning
CASStatus(ctx, id, from, to) (bool, error)
```

### 2.3 `RunInstance` DO 与 `InstancePO` 字段裁剪

同步删除四个字段。DTO 层 `InstanceView` 同步删除 `HeartbeatAt / DeadlineAt / WorkerID / QueuedAt`，`ErrorMessage` 语义从"总为空"变为"终态时非空（PASSED 除外）"。

### 2.4 `InstanceExecutor` 依赖裁剪

构造函数移除 `heartbeatInterval`：

```go
func NewInstanceExecutor(
    instRepo repositories.EvalRunInstanceRepository,
    taskRepo repositories.EvalTaskRepository,
    resultRepo repositories.EvalResultRepository,
    snapshotRepo repositories.EvalAgentSnapshotRepository,
    verifyRunner *VerifyRunner,
    chatRunner InternalChatRunner,
    aggregator *TraceAggregator,
    tracer *tracing.Tracer,
    skillExecutor tools.SkillExecutor,
    nativeProvider tools.NativeToolsProvider,
    workerID string,                 // 保留：仅用于日志字段，不再写 DB
    chatTimeout time.Duration,
) *InstanceExecutor
```

`workerID` 保留仅用于结构化日志（`EVAL_STAGE_INIT` 等埋点里的 `worker_id` 字段），不写 DB。

### 2.5 状态机白名单

`state_machine.go` 的 `instanceWhitelist` 大幅收缩：

```go
var instanceWhitelist = map[ev.InstanceStatus]map[ev.InstanceStatus]bool{
    ev.InstanceStatusPending: {ev.InstanceStatusRunning: true},
    ev.InstanceStatusRunning: {
        ev.InstanceStatusPassed:  true,
        ev.InstanceStatusFailed:  true,
        ev.InstanceStatusTimeout: true,
    },
    ev.InstanceStatusFailed:  {ev.InstanceStatusPending: true},  // 重试
    ev.InstanceStatusTimeout: {ev.InstanceStatusPending: true},  // 重试
}
```

删除对 `Queued / Initializing / Verifying / Canceled` 的所有引用。`InstanceStatusCanceled` 常量本次一并删除。

---

## 3. 主流程时序与 executor 单函数改造

### 3.1 新主流程时序（happy path）

```
用户 POST /api/eval/tasks
  ↓
Handler.CreateTask
  ↓
Application.CreateTask
  ├─ Domain.CreateTask  → batch INSERT M×N instance (status=PENDING) + N snapshot
  └─ enqueueInstances   → 逐个 MQ.EnqueueRunInstance(id, 0)
                          ★ 不再写 queued_at

===== 异步消费 =====

asynq worker → RunInstanceHandler.ProcessTask
  ├─ payload unmarshal (脏包 → SkipRetry)
  ├─ instRepo.GetByID (miss → SkipRetry)
  ├─ caseGate.Acquire (Redis err → 重试；busy → 30s 后重投)
  └─ defer caseGate.Release
      ↓
InstanceExecutor.Execute(ctx, instanceID)          ← 单函数
  │
  ├─ [W1] CAS PENDING→RUNNING (UPDATE started_at=now())
  │       ok=false → return nil (合法竞速，被别人抢了)
  │
  ├─ [G1] guard: 目标终态 + errMsg 缓冲，defer finalize
  │
  ├─ inst = instRepo.GetByID
  ├─ workdir = nativeProvider.MessageWorkspaceDir + MkdirAll
  │       err → target=FAILED; errMsg="mkdir_workspace: <err>"; return
  │
  ├─ if InitScript != "": verifyRunner.Run(ctx, workdir, InitScript)
  │       err/exit≠0 → target=FAILED; errMsg="init_script: exit=…; stderr=…"; return
  │
  ├─ snap = snapshotRepo.Get
  │       err → target=FAILED; errMsg="load_snapshot: <err>"; return
  │
  ├─ chatRes = chatRunner.Run(ctx, snap, taskPrompt, chatTimeout)
  │       cerr != nil          → target=FAILED;  errMsg="chat_stage: <err>"
  │       chatRes.DidTimeout   → target=TIMEOUT; errMsg="chat_stage: chat_timeout=<Xs>"
  │       chatRes.Error != nil → target=FAILED;  errMsg="chat_stage: agent_error: <上游 err>"
  │
  ├─ vres = verifyRunner.Run(ctx, workdir, VerifyScript)
  │       verr != nil          → target=FAILED;  errMsg="verify_script: run: <err>"
  │       vres.ExitCode == 0   → target=PASSED
  │       vres.ExitCode != 0   → target=FAILED; errMsg="verify_script: exit=N; stderr=…"
  │
  └─ [F1] defer finalize:
        ├─ sleep 300ms (等 tracer flush)
        ├─ metrics = aggregator.Aggregate(conversationID)
        ├─ resultRepo.Upsert(instanceID, passed, verify 产物, tokens, error_log=完整errMsg)
        ├─ [W2] instRepo.FinalizeRunning(id, target, truncate(errMsg,4KB), now)
        │        ↑ 唯一的一次 status UPDATE，合并了 status + error_message + finished_at
        ├─ if metrics.TraceID != "": instRepo.UpdateTraceID
        ├─ taskRepo.RecountAndTransit(taskID)
        └─ cleanup skill + native workspace

===== cron sweeper =====

每 CronSweeperIntervalSec:
  service.SweepStaleInstances
    ├─ ranBefore = now - InstanceTotalTimeoutSec - staleGrace
    ├─ ListStaleRunning(ranBefore)   ← 新 SQL
    └─ for each:
        instRepo.FinalizeRunning(id, TIMEOUT, "sweeper_stale: started_at=<RFC3339>; grace_s=…", now)
        taskRepo.RecountAndTransit
```

### 3.2 关键点：`defer finalize` 一次收敛

**当前代码痛点**：`finalizeError` 在 executor 里被 3 处调用（init 失败、chat 失败、verify 前 CAS 失败），`finalizeVerify` 又是独立函数，两条路径分别写 result / CAS status → 错误处理散在 5 个地方。

**新形态**：executor 顶层 defer 一个内部闭包 `finalize()`，用局部变量 `target ev.InstanceStatus` 与 `errMsg string` 传递结果。所有 stage 只做"设 target/errMsg + return"，一律不再自己调 CAS / Upsert / Recount。

- 主函数从头看到尾，20-30 行内即可看完全部 stage 边界
- `finalize` 一处封装：result Upsert + FinalizeRunning + taskRecount + cleanup + 长错误裁切
- 单元测试注入 stage 的 fake 时不用再关心 finalize 侧逻辑

### 3.3 sweeper 与 executor 的竞速处理

sweeper 只发起 **一次** `FinalizeRunning(id, TIMEOUT, "sweeper_stale: …", now)`。因为它带 `WHERE status='RUNNING'` guard，executor 正常完成时（自己已经把 status 变到终态）sweeper 的 UPDATE 会 rowsAffected=0，安全 no-op。

反之如果 sweeper 先动手：

- executor 的 defer `FinalizeRunning` 也会 rowsAffected=0（status 已经是 TIMEOUT），此时 `result.Upsert` 仍然照常落库 —— 保证前端能看到 verify 中间产物 + error_log
- rowsAffected=0 时只记一条 `EVAL_STAGE_FINALIZE_CAS_MISS` 警告日志

### 3.4 重试链路（RetryInstance）

`RetryInstance` 逻辑保持基本不变，两处调整：

- 清 `queued_at` / `heartbeat_at` 的代码删掉（列没了）
- CAS 目标：`FAILED/TIMEOUT → PENDING` + `attempt = attempt+1` + `started_at=NULL` + `finished_at=NULL` + `error_message=''`
- 保留幂等：只有 FAILED/TIMEOUT 可 Retry；其它状态返回 error

### 3.5 心跳彻底移除的连带影响

- executor 里 `startHeartbeat` 函数删除
- executor 里 `stageCtx` 概念消失，全流程只用 `ctx`（handler 传下来）
- 取消 stage ctx 的能力：不再需要（外层 handler ctx 由 asynq Timeout(20m) 兜底）
- 心跳依赖的 `ev.InstanceStatusTimeout/Canceled` 检查逻辑一并删除

---

## 4. 错误分类与 error_message 落地约定

instance.error_message 从"总为空"升级为"终态时的错误摘要"，是研发排查的**第一入口**。

### 4.1 error_message 的三条硬约束

1. **长度上限 4KB**（超过用 `truncate + "\n[truncated]"` 后缀）
2. **首行必是 `<reason>: <detail>` 格式**（reason 从固定枚举挑，detail 是自由文本）
3. **PASSED 状态时 `error_message = ""`**，不允许写占位符

### 4.2 reason 枚举（固定 6 种）

| reason              | 触发点                                          | target |
|---------------------|-----------------------------------------------|--------|
| `mkdir_workspace`   | `nativeProvider.MkdirAll` 失败                  | FAILED |
| `init_script`       | `verifyRunner.Run(initScript)` err 或 exit≠0     | FAILED |
| `load_snapshot`     | `snapshotRepo.Get` 失败                         | FAILED |
| `chat_stage`        | chat 阶段全部三类失败合并                        | FAILED / TIMEOUT |
| `verify_script`     | verify 阶段 err 或 exit≠0                       | FAILED |
| `sweeper_stale`     | cron sweeper 兜底                              | TIMEOUT |

**detail 组装规则**：

```
mkdir_workspace   : "<err.Error()>"
init_script       : "exit=<code>; stderr=<stderr前512B>"     (exit=-1 表示未启动)
load_snapshot     : "<err.Error()>"
chat_stage        : 分三个子分支：
                    - chatRunner err       → "<err.Error()>"
                    - chatRes.DidTimeout   → "chat_timeout=<Xs>"      → target=TIMEOUT
                    - chatRes.Error != nil → "agent_error: <上游 err>"
verify_script     : "exit=<code>; stderr=<stderr前512B>"   或 "run: <err.Error()>"
sweeper_stale     : "started_at=<RFC3339>; grace_s=<staleGraceSeconds>"
```

组装完之后一律再走 `truncate(msg, 4KB)`。

### 4.3 与 eval_result 表的分工

| 字段                    | instance.error_message | eval_result                |
|------------------------|------------------------|----------------------------|
| reason（简短分类）       | ✅（首 token）           | ❌                          |
| detail（短摘要）         | ✅（首行）              | ❌                          |
| stderr 完整文本          | ❌                     | ✅ `verify_stderr`          |
| stdout 完整文本          | ❌                     | ✅ `verify_stdout`          |
| exit_code               | ✅（写在 detail 内）    | ✅ `verify_exit_code`       |
| error 长诊断（chain）    | ❌                     | ✅ `error_log`（64KB）       |

`result.error_log` 与 `instance.error_message` **允许语义重叠**但粒度不同：result.error_log 是"长版原始日志"，instance.error_message 是"短版分类摘要"。

排查路径：

- **列表页**看 `status + error_message 首行` 快速定位类别
- **详情页**看 `result.error_log + verify_stderr` 拿完整现场

### 4.4 日志埋点保持不变

现有 zap 结构化日志（`EVAL_STAGE_INIT / EVAL_STAGE_RUN_ERR / EVAL_STAGE_VERIFY_DONE / EVAL_STAGE_FINALIZE` 等）全部保留 —— 状态机不再暴露中间态，研发排查阶段边界靠这些日志。

### 4.5 前端展示

`InstanceView` 变更：

- **删除**：`HeartbeatAt / DeadlineAt / WorkerID / QueuedAt`
- **保留**：`Status / Attempt / StartedAt / FinishedAt / ErrorMessage / TraceID / ConversationID / MessageID`
- **语义变化**：`ErrorMessage` 从"永远为空"变为"PENDING/RUNNING 时空、终态时非空（PASSED 除外）"

后端不做多语言映射；前端拿到首行 reason 后可自行做 icon/tag 展示（本次不做前端联动）。

### 4.6 常量收敛

`executor.go` 现有 `truncate(s, n)` helper 保留、上限值改为包级常量：

```go
const (
    MaxErrorMessageBytes = 4 << 10   // 4KB → instance.error_message
    MaxErrorLogBytes     = 64 << 10  // 64KB → result.error_log (与当前一致)
    MaxVerifyOutBytes    = 64 << 10  // 64KB → verify_stdout/stderr (与当前一致)
)
```

`firstNonEmpty` helper 保留。reason 常量新增于 `executor.go` 或独立 `errors.go`：

```go
const (
    ReasonMkdirWorkspace = "mkdir_workspace"
    ReasonInitScript     = "init_script"
    ReasonLoadSnapshot   = "load_snapshot"
    ReasonChatStage      = "chat_stage"
    ReasonVerifyScript   = "verify_script"
    ReasonSweeperStale   = "sweeper_stale"
)
```

---

## 5. 测试策略与 E2E 验证矩阵

### 5.1 单元测试重构清单

| 文件 | 命运 | 说明 |
|-----|-----|------|
| `state_machine_test.go` | **重写** | 白名单从 7 转换点缩到 6 转换点；删所有 QUEUED/INITIALIZING/VERIFYING/CANCELED 用例 |
| `executor_cas_test.go` | **改写** | 只测 `PENDING→RUNNING` 幂等（多 worker 竞速一个赢）；删中间态 CAS 用例 |
| `executor_init_test.go` | **改写** | 测 mkdir_workspace / init_script 失败路径 → error_message reason 命中 |
| `executor_chat_verify_test.go` | **改写** | chat_stage 三个子分支（cerr / DidTimeout / chatRes.Error）都归 `chat_stage` reason；DidTimeout 走 TIMEOUT，其余 FAILED |
| `executor_finalize_test.go` | **合并** | 单点 finalize（PASSED/FAILED/TIMEOUT 三分支），断言 `result.Upsert` 与 `FinalizeRunning` 恰好各调一次 |
| `executor_stubs_test.go` | **调整** | `stubInstRepo` 删 `UpdateHeartbeat/UpdateQueuedAt/ListStaleInstances`；新增 `FinalizeRunning/ListStaleRunning`；改造 `finalizeCalls` 记录 |
| `service_impl_test.go` | **调整** | `fakeInstRepo` 同步接口变化；`TestSweepStaleInstances_*` 改成 started_at 判据 |
| `e2e_test.go` | **改写** | 2×2 生命周期用例保留但只期望 PENDING→RUNNING→终态；删心跳/deadline 子用例 |
| `stress_test.go` | **调整** | 并发压测断言口径改为"每个 instance ≤ 2 次 UPDATE + 1 次 result Upsert" |
| `internal_chat_runner_test.go` | 不动 | 本 spec 不改 chat runner |
| `internal_chat_runner_tracing_test.go` | 不动 | 同上 |
| `snapshot_test.go` | 不动 | 快照逻辑与本次无关 |
| `verify_runner_test.go` | 不动 | verify runner 不改 |
| `trace_aggregator_test.go` | 不动 | tracer 聚合与本次无关 |
| `main_test.go` | 不动 | logger 初始化 |

### 5.2 新增单测场景

- **`TestExecutor_FinalizeSinglePoint`**：正常 chat + verify PASSED，断言 `resultRepo.Upsert` 调用 1 次、`instRepo.FinalizeRunning` 调用 1 次（`to=PASSED, errMsg=""`）、`taskRepo.RecountAndTransit` 调用 1 次
- **`TestExecutor_ErrorMessageFormat`**：每个 reason 一个用例，断言 `error_message` 首行以 `<reason>:` 开头、超过 4KB 会被 truncate
- **`TestExecutor_CASMissAfterSweeper`**：模拟 sweeper 已 TIMEOUT 该 instance，executor 走完 chat+verify 后 FinalizeRunning rowsAffected=0，断言仅记 CAS_MISS 警告日志、`resultRepo.Upsert` 仍然照常落库
- **`TestSweeper_UsesStartedAt`**：塞 3 条 instance（started 5min 前 / 20min 前 / 无 started_at），断言 `ListStaleRunning` 只捞出中间那条
- **`TestState_RetryFromTerminal`**：FAILED→PENDING、TIMEOUT→PENDING 各一条，attempt+1 + started_at/finished_at/error_message 清零

### 5.3 E2E 功能验证矩阵（黑盒手测清单）

保存到 `mooc-manus/docs/eval-state-refactor-e2e.md`。7 组共 18 个用例。

#### 组 1 — 生命周期基线（3 用例）

| 用例 | 前置 | 动作 | 期望 |
|-----|-----|------|-----|
| 1.1 单 case + 单 agent 成功 | init/verify 都 exit=0 | POST /api/eval/tasks | instance 走 PENDING→RUNNING→PASSED；result.passed=true；error_message=空 |
| 1.2 单 case + verify 失败 | verify exit=1, stderr="assertion failed" | 同上 | instance→FAILED；`error_message` 首行 `verify_script: exit=1; stderr=assertion failed`；result.verify_exit_code=1，verify_stderr 完整存 |
| 1.3 单 case + init 失败 | init exit=2 | 同上 | instance→FAILED；`error_message` `init_script: exit=2; stderr=…`；chatRunner 未被调用 |

#### 组 2 — Chat 相关失败（3 用例）

| 用例 | 前置 | 动作 | 期望 |
|-----|-----|------|-----|
| 2.1 agent 超时 | chatTimeout=5s，prompt 触发 60s 等待 | 提交任务 | instance→**TIMEOUT**；`error_message` `chat_stage: chat_timeout=5s` |
| 2.2 agent 返回 ErrorEvent | 错误 apiKey | 提交任务 | instance→FAILED；`error_message` `chat_stage: agent_error: <上游>` |
| 2.3 chatRunner 内部 err | snapshot 缺 model 字段 | 提交任务 | instance→FAILED；`error_message` `chat_stage: <err>` |

#### 组 3 — sweeper 兜底（3 用例）

| 用例 | 前置 | 动作 | 期望 |
|-----|-----|------|-----|
| 3.1 worker 在 RUNNING 期间 kill | 手动 kill -9 backend | 等 `InstanceTotalTimeoutSec + staleGrace + CronSweeperInterval` | instance 从 RUNNING→TIMEOUT；`error_message` `sweeper_stale: started_at=…; grace_s=…`；无 result upsert |
| 3.2 executor 与 sweeper 竞速 | InstanceTotalTimeoutSec < 实际 chat 用时 | 等 sweeper 抢先 | executor 后续 FinalizeRunning rowsAffected=0；日志出现 `EVAL_STAGE_FINALIZE_CAS_MISS`；result 仍被 upsert；最终态 TIMEOUT 不被覆盖 |
| 3.3 sweeper 不误伤已 PASSED | 正常成功的 case，调低 CronSweeperInterval | 观察 2 个周期 | status 保持 PASSED；无 FinalizeRunning 日志 |

#### 组 4 — 重试链路（2 用例）

| 用例 | 前置 | 动作 | 期望 |
|-----|-----|------|-----|
| 4.1 FAILED→重试 | 一个 verify 失败的 instance | POST /api/eval/instances/:id/retry | attempt+1；started_at/finished_at/error_message 清空；status→PENDING；重新入队；跑通后 PASSED |
| 4.2 TIMEOUT→重试 | chat_timeout 的 instance | 同上 | 同 4.1 |

#### 组 5 — 并发与幂等(3 用例)

| 用例 | 前置 | 动作 | 期望 |
|-----|-----|------|-----|
| 5.1 同一 instance 被两个 worker 抢 | 手工双发同一 payload | 观察 | 只有一个 worker CAS PENDING→RUNNING 成功；另一个 `EVAL_STAGE_INIT_CAS_MISS` 静默退出 |
| 5.2 asynq Unique(24h) 幂等 | 24h 内同一 instance 两次 EnqueueRunInstance | 观察 | 第二次静默吞掉；DB 无重复消费 |
| 5.3 case 令牌门并发限制 | case 并发 limit=2，同时提交 5 个 instance | 观察 | 同时最多 2 个 `EVAL_STAGE_RUN_ENTER`；其余 `EVAL_MQ_TOKEN_BUSY` 后被 asynq 30s 重投 |

#### 组 6 — DB 写次数验证（3 用例）

| 用例 | 前置 | 动作 | 期望 |
|-----|-----|------|-----|
| 6.1 成功路径写次数 | 打开 postgres 慢日志或加钩子 | 提交单 instance 任务 | eval_run_instance 命中 2 次 UPDATE + 1 次 INSERT；eval_result 命中 1 次 UPSERT |
| 6.2 sweeper 路径写次数 | 手动模拟 stale | 观察 | eval_run_instance 命中 1 次 UPDATE；eval_result 无写入 |
| 6.3 心跳消失验证 | 30 分钟压测 | 观察 heartbeat 相关 UPDATE | 数量 = 0（不再有任何 UpdateHeartbeat 相关 SQL） |

#### 组 7 — 前端字段消失（1 用例）

| 用例 | 前置 | 动作 | 期望 |
|-----|-----|------|-----|
| 7.1 API 返回字段裁剪 | 无 | GET /api/eval/instances/:id | 响应体不含 `heartbeat_at / deadline_at / worker_id / queued_at`；`error_message` 终态时非空 |

### 5.4 E2E 文档形式

markdown 表格 + 每个用例一段 curl/命令提示，纯中文。生成时机在 Section 6 实施步骤 9 中一起产出。

---

## 6. 实施计划与风险清单

### 6.1 实施步骤

10 步，每步一 commit，可独立回滚。步骤 1-4 是接口/schema 变更（中途编译红是预期），步骤 5-6 主 executor 与 service 层调整，之后 7-10 收尾。

| 步 | 名称 | 主要文件 | 交付物 |
|----|-----|--------|--------|
| 1 | 状态枚举收缩 | `internal/domains/models/evaluation/status.go` | 删 `Queued/Initializing/Verifying/Canceled` 常量；`IsTerminal` 更新 |
| 2 | 状态机白名单缩到 6 转换点 | `internal/domains/services/evaluation/state_machine.go` | 新白名单 + `state_machine_test.go` 重写 |
| 3 | Instance PO/DO/DTO/Repository 接口调整 | `eval_run_instance.go` (PO/repo)、`run_instance.go` (DO)、`eval.go` (DTO)、`eval_converter.go` | 删 4 字段；新增 `FinalizeRunning`/`ListStaleRunning`；删 `UpdateHeartbeat`/`UpdateQueuedAt`/`ListStaleInstances`；GORM tag 与 InstanceView 同步 |
| 4 | DB migration | `data/manus_schema.sql` 或独立 migration | `ALTER TABLE eval_run_instance DROP COLUMN heartbeat_at, DROP COLUMN deadline_at, DROP COLUMN worker_id, DROP COLUMN queued_at;` + `idx_status_started_at` 新建；老索引对应 DROP |
| 5 | Executor 单函数化 | `executor.go` | `Execute` 线性化 + `defer finalize`；删 `startHeartbeat/finalizeError/finalizeVerify/cleanupAndRecount`；6 种 reason 常量与错误组装 helper |
| 6 | Application/Domain 层同步 | `service_impl.go`、`applications/services/eval.go` | `SweepStaleInstances` 改用 `ListStaleRunning + FinalizeRunning`；`RetryInstance` 清 4 字段的代码删；`instanceDOToView` DTO 同步；`enqueueInstances` 删 `UpdateQueuedAt` |
| 7 | route.go 装配调整 | `api/routers/route.go`、`config/config.go`、`config/config.toml` | `NewInstanceExecutor` 少传 `heartbeatInterval`；`EvaluationConfig.HeartbeatIntervalSec` 删除 + `SweeperStaleGraceSec` 新增（默认 60s） |
| 8 | 单测重写/调整 | 见 §5.1 | 8 个 test 文件按"重写/调整"列执行；新增 5 个用例（§5.2） |
| 9 | E2E 文档产出 | `mooc-manus/docs/eval-state-refactor-e2e.md` | §5.3 的 18 个用例 markdown |
| 10 | 日志埋点字段修剪 | `executor.go`、`service_impl.go` | 撤除 `heartbeat_interval / deadline_at / worker_id` 相关日志字段 |

**编译门槛**：步骤 1-3 改完立刻会有大量 red spots；步骤 5-6 之前保持不能 build 是正常的；一路推到步骤 6 之后应该恢复绿灯。plan 阶段会把每步再细化到 <10 行 patch + 明确验证命令。

### 6.2 风险清单

| 风险 | 严重度 | 缓解 |
|-----|-------|-----|
| DB migration 在有历史数据的环境执行会丢 heartbeat_at 等列 | 中 | 历史数据无查询需求（运行时用途）；stakeholders 已同意"硬改" |
| 前端仍在读 4 个已删字段会渲染坏 | 高 | 前端 Web 子仓需**同期**改字段（本 spec 之外的联动 PR，需与前端组同步） |
| sweeper 判据 `started_at + timeout + grace` 若 `staleGrace` 太小会误杀正在 chat 的 instance | 中 | `staleGrace` 默认 60s；作为 `EvaluationConfig.SweeperStaleGraceSec` 显式配置项 |
| CANCELED 语义未来要加时无处放（本次删了常量） | 低 | 未来实现时重新引入常量 + 一条白名单转换 `RUNNING→CANCELED` |
| stage 中的错误细节不再进 error_message，排查困难 | 低 | zap 结构化日志全部保留；error_message 首行 reason 是索引，详细排查靠日志 + result.error_log |
| 单元测试改动量大（8 文件重写） | 中 | 每次 diff 都跑 `go test ./internal/domains/services/evaluation/... -count=1`；步骤 8 是最后一步 test 改动，前 7 步任一失败可立刻回退 |
| MQ 层与 executor 边界（`InstanceExecutorAPI.Execute` 签名）保持不动，与下一轮 MQ 抽象 spec 耦合 | 低 | 本轮明确不动这个签名；下一轮 MQ spec 的 §1 锚定本签名 |

### 6.3 回滚策略

- 每步一 commit，回滚粒度为单 commit
- migration 附带 down 部分（`ALTER TABLE ADD COLUMN` 恢复空列）
- 若上线后遇到 sweeper 误杀，紧急止损：把 `SweeperStaleGraceSec` 拉到极大（例如 24h），观察 24h 数据后再调整

### 6.4 依赖与前置

- 无 breaking 依赖：本 spec 独立可交付
- **前端联动**：非本 spec 范围，但需同期开一个 mooc-manus-web PR 删 4 个字段的读取
- **下一轮 MQ 抽象 spec**：会依赖本 spec 交付的 `InstanceExecutorAPI.Execute` 签名（不变）

---

## 7. 交付物汇总

- [`docs/superpowers/specs/2026-07-19-eval-state-refactor-design.md`](本文件)
- [`mooc-manus/docs/eval-state-refactor-e2e.md`] — 步骤 9 产出
- 10 个 commit，每步一个，按 §6.1 顺序推进
- 单测：8 文件重写/调整 + 5 个新增用例（§5.1 & §5.2）
- DB migration up + down 双向 SQL

## 8. 附录：状态机对比图

```
【当前 9 状态】
                       ┌─────► CANCELED (未实现)
PENDING ──► QUEUED ──► INITIALIZING ──► RUNNING ──► VERIFYING ──► PASSED
              │             │              │           │
              │             ├──────────────┼───────────┼──► FAILED
              │             │              │           │
              │             └──────────────┴───────────┴──► TIMEOUT
              │                                                │
              │                                                ▼
              └────────────────────────────────────────────► PENDING (retry)

CAS 次数 / instance: 5+（P→Q, Q→I, I→R, R→V, V→终态）


【新 5 状态】
PENDING ──► RUNNING ──► PASSED
              │
              ├──► FAILED   ──► PENDING (retry)
              │
              └──► TIMEOUT  ──► PENDING (retry)

CAS 次数 / instance: 2（P→R, R→终态）
```


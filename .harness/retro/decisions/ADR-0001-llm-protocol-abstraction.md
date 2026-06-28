---
adr_id: ADR-0001
title: LLM 协议抽象（Message/Tool 值对象）
status: accepted
date: 2026-01-15
deciders: 项目组
supersedes: []
superseded_by: []
related_specs:
  - mooc-manus/docs/superpowers/specs/2026-06-28-llm-protocol-abstraction-design.md
related_rules:
  - mooc-manus/.harness/rules/42-llm-protocol.md (R-42-llm)
---

# ADR-0001: LLM 协议抽象（Message/Tool 值对象）

> ADR 记录"为什么做出某个架构决定"。本 ADR 沉淀 LLM 协议抽象重构的决策依据。

## 背景

`BaseAgent` 与大模型对话的整条链路最初强耦合在 OpenAI 协议上：

- `BaseAgent.llm` 字段类型为 `*llm.OpenAiLLM`，只能调用 OpenAI SDK。
- `BaseAgent.memory` 以 `[]openai.ChatCompletionMessageParamUnion` 存储历史会话。
- 所有 LLM 交互方法签名（`InvokeLLM` / `StreamingInvokeLLM` / `InvokeToolCalls` / `AddToMemory` / `GetMessages` / `GetAvailableTools`）均使用 OpenAI 类型。
- `tools.Tool.GetTools()` 直接返回 `[]openai.ChatCompletionToolParam`。
- `events.ToolEvent` 构造函数参数为 `openai.ChatCompletionMessageToolCall`。

约束 / 痛点：

- 业务上要求接入 Anthropic（Claude）协议，并为后续 A2A / 其他厂商预留空间。
- Domain 层直接 import 厂商 SDK → 违反 DDD 分层（基础设施细节渗入领域层），且单测 mock 困难。
- 现有 `BaseAgent` 子类（plan / react / a2a / skill 四种 agent）已大量耦合 OpenAI 类型，越拖越难替换。

相关引用：spec `2026-06-28-llm-protocol-abstraction-design.md`、规则 `R-42-llm`、落地 commit `e839163`（LLM 协议抽象重构）、`f9c1823`（子模块指针升级）。

## 决策

我们决定在 `internal/domains/models/llm/` 下引入厂商无关的 `Message` / `Tool` / `ToolCall` 值对象与 `invoker.Invoker` 接口，所有 LLM 交互通过该值对象与接口完成；具体 SDK 调用收敛到 `internal/infra/external/llm/` 的 Adapter 层。

- 范围：`BaseAgent`、`ChatMemory`、`tools.Tool`、`events` 全链路切换为统一消息体；DI 装配（`api/routers/route.go::InitRouter`）按 `ModelConfig.Provider` 路由到对应 Invoker。
- 不在范围：Anthropic 适配器的实际 SDK 实现（仅保留方法骨架）、模型配置在 API/前端的暴露、A2A 工具协议双轨支持、多模态/thinking blocks/prompt caching 等厂商特性的具体落地（通过 `Message.Extra` 预留通道）。
- 关键设计点：
  1. 值对象集中在 `internal/domains/models/llm/`，字段保持厂商无关，扩展走 `Extra map[string]any`。
  2. `invoker.Invoker` 接口仅暴露 `Invoke(ctx, request)` 与 `StreamingInvoke(...)` 两个方法。
  3. Adapter 双向转换 `llm.Message ↔ SDK type`，例外允许 adapter 文件 import 厂商 SDK。
  4. 静态检查 deny-list 仅作用于 `internal/domains/`，防止 SDK 反向渗入。
  5. `ModelConfig` 新增 `Provider` 字段，作为运行时选择 adapter 的唯一依据。

## 后果

### 正面

- Domain 层与厂商 SDK 解耦，DDD 分层重新闭合。
- 单测可对 `Invoker` 接口直接 mock，工具调用 / 普通对话 / 错误三分支均可独立覆盖。
- 新增 LLM 厂商只需写一个 adapter + DI 注册，不动 domain 代码。
- 为多模态、thinking blocks 等特性提供了统一扩展通道（`Extra` 字段）。

### 负面 / 代价

- 技术债：多了一层值对象转换，每次 LLM 调用都要做 `Message ↔ SDK` 双向 marshal，热路径需关注分配。
- 维护成本：新增 LLM 厂商需要新写 adapter 并保持 `Message` 字段覆盖度，文档（R-42）与 deny-list 需同步更新。
- 学习曲线：新成员需先理解 `llm.Message` / `Invoker` 的语义边界，再写 adapter，比直接调 SDK 上手慢。
- 兼容性影响：旧 `*llm.OpenAiLLM` 调用点全部需要改造（已在 commit `e839163` 一次性完成）。

### 中性 / 待观察

- `Message.Extra` 的字段约定需要随多模态 / 工具协议演进，可能在未来某次重构时升级为强类型子结构。
- adapter 层的错误语义统一（OpenAI rate limit / Anthropic overloaded → 框架级 error 分类）尚未规约，待第二个 adapter 落地时一并补 ADR。

## 替代方案

1. **保持直接 SDK 调用，按需 if/else 切换厂商**
   - 思路：在 `BaseAgent` 内根据 `Provider` 字段分支，分别调 OpenAI / Anthropic SDK。
   - 放弃原因：分支会迅速渗透到 memory / tools / events 全链路，DDD 分层彻底失守；多 agent 子类各自维护分支，重复代码爆炸。

2. **引入 langchaingo / 类似开源 LLM 抽象层**
   - 思路：用 `github.com/tmc/langchaingo/llms` 作为统一接口，省下自研值对象。
   - 放弃原因：langchaingo 的 `MessageContent` 与本框架的工具调用 / 事件流模型不匹配，强行适配反而增加阻抗；同时引入一个大型依赖，升级风险与自由度都不可控。轻量自研值对象更贴合本项目的工具/事件/记忆体设计。

## 实施 / 跟进

- 关联 plan：`mooc-manus/docs/superpowers/plans/2026-06-28-llm-protocol-abstraction.md`
- 关联 spec：`mooc-manus/docs/superpowers/specs/2026-06-28-llm-protocol-abstraction-design.md`
- 关键 commit：`e839163`（LLM 协议抽象重构）、`b65f8e3`（ModelConfig 新增 Provider）、`b5a16a0`（上层智能体切换至 Invoker 注入）、`467ef06`（清理 file 包遗留 openai 引用）。
- 静态约束：`R-42-llm`（`mooc-manus/.harness/rules/42-llm-protocol.md`）通过 grep deny-list + ddd-layer-checker 子代理强制执行。
- 后续 review 时点：Anthropic adapter 实际 SDK 实现落地时，回看 `Message.Extra` 字段是否需要升格。
- 失效条件：若引入的第二个 adapter 表明 `Message` 字段集不足以承载（如必须暴露 SDK 原生类型），需要新 ADR supersede 本 ADR。

## 变更日志

- 2026-01-15 proposed & accepted by 项目组（决策实际发生时间，对应 spec / 重构 commit 时点）
- 2026-06-28 recorded into `.harness/retro/decisions/`（Phase 8 harness 文档体系建设期间补录）

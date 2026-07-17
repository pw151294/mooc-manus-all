# Agent Tracing 模块拆分索引

**父规格**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**拆分日期**：2026-07-17
**目标仓库**：mooc-manus（后端 Go 服务，本期仅后端）

---

## 模块列表

| 模块 | Spec | E2E | 依赖 | 说明 |
|---|---|---|---|---|
| M1 数据模型与建表 | [M1-tracing-domain-schema-spec.md](M1-tracing-domain-schema-spec.md) | [M1-tracing-domain-schema-e2e.md](../../e2e/agent-tracing-modules/M1-tracing-domain-schema-e2e.md) | 无 | Span/LogEntry/SpanNode 值对象、SpanRepository 接口、敏感字段打码/长度截断、ai_span DDL |
| M2 Tracer 与批量落盘 | [M2-tracer-and-repository-spec.md](M2-tracer-and-repository-spec.md) | [M2-tracer-and-repository-e2e.md](../../e2e/agent-tracing-modules/M2-tracer-and-repository-e2e.md) | M1 | Tracer 服务、缓冲区、批量 flush、Shutdown、包级单例、MySQL Repository 实现、路由初始化 |
| M3 埋点注入 | [M3-agent-instrumentation-spec.md](M3-agent-instrumentation-spec.md) | [M3-agent-instrumentation-e2e.md](../../e2e/agent-tracing-modules/M3-agent-instrumentation-e2e.md) | M1、M2 | Application/Domain 层埋点、ctx 参数改造、循环埋点匿名函数模板、tags/logs 采集 |
| M4 查询 API 与树构建 | [M4-trace-query-api-spec.md](M4-trace-query-api-spec.md) | [M4-trace-query-api-e2e.md](../../e2e/agent-tracing-modules/M4-trace-query-api-e2e.md) | M1、M2 | BuildSpanTree 算法、Application Service、GET /api/trace/:trace_id、GET /api/traces、Handler |

---

## 依赖关系图

```
M1 (数据模型与 DDL)
 ├── M2 (Tracer + Repository 实现)
 │    ├── M3 (埋点注入到 Chat / ReAct 循环)
 │    └── M4 (查询 API + 树构建)
 └──────

建议执行顺序：M1 → M2 → M3 → M4
```

**关键点**：

- M1 是纯定义层（类型、接口、DDL），无运行时依赖，最先交付
- M2 需要 M1 的 Span/SpanRepository 接口才能实现；M2 完成后 Tracer 已可用但无人调用（无埋点）
- M3、M4 是 M2 之上的两个并行分支：M3 让 Tracer 真正跑起来（生产 span），M4 让 span 可查（消费 span）
- 若开发资源紧张，**M3 优先于 M4**——无埋点则 M4 查不到任何数据
- 建议按顺序发布，每完成一模块跑对应 E2E 收敛后再启动下一模块

---

## 与父规格的关系

- 父规格是设计源头，包含完整的架构决策、数据模型、埋点位置、查询协议
- 子模块规格从父规格切片而来，各自可独立 spec → plan → implementation
- 子规格中大量引用父规格章节号（如"详见父规格 §3.1"），阅读时请交叉参考
- 若需修改核心决策（如 span 类型、缓冲策略、DDL 字段），改父规格后再同步子规格

---

## 执行方式

每个模块可独立走 `superpowers:writing-plans` 生成实施计划，再走 `superpowers:executing-plans` 或
`subagent-driven-development` 执行。

**推荐顺序**：M1 → M2 → M3 → M4，每完成一模块跑对应 E2E。M3 和 M4 若并行开发，需注意都会修改
`api/routers/route.go`（M2 初始化 Tracer + Repository，M4 注册 trace handler），协作时用不同分支或按序合入。

---

**索引版本**：v1.0

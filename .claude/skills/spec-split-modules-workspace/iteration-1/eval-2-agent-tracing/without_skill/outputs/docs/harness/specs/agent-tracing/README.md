# Agent Tracing 模块化拆分索引

**来源**：`docs/superpowers/specs/2026-07-14-agent-tracing-design.md`
**拆分日期**：2026-07-17
**拆分目标**：将大型 spec 按可独立交付边界切分为若干子模块，各模块可独立评审、开发、验收

---

## 一、拆分原则

1. **单一职责**：每个模块聚焦一个可独立交付的技术切面
2. **依赖有向**：M1 是基础，M2/M3 在 M1 之上，M4 在 M1/M3 之上，M5 横切
3. **可独立验收**：每个模块自带 e2e 验证文档，可脱离其他模块独立测试
4. **对齐 DDD 分层**：Domain / Repository / Application / Handler 各归其位

---

## 二、模块清单

| 模块 | 名称 | 交付内容 | 依赖 |
|------|------|---------|------|
| M1 | 数据模型与 Tracer 基础设施 | Span 值对象、Tracer 单例、SpanRepository 接口、ai_span 表结构 | 无 |
| M2 | Agent 链路埋点 | AGENT_ROOT / AGENT_ROUND / LLM_CALL / TOOL_BATCH / TOOL_CALL / SUBAGENT_CALL 埋点 | M1 |
| M3 | 异步缓冲与批量落盘 | 内存 chan 队列、BatchProcessor goroutine、批量 INSERT | M1 |
| M4 | 查询 API 与树构建 | GET /api/trace/:id、GET /api/traces、扁平→树算法 | M1、M3 |
| M5 | 错误处理与降级 | 敏感字段打码、tracing 自身异常兜底、优雅退出 | M1、M2、M3 |

依赖关系图：

```
        M1（基础）
       /    |    \
      M2   M3    M5
            \
             M4
```

---

## 三、模块交付顺序建议

1. **第 1 周**：M1 数据模型 + ai_span 表 DDL
2. **第 2 周**：M3 异步落盘（提前，M2 埋点产生数据后才能验证落盘）
3. **第 3 周**：M2 埋点（依赖 M1、M3）
4. **第 4 周**：M4 查询 API
5. **第 5 周**：M5 加固（打码、降级、优雅退出）

---

## 四、非目标（保留自原 spec §1.4）

- 前端可视化瀑布图
- OpenTelemetry 协议兼容
- 采样策略（本期 100% 采集）
- 分区表 / 归档
- PlanAgent / A2AAgent 埋点
- 错误向父级 span 冒泡

---

## 五、文档索引

- 设计文档：`docs/harness/specs/agent-tracing/M{1..5}-*-spec.md`
- 验证文档：`docs/harness/e2e/agent-tracing/M{1..5}-*-e2e.md`

# E2E-04 skip

**跳过原因**: 后端 `waitTimeout` 硬编码 5 分钟(`internal/applications/services/agent.go:54: waitTimeout: 5 * time.Minute`),没有 env / 配置项可以在不改代码的前提下调低。spec 明确"若无法调低超时,则本用例需 300s 挂机等待,不建议在自动跑 pipeline 里默认启用",可用 @slow 标签跳过。

**建议**: 后端把 `waitTimeout` 抽成 `config.HITL.WaitTimeout` 配置项 + env override(如 `HITL_WAIT_TIMEOUT`),复跑本用例前把超时改成 10s 即可。

**间接覆盖**: 集成测试 `internal/applications/services/agent_hitl_integration_test.go` 的 I-03 用手动 tick 覆盖了 Timer fire 的语义,E2E 层不重复。

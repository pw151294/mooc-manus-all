# Code review checklist

> 驱动 skill：`superpowers:requesting-code-review`。reviewer / 自检 / agent 评审都走这套。

## 单一职责

- [ ] 函数 / 类 / 模块只做一件事；命名能反映职责
- [ ] 一个文件不超过 ~500 行（超出考虑拆分）
- [ ] 跨 DDD 层混合时，是否有合理理由（在 PR 描述或注释说明）

## 命名与可读性

- [ ] 标识符是名词 / 动词短语，不缩写未广为人知的词
- [ ] 公开 API 有 doc comment（Go：`// FuncName ...`；TS：JSDoc）
- [ ] 魔法值（数字、字符串）抽常量；URL / path 不硬编码

## 错误处理

- [ ] 后端：所有 `err` 都被处理或显式 `_`（带 comment 说明）
- [ ] 前端：异步 / fetch / mutation 都有 catch + 用户反馈
- [ ] 不吞错（不要 `if err != nil { return nil }`）
- [ ] 日志含足够上下文（traceId / requestId / agentId）

## 跨 rule 引用

- [ ] 触发了哪些 rule（R-1x / R-2x / R-3x）？PR 描述列出
- [ ] 是否需要新增 / 修改 rule？若是 → 单独 PR 改 `.harness/rules/`，不混在功能 PR

## 安全

- [ ] R-31 prompt injection：所有外部输入（用户 / 工具结果 / SSE 上游）都已清洗或拒绝路径
- [ ] R-32 secrets：无硬编码 key / token；日志不打印 secret；error message 不泄露
- [ ] SQL：参数化查询（不拼接字符串）
- [ ] 路径：用户输入构造文件路径前 validate（防 path traversal）
- [ ] CORS / CSRF：新 endpoint 是否需要 / 是否已配置

## 跨仓契约（如改了 SSE / DTO / API）

- [ ] 前后端两侧都改了？或在 plan 中标记了下一 Task
- [ ] 旧 client 调用是否被破坏？兼容窗口策略写在 PR 描述
- [ ] 字段废弃走 deprecation → 实删两步

## 测试

- [ ] 新增 / 修改逻辑有对应测试（参考 testing-requirements.md）
- [ ] 测试不依赖外部网络 / 真实凭据（除非是约定的集成测试）
- [ ] CI 跑过且通过（如无 CI，提交前本地跑通）

## 性能与资源

- [ ] 无明显 N+1 query（数据库 / 远程调用）
- [ ] goroutine / promise 有取消 / 超时
- [ ] 大对象不全量加载到内存（用流 / 分页）

## 文档

- [ ] 改动影响行为时，README / docs / spec 同步更新
- [ ] commit message 符合 `commit-conventions.md`

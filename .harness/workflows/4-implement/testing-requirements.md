# 测试要求

> 写测试是 Task DoD 的一部分。本文档说明在 mooc-manus-all 各仓写测试的最低要求。

## 后端（mooc-manus/，Go）

### 框架

- 单元测试：标准 `testing` + `github.com/stretchr/testify/{assert,require}`（项目已用）
- 表驱动测试是默认形态，参考现有：
  - `internal/infra/external/llm/openai_adapter_test.go`
  - `internal/domains/models/memory/memory_test.go`
  - `internal/domains/models/events/tools_test.go`

### 命名

- 文件：被测文件同目录 `<name>_test.go`
- 函数：`Test<被测函数>_<场景>`（驼峰）
- 表驱动 case 名：snake_case 中英文均可

### 覆盖优先级

- 必测：domains 层（业务不变式）、跨仓契约的序列化层（DTO / SSE event）、错误路径
- 应测：applications 层 usecase 的 happy path 与边界
- 可选：interfaces 层（用集成测试覆盖更划算）

### 集成测试

- 偏好 **真实依赖** 而非 mock（参考 spec 中 "prefer real over mocked"）
- 数据库：用 testcontainers / sqlite-in-memory，**不要 mock SQL driver**
- 外部 LLM：单测可 mock，集成测试用真实 provider（带 record/replay）

### 执行

```bash
cd mooc-manus
go test ./...
go test -race ./...   # 关键并发模块必跑
```

## 前端（mooc-manus-web/，TypeScript + React）

### 现状

项目当前 **没有 unit test framework**。在加测试前应该：

1. 起一个 ADR：`.harness/retro/adr/<date>-frontend-test-framework.md`
2. 选型建议：vitest + @testing-library/react（与 Vite 栈兼容）
3. ADR approved 后再补测试基础设施

### 临时约定（ADR 完成前）

- 新增 UI 组件：在 PR 描述写明"手测步骤"（哪个页面、点哪个按钮、看到什么）
- 服务层 / hooks：以 TypeScript 类型约束 + 手测覆盖
- 不允许在没有任何验证的情况下交付（违反 R-40 verification-before-completion）

### ADR 通过后

- 命名：`<component>.test.tsx` / `<service>.test.ts`
- 单元测试：vitest + testing-library，覆盖 features/ 与 services/
- E2E：建议 Playwright，但属新支线，需独立 ADR

## 通用要求

- 跑测试是 Task 完成判定的一部分；测试失败 → Task 不能 mark complete
- 不允许通过删除 / 跳过 (`t.Skip` / `.skip`) 测试来绿灯
- 新代码若与 spec 中已约束的不变式相关，必须有对应测试

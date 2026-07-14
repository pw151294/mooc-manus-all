# E2E Subagents 测试套件

覆盖子智能体功能的端到端验证，包含两条用例：

- **C1**：PlanMode=off，主 Agent 直接调 fileRead，无子智能体
- **C3**：PlanMode=on，主 Agent 派遣 dispatchSubagent，生成 Plan.md/TODO.md

## 前置条件

1. 后端启动：`cd mooc-manus && go run main.go`（监听 8080）
2. 前端启动：`cd mooc-manus-web && npm run dev -- --port 3000 --strictPort`
3. 数据库：Postgres + Redis 已启动，配置在 `mooc-manus/config/config.toml`
4. 模型配置：数据库中至少有一条包含 "zai-org/GLM-5.2" 的 AppConfig

## 安装依赖

```bash
cd e2e/subagents
npm install
npx playwright install chromium
```

## 运行测试

```bash
# 运行所有用例
npm test

# 只跑 C1
npm run test:c1

# 只跑 C3
npm run test:c3

# 查看报告
npx playwright show-report
```

## 失败诊断

失败时 Playwright 会在 `test-results/` 下生成：
- 截屏（`*.png`）
- 视频（`*.webm`）
- trace 文件（`*.zip`，用 `npx playwright show-trace` 打开）

## 注意事项

- Fixture 目录：`~/mooc-manus-e2e-fixtures/`，用例结束后自动清理
- 超时：C1 用 120s，C3 用 180s（覆盖 LLM 长思考 + 子智能体派发延迟）
- 如需调整模型，修改 spec 文件中的 `zai-org/GLM-5.2` 字符串

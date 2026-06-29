# 部署拓扑

## 为什么需要这份文档

mooc-manus-all 目前只有**本地开发拓扑**——生产部署尚未上线，无 K8s manifest、无 IaC、无远端环境。这份文档把"在本机怎么把整套系统跑起来"形成可重放的指引，让新成员（或 AI agent）在 15 分钟内拉起前后端 + 依赖服务，并明确各组件的端口、依赖关系、起服顺序。生产拓扑暂为占位章节，待上线时按 R-30（部署护栏）扩展。

## 现状

### 本地开发拓扑图

```
┌──────────────────────────────────────────────────────────────┐
│ 开发者本机（macOS / Linux）                                    │
│                                                              │
│   ┌──────────────────┐   :3000   ┌──────────────────────┐   │
│   │ mooc-manus-web   │ ────────► │ Vite Dev Server       │   │
│   │ (React + TS)     │           │ proxy /api → :8080    │   │
│   └──────────────────┘           └──────────┬───────────┘   │
│                                              │ HTTP/SSE      │
│                                              ▼               │
│                                   ┌─────────────────────┐    │
│                                   │ mooc-manus           │   │
│                                   │ (Go Gin) :8080       │   │
│                                   └──┬───────┬─────┬─────┘   │
│                          PostgreSQL  │       │     │ Redis    │
│                                 :5432 ▼       ▼     ▼ :6379    │
│                              ┌─────────┐  ┌───────────┐       │
│                              │ Postgres│  │ Redis     │       │
│                              └─────────┘  └───────────┘       │
│                                                              │
│                              ┌──────────────────┐            │
│                              │ Docker daemon    │ Skill 沙盒  │
│                              │ /var/run/...sock │            │
│                              └──────────────────┘            │
│                                                              │
│   外部网络：                                                  │
│     ├─ LLM Provider (OpenAI / Anthropic / Azure)             │
│     ├─ MCP Servers（动态注册，可本地或远端）                   │
│     └─ A2A Agents（远端 HTTP 服务）                           │
└──────────────────────────────────────────────────────────────┘
```

### 组件清单

| 组件 | 端口 | 启动方式 | 依赖 |
|---|---|---|---|
| mooc-manus（后端 Gin） | 8080 | `cd mooc-manus && go run main.go` | Redis、Postgres、Docker daemon |
| mooc-manus-web（前端 Vite） | 3000 | `cd mooc-manus-web && npm run dev` | 后端 :8080（Vite proxy 已配置） |
| PostgreSQL | 5432 | Docker / Homebrew | — |
| Redis | 6379 | Docker / Homebrew | — |
| Docker daemon | unix socket | 系统服务 | — |

后端 `main.go` 的初始化顺序固化为：config → logger → Redis → Postgres → router/handlers，缺一不可（R-40 模块初始化规则）。前端 `vite.config.ts` 已配置 `/api` 代理到 `localhost:8080`，开发态无需额外 CORS 配置。

### 配置文件

- 后端：`mooc-manus/config/dev.toml`（toml 格式，含 `redis` / `database` / `logger` / `storage` / `skill` 五段）
- 前端：`mooc-manus-web/vite.config.ts`（端口、proxy）+ `.env.local`（可选 LLM Key 覆盖）
- 敏感字段（LLM API key、DB 密码）走环境变量或本地 toml，不进 git（R-32）

## 启动顺序

冷启动一个全新环境的推荐顺序：

1. **拉子仓**：`git submodule update --init --recursive`
2. **起依赖**：Postgres + Redis（建议 `docker compose up -d postgres redis`，或本地服务）
3. **后端**：`cd mooc-manus && go run main.go` → 应看到 "init redis ok / init postgres ok / start server :8080"
4. **前端**：`cd mooc-manus-web && npm install && npm run dev` → 浏览器访问 http://localhost:3000
5. **Docker daemon**：执行 Skill 工具时需要（首次执行会拉取镜像）

任一步骤失败：先看日志、再看配置（最常见的是 `dev.toml` 里 host/port 不匹配），不要绕过初始化顺序去 hack（违反 R-40）。

## 生产拓扑（占位）

当前未规划生产部署，本节先列出**未来扩展时需要的决策项**，避免临时拍脑袋：

- **编排方式**：单机 systemd / Docker Compose / K8s
- **TLS / 反代**：Nginx / Caddy 终止 TLS，转发 :3000 与 :8080
- **数据持久化**：Postgres 备份策略、Redis 是否需要持久化
- **Skill 沙盒**：生产是否仍用本机 Docker，还是改 K8s Job / Firecracker
- **LLM Key 管理**：是否引入 Vault / KMS（R-32 敏感信息处理）
- **可观测性**：日志（已有 logger） / metrics / tracing
- **CI/CD**：升级子模块指针的发布流水线（R-10 + R-30）

生产化前必须先写 ADR 走 review，**禁止**在没有 plan 的情况下直接动 deploy 脚本（R-30）。

## 与其他文档的关系

- **R-30**：部署护栏（master 直推 / force push 禁止）
- **R-32**：敏感信息处理（API Key / DB 密码不入 git）
- **R-40**：DDD 分层与模块初始化顺序（后端启动流程的强制点）
- **architecture-overview.md**：组件职责详解
- **submodule-workflow.md**：拉取子仓的命令
- **event-protocol.md**：前后端通信协议（SSE）

## 验证方式

```bash
# 后端能起
cd mooc-manus && go build ./...

# 前端能起
cd mooc-manus-web && npm run build

# 依赖端口可达（macOS）
nc -z localhost 5432 && nc -z localhost 6379 && echo "deps ok"

# 后端 health 检查（启动后）
curl -fsS http://localhost:8080/api/health 2>/dev/null || echo "未实现 health 端点"

# 前端 dev server 可达
curl -fsS http://localhost:3000 | head -3
```

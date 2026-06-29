# 端到端新功能（spec → plan → 双仓编码 → 联调 → 指针）

接到一个跨前后端的产品需求（如"在 Agent 列表加一种新 Agent 类型并支持配置 UI"），从需求到上线的全流程剧本。关联 R-10 / R-20 / R-45 / R-41。

## 前置条件

1. 产品意图清晰但落地细节未定（典型场景：本剧本第一步就是把它落成 spec）
2. 两子仓本地干净、master 最新
3. 阅读过 `knowledge/architecture-overview.md` 与 `knowledge/event-protocol.md`
4. 影响面初判：是否涉及 SSE 新事件 / 新 DTO / 新表 / 新页面 / 新 Agent

## 步骤

### 阶段 1：Spec（总仓）

- 在 `mooc-manus-all/.harness/specs/` 写需求 spec：
  - **§动机**：业务背景与现状痛点
  - **§范围**：哪两个子仓改、不改什么
  - **§契约**：新增 / 改动的事件、DTO（关联 R-20）
  - **§现状基线**：列出受影响的实际文件路径（如 `internal/domains/services/agents/plan.go:120-180`）
- spec ID 形如 `SPEC-YYYYMMDD-<topic>`
- 在 `specs/INDEX.md` 追加索引行

### 阶段 2：Plan（总仓）

- 在 `mooc-manus-all/.harness/plans/` 写实施 plan：按"后端 → 前端 → 指针"切 Phase
- 每个 Phase 列：交付物 / 验证命令 / 关联 rule（R-XX 短码）
- 跨仓任务在 plan 内显式标注"⚠️ 子仓 commit"或"⚠️ 总仓指针升级"
- 在 `plans/INDEX.md` 追加索引行

### 阶段 3：后端实现（`mooc-manus`）

```bash
cd mooc-manus && git switch -c feat/<topic>
```

按子仓 plan 章节顺序：
1. **领域层**（`internal/domains/`）：新增 DO / DomainService 接口、值对象
2. **基础设施**（`internal/infra/`）：repository 实现、external adapter（如新 LLM 走 R-42 + ADR-0001）
3. **应用层**（`internal/applications/`）：service + DTO（注意命名与前端 camelCase 对齐，R-20）
4. **接口层**（`api/routers/`）：路由 + DI 装配
5. **如涉及新事件** → 走 `add-new-event-type.md` 后端段
6. `go build ./... && go test ./...` → commit & push & PR & merge

### 阶段 4：前端实现（`mooc-manus-web`）

```bash
cd mooc-manus-web && git switch -c feat/<topic>
```

1. **类型**（`src/types/`）：与后端 DTO 对齐字段
2. **API client**（`src/api/modules/`）：新增接口调用
3. **状态**（`src/store/`，zustand）：如需全局状态
4. **页面/组件**（`src/pages/<NewArea>/` 或 `src/components/`）：参考既有 `Agent / Tool / Skill / AppConfig` 结构（详见 `add-new-page.md`）
5. **路由**（`src/router/index.tsx`）：新增 path
6. **SSE 订阅**（如涉及）：走 `add-new-event-type.md` 前端段 + R-41
7. `npm run lint && npm run build` → commit & push & PR & merge

### 阶段 5：总仓指针升级

```bash
cd /path/to/mooc-manus-all && git switch -c chore/bump-<topic>
git submodule update --remote --merge mooc-manus && git add mooc-manus
git commit -m "chore: 升级子模块指针(mooc-manus, <一句话>)"
git submodule update --remote --merge mooc-manus-web && git add mooc-manus-web
git commit -m "chore: 升级子模块指针(mooc-manus-web, <一句话>)"
git push -u origin chore/bump-<topic>
```

### 阶段 6：联调

- 总仓根 `docker compose up` 或分别启两个子仓
- 跑契约校验：`.harness/scripts/validate-contracts.sh`
- 走完关键链路：触发请求 → 观察事件 → UI 渲染 → 数据回写

### 阶段 7：Retro（总仓）

- 在 `.harness/retro/` 追加一份回顾：踩过的坑、为后续 spec 沉淀经验

## 常见坑

1. **先实现再写 spec**：跨仓改完才发现契约不一致，前端的 `Type | null` 与后端 `*Type` 漂移。Spec/Plan 是预防工具，不是文档负担。
2. **指针在前**：前端依赖后端事件，但总仓先升前端 → 部署后前端订阅一个还不存在的事件类型。务必"先升后端再升前端"。
3. **单 commit 升两子模块**：违反 R-10 第 4 条；review 难度大，回滚粒度粗。
4. **跳过应用层直接 handler 调 domain**：违反 DDD 分层（R-40-ddd-layering），写完才发现接口该收的入参丢了。

## 验证

```bash
# 三仓
.harness/scripts/validate-harness.sh
HARNESS_ROOT=mooc-manus/.harness ./mooc-manus/.harness/scripts/validate-harness.sh
HARNESS_ROOT=mooc-manus-web/.harness ./mooc-manus-web/.harness/scripts/validate-harness.sh

# 契约
.harness/scripts/validate-contracts.sh

# 端到端
# 启动 + 触发 + 断言（人工或脚本）
```

## Agent 行为

- 任何"端到端新功能"请求 → 先 dispatch sub-agent 起 spec，**不直接编码**；spec 写完再起 plan
- 看到"我直接改后端就行" → 提示 R-20：是否会影响契约？需要 ADR 吗？
- 阶段 5 升指针时 → 默认拆两 commit；只有用户明确说合并才合
- 联调失败 → 优先看 `validate-contracts.sh` 输出（最常见的根因），再看 R-45 顺序约束
- ⚠️ 注意 R-10：在总仓阶段（1/2/5/6/7）若发现编辑落在 `mooc-manus/` 或 `mooc-manus-web/` 内的源码 → 拒绝并提示"请切换到子仓"
- 关键决策点（spec 范围、是否引入新事件、是否拆 DTO 版本）→ 停下来问用户

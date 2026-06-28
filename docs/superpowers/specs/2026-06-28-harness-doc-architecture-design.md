---
title: mooc-manus-all SDD + Harness 三层文档体系
date: 2026-06-28
author: harness engineering team
status: in-review
---

# 设计文档：mooc-manus-all SDD + Harness 三层文档体系

## 1. 背景与动机

### 1.1 问题

mooc-manus-all 是一个智能体编排全栈系统（Go DDD 后端 + React 前端 + MCP/A2A 协议），通过 git submodule 组织为 mono-repo。当前工程已经在多处分散维护"agent 指导"类文档：

- 根仓：`CLAUDE.md`
- 后端 `.harness/`：`.cursorrules`、`AGENTS.md`、`knowledge/conventions.md`、`knowledge/ai-error-log.md`
- 后端 `docs/`：4 份业务规范（code-standards / skill-config-and-version-spec / skill-executor-fix-plan）
- 根仓 `docs/superpowers/plans/`：1 份正在进行的 plan

这些文档形态各异、归属混乱：有的给 AI agent 看（rules），有的给人类工程师看（onboarding），有的是流程产物（specs/plans），没有统一的索引、加载顺序与冲突解决规则。AI agent 在编码/规划/评审循环中无法稳定遵循项目规约，新成员也找不到入口。

### 1.2 目标

建立一套**SDD（Spec-Driven Development）+ Harness 三层文档体系**，主要服务于 AI coding agent（Claude Code / Cursor 等）和 AI 自我评审 / 规划循环：

1. **认知层**：rules / knowledge / playbooks / workflows / specs / plans / retro，让 agent 读到什么、按什么顺序读
2. **桥接层**：CLAUDE.md / AGENTS.md / GEMINI.md / .cursorrules，让工具链自动找到 .harness/
3. **执行层**：agents / hooks / scripts，把"应当"变成"可强制执行/可校验"

### 1.3 非目标

- 不替换现有业务规范文档（如 skill-config-and-version-spec.md），仅做归类和引用
- 不引入新的 agent 框架或工具链
- 不强制人类工程师改变日常开发习惯（hooks 仅 warning）
- 不覆盖运维 harness（CI/CD pipeline）或测试 harness（test fixtures）

## 2. 方案对比

### 方案 A：三仓对称 · 单 harness 根（推荐）

每个仓库（总仓 + 后端 + 前端）根下都有一个 `.harness/` 目录，内部结构完全对称。三个 .harness 通过显式 manifest 互相 inherits。

- **优点**：mono-repo via submodule 友好（agent 在任一仓单独打开都自洽）；七层划分是 harness engineering 实践共识；现有 9 份文档全部有归宿
- **缺点**：初期工作量最大；需要维护三套结构

### 方案 B：单仓集中 · 子仓只放门面

只在总仓维护完整 harness，子仓仅有极简 `.harness/README.md` 跳转到总仓。

- **优点**：维护点单一，不会三仓不同步
- **缺点**：agent 被孤立 dispatch 到子仓时看不到总仓 .harness；与 submodule 独立工作习惯有摩擦

### 方案 C：按角色而非按位置组织

不按仓库分，按"角色"组织：`docs/harness/{for-coding/, for-planning/, for-reviewing/, for-onboarding/}`。

- **优点**：agent 按当前任务角色直接拉对应目录
- **缺点**：与 `.cursorrules`/`AGENTS.md` 工具默认路径不亲和；前后端规则混在一起反而难定位

### 推荐方案：A

理由：
1. 对齐现有 `.harness/` 路径与 `docs/superpowers/plans` 流程
2. mono-repo via submodule 结构友好
3. 七层划分（rules/knowledge/playbooks/workflows/specs/plans/retro）在 harness engineering 实践中被验证
4. 保留所有现有内容，零丢失，仅做分类与索引层重构

## 3. 详细设计

### 3.1 三层 harness 模型

| 层 | 谁读 | 作用 | 失效后果 |
|---|---|---|---|
| **认知层** `.harness/{rules,knowledge,playbooks,workflows,specs,plans,retro}` | AI agent 主循环 | 提供约束 + 上下文 + 流程 | agent 写出违规代码 |
| **桥接层** 仓根 `CLAUDE.md`、`AGENTS.md`、`GEMINI.md`、`.cursorrules` | AI 工具链（启动时自动加载） | 把工具自动加载入口路由到 .harness/ | 工具读不到 .harness，等于没有 harness |
| **执行层** `.harness/{agents,hooks,scripts}` | git / Claude Code subagent / CI | 把"应当"变成"必须" | 违规仅靠 agent 自律 |

### 3.2 同构骨架（三仓一致）

```
.harness/
├── README.md                  入口卡片
├── manifest.yaml              元数据：版本、inherits、加载顺序、清单
│
├── rules/                     【认知】硬约束（NN- 前缀决定加载顺序）
├── knowledge/                 【认知】上下文百科（按需检索）
├── playbooks/                 【认知】任务剧本（任务 → 步骤）
├── workflows/                 【认知】SDD 模板（仅总仓维护，子仓继承）
├── specs/                     【认知】已评审通过的设计文档
├── plans/                     【认知】实现计划（in-progress / completed / blocked）
├── retro/                     【认知】学习闭环
│   ├── ai-error-log.md        错误案例库
│   └── decisions/             ADR
│
├── agents/                    【执行】子代理定义
│   ├── README.md
│   ├── ddd-layer-checker.md
│   ├── event-contract-checker.md
│   ├── llm-protocol-checker.md
│   ├── submodule-discipline-checker.md
│   └── prompt-template-reviewer.md
│
├── hooks/                     【执行】git 钩子源（warning only）
│   ├── pre-commit
│   ├── commit-msg
│   ├── pre-push
│   ├── post-checkout
│   └── install.sh
│
└── scripts/                   【执行】辅助工具
    ├── bootstrap.sh
    ├── validate-harness.sh
    ├── generate-cursorrules.sh
    └── sync-bridges.sh

# 仓根（桥接层）
CLAUDE.md
AGENTS.md
GEMINI.md
.cursorrules                   自动生成，禁止手改
```

### 3.3 命名约定（强制）

| 类型 | 规则 | 示例 |
|---|---|---|
| rules | `NN-kebab-case.md`，00-09 总则、10-29 跨仓、30-39 安全、40-69 仓内、70-89 工具链、90-99 实验性 | `40-ddd-layering.md` |
| knowledge | 名词性 kebab-case | `event-protocol.md` |
| playbooks | 动宾性 kebab-case | `add-new-tool.md` |
| agents | 角色名 kebab-case | `ddd-layer-checker.md` |
| hooks | 标准 git hook 名 | `pre-commit` |
| spec | `YYYY-MM-DD-<topic>-design.md` | `2026-06-28-harness-doc-architecture-design.md` |
| plan | `YYYY-MM-DD-<topic>-plan.md` | 同上 |
| ADR | `ADR-NNNN-<topic>.md` | `ADR-0001-llm-protocol-abstraction.md` |

### 3.4 manifest.yaml schema

```yaml
harness_version: "1.0"
repo: mooc-manus-all                # 或 mooc-manus / mooc-manus-web
inherits:                            # 仅子仓使用
  - path: ../mooc-manus-all/.harness
    version: "1.0"

cognition:
  loadOrder:                         # rules 加载顺序
    - rules/00-priority.md
    - rules/10-submodule-discipline.md
    - rules/20-cross-repo-contracts.md
    - rules/30-deployment-safety.md
  playbooksIndex: playbooks/INDEX.md

bridges:                             # 桥接层文件位置（仓根）
  - file: ../CLAUDE.md
    tool: claude-code
  - file: ../AGENTS.md
    tool: agents-md-standard
  - file: ../.cursorrules
    tool: cursor-legacy
    generated: true                  # 自动生成，禁止手改

execution:
  agents:
    - agents/ddd-layer-checker.md
    - agents/event-contract-checker.md
    - agents/llm-protocol-checker.md
    - agents/submodule-discipline-checker.md
    - agents/prompt-template-reviewer.md
  hooks:
    installer: scripts/bootstrap.sh
    enabled:
      - pre-commit
      - commit-msg
      - pre-push
    strictness: warning              # warning only，不 block
  scripts:
### 3.5 rules/ 内容拆分

#### 总仓 rules（跨仓通用约束）

```
mooc-manus-all/.harness/rules/
├── 00-priority.md              指令优先级与冲突解决
├── 10-submodule-discipline.md  子模块升级规约、禁止跨仓改文件
├── 20-cross-repo-contracts.md  前后端契约：SSE 11 种事件、DTO 结构
└── 30-deployment-safety.md     部署护栏：不推 master、不跨仓强推
```

每个 rules 文件 frontmatter：
```yaml
---
rule_id: R-NN-name
severity: critical | high | medium | low
---
```

#### 后端 rules（Go + DDD + Agent 内核）

```
mooc-manus/.harness/rules/
├── 40-ddd-layering.md          DDD 三层职责、PO/DO/DTO 转换
├── 41-go-conventions.md        命名、错误处理、日志（迁移 .cursorrules）
├── 42-llm-protocol.md          Message/Tool 值对象使用规约
├── 43-agent-composition.md     4 种 Agent 调用时机、参数格式
├── 44-tool-registration.md     ToolProvider 注册、Skill/MCP/A2A
├── 45-event-emission.md        何时发哪种事件、payload 必填字段
├── 46-prompt-management.md     PromptManager 单例使用、Plan 持久化
└── 47-memory-boundaries.md     ChatMemory 生命周期、conversationId 隔离
```

#### 前端 rules（React + TypeScript + SSE）

```
mooc-manus-web/.harness/rules/
├── 40-react-conventions.md     组件划分、hooks 规约、状态管理边界
├── 41-sse-event-handling.md    SSE 订阅、事件解析、错误重连、类型安全
├── 42-typescript-strict.md     严格模式、类型守卫、避免 any
└── 43-ui-accessibility.md      ARIA、键盘导航、语义化 HTML
```

#### 跨仓继承与覆盖规则

- 子仓 manifest.yaml::inherits 声明父仓路径
- Agent 启动时：先加载父仓 rules（按父仓 loadOrder），再加载本仓 rules
- **同名规则文件：本仓覆盖父仓**（子仓文件头部需声明 `overrides: ../mooc-manus-all/.harness/rules/40-xxx.md`）
- **不同名：合并**
- `validate-harness.sh` 扫描同名文件 → 警告"R-XX 被子仓覆盖"

### 3.6 knowledge/ 与 playbooks/ 内容拆分

#### 职责切分

| 维度 | knowledge/ | playbooks/ |
|---|---|---|
| 阅读时机 | 按需检索（agent 遇到概念时查） | 任务驱动（agent 要做 X 时看） |
| 组织方式 | 按领域分类 | 按任务分类 |
| 内容形式 | 概念 + 原理 + 示例 | 步骤 + 检查清单 + 常见坑 |
| 更新频率 | 稳定 | 频繁 |
| 典型读者 | "Message 值对象是什么" | "我要加一个新 Agent 类型" |

#### 总仓 knowledge（全栈共识）

```
mooc-manus-all/.harness/knowledge/
├── README.md                        知识库索引
├── architecture-overview.md         全栈架构总图 + Mermaid
├── glossary.md                      术语表
├── event-protocol.md                SSE 11 种事件契约详解
├── submodule-workflow.md            子模块协作工作流
└── deployment-topology.md           部署拓扑
```

#### 后端 knowledge（Go + Agent 内核深度）

```
mooc-manus/.harness/knowledge/
├── agent-internals.md               4 种 Agent 实现原理 + 状态机
├── tool-invocation-flow.md          ToolProvider → Executor 调用链 + Mermaid
├── llm-protocol-abstraction.md      Message/Tool 设计动机 + SDK 映射
├── prompt-management.md             PromptManager 单例 + Plan 持久化
├── memory-lifecycle.md              ChatMemory 生命周期 + 清理策略
├── event-driven-model.md            事件发布/订阅机制 + 可靠性
└── ddd-examples.md                  DDD 三层典型代码示例
```

#### 前端 knowledge

```
mooc-manus-web/.harness/knowledge/
├── sse-client-architecture.md       EventSource 封装 + 重连策略
├── chat-ui-event-flow.md            前端事件驱动渲染流程
├── component-taxonomy.md            组件分类
└── state-management.md              状态管理策略
```

#### 总仓 playbooks（跨仓任务）

```
mooc-manus-all/.harness/playbooks/
├── upgrade-submodule.md             升级子模块指针完整步骤
├── add-new-event-type.md            新增 SSE 事件类型（前后端协同）
├── full-stack-feature.md            全栈功能开发
└── emergency-rollback.md            紧急回滚流程
```

#### 后端 playbooks

```
mooc-manus/.harness/playbooks/
├── add-new-agent-type.md
├── add-react-agent-step.md
├── integrate-new-mcp-server.md
├── extend-llm-provider.md
└── migrate-repository-impl.md
```

#### 前端 playbooks

```
mooc-manus-web/.harness/playbooks/
### 3.7 workflows/ SDD 全链路模板（仅总仓维护）

```
mooc-manus-all/.harness/workflows/
├── README.md                        流程总览 + 何时用哪个
├── 1-brainstorm/
│   ├── template.md                  brainstorm 输出模板
│   └── example-add-agent.md
├── 2-spec/
│   ├── template.md                  设计文档模板
│   ├── checklist.md                 spec 必备章节检查清单
│   └── example-llm-protocol.md
├── 3-plan/
│   ├── template.md                  实现计划模板
│   ├── task-breakdown-guide.md
│   └── example-harness-build.md
├── 4-implement/
│   ├── checklist.md                 实现阶段检查清单
│   ├── commit-conventions.md
│   └── testing-requirements.md
├── 5-review/
│   ├── code-review-checklist.md
│   ├── spec-review-prompt.md        spec 评审 agent prompt
│   └── self-review-guide.md
└── 6-retro/
    ├── error-log-template.md
    └── adr-template.md
```

子仓通过 inherits 继承，不重复定义。

### 3.8 流程产物管理（specs / plans / retro）

#### specs/

```
.harness/specs/
├── INDEX.md                         所有 spec 的分类索引
├── 2026-06-28-harness-doc-architecture-design.md
└── ...
```

状态流转：draft → in-review → approved → deprecated。
INDEX.md 按状态分组：进行中 / 已通过 / 已废弃。

#### plans/

```
.harness/plans/
├── INDEX.md
├── in-progress/
│   └── 2026-06-28-harness-doc-build-plan.md
├── completed/
└── blocked/
```

plan 完成后从 in-progress/ 移到 completed/，便于归档。

#### retro/

```
.harness/retro/
├── ai-error-log.md                  错误案例库（迁移现有）
└── decisions/
    ├── INDEX.md
    ├── ADR-0001-llm-protocol-abstraction.md
    └── ...
```

ADR 编号规则：四位数递增，INDEX.md 维护"决策树"（哪些 ADR 互相依赖/覆盖）。
现有后端 `.harness/knowledge/ai-error-log.md` 迁移到总仓 `.harness/retro/ai-error-log.md`，保持单一来源。

### 3.9 桥接层（CLAUDE.md / AGENTS.md / GEMINI.md / .cursorrules）

桥接层不是空壳门面，也不是规则正文——职责是**"工具特定的开场白 + 把工具引向 .harness"**：

```
CLAUDE.md 结构（约 80-120 行）
├─ 身份与语言：工作语言、回复风格
├─ Harness 加载指令：按 manifest.yaml::loadOrder 加载 rules
├─ Claude Code 特化：superpowers skills 清单、项目专属 subagent 索引
├─ 当前进行中的 plan 索引
├─ 核心约束摘要（从 rules/ 提取最高优先级 4-5 条）
└─ 兜底："详细规则见 .harness/rules/，不要把规则正文复制到这里"
```

差异化：
- **CLAUDE.md**：Claude Code 特化（superpowers / hooks / settings.json）
- **AGENTS.md**：通用 AGENTS.md 标准（Cursor 新版、Codex、其他读 AGENTS.md 的工具）
- **GEMINI.md**：Gemini CLI 的 `activate_skill` 机制
- **.cursorrules**：由 `scripts/generate-cursorrules.sh` 从 `rules/` 拼装，**不手写**

> 设计原则：桥接层只放"工具特定话术 + 路径指针"，规则正文唯一存放在 `.harness/rules/`，单源避免漂移。

### 3.10 执行层（agents / hooks / scripts）

#### agents/ — 项目专属子代理

每份 .md 定义一个可被主 agent 通过 `Agent`/`Task` 工具 dispatch 的检查员：

```markdown
---
name: ddd-layer-checker
description: 检查 PO/DO/DTO 边界、interfaces 是否私下 import domains/repositories
when_to_use: 任何修改后端代码后 / spec/plan 中涉及跨层调用时
inputs: 修改的文件列表 + diff
outputs: 违规位置 + 建议修复
---
（正文：检查清单、典型违规模式、检查 prompt）
```

5 个 agent：
- `ddd-layer-checker`：检查 DDD 分层违规
- `event-contract-checker`：检查前后端事件契约
- `llm-protocol-checker`：检查 Message/Tool 值对象使用
- `submodule-discipline-checker`：检查跨仓改动合规性
- `prompt-template-reviewer`：检查 Prompt 模板变更

与 superpowers 自带 agent（spec-document-reviewer 等）**互补**，专攻本项目业务规则。

#### hooks/ — git 强制护栏（warning only）

- `pre-commit`：lint / format / `validate-harness.sh` / 文件名校验
- `commit-msg`：conventional commits 格式校验（warning）
- `pre-push`：必要单元测试 / 子模块指针校验 / specs 引用但未提交检查
- `post-checkout`：切分支时刷新桥接层
- `install.sh`：通过 `core.hooksPath` 部署（兼容 submodule）

**所有 hooks 仅输出 warning，不阻断提交**。

#### scripts/ — 自动化辅助

- `bootstrap.sh`：一键安装 hooks + 校验 manifest
- `validate-harness.sh`：CI 必跑，校验 .harness 自身完整性
- `generate-cursorrules.sh`：单源驱动，从 rules/ 拼装 .cursorrules
- `sync-bridges.sh`：基于 manifest 重生成 CLAUDE.md / AGENTS.md 的"路径指针"段

### 3.11 错误处理与冲突解决

#### 规则冲突优先级

`00-priority.md` 定义统一优先级（高 → 低）：

1. 用户当前会话的直接指令
2. 仓根桥接层（CLAUDE.md / AGENTS.md / GEMINI.md）
3. 本仓 `.harness/rules/`
4. 父仓 `.harness/rules/`（通过 inherits 继承）
5. system prompt 默认行为

#### 典型冲突场景

| 场景 | 解决 |
|------|------|
| 用户说"这次提交跳过 lint"，但 rules 要求必须 lint | 听用户，但在响应中提示"已跳过 lint（违反 R-42）" |
| CLAUDE.md 说"用中文"，AGENTS.md 没提 | 以 CLAUDE.md 为准 |
| 后端 rules 与总仓 rules 对同一概念定义不一致 | 以**更近的仓库**（后端）为准，标记冲突到 retro/ai-error-log.md |

#### Agent 行为要求

- 每次启动时按 manifest.yaml::loadOrder 加载 rules
- 遇到明显冲突时，按优先级选择，并在响应中说明"已按优先级选择 X，忽略 Y"
- 无法判断时询问用户而非自行决策

#### 桥接层失效

- 若 CLAUDE.md 中的"Harness 加载指令"段缺失：`validate-harness.sh` 在 CI 报错
- 若 `.cursorrules` 与 `rules/` 内容漂移：`sync-bridges.sh` 检测到重新生成

### 3.12 测试策略

#### Harness 自身的可验证性

| 验证项 | 方法 | 何时跑 |
|--------|------|--------|
| .harness 结构完整性 | `validate-harness.sh` 校验必备目录/文件存在 | pre-commit + CI |
| manifest.yaml::loadOrder 引用有效 | 脚本检查每个引用文件是否存在 | pre-commit + CI |
| rules 文件命名符合 NN-kebab-case | 正则校验 | pre-commit |
| 子仓 inherits 路径有效 | 脚本解析父仓 .harness 是否存在 | CI |
| 同名 rules 文件冲突 | 跨父子仓扫描同名文件 → 警告 | CI |
| 桥接层指针段未漂移 | `sync-bridges.sh --check` 对比生成内容 | CI |
| .cursorrules 与 rules/ 同步 | `generate-cursorrules.sh --check` | CI |
| 前后端事件契约一致 | `validate-contracts.sh` 对比枚举 | CI |

#### Harness 起作用的可验证性

| 验证项 | 方法 |
|--------|------|
| Agent 是否真的按 loadOrder 加载 rules | 让 agent 执行简单任务，观察是否提及 rules 中的约束 |
| Subagent 是否能被正确 dispatch | 在测试任务中显式 dispatch `ddd-layer-checker`，观察输出 |
| Playbook 是否被发现 | 让 agent 执行"升级子模块"任务，看是否找到 `upgrade-submodule.md` |
| Hooks 是否生效 | 提交故意违反命名的文件，看 pre-commit 是否警告 |

## 4. 影响面分析

### 4.1 前端

- 新增 `mooc-manus-web/.harness/` 目录及所有内容
- 重写仓根 `CLAUDE.md`、新增 `AGENTS.md`、自动生成 `.cursorrules`
- 不影响前端业务代码

### 4.2 后端

- 重组现有 `.harness/` 目录（增量重组，零删除）
- 现有 `.cursorrules` → 拆分到 `rules/41-go-conventions.md` + 自动生成新 `.cursorrules`
- 现有 `AGENTS.md` → 拆分到 `rules/40-ddd-layering.md` + `knowledge/agent-internals.md`
- 现有 `knowledge/conventions.md`、`knowledge/ai-error-log.md` → 重组
- 现有 `docs/` 4 份业务规范 → 保持主体，仅从 `.harness/knowledge/` 添加指向
- 不影响后端业务代码

### 4.3 总仓

- 新增 `mooc-manus-all/.harness/` 目录及所有内容
- 重写仓根 `CLAUDE.md`、新增 `AGENTS.md`
- 现有 `docs/superpowers/plans/2026-06-25-architecture-unification.md` → 迁移到 `.harness/plans/in-progress/`
- 不影响 submodule 指针

### 4.4 数据库

无变化。

### 4.5 依赖

无新增运行时依赖。可选工具：
- `yq`（用于 manifest.yaml 解析，hooks/scripts 中使用）
- `shellcheck`（CI 中校验 shell 脚本质量）

### 4.6 向后兼容性

- 现有 9 份文档全部保留为"归档版本"（`.bak` 后缀），新体系建立后保留 1 个 release cycle 再考虑删除
- 现有提交习惯（如 `chore: 升级子模块指针`）已符合 conventional commits，无需调整
- 旧版 Cursor 通过自动生成的 `.cursorrules` 继续工作

## 5. 实施步骤（概要）

详细任务拆解见对应 plan 文件。本节仅给出阶段总览：

1. **Phase 1**：搭建三仓 .harness 骨架 + manifest（1 天）
2. **Phase 2**：迁移总仓 rules（0.5 天）
3. **Phase 3**：迁移后端 rules（1 天）
4. **Phase 4**：迁移前端 rules（0.5 天）
5. **Phase 5**：填充 knowledge（1.5 天）
6. **Phase 6**：编写 playbooks（1 天）
7. **Phase 7**：workflows 模板（0.5 天）
8. **Phase 8**：specs/plans/retro 整理（0.5 天）
9. **Phase 9**：agents 定义（1 天）
10. **Phase 10**：hooks + scripts（1 天）
11. **Phase 11**：桥接层更新（0.5 天）
12. **Phase 12**：CI 集成（0.5 天）
13. **Phase 13**：文档收尾（0.5 天）

**总工作量**：约 10 工日（含并行可压缩到 7-8 工日）。
**关键路径**：Phase 1 → 2 → 3 → 10。其余可并行。

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 三仓 .harness 同步漂移 | 中 | 高 | `validate-harness.sh` 进 CI，强制检查 inherits 路径有效性；同名文件冲突时强制 INDEX 标注 overrides |
| 桥接层与 rules 内容漂移 | 高 | 中 | `.cursorrules` 自动生成，CLAUDE.md 指针段由 `sync-bridges.sh` 维护，CI 校验 |
| Agent 不读 manifest::loadOrder | 中 | 高 | CLAUDE.md 顶部明确"必读 manifest"，配合 superpowers 的 using-superpowers skill |
| 现有文档迁移过程中丢失内容 | 低 | 高 | 增量重组策略：旧文件保留 `.bak`，新文件建立后保留 1 release cycle |
| Hooks warning 被忽视 | 高 | 低 | 接受这是已选 tradeoff；CI 是最终强制点 |
| 子代理 dispatch 失败 | 中 | 中 | agents/README.md 详细说明何时用，提供 Agent 调用示例 |
| 团队新成员看不懂 .harness | 中 | 中 | 编写 `docs/harness-guide.md` 面向人类，作为入口 |
| superpowers plan 流程被打断 | 低 | 中 | 现有 `docs/superpowers/plans/2026-06-25-architecture-unification.md` 平滑迁移到 `.harness/plans/in-progress/`，保留 URL 引用 |

## 7. 参考资料

### 现有文档（待迁移/引用）

- `mooc-manus-all/CLAUDE.md`
- `mooc-manus/.harness/.cursorrules`
- `mooc-manus/.harness/AGENTS.md`
- `mooc-manus/.harness/knowledge/conventions.md`
- `mooc-manus/.harness/knowledge/ai-error-log.md`
- `mooc-manus/docs/mooc-manus-code-standards.md`
- `mooc-manus/docs/skill-config-and-version-spec.md`
- `mooc-manus/docs/skill-executor-fix-plan.md`
- `mooc-manus/docs/superpowers/plans/2026-06-25-architecture-unification.md`

### 关键代码索引

- Agent 抽象：`mooc-manus/internal/domains/services/agents/{agent,base,react,plan,a2a}.go`
- LLM 协议抽象：`mooc-manus/internal/domains/models/llm/{message,tool}.go`
- 工具链：`mooc-manus/internal/domains/services/tools/{base,execute_skill,mcp,a2a}.go`
- 事件模型：`mooc-manus/internal/domains/models/events/`
- Prompt：`mooc-manus/internal/domains/models/prompts/`
- Memory：`mooc-manus/internal/domains/models/memory/`
- 前端 SSE 客户端：`mooc-manus-web/src/api/sse.ts`

### 外部参考

- AGENTS.md 标准：https://agents.md
- Spec-Driven Development：业界 SDD 实践
- Architecture Decision Records (ADR)：Michael Nygard, 2011


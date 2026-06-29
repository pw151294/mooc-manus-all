# 子模块协作工作流

## 为什么需要这份文档

mooc-manus-all 通过 git submodule 把后端 `mooc-manus` 与前端 `mooc-manus-web` 链接为 mono-repo。指针型的子模块对工程师（人或 AI）来说有两个陷阱：在总仓直接改了子仓文件而没意识到、指针升级 commit 丢失上下文导致后续溯源困难。R-10 给出禁止/要求清单，本文档把它落成**可重放的剧本**——每条命令做什么、什么时候做、出错怎么办。

> 规则正文参见 R-10（子模块协作纪律）、R-30（部署护栏 force push 红线）；详细 commit message 模板与紧急回滚另见 `playbooks/upgrade-submodule.md` 与 `playbooks/emergency-rollback.md`（Phase 6 落地）。本文档仅讲日常工作流。

## 现状

### 三仓拓扑

```
mooc-manus-all/                   # 总仓（指针所有者）
├── .gitmodules                   # 声明两个子模块路径与远端
├── mooc-manus/                   # 后端子仓（独立 git history）
└── mooc-manus-web/               # 前端子仓（独立 git history）
```

`git submodule status` 输出形如 `<sha> mooc-manus (heads/master)`，其中 sha 是总仓"锁定"的子仓 commit。子仓自身的工作树指向哪个分支与总仓无关——总仓只关心那个 sha。

### 命令清单

| 场景 | 命令 | 何时使用 |
|---|---|---|
| 克隆总仓 | `git clone --recurse-submodules <url>` | 首次拉代码 |
| 拉子模块 | `git submodule update --init --recursive` | 已 clone 但子仓为空 |
| 同步远端指针 | `git submodule update --remote --merge` | 想拿到子仓 master 最新 |
| 进入子仓 | `cd mooc-manus`（普通 git 仓） | 修改子仓代码前 |
| 查看指针差异 | `git diff --submodule=log` | review 总仓 PR |
| 提交指针升级 | 总仓 `git add mooc-manus && git commit` | 子仓 push 之后 |

## 典型工作流

### 工作流 A：单子仓功能开发

适用于"只改后端"或"只改前端"。

1. 在子仓分支开发 → 子仓单测/lint 通过 → 子仓 commit & push（**绝不能在总仓里直接改子仓文件**，R-10）
2. 切回总仓 `cd ..` → `git submodule update --remote mooc-manus` 拉取子仓最新 → 此时 `git status` 应显示 `modified: mooc-manus (new commits)`
3. 总仓 `git diff --submodule=log mooc-manus` 检查指针差异，确认所含 commit 与预期一致
4. 总仓 `git add mooc-manus && git commit -m "chore: 升级 mooc-manus 至 <短SHA>（<关键改动>）"`
5. 总仓 push（走 PR，R-30 禁止直推 master）

### 工作流 B：跨仓协同（前后端同时改）

适用于"新增 SSE 事件"等需要双仓同步的任务。

1. 后端子仓先开发并 push（事件源头）
2. 前端子仓基于后端事件定义开发并 push
3. 总仓**分两个 commit** 升级指针（R-10 第 4 条：一个 commit 一个子模块）：
   ```
   chore: 升级子模块指针(mooc-manus, 新增 agent_thinking 事件)
   chore: 升级子模块指针(mooc-manus-web, 订阅 agent_thinking)
   ```
4. CI 跑 `validate-contracts.sh` 校验前后端 EventType 一致性（R-20）

### 工作流 C：合并冲突中的子模块指针

两条 feature 分支同时升过同一个子模块 → merge 时总仓显示 conflict at `mooc-manus`。不要直接 `--theirs/--ours`（会丢工作），进入子仓 merge 双方分支并 push 一个新 commit，回总仓把指针指到那个新 commit。

## 历史 commit 形态参考

总仓现有指针升级 commit 已稳定形成 `chore: 升级子模块指针(...)` 格式：

```
4b39465 chore: 升级子模块指针(mooc-manus & mooc-manus-web)
3c3f987 chore: 升级子模块指针(mooc-manus, R-45 数量修正)
1e4460a chore: 升级子模块指针(mooc-manus & mooc-manus-web) - Phase 9 agents 定义
```

约定：前缀 `chore: 升级子模块指针` 固定；括号内说明涉及子仓与一句话改动摘要；双子仓同时升级时用 `&` 连接，但鼓励拆成两个 commit 让 review 更聚焦。

## 与其他文档的关系

- **R-10**：禁止/要求清单的规则正文
- **R-20**：跨仓契约（事件 / DTO），决定工作流 B 的同步范围
- **R-30**：禁止直推 master 与 force push
- **architecture-overview.md**：三仓职责与协作界面
- **event-protocol.md**：跨仓变更最常见的导火索（新事件）
- **deployment-topology.md**：本地起服的端口与服务依赖
- **playbooks/upgrade-submodule.md**（Phase 6）：升级指针的完整 checklist

## 例子

### 反例：在总仓直接改子仓文件

```bash
cd mooc-manus-all
vim mooc-manus/internal/domains/models/agents/react_agent.go   # ❌
```

总仓视角里 `mooc-manus/` 是 gitlink 不是目录，git 不会把内部路径加入索引。Agent 行为：拒绝并提示"请 `cd mooc-manus` 后再修改"。

### 正例：升级单一子模块指针

```bash
cd mooc-manus
git pull origin master
cd ..
git submodule status                       # 确认 mooc-manus 已变
git diff --submodule=log mooc-manus        # 看里面有哪些 commit
git add mooc-manus
git commit -m "chore: 升级子模块指针(mooc-manus, R-42 LLM 协议抽象修复)"
```

## 验证方式

```bash
# 三仓结构
git submodule status

# 当前指针与子仓 origin/master 的差距
git submodule foreach 'git log --oneline origin/master ^HEAD | head -5'

# pre-push hook 是否就位（R-10 第 3 条的强制点）
ls .harness/hooks/pre-push 2>/dev/null

# 检查上一次升级 commit 是否含"升级"关键词
git log -1 --format=%s -- mooc-manus | grep -E "升级|upgrade"
```

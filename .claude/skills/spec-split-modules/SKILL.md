---
name: spec-split-modules
description: 基于 superpowers 生成的 spec 技术设计文档进行模块拆分，为每个子模块产出独立的 spec 设计文档与 eval 功能验证文档。用户想按技术方案启动项目、把大 spec 切成可独立交付的子模块时使用。
argument-hint: "[superpowers-spec-path]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# spec-split-modules

把一份 superpowers 产出的大型 spec，拆成多个可独立 spec → plan → implementation 的子模块，
每个子模块配一份**设计文档**（`docs/harness/specs/<group>/M{n}-*-spec.md`）和一份
**功能验证文档**（`docs/harness/e2e/<group>/M{n}-*-e2e.md`），外加一份索引 README。

## 何时用

- 用户明确调用 `/spec-split-modules <spec-path>` 或语义等价的请求
- 用户手上已有一份 superpowers 产出的、体量较大的 spec 文档（500+ 行 / 覆盖多页面或多领域）
- 用户想把大 spec 落成"可分批交付"的子任务，然后按模块跑 writing-plans → executing-plans

**不适用**：spec 本身规模很小（一个模块的量）、或用户还没进入设计阶段（该先跑 brainstorming）。

## 输入契约

- **必选参数**：superpowers spec 文档路径（相对 or 绝对）
- 该 spec 通常在 `docs/superpowers/specs/YYYY-MM-DD-*-design.md`，是完整的技术方案

## 输出契约

在项目根目录下产出：

```
docs/harness/specs/<group-name>/
├── README.md                       # 模块索引
├── M1-<kebab-slug>-spec.md
├── M2-<kebab-slug>-spec.md
└── ...

docs/harness/e2e/<group-name>/
├── M1-<kebab-slug>-e2e.md
├── M2-<kebab-slug>-e2e.md
└── ...
```

`<group-name>` 从父 spec 主题派生，用 kebab-case，例：`eval-modules`、`agent-tracing-modules`。

## 工作流

### Step 0 · 确认输入

1. 用 Read 打开 `$ARGUMENTS` 指向的 spec，确认存在且是 superpowers 风格（有明确章节树、覆盖多个能力域）
2. 通读一遍，做心里预估：可能拆几个模块？基础设施层 / 业务层 / 集成层的边界在哪？
3. 用 Bash `grep -n "^#" <spec>` 拿一份章节树，便于后续切片时精确引用父规格章节号

**若父 spec 已在 §10 或 §"实施顺序"里显式给出 Phase 列表**——那多半就是天然的模块边界，可以直接沿用。

### Step 1 · 拆分模块

**参阅**：`references/split-algorithm.md`（拆分粒度原则 + 依赖建模）

产出的中间产物（写在心里或短暂记在 TodoList 里，不必写文件）：

- 模块列表（编号 + 名称 + 一句话职责）
- 每个模块的交付物清单（文件、组件、接口，逐项列清楚）
- 依赖 DAG（谁依赖谁，弱依赖标注）
- 推荐执行顺序（DAG 拓扑排序）

**红旗自检**：拆完后用 `split-algorithm.md` 的红旗信号表复查一遍，出现"两个模块改同一文件"、"某模块只有 1 个交付文件"、"循环依赖"任一，就重拆。

### Step 2 · 与用户对齐（关键停顿点）

**不要一口气生成所有文件**。先把拆分结果以精简清单形式回复给用户：

```
建议拆分为 N 个模块：
- M1 {名称}（无依赖）：{一句话职责}，交付 {文件数} 个文件
- M2 {名称}（依赖 M1）：{一句话职责}...
- ...

推荐执行顺序：M1 → M2 → ... → M{n}
是否按此方案生成 spec + e2e？
```

用户确认或提出调整后，再进入 Step 3。若用户明确说"直接生成"或"你决定"，可跳过这步。

### Step 3 · 生成子 spec

**参阅**：`assets/spec-template.md`

对每个模块，用 Write 工具产出 `docs/harness/specs/<group>/M{n}-<slug>-spec.md`。

关键原则：

- **切片，不重写**：子 spec 的核心内容尽量**引用父规格章节号**（"详见父规格 §7.1.4"），
  避免复制粘贴大段代码——一致性交给父规格保证，子规格保持精简（150-350 行）
- **交付物必须具体**：列文件路径、组件名、接口个数，不用"若干工具方法"这类模糊描述
- **非目标要显式**：写清"本模块不做 X（属 M{k}）"，避免范围蔓延
- **依赖关系写在开头**：`依赖：M{k}；被依赖：M{k+n}`
- **决策继承要标源头**：关键决策表列出"依据（父规格章节）"，便于反查

### Step 4 · 生成 e2e 验证文档

**参阅**：`references/eval-coverage.md`（覆盖矩阵 + 检查项写法）+ `assets/e2e-template.md`

对每个模块，用 Write 工具产出 `docs/harness/e2e/<group>/M{n}-<slug>-e2e.md`。

关键原则：

- **区分类型**：无 UI 模块 → "技术层验证"（编译、curl、devtools）；有 UI 模块 → "功能验证"（用户操作流）
- **每个检查项独立可执行**：`- [ ]` 开头 + 前置 + 具体操作 + `Expected:` 可观察结果
- **覆盖矩阵按模块类型选**：不是每个模块都要跑全 9 个维度，参考 `eval-coverage.md` 的对应表
- **交付物必须都被覆盖**：spec §1.1 交付物清单里的每个文件，至少被一条检查项覆盖到
- **依赖下游的项标 TODO**：本模块 e2e 里若有测试项依赖尚未交付的 M{k+n}，明确标注"需 M{k+n} 后测；本模块独立验收时跳过"
- **收尾要有验收清单**：文末列 3-5 条最终 checklist（所有检查通过 / git 干净 / devtools 无错等）

### Step 5 · 生成索引 README

**参阅**：`assets/readme-template.md`

产出 `docs/harness/specs/<group>/README.md`：模块列表表格 + 依赖关系图 + 执行方式说明。

**注意路径**：README 里指向 e2e 文档的相对路径要正确（`../../e2e/<group>/M{n}-...-e2e.md`）。

### Step 6 · 交付回复

给用户一个简短总结：

- 拆分为 N 个模块，输出 M 个文件
- 列出根目录下的产物路径
- 提示下一步：`每个模块可独立走 superpowers:writing-plans 生成 plan`

## 关键约束

- **不要修改父 spec**：父规格是设计源头，本 skill 只做切片映射
- **不要生成 plan**：plan 是 superpowers:writing-plans 的职责，本 skill 只到 spec + e2e
- **不要生成代码**：交付物是文档，不是实现
- **保持中文**：文档正文用中文，代码/字段名保持原样
- **产出路径固定**：`docs/harness/specs/<group>/` + `docs/harness/e2e/<group>/`（本项目约定，见 CLAUDE.md）
- **文件名统一**：`M{n}-<kebab-slug>-spec.md` / `M{n}-<kebab-slug>-e2e.md`，编号即推荐执行顺序

## Reference 索引

- `references/split-algorithm.md` — 模块拆分粒度、依赖建模、红旗信号
- `references/eval-coverage.md` — e2e 覆盖矩阵、检查项写法、跨模块依赖处理
- `assets/spec-template.md` — 子 spec 骨架
- `assets/e2e-template.md` — 子 e2e 骨架
- `assets/readme-template.md` — 索引 README 骨架

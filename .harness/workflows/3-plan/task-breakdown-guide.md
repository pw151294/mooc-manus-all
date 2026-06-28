# Task 拆解指南

> 写 plan 时拆 Phase / Task / Step 的项目化约定。配合 `superpowers:writing-plans` skill 使用。

## 粒度

- **Phase**：一个独立可交付的成果，约 0.5-2 工日；Phase 之间可能存在串行依赖
- **Task**：单 commit 的最小单元，约 0.5-3 小时
- **Step**：Task 内的可执行动作（命令 / 文件改动 / 验证）

> 经验：如果一个 Task 拆出超过 6 个 Step，多半是 Phase / Task 误用，回去重切。

## 单 commit 原则

- 每个 Task 对应 **1 个 commit**（无 exception 时）
- 例外必须在 Task 标题中写明，例如 "Task 3.4（2 commits：子仓 + 总仓指针升级）"
- subagent 完成 Task 后必须 commit；不允许"积压多个 Task 一起 commit"

## 跨仓改动

- 子仓（mooc-manus / mooc-manus-web）的代码改动 **必须在子仓内** commit
- 总仓只 commit 三种东西：
  1. 总仓自己的文件（.harness、docs/、root-level config）
  2. submodule 指针升级（`chore: 升级子模块指针(<name>)`）
  3. CI workflows（.github/workflows/）
- 涉及跨仓的 Task 必须显式声明顺序：先子仓 commit → 总仓更新指针

## 显式依赖

- Phase 标题后用括号标注依赖：`Phase 5（依赖 Phase 3.4）`
- 并行支线在 plan 顶部依赖图（mermaid）中标出
- subagent dispatch 时按依赖图分批分配

## 完成判定（DoD）

每个 Task 至少有一条**可被脚本或他人核对**的判据，例如：

- "命令 `<x>` 退出码为 0"
- "endpoint `<x>` 返回字段 `<y>`"
- "新增文件 `<path>` 存在且行数在 N 范围内"
- "`grep -r <pattern>` 结果为空 / 命中 N 处"
- "对应单元测试通过"

避免使用"实现 X 功能"这种无验证手段的描述。

## Working dir 声明

每个 Phase 头必须有：

```
**Working dir:** `mooc-manus-all/` | `mooc-manus-all/mooc-manus/` | `mooc-manus-all/mooc-manus-web/`
```

subagent 必须在 dispatch 提示中**复述** working dir，防止跑错仓。

# Battle Map 解析算法

## 目标

从 `docs/harness/specs/<group>/` 和 `docs/harness/e2e/<group>/` 下的模块化 spec + e2e 文档中，提取出任务节点（tasks）、依赖关系（edges）、阶段分组（zones/phases），最终生成一份可视化 DAG 作战地图（JSON 格式）。

## 一、输入约定

### 1.1 Spec 文档结构

每个 spec 文档（`M{n}-<slug>-spec.md`）应包含：

**Frontmatter 区域**（前 10-20 行）：
- `**模块编号**：M{n}`
- `**依赖**：M{k}, M{j}, ...` 或 `无`
- `**被依赖**：M{x}, ...` 或 `无`

**§1.1 交付物**章节：
```markdown
### 1.1 交付物

- 文件路径：`path/to/file.ts`（描述）
- 组件：`ComponentName.tsx`
- API 层：`api/modules/xxx.ts`（N 个函数）
...
```

### 1.2 E2E 文档结构

每个 e2e 文档（`M{n}-<slug>-e2e.md`）包含：
- 检查项清单：`- [ ] **场景名**`
- 前置条件：`**前置**：...`

E2E 主要用于补充任务类型（功能验证 vs 技术验证）、确认模块交付范围。

## 二、解析步骤

### Step 1：扫描模块列表

遍历 `docs/harness/specs/<group>/` 目录，找出所有 `M*-*-spec.md` 文件。

对每个 spec 文件：
1. 读取前 30 行，正则提取：
   - `module_id`：`M\d+`
   - `dependencies`：匹配 `依赖[:：]\s*(.*)` 行中的所有 `M\d+`
   - `title`：第一行 `#` 标题或 spec 文件名
2. 读取全文，提取 `§1.1 交付物` 章节内容（通常在 `## 1.` 或 `### 1.1` 后）

### Step 2：提取交付物 → 生成 Task 节点

对每个模块，从 `§1.1 交付物` 中提取文件路径（使用正则 `` `(.*?\.(ts|tsx|py|go|sql|json|md))` ``）。

**映射规则**：
- 一个模块 → 1 个主 task（代表该模块的核心交付）
- task.id：`t{n}`（按模块编号 M{n} 映射，如 M1 → t1）
- task.title：`T{n} {模块名}`（从 spec 文件名或第一行标题提取）
- task.description：从 spec 的「模块范围」或「一句话职责」提取
- task.artifacts：`§1.1 交付物` 中所有文件路径
- task.phase：默认 `P{n}`（后续可按依赖深度或用户自定义调整）
- task.zone：按模块类型推断（见 Step 3）
- task.type：按文件类型推断（`fe`/`be`/`contract`/`test`/`pm`）
- task.position：按拓扑层级自动布局（见 Step 5）

**type 推断规则**：
- 含 `.tsx` / `.ts` (frontend) → `fe`
- 含 `.go` / `.py` (backend) → `be`
- 含 `types/` / `api/` / `contract` 关键字 → `contract`
- 含 `test` / `e2e` / `验证` 关键字 → `test`
- 含 `docs/` / `README` → `pm`

### Step 3：推断 Zone（人机协作区 vs 智能体驱动区 vs 验证验收区）

**Zone 分类依据**：
- **human-ai**（人机协作区）：M1 基础设施、类型定义、API 契约等"合约"类模块
  - 判断：`type == 'contract'` 或模块名含 `基础` / `infrastructure` / `types` / `api`
- **agent-harness**（智能体驱动区）：业务组件、页面、状态管理等可自动化实现的模块
  - 判断：`type in ('fe', 'be')` 且非 contract
- **verify**（验证验收区）：E2E 验证、测试、文档产出
  - 判断：`type in ('test', 'pm')`

### Step 4：构建依赖边（edges）

从每个 spec 的 `依赖` 字段提取出 `M{k} → M{n}` 的有向边。

**edge.type 推断**：
- 若 from.zone == 'human-ai' && from.type == 'contract' → `'contract'`（合约依赖）
- 若 to.zone == 'verify' → `'pass'`（验证门）
- 否则 → `'normal'`

### Step 5：自动布局（position）

**纵向分层**（y 坐标）：
- 按依赖深度（DAG 拓扑层级）分配：depth 0 → y=300, depth 1 → y=500, depth 2 → y=700...
- 每层间隔 150-200px

**横向分布**（x 坐标）：
- 每层内的节点按 task.id 或字母顺序水平均匀分布
- 总宽度约 1000px，假设每层最多 5 个节点，间隔 200px

算法：
```python
# 拓扑排序得到每个节点的 depth
depths = topological_depth(dag)
layers = group_by_depth(tasks, depths)
for layer_idx, layer_tasks in enumerate(layers):
    y = 300 + layer_idx * 180
    x_step = 1000 / (len(layer_tasks) + 1)
    for i, task in enumerate(layer_tasks):
        task.position = {"x": (i + 1) * x_step, "y": y}
```

## 三、特殊处理

### 3.1 弱依赖

Spec 中若写 `依赖：M1, (M2 推荐)` → 只建立 M1 → 当前模块的边，M2 不建边或标记为虚线（待 viewer 支持）。

正则：`\(.*?\)` 括号包裹的视为弱依赖，暂不建边。

### 3.2 多 artifact 拆分

若一个模块的交付物超过 8 个文件，可考虑拆成多个子 task（如 M2-case-management 拆成 t2a/t2b/t2c），但初版保持 1 模块 = 1 task。

### 3.3 缺失 owner

从 spec 文件路径或交付物推断：
- 含 `mooc-manus-web/` → `前端`
- 含 `mooc-manus/` (Go) → `后端`
- 含 `docs/` → `PM/前端`
- 无法推断 → `待定`

## 四、输出格式

最终产出 `docs/harness/battle-maps/<group>.json`，schema 参考 `example.json`：

```json
{
  "projectId": "eval-modules",
  "projectName": "评测模块拆分实施",
  "version": "1.0.0",
  "zones": [
    { "id": "human-ai", "label": "人机协作区", "phases": ["P0","P1"], "driver": "human" },
    { "id": "agent-harness", "label": "智能体驱动区", "phases": ["P2","P3","P4"], "driver": "agent" },
    { "id": "verify", "label": "验证验收区", "phases": ["P5"], "driver": "mixed" }
  ],
  "tasks": {
    "t1": {
      "title": "T1 基础设施（M1）",
      "owner": "前端",
      "description": "types + api + store 基座",
      "phase": "P1",
      "zone": "human-ai",
      "type": "contract",
      "artifacts": ["src/types/eval.ts", "src/api/modules/eval.ts"],
      "position": {"x": 500, "y": 300}
    },
    ...
  },
  "edges": [
    { "from": "t1", "to": "t2", "type": "contract" },
    ...
  ]
}
```

## 五、执行清单

- [ ] 扫描 spec 目录，提取模块列表（M{n} + 依赖）
- [ ] 逐模块解析 §1.1 交付物 → 生成 task 节点
- [ ] 推断 zone / type / owner
- [ ] 构建 edges（从"依赖"字段）
- [ ] 拓扑排序 + 自动布局
- [ ] 输出 JSON
- [ ] 调 hook 验证格式

---
name: battle-map-generator
description: 基于 docs/harness/specs 和 docs/harness/e2e 下维护的 spec 技术规格文档和 eval 功能验证文档，创建 DAG 作战地图，输出到 docs/harness/battle-maps 下。用户想要对 spec+eval 模块进行可视化时触发。
argument-hint: "[harness-spec-path] [harness-eval-path]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# battle-map-generator

从模块化的 spec + e2e 文档中提取任务节点、依赖关系、阶段分组，生成可视化 DAG 作战地图（JSON 格式），输出到 `docs/harness/battle-maps/<group>.json`。

前端 viewer 可直接加载该 JSON 渲染交互式作战地图。

## 何时用

- 用户明确调用 `/battle-map-generator <spec-path> <eval-path>` 或语义等价的请求
- 用户手上已有一组拆分好的 spec + e2e 文档（通常由 `spec-split-modules` 产出）
- 用户想要可视化模块间依赖关系、规划实施顺序

**不适用**：spec 尚未拆分、或用户只想看文字版 README 索引。

## 输入契约

- **参数 1（必选）**：`harness-spec-path` — spec 文档所在目录，通常为 `docs/harness/specs/<group>/`
- **参数 2（可选）**：`harness-eval-path` — e2e 文档所在目录，通常为 `docs/harness/e2e/<group>/`（若省略，自动推断为 `docs/harness/e2e/<group>/`）

## 输出契约

在 `docs/harness/battle-maps/<group>.json` 产出一份符合 schema 的 battle-map JSON 文件。

schema 参考：`docs/harness/battle-maps/example.json`

## 工作流

### Step 0 · 确认输入

1. 用 Bash `ls` 确认 spec 目录存在、含有 `M*-*-spec.md` 文件
2. 若用户未提供 eval-path，自动推断：`docs/harness/e2e/<group>/`（`<group>` 从 spec-path 提取）
3. 提取 `<group>` 名称（spec-path 的最后一级目录名），作为输出文件名前缀

### Step 1 · 扫描模块列表

**参阅**：`references/parse-algorithm.md` §二 Step 1

用 Bash `find` 遍历 spec 目录，找出所有 `M*-*-spec.md` 文件。

对每个 spec 文件：
1. 用 Read 工具读取前 40 行（包含 frontmatter）
2. 正则提取：
   - `module_id`：`M\d+`
   - `module_name`：从第一行 `# M{n} {名称}` 或文件名提取
   - `dependencies`：匹配 `依赖[:：]\s*(.*)` 行中的所有 `M\d+`（括号包裹的弱依赖忽略）
3. 构建 module 元数据字典：
   ```python
   modules = {
       'M1': {'id': 'M1', 'name': '基础设施', 'deps': [], 'spec_path': '...'},
       'M2': {'id': 'M2', 'name': '用例管理', 'deps': ['M1'], 'spec_path': '...'},
       ...
   }
   ```

### Step 2 · 提取交付物 → 生成 Task 节点

**参阅**：`references/parse-algorithm.md` §二 Step 2

对每个模块：
1. 用 Read 工具读取完整 spec 文件
2. 定位 `§1.1 交付物` 章节（通常在 `### 1.1` 或 `## 1.` 后）
3. 正则提取所有文件路径（`` `([^`]+\.(ts|tsx|py|go|sql|json|md|sh))` ``）
4. 生成 task 节点：
   - `task.id`：`t{n}`（M1 → t1, M2 → t2）
   - `task.title`：`T{n} {模块名}`
   - `task.description`：从 spec 的 `§1. 模块范围` 第一段或 frontmatter 的「一句话职责」提取
   - `task.artifacts`：步骤 3 提取的文件路径列表
   - `task.owner`：从 artifacts 推断（见 Step 3）
   - `task.type`：从 artifacts 推断（见 Step 3）
   - `task.phase`：默认 `P{n}`（后续按拓扑深度调整）
   - `task.zone`：按 type 推断（见 Step 3）
   - `task.position`：暂时留空（Step 5 布局）

### Step 3 · 推断 Owner / Type / Zone

**参阅**：`references/parse-algorithm.md` §二 Step 2-3

**Owner 推断规则**：
- artifacts 含 `mooc-manus-web/` → `前端`
- artifacts 含 `mooc-manus/` (Go) → `后端`
- artifacts 含 `docs/` → `PM/前端`
- 无法推断 → `待定`

**Type 推断规则**：
- 含 `.tsx` / `.ts` (frontend) → `fe`
- 含 `.go` / `.py` (backend) → `be`
- 含 `types/` / `api/` 或模块名含 `基础` / `infrastructure` → `contract`
- 含 `test` / `e2e` / `验证` 关键字 → `test`
- 含 `docs/` / `README` → `pm`
- 默认 → `infra`

**Zone 推断规则**：
- `type == 'contract'` → `human-ai`（人机协作区）
- `type in ('fe', 'be')` 且非 contract → `agent-harness`（智能体驱动区）
- `type in ('test', 'pm')` → `verify`（验证验收区）

### Step 4 · 构建依赖边（edges）

**参阅**：`references/parse-algorithm.md` §二 Step 4

从 Step 1 提取的 `dependencies` 构建边：
- 对每个模块 `M{n}`，其 `deps` 列表中的每个 `M{k}`，生成边 `M{k} → M{n}`
- 转换为 task id：`M{k} → t{k}`, `M{n} → t{n}`
- edge.type 推断：
  - 若 `from.zone == 'human-ai' && from.type == 'contract'` → `'contract'`
  - 若 `to.zone == 'verify'` → `'pass'`
  - 否则 → `'normal'`

### Step 5 · 自动布局（position）

**参阅**：`references/parse-algorithm.md` §二 Step 5

**算法**：
1. 对 DAG 做拓扑排序，计算每个节点的层级深度（depth）
2. 按 depth 分组：
   - depth 0 → y=300
   - depth 1 → y=500
   - depth 2 → y=700
   - ...（每层间隔 200px）
3. 每层内的节点按 task.id 字母顺序水平均匀分布：
   - 总宽度 1000px
   - x = (i + 1) * (1000 / (len(layer) + 1))

**拓扑深度算法**（伪码）：
```python
def compute_depths(tasks, edges):
    # 初始化所有节点深度为 0
    depths = {tid: 0 for tid in tasks}
    # 构建邻接表
    adj = build_adjacency_list(edges)
    # DFS 更新深度
    def dfs(node):
        for neighbor in adj.get(node, []):
            depths[neighbor] = max(depths[neighbor], depths[node] + 1)
            dfs(neighbor)
    # 从入度为 0 的节点开始
    roots = [tid for tid in tasks if not any(e['to'] == tid for e in edges)]
    for root in roots:
        dfs(root)
    return depths
```

### Step 6 · 生成 zones 元数据

根据 tasks 的实际 zone 分布，动态生成 zones 列表：

```python
zone_phases = {}
for task in tasks.values():
    zone = task['zone']
    phase = task['phase']
    if zone not in zone_phases:
        zone_phases[zone] = []
    if phase not in zone_phases[zone]:
        zone_phases[zone].append(phase)

zones = []
if 'human-ai' in zone_phases:
    zones.append({
        'id': 'human-ai',
        'label': '人机协作区',
        'phases': sorted(zone_phases['human-ai']),
        'driver': 'human'
    })
if 'agent-harness' in zone_phases:
    zones.append({
        'id': 'agent-harness',
        'label': '智能体驱动区',
        'phases': sorted(zone_phases['agent-harness']),
        'driver': 'agent'
    })
if 'verify' in zone_phases:
    zones.append({
        'id': 'verify',
        'label': '验证验收区',
        'phases': sorted(zone_phases['verify']),
        'driver': 'mixed'
    })
```

### Step 7 · 组装 JSON 并输出

用 Write 工具产出 `docs/harness/battle-maps/<group>.json`：

```json
{
  "projectId": "<group>",
  "projectName": "{从 README 或 spec 父目录推断}",
  "version": "1.0.0",
  "zones": [...],
  "tasks": {...},
  "edges": [...]
}
```

### Step 8 · 验证（hook）

**参阅**：`references/schema-validation.md`

调用验证 hook：
```bash
python3 .claude/skills/battle-map-generator/hooks/validate-battle-map.py \
  docs/harness/battle-maps/<group>.json
```

**处理结果**：
- 若退出码 0（验证通过）→ 向用户报告"生成成功 + warnings"
- 若退出码 1（验证失败）→ 向用户报告 errors，询问是否修正后重新生成

### Step 9 · 交付回复

给用户简短总结：
- 生成了 `docs/harness/battle-maps/<group>.json`
- 包含 N 个 tasks、M 条 edges、K 个 zones
- 验证结果（通过 / 失败 + warnings）
- 提示：可用前端 viewer 加载该文件可视化

## 关键约束

- **不要修改 spec/e2e 源文件**：本 skill 只读，不改
- **不要猜测未声明的依赖**：只从 spec frontmatter 的「依赖」字段提取
- **保持中文**：projectName / task.title / task.description 用中文
- **产出路径固定**：`docs/harness/battle-maps/<group>.json`
- **验证必做**：Step 8 hook 验证不可跳过

## 参考实例

本项目已有一份高质量 battle-map 可作对照：

- 输入 spec：`docs/harness/specs/eval-modules/`（M1-M5 五个模块）
- 输出 map：`docs/harness/battle-maps/example.json`（23 个 tasks + zones + edges）

若不确定如何解析，Read example.json 找感觉。

## Reference 索引

- `references/parse-algorithm.md` — 模块扫描、交付物提取、依赖推导、自动布局
- `references/schema-validation.md` — JSON schema 定义、验证规则、DAG 无环检测
- `hooks/validate-battle-map.py` — 格式验证脚本（Step 8 调用）

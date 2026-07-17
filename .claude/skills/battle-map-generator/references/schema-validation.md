# Battle Map Schema 验证规范

## 目标

验证生成的 `<group>.json` 文件是否符合 battle-map 的 schema 约定，确保前端 viewer 能正确渲染。

## 一、JSON Schema 定义

基于 `docs/harness/battle-maps/example.json` 归纳出的强制字段：

### 1.1 顶层结构

```typescript
interface BattleMap {
  projectId: string;        // 项目唯一标识，kebab-case
  projectName: string;      // 中文项目名
  version: string;          // 语义化版本号 "x.y.z"
  zones: Zone[];            // 至少 1 个 zone
  tasks: Record<string, Task>;  // 至少 1 个 task，key 为 task.id
  edges: Edge[];            // 可为空数组（无依赖的单模块项目）
}
```

### 1.2 Zone 结构

```typescript
interface Zone {
  id: string;               // zone 唯一标识，kebab-case
  label: string;            // 中文显示名
  phases: string[];         // 该 zone 覆盖的 phase 列表（如 ["P0","P1"]）
  driver: 'human' | 'agent' | 'mixed';  // 驱动方式
}
```

**约束**：
- zones 至少包含 1 个 zone
- 所有 zone.phases 合并后，应覆盖所有 task.phase 的值（即每个 task.phase 都能映射到某个 zone）
- zone.id 不重复

### 1.3 Task 结构

```typescript
interface Task {
  title: string;            // 任务标题（中文，如 "T1 基础设施"）
  owner: string;            // 负责方（如"前端"/"后端"/"PM"）
  description: string;      // 一句话描述任务职责
  phase: string;            // 所属阶段（如 "P1"）
  zone: string;             // 所属 zone（必须在 zones[].id 中存在）
  type: string;             // 任务类型（fe/be/contract/test/pm/infra）
  artifacts: string[];      // 交付物文件路径列表（可为空）
  position: {x: number, y: number};  // 画布坐标
}
```

**约束**：
- task.zone 必须在 zones[].id 中存在
- task.phase 必须在某个 zone.phases 列表中出现
- task.type 应为已知类型之一：`fe`, `be`, `contract`, `test`, `pm`, `infra`
- task.position.x 和 task.position.y 为正数（0-2000 合理范围）
- tasks 至少包含 1 个 task

### 1.4 Edge 结构

```typescript
interface Edge {
  from: string;             // 源 task id（必须在 tasks 中存在）
  to: string;               // 目标 task id（必须在 tasks 中存在）
  type: 'normal' | 'contract' | 'pass';  // 边类型
}
```

**约束**：
- edge.from 和 edge.to 必须在 tasks 中存在
- 不允许自环（from == to）
- 不允许重复边（同一 (from, to) 对只能出现一次）

## 二、DAG 约束

### 2.1 无环检测

edges 构成的有向图必须无环（DAG）。

**检测算法**（DFS 染色法）：
```python
def has_cycle(tasks, edges):
    WHITE, GRAY, BLACK = 0, 1, 2
    colors = {tid: WHITE for tid in tasks}
    adj = build_adjacency_list(edges)
    
    def dfs(node):
        colors[node] = GRAY
        for neighbor in adj.get(node, []):
            if colors[neighbor] == GRAY:
                return True  # back edge
            if colors[neighbor] == WHITE and dfs(neighbor):
                return True
        colors[node] = BLACK
        return False
    
    return any(colors[tid] == WHITE and dfs(tid) for tid in tasks)
```

### 2.2 孤岛检测（警告级）

所有 task 应该至少有一条边连接（入度 + 出度 >= 1），否则是孤岛节点。

**孤岛节点判定**：
```python
connected_tasks = set()
for edge in edges:
    connected_tasks.add(edge['from'])
    connected_tasks.add(edge['to'])

orphans = set(tasks.keys()) - connected_tasks
# 警告：orphans 列表
```

孤岛不算错误（单模块项目可能只有 1 个 task + 0 edges），但多模块项目出现孤岛通常是解析遗漏。

## 三、验证流程

### Step 1：JSON 解析

尝试 `json.loads()`，捕获 `JSONDecodeError` → 返回"格式错误"。

### Step 2：顶层必填字段

检查 `projectId`, `projectName`, `version`, `zones`, `tasks`, `edges` 是否存在。

### Step 3：Zones 验证

- `len(zones) >= 1`
- 每个 zone 有 `id`, `label`, `phases`, `driver`
- `zone.driver in ('human', 'agent', 'mixed')`
- 所有 zone.id 不重复

### Step 4：Tasks 验证

- `len(tasks) >= 1`
- 每个 task 有必填字段：`title`, `owner`, `description`, `phase`, `zone`, `type`, `artifacts`, `position`
- `task.zone` 在 zones 中存在
- `task.phase` 在某个 zone.phases 中出现
- `task.type` 在已知类型列表中
- `task.position.x` 和 `task.position.y` 为数字且 >= 0

### Step 5：Edges 验证

- 每条 edge 有 `from`, `to`, `type`
- `edge.from` 和 `edge.to` 在 tasks 中存在
- `edge.type in ('normal', 'contract', 'pass')`
- 无自环（`edge.from != edge.to`）
- 无重复边

### Step 6：DAG 无环检测

运行 DFS 染色法，若检测到环 → 返回"依赖关系存在环"+ 环路节点列表。

### Step 7：孤岛检测（警告）

统计孤岛节点，若存在 → 打印警告（不阻止验证通过）。

## 四、验证输出格式

**通过**：
```json
{
  "valid": true,
  "warnings": ["task t5 是孤岛节点"],
  "stats": {
    "tasks_count": 10,
    "edges_count": 15,
    "zones_count": 3
  }
}
```

**失败**：
```json
{
  "valid": false,
  "errors": [
    "task t2 的 zone 'unknown' 不在 zones 中",
    "edge from='t3' to='t1' 形成环: t1 → t2 → t3 → t1"
  ],
  "warnings": []
}
```

## 五、Hook 集成

验证脚本：`.claude/skills/battle-map-generator/hooks/validate-battle-map.py`

**调用方式**（在 SKILL.md Step 6）：
```bash
python3 .claude/skills/battle-map-generator/hooks/validate-battle-map.py \
  docs/harness/battle-maps/<group>.json
```

**退出码**：
- 0：验证通过（可能有 warnings）
- 1：验证失败（有 errors）

**输出格式**：JSON（stdout）+ 人类可读总结（stderr）。

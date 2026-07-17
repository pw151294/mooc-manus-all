#!/usr/bin/env python3
"""
Battle Map Schema 验证脚本

Usage:
    python3 validate-battle-map.py <path-to-battle-map.json>

Exit codes:
    0 - validation passed (may have warnings)
    1 - validation failed (has errors)
"""
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple


KNOWN_TYPES = {'fe', 'be', 'contract', 'test', 'pm', 'infra'}
KNOWN_DRIVERS = {'human', 'agent', 'mixed'}
KNOWN_EDGE_TYPES = {'normal', 'contract', 'pass'}


def validate_battle_map(data: Dict[str, Any]) -> Tuple[bool, List[str], List[str]]:
    """
    Returns: (valid, errors, warnings)
    """
    errors = []
    warnings = []

    # Step 2: 顶层必填字段
    required_top = ['projectId', 'projectName', 'version', 'zones', 'tasks', 'edges']
    for field in required_top:
        if field not in data:
            errors.append(f"缺少顶层必填字段: {field}")

    if errors:
        return False, errors, warnings

    zones = data.get('zones', [])
    tasks = data.get('tasks', {})
    edges = data.get('edges', [])

    # Step 3: Zones 验证
    if len(zones) < 1:
        errors.append("zones 至少需要 1 个 zone")

    zone_ids = set()
    all_phases = set()
    for i, zone in enumerate(zones):
        if not isinstance(zone, dict):
            errors.append(f"zones[{i}] 不是对象")
            continue
        for field in ['id', 'label', 'phases', 'driver']:
            if field not in zone:
                errors.append(f"zones[{i}] 缺少字段: {field}")

        zid = zone.get('id')
        if zid:
            if zid in zone_ids:
                errors.append(f"zone.id '{zid}' 重复")
            zone_ids.add(zid)

        driver = zone.get('driver')
        if driver and driver not in KNOWN_DRIVERS:
            errors.append(f"zone '{zid}' driver '{driver}' 不在已知列表: {KNOWN_DRIVERS}")

        phases = zone.get('phases', [])
        if isinstance(phases, list):
            all_phases.update(phases)

    # Step 4: Tasks 验证
    if len(tasks) < 1:
        errors.append("tasks 至少需要 1 个 task")

    task_ids = set(tasks.keys())
    for tid, task in tasks.items():
        if not isinstance(task, dict):
            errors.append(f"tasks['{tid}'] 不是对象")
            continue

        required_task = ['title', 'owner', 'description', 'phase', 'zone', 'type', 'artifacts', 'position']
        for field in required_task:
            if field not in task:
                errors.append(f"task '{tid}' 缺少字段: {field}")

        # zone 存在性
        zone = task.get('zone')
        if zone and zone not in zone_ids:
            errors.append(f"task '{tid}' 的 zone '{zone}' 不在 zones 中")

        # phase 存在性
        phase = task.get('phase')
        if phase and phase not in all_phases:
            warnings.append(f"task '{tid}' 的 phase '{phase}' 不在任何 zone.phases 中")

        # type 合法性
        ttype = task.get('type')
        if ttype and ttype not in KNOWN_TYPES:
            warnings.append(f"task '{tid}' type '{ttype}' 不在已知列表: {KNOWN_TYPES}")

        # position 有效性
        pos = task.get('position', {})
        if not isinstance(pos, dict):
            errors.append(f"task '{tid}' position 不是对象")
        else:
            x = pos.get('x')
            y = pos.get('y')
            if not isinstance(x, (int, float)) or x < 0:
                errors.append(f"task '{tid}' position.x 无效: {x}")
            if not isinstance(y, (int, float)) or y < 0:
                errors.append(f"task '{tid}' position.y 无效: {y}")

        # artifacts 类型
        artifacts = task.get('artifacts')
        if artifacts is not None and not isinstance(artifacts, list):
            errors.append(f"task '{tid}' artifacts 应为数组")

    # Step 5: Edges 验证
    seen_edges = set()
    adj_list: Dict[str, List[str]] = {tid: [] for tid in task_ids}

    for i, edge in enumerate(edges):
        if not isinstance(edge, dict):
            errors.append(f"edges[{i}] 不是对象")
            continue

        for field in ['from', 'to', 'type']:
            if field not in edge:
                errors.append(f"edges[{i}] 缺少字段: {field}")

        from_id = edge.get('from')
        to_id = edge.get('to')
        etype = edge.get('type')

        # from/to 存在性
        if from_id and from_id not in task_ids:
            errors.append(f"edges[{i}] from='{from_id}' 不在 tasks 中")
        if to_id and to_id not in task_ids:
            errors.append(f"edges[{i}] to='{to_id}' 不在 tasks 中")

        # type 合法性
        if etype and etype not in KNOWN_EDGE_TYPES:
            warnings.append(f"edges[{i}] type '{etype}' 不在已知列表: {KNOWN_EDGE_TYPES}")

        # 自环
        if from_id == to_id:
            errors.append(f"edges[{i}] 自环: from=to='{from_id}'")

        # 重复边
        edge_pair = (from_id, to_id)
        if edge_pair in seen_edges:
            errors.append(f"edges[{i}] 重复边: {from_id} → {to_id}")
        seen_edges.add(edge_pair)

        # 构建邻接表（用于环检测）
        if from_id and to_id and from_id in adj_list:
            adj_list[from_id].append(to_id)

    # Step 6: DAG 无环检测
    cycle = detect_cycle(adj_list)
    if cycle:
        errors.append(f"依赖关系存在环: {' → '.join(cycle)}")

    # Step 7: 孤岛检测
    connected = set()
    for edge in edges:
        connected.add(edge.get('from'))
        connected.add(edge.get('to'))
    orphans = task_ids - connected
    if orphans:
        warnings.append(f"孤岛节点（无依赖边）: {', '.join(sorted(orphans))}")

    valid = len(errors) == 0
    return valid, errors, warnings


def detect_cycle(adj: Dict[str, List[str]]) -> List[str]:
    """
    DFS 染色法检测环。返回环路节点列表，若无环返回空列表。
    """
    WHITE, GRAY, BLACK = 0, 1, 2
    colors = {node: WHITE for node in adj}
    parent = {}
    cycle_nodes = []

    def dfs(node):
        colors[node] = GRAY
        for neighbor in adj.get(node, []):
            if colors.get(neighbor, WHITE) == GRAY:
                # back edge - 找出环
                path = [neighbor]
                curr = node
                while curr != neighbor:
                    path.append(curr)
                    curr = parent.get(curr)
                    if curr is None:
                        break
                path.append(neighbor)
                cycle_nodes.extend(reversed(path))
                return True
            if colors.get(neighbor, WHITE) == WHITE:
                parent[neighbor] = node
                if dfs(neighbor):
                    return True
        colors[node] = BLACK
        return False

    for node in adj:
        if colors[node] == WHITE:
            if dfs(node):
                return cycle_nodes
    return []


def main():
    if len(sys.argv) < 2:
        print("Usage: validate-battle-map.py <battle-map.json>", file=sys.stderr)
        sys.exit(1)

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"Error: 文件不存在: {path}", file=sys.stderr)
        sys.exit(1)

    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"Error: JSON 格式错误: {e}", file=sys.stderr)
        sys.exit(1)

    valid, errors, warnings = validate_battle_map(data)

    # 输出 JSON 到 stdout（供程序解析）
    result = {
        "valid": valid,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "tasks_count": len(data.get('tasks', {})),
            "edges_count": len(data.get('edges', [])),
            "zones_count": len(data.get('zones', []))
        }
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))

    # 人类可读总结到 stderr
    if valid:
        print(f"\n✅ 验证通过: {path}", file=sys.stderr)
        if warnings:
            print(f"⚠️  {len(warnings)} 条警告:", file=sys.stderr)
            for w in warnings:
                print(f"  - {w}", file=sys.stderr)
    else:
        print(f"\n❌ 验证失败: {path}", file=sys.stderr)
        print(f"❌ {len(errors)} 条错误:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        if warnings:
            print(f"⚠️  {len(warnings)} 条警告:", file=sys.stderr)
            for w in warnings:
                print(f"  - {w}", file=sys.stderr)

    sys.exit(0 if valid else 1)


if __name__ == '__main__':
    main()

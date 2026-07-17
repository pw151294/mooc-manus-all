#!/usr/bin/env python3
"""Auto-grade the 4 runs against their assertions."""
import json
import re
from pathlib import Path
from typing import Optional, List, Dict

WS = Path("/Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/.claude/skills/spec-split-modules-workspace/iteration-1")


def find_specs(outputs_dir: Path) -> List[Path]:
    return sorted((outputs_dir).glob("docs/harness/specs/*/M*-*-spec.md"))


def find_e2es(outputs_dir: Path) -> List[Path]:
    return sorted((outputs_dir).glob("docs/harness/e2e/*/M*-*-e2e.md"))


def find_readme(outputs_dir: Path) -> Optional[Path]:
    hits = list((outputs_dir).glob("docs/harness/specs/*/README.md"))
    return hits[0] if hits else None


FILENAME_RE = re.compile(r"^M\d+-[a-z0-9-]+-(spec|e2e)\.md$")
CHECKITEM_RE = re.compile(r"^- \[ \]", re.M)


def grade_run(run_dir: Path, eval_name: str) -> dict:
    outputs = run_dir / "outputs"
    specs = find_specs(outputs)
    e2es = find_e2es(outputs)
    readme = find_readme(outputs)

    results = []

    def add(id_, text, passed, evidence):
        results.append({"id": id_, "text": text, "passed": passed, "evidence": evidence})

    # 1. README index
    add("produced-index-readme",
        "产出目录下存在 docs/harness/specs/<group>/README.md 索引文件",
        readme is not None,
        f"README at {readme.relative_to(outputs) if readme else 'NONE'}")

    # 2. count match
    add("specs-and-e2e-count-match",
        "spec 文件数量与 e2e 文件数量相等",
        len(specs) == len(e2es),
        f"specs={len(specs)}, e2es={len(e2es)}")

    # 3. module count in range
    if eval_name == "eval-platform-frontend":
        low, high = 3, 6
    else:
        low, high = 3, 7
    add("module-count-in-range",
        f"模块数量在 {low}-{high} 之间",
        low <= len(specs) <= high,
        f"count={len(specs)}")

    # 4. filename convention
    bad_names = [p.name for p in specs + e2es if not FILENAME_RE.match(p.name)]
    add("filename-follows-convention",
        "文件名遵循 M{n}-<kebab-slug>-(spec|e2e).md",
        len(bad_names) == 0,
        f"violations={bad_names}" if bad_names else "all conforming")

    # 5. output path correct - specs dir has no *-e2e.md, e2e dir has no *-spec.md
    misplaced = []
    for p in outputs.glob("docs/harness/specs/*/*-e2e.md"):
        misplaced.append(str(p.relative_to(outputs)))
    for p in outputs.glob("docs/harness/e2e/*/*-spec.md"):
        misplaced.append(str(p.relative_to(outputs)))
    add("output-path-correct",
        "spec 输出到 specs/，e2e 输出到 e2e/，不混放",
        len(misplaced) == 0,
        f"misplaced={misplaced}" if misplaced else "clean")

    # 6. dependencies declared - "依赖" / "Dependency" / "前置"
    missing_deps = []
    dep_terms = ["依赖", "Depend", "前置", "Prereq", "依托"]
    for sp in specs:
        text = sp.read_text()
        header = "\n".join(text.splitlines()[:40])
        if not any(t in header for t in dep_terms):
            missing_deps.append(sp.name)
    add("each-spec-declares-dependencies",
        "每个 spec 在开头显式声明「依赖」字段",
        len(missing_deps) == 0,
        f"missing={missing_deps}" if missing_deps else "all declare deps")

    # 7. references parent spec
    missing_parent = []
    for sp in specs:
        text = sp.read_text()
        if "父规格" not in text and "§" not in text and "parent" not in text.lower():
            missing_parent.append(sp.name)
    add("each-spec-references-parent",
        "每个 spec 引用父规格章节号",
        len(missing_parent) == 0,
        f"missing={missing_parent}" if missing_parent else "all reference parent")

    # 8. deliverables listed - "交付物" / "交付清单" / "Deliverables" / "产出"
    missing_deliv = []
    deliv_terms = ["交付物", "交付清单", "Deliverables", "产出", "输出物"]
    for sp in specs:
        text = sp.read_text()
        if not any(t in text for t in deliv_terms):
            missing_deliv.append(sp.name)
    add("each-spec-lists-deliverables",
        "每个 spec 显式列出交付物清单",
        len(missing_deliv) == 0,
        f"missing={missing_deliv}" if missing_deliv else "all list deliverables")

    # 9. non-goals
    missing_ng = []
    for sp in specs:
        text = sp.read_text()
        if "非目标" not in text and "Non-goal" not in text.lower() and "不做" not in text:
            missing_ng.append(sp.name)
    add("each-spec-lists-non-goals",
        "每个 spec 显式列出非目标",
        len(missing_ng) == 0,
        f"missing={missing_ng}" if missing_ng else "all list non-goals")

    # 10. e2e checkitems >= 5
    low_check = []
    for e2 in e2es:
        text = e2.read_text()
        n = len(CHECKITEM_RE.findall(text))
        if n < 5:
            low_check.append(f"{e2.name}({n})")
    add("e2e-checkitems-are-checkable",
        "每个 e2e 至少 5 条 - [ ] 检查项",
        len(low_check) == 0,
        f"low={low_check}" if low_check else "all >=5")

    # 11. Expected coverage
    low_expected = []
    for e2 in e2es:
        text = e2.read_text()
        checks = CHECKITEM_RE.findall(text)
        n_check = len(checks)
        n_expected = text.count("Expected") + text.count("预期") + text.count("期望")
        # heuristic: at least half of check items have Expected mention
        if n_check > 0 and n_expected < n_check / 2:
            low_expected.append(f"{e2.name}(check={n_check},exp={n_expected})")
    add("e2e-has-expected",
        "e2e 检查项含 Expected: 可观察结果（至少一半）",
        len(low_expected) == 0,
        f"low={low_expected}" if low_expected else "all have Expected")

    # 12. README dependency graph (code block or arrow)
    readme_has_graph = False
    if readme:
        rtxt = readme.read_text()
        readme_has_graph = ("```" in rtxt and ("→" in rtxt or "->" in rtxt or "──" in rtxt)) \
                         or "M1" in rtxt and "M2" in rtxt
    add("readme-has-dependency-graph",
        "README 含依赖关系图",
        readme_has_graph,
        "graph found" if readme_has_graph else "no graph")

    # 13. no circular dep - parse dep lines, build DAG
    dep_map = {}
    for sp in specs:
        module = re.match(r"^(M\d+)", sp.name).group(1)
        text = sp.read_text()
        header = "\n".join(text.splitlines()[:20])
        # Find "依赖：..." line
        m = re.search(r"依赖[:：]([^\n]*)", header)
        deps = []
        if m:
            deps = re.findall(r"M\d+", m.group(1))
        dep_map[module] = deps
    # cycle detection
    def has_cycle(g):
        WHITE, GRAY, BLACK = 0, 1, 2
        colors = {n: WHITE for n in g}
        def dfs(n):
            colors[n] = GRAY
            for m in g.get(n, []):
                if colors.get(m, WHITE) == GRAY:
                    return True
                if colors.get(m, WHITE) == WHITE and dfs(m):
                    return True
            colors[n] = BLACK
            return False
        return any(colors[n] == WHITE and dfs(n) for n in g)
    cycle = has_cycle(dep_map)
    add("no-circular-dependency",
        "模块依赖关系无环",
        not cycle,
        f"deps={dep_map}")

    # eval-specific:
    if eval_name == "eval-platform-frontend":
        # 14 infrastructure layer
        has_infra = False
        for sp in specs:
            name = sp.name.lower()
            if "infrastructure" in name or "foundation" in name or "base" in name or "基础" in sp.read_text()[:200]:
                has_infra = True
                break
        add("covers-infrastructure-layer",
            "识别出「基础设施」层",
            has_infra,
            "found" if has_infra else "not found")

        has_trace = False
        for sp in specs:
            name = sp.name.lower()
            if "trace" in name or "deeplink" in name or "深链" in sp.read_text()[:500]:
                has_trace = True
                break
        add("covers-trace-deeplink",
            "识别出 Trace 深链模块",
            has_trace,
            "found" if has_trace else "not found")

    else:  # agent-tracing
        has_datamodel = False
        for sp in specs:
            name = sp.name.lower()
            body = sp.read_text()[:1500].lower()
            if "domain" in name or "model" in name or "schema" in name or "foundation" in name or \
               "span" in body and ("ddl" in body or "repository" in body or "值对象" in body):
                has_datamodel = True
                break
        add("covers-data-model-layer",
            "识别出数据模型/持久化层",
            has_datamodel,
            "found" if has_datamodel else "not found")

        has_instr = False
        for sp in specs:
            name = sp.name.lower()
            body = sp.read_text()[:1500].lower()
            if "instrument" in name or "埋点" in sp.read_text()[:1500] or "tracer" in name:
                has_instr = True
                break
        add("covers-instrumentation",
            "识别出埋点/instrumentation 模块",
            has_instr,
            "found" if has_instr else "not found")

        has_query = False
        for sp in specs:
            name = sp.name.lower()
            body = sp.read_text()[:1500].lower()
            if "query" in name or "api" in name and "trace" in body:
                has_query = True
                break
        add("covers-query-api",
            "识别出查询 API 模块",
            has_query,
            "found" if has_query else "not found")

        # backend e2e style: contains curl / go test / DB verification
        backend_e2e_ok = True
        weak_e2es = []
        for e2 in e2es:
            text = e2.read_text().lower()
            has_backend = ("curl" in text or "go test" in text or "select" in text or "run:" in text
                          or "sql" in text or "gorm" in text)
            if not has_backend:
                weak_e2es.append(e2.name)
        add("e2e-not-just-frontend-ui",
            "e2e 含 curl/go test/DB 校验，不能全是 UI",
            len(weak_e2es) == 0,
            f"weak={weak_e2es}" if weak_e2es else "all have backend verifications")

    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    return {
        "eval_name": eval_name,
        "run": run_dir.name,
        "passed": passed,
        "total": total,
        "pass_rate": passed / total,
        "expectations": results,
    }


def main():
    runs = [
        ("eval-1-eval-platform-frontend", "with_skill", "eval-platform-frontend"),
        ("eval-1-eval-platform-frontend", "without_skill", "eval-platform-frontend"),
        ("eval-2-agent-tracing", "with_skill", "agent-tracing"),
        ("eval-2-agent-tracing", "without_skill", "agent-tracing"),
    ]
    for eval_dir, config, eval_name in runs:
        run_dir = WS / eval_dir / config
        result = grade_run(run_dir, eval_name)
        out = run_dir / "grading.json"
        out.write_text(json.dumps(result, indent=2, ensure_ascii=False))
        print(f"{eval_dir}/{config}: {result['passed']}/{result['total']} ({result['pass_rate']*100:.0f}%)")


if __name__ == "__main__":
    main()

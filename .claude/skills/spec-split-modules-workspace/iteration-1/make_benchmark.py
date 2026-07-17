#!/usr/bin/env python3
"""Build benchmark.json matching viewer's expected schema."""
import json
import statistics
from pathlib import Path

WS = Path("/Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/.claude/skills/spec-split-modules-workspace/iteration-1")

evals = [
    ("eval-1-eval-platform-frontend", "eval-platform-frontend"),
    ("eval-2-agent-tracing", "agent-tracing"),
]
configs = ["with_skill", "without_skill"]

per_eval = []
config_scores = {c: [] for c in configs}
config_time = {c: [] for c in configs}
config_tokens = {c: [] for c in configs}

for eval_dir, eval_name in evals:
    row = {"eval_name": eval_name, "eval_id": eval_dir, "results": {}}
    for cfg in configs:
        run_dir = WS / eval_dir / cfg
        grading = json.load(open(run_dir / "grading.json"))
        timing = json.load(open(run_dir / "timing.json"))
        passed = sum(1 for r in grading["expectations"] if r["passed"])
        total = len(grading["expectations"])
        rate = passed / total if total else 0
        row["results"][cfg] = {
            "passed": passed,
            "total": total,
            "pass_rate": rate,
            "duration_seconds": timing["total_duration_seconds"],
            "total_tokens": timing["total_tokens"],
        }
        config_scores[cfg].append(rate)
        config_time[cfg].append(timing["total_duration_seconds"])
        config_tokens[cfg].append(timing["total_tokens"])
    per_eval.append(row)


def stats(vals):
    if not vals:
        return {"mean": 0, "stddev": 0}
    m = statistics.mean(vals)
    sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
    return {"mean": round(m, 4), "stddev": round(sd, 4)}


summary = {}
for cfg in configs:
    summary[cfg] = {
        "pass_rate": stats(config_scores[cfg]),
        "duration_seconds": stats(config_time[cfg]),
        "total_tokens": stats(config_tokens[cfg]),
    }

benchmark = {
    "skill_name": "spec-split-modules",
    "iteration": 1,
    "configurations": [
        {"name": "with_skill", "label": "With skill (v1)"},
        {"name": "without_skill", "label": "Baseline (no skill)"},
    ],
    "summary": summary,
    "per_eval": per_eval,
    "deltas": {
        "pass_rate": round(summary["with_skill"]["pass_rate"]["mean"]
                          - summary["without_skill"]["pass_rate"]["mean"], 4),
        "duration_seconds": round(summary["with_skill"]["duration_seconds"]["mean"]
                          - summary["without_skill"]["duration_seconds"]["mean"], 2),
        "total_tokens": round(summary["with_skill"]["total_tokens"]["mean"]
                          - summary["without_skill"]["total_tokens"]["mean"]),
    },
}

with open(WS / "benchmark.json", "w") as f:
    json.dump(benchmark, f, indent=2, ensure_ascii=False)

# Also emit a readable markdown
md = f"""# Skill Benchmark: spec-split-modules — iteration 1

## Summary

| Metric | with_skill | without_skill (baseline) | Delta |
|---|---|---|---|
| Pass Rate | {summary['with_skill']['pass_rate']['mean']*100:.1f}% ± {summary['with_skill']['pass_rate']['stddev']*100:.1f}% | {summary['without_skill']['pass_rate']['mean']*100:.1f}% ± {summary['without_skill']['pass_rate']['stddev']*100:.1f}% | {benchmark['deltas']['pass_rate']*100:+.1f}pp |
| Duration | {summary['with_skill']['duration_seconds']['mean']:.1f}s ± {summary['with_skill']['duration_seconds']['stddev']:.1f}s | {summary['without_skill']['duration_seconds']['mean']:.1f}s ± {summary['without_skill']['duration_seconds']['stddev']:.1f}s | {benchmark['deltas']['duration_seconds']:+.1f}s |
| Tokens | {summary['with_skill']['total_tokens']['mean']:.0f} ± {summary['with_skill']['total_tokens']['stddev']:.0f} | {summary['without_skill']['total_tokens']['mean']:.0f} ± {summary['without_skill']['total_tokens']['stddev']:.0f} | {benchmark['deltas']['total_tokens']:+.0f} |

## Per-eval breakdown

"""
for row in per_eval:
    md += f"### {row['eval_name']}\n\n"
    md += "| Config | Pass | Rate | Time (s) | Tokens |\n|---|---|---|---|---|\n"
    for cfg in configs:
        r = row["results"][cfg]
        md += f"| {cfg} | {r['passed']}/{r['total']} | {r['pass_rate']*100:.0f}% | {r['duration_seconds']:.1f} | {r['total_tokens']} |\n"
    md += "\n"

(WS / "benchmark.md").write_text(md)
print("Written benchmark.json and benchmark.md")
print(md)

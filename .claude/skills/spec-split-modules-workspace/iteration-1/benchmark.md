# Skill Benchmark: spec-split-modules — iteration 1

## Summary

| Metric | with_skill | without_skill (baseline) | Delta |
|---|---|---|---|
| Pass Rate | 100.0% ± 0.0% | 84.1% ± 5.8% | +15.9pp |
| Duration | 461.0s ± 11.6s | 549.4s ± 110.7s | -88.4s |
| Tokens | 50807 ± 2430 | 57053 ± 1674 | -6246 |

## Per-eval breakdown

### eval-platform-frontend

| Config | Pass | Rate | Time (s) | Tokens |
|---|---|---|---|---|
| with_skill | 15/15 | 100% | 452.8 | 49089 |
| without_skill | 12/15 | 80% | 471.1 | 58237 |

### agent-tracing

| Config | Pass | Rate | Time (s) | Tokens |
|---|---|---|---|---|
| with_skill | 17/17 | 100% | 469.2 | 52525 |
| without_skill | 15/17 | 88% | 627.7 | 55869 |


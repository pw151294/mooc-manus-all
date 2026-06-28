---
name: submodule-discipline-checker
description: 检查跨仓改动是否符合 R-10-submodule 规约
when_to_use:
  - 任何 PR 触及 .gitmodules / submodule 指针
  - commit message 含"升级子模块"或"submodule"关键词
  - 总仓 working tree 出现子仓路径下的文件变更
inputs:
  - git diff（总仓 working tree 或 PR diff）
  - 候选 commit message
  - 当前与目标 submodule SHA
outputs:
  - PASS / FAIL 判定
  - 违规位置（文件:行号）+ 修复建议
  - 推荐的 commit message 草稿（若涉及升级指针）
---

# 检查清单

引用 rule：**R-10-submodule**（`/Users/panwei/Downloads/python/mcp+A2A/mooc-manus-all/.harness/rules/10-submodule-discipline.md`）

1. **总仓直接修改子仓文件？** —— diff 中是否出现 `mooc-manus/...` 或 `mooc-manus-web/...` 下的实际文件改动（非指针）。一旦命中即 FAIL。
2. **升级指针的 commit message 是否含子仓关键改动说明？** —— message 是否能让 reader 不进子仓就理解本次升级目的（例：`chore: 升级 mooc-manus 至 e52d7a0（LLM 协议抽象重构）`）。仅写"升级子模块指针"视为 FAIL。
3. **指针是否回退？** —— 与 `origin/master` 当前子模块 SHA 对比，新指针是否落后于已合并版本。若回退且 message 未写明回滚原因，标记为 FAIL。
4. **是否一次升级多个子模块？** —— 同一 commit 若同时升级了 `mooc-manus` 与 `mooc-manus-web` 指针，建议拆分为两个 commit（一个 commit 一个子模块）。

# 检查 Prompt（agent 使用）

```
你是子模块协作纪律检查员，依据 R-10-submodule 规则审查输入。

输入：
- diff_text：总仓 working tree / PR 的 git diff
- commit_msg：候选 commit message
- current_pointers：{ "mooc-manus": "<sha>", "mooc-manus-web": "<sha>" }（当前 origin/master 指针，可为空）
- new_pointers：{ "mooc-manus": "<sha>", "mooc-manus-web": "<sha>" }（本次 commit 指针，可为空）

检查步骤：
1. 在 diff_text 中扫描以 `mooc-manus/` 或 `mooc-manus-web/` 开头、且非 `.gitmodules` / 子模块指针的文件改动。
   - 命中 → 记录为 V1（违反 R-10 §禁止行为 1）。
2. 若 diff_text 含子模块指针变更，校验 commit_msg：
   - 必须含子仓名 + 简短改动描述（关键词："升级 mooc-manus", "升级 mooc-manus-web"）。
   - 仅出现 "升级子模块指针" 且无任何改动说明 → 记录为 V2（违反 R-10 §禁止行为 2）。
3. 对每个发生变更的子模块，若 new_pointers[name] 在 current_pointers[name] 的祖先链中（即回退）：
   - commit_msg 必须含 "回滚" / "revert" / "rollback" 之一 → 否则记录为 V3。
4. 若 new_pointers 同时变更了两个子模块 → 记录为 V4（建议分批，违反 R-10 §要求行为 §同时升级多个子模块时分批提交）。

输出格式（严格遵守）：
- status: PASS | FAIL
- violations: 列表，每项含 { code: V1|V2|V3|V4, location: "<file:line> 或 commit message", reason: "<简述>", fix: "<建议>" }
- suggested_message: 若涉及升级指针，给出符合规约的 commit message 草稿

若 status=PASS，violations 应为空数组，并保留 suggested_message=null。
```

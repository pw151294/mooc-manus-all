# 升级子模块指针

把已 push 到子仓 master 的新 commit 在总仓"锁定"。最常见的总仓动作，每周多次执行。规则正文见 R-10（子模块协作纪律）与 R-30（部署护栏）。

## 前置条件

1. 子仓改动**已 push 到 origin/master**（或目标分支）；本地未 push 的子仓 commit 升级到总仓后会让别人 clone 不到（指针悬空）
2. 子仓 CI 通过；指针升级 commit 自身不会触发子仓 CI
3. 总仓当前 worktree 干净（`git status` 仅显示子模块指针变化），避免与无关改动混入一个 commit
4. 不在 master 直接操作；先切 feature 分支（R-30 禁止直推 master）

## 步骤

```bash
# 0. 总仓根目录、新建分支
cd /path/to/mooc-manus-all
git switch -c chore/bump-mooc-manus-<date>

# 1. 拉取子仓最新（任选一种）
# 1a. 已经在子仓 push 完，回到总仓拉指针
git submodule update --remote --merge mooc-manus
# 1b. 或者自己手动进子仓 fetch / checkout 到目标 commit
cd mooc-manus && git fetch origin && git checkout <sha> && cd ..

# 2. 检查变化
git status                              # 应只显示 modified: mooc-manus
git diff --submodule=log mooc-manus     # 看子仓 commit 摘要

# 3. 从子仓提取关键改动写 commit message
cd mooc-manus
git log --oneline <old_sha>..<new_sha>  # 提取要点
cd ..

# 4. 暂存并提交（HEREDOC 保证多行格式）
git add mooc-manus
git commit -m "$(cat <<'EOF'
chore: 升级子模块指针(mooc-manus, <一句话改动>)

子仓变化：
- <commit-1 摘要>
- <commit-2 摘要>
EOF
)"

# 5. push 走 PR（R-30 禁直推 master）
git push -u origin chore/bump-mooc-manus-<date>
```

## Commit message 模板

```
chore: 升级子模块指针(<子仓名>, <一句话改动>)

子仓变化：
- <子仓 commit 摘要 1>
- <子仓 commit 摘要 2>
```

双子仓同时升级时**鼓励拆两个 commit**（一个 commit 一个子模块，R-10 第 4 条要求行为）。若确实要一次升两个，commit subject 用 `&`：
`chore: 升级子模块指针(mooc-manus & mooc-manus-web) - <场景>`。

## 常见坑

1. **指针悬空**：子仓 commit 只在本地 → 总仓 push 后队友 clone 不到。先确认 `git ls-remote origin <sha>` 命中。
2. **指针回退**：`git submodule update` 在子仓 detached HEAD 下被人 `git checkout master`，下一次再 `add` 会把指针倒回旧 commit。养成 `git diff --submodule=log` 习惯。
3. **混入无关改动**：当前 worktree 有别的修改时 `git add mooc-manus` 不会带走它们，但很容易随手 `git add .`。指针升级 commit 单跑。
4. **bash 3.2**：脚本里若用 `[[ a =~ b ]]` 注意 macOS 默认 bash 3.2 的行为差异；HEREDOC 用单引号 `'EOF'` 防止变量替换。

## 验证

```bash
git log -1 --format='%s'                        # commit subject 含 "升级子模块指针"
git diff HEAD~1 HEAD --submodule=log mooc-manus # 指针差异符合预期
.harness/scripts/validate-harness.sh            # 三仓 harness 完整性（如改了 .harness）
```

可选：在 PR 上等 CI 跑 `validate-contracts.sh`（仅当涉及契约改动）。

## Agent 行为

- 接到"升级指针"请求 → 自动进入子仓抓 `git log <old>..<new> --oneline` 作为 commit body 候选，不让用户手填
- 检测到子仓 sha 在 origin 上不存在（`git ls-remote --exit-code origin <sha>` 失败）→ 拒绝升级，提示"子仓 commit 未 push"
- 检测到指针**回退**（新 sha 不是旧 sha 的祖先后裔）→ 默认拒绝；若用户坚持要回退，强制走 `emergency-rollback.md`
- 用户说"一次升两个子模块" → 默认拆两个 commit；只有用户明确说"合并升级"才用 `&` 一个 commit
- ⚠️ 注意 R-10：用户若让你"顺便在总仓改一下子仓文件"，拒绝并提示"请切换到子仓工作"

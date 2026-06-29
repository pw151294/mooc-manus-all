# 紧急回滚剧本

线上指针指到一个坏 commit（后端 crash / 前端白屏 / 数据错乱），需要立即把子模块指针指回上一个已知好的 commit。关联 R-10（指针纪律）、R-30（部署护栏）。

## 前置条件

1. 已确认坏指针位置（`git submodule status`）与目标好指针 sha（线上最近一次稳定的指针升级 commit）
2. 有人决策回滚（生产事故级，AI 不自行决定）
3. 知道是回滚**子仓指针**还是**总仓 commit**
   - 子仓 bug → 把指针指回上一个好 sha（更常见）
   - 总仓元信息错乱 → revert 总仓 commit

## 步骤

### 路径 A：单子仓指针回退（最常见）

```bash
cd /path/to/mooc-manus-all
git switch -c hotfix/rollback-<date>

# 1. 找到目标 sha（上一个稳定指针）
git log --oneline -- mooc-manus           # 看历史升级
GOOD_SHA=<上一次升级里子仓的 sha>          # 从 git diff --submodule=log 提取

# 2. 把子仓 checkout 到该 sha
cd mooc-manus && git fetch origin && git checkout $GOOD_SHA && cd ..

# 3. 提交回退（commit message 必须含"回滚"+原因，R-10 第 3 条）
git add mooc-manus
git commit -m "$(cat <<'EOF'
chore: 紧急回滚 mooc-manus 指针至 <GOOD_SHA>

原因：<具体故障 / issue 链接>
影响：<受影响功能>
后续：<根因修复 plan 链接>
EOF
)"

# 4. push 走 PR（即便紧急也不能 force push master，R-30）
git push -u origin hotfix/rollback-<date>
```

### 路径 B：双子仓同时回退

按路径 A 顺序做两次（先做依赖方，再做依赖来源；通常前端依赖后端，所以先回前端再回后端）。**拆两个 commit**（R-10）。

### 路径 C：revert 总仓 commit（仅当总仓元信息错了，比如 `.gitmodules` 改错）

```bash
git revert <bad_commit_sha>
# 走 PR
```

不要直接 `git reset --hard origin/master`：会丢别人未到达的 commit；R-30 禁止。

## 部署侧动作

- 回滚 commit 合并到 master 后，CI/CD 会按正常发布流走；不要直接在生产服务器手动 `git checkout`
- 生产已挂的服务先用上一版镜像/二进制恢复（部署平台回滚按钮），再做 git 层回滚补齐版本一致性
- 通知前端/后端 oncall：指针已回退，新的 feature 分支需 rebase

## 常见坑

1. **回退到一个没 push 的 sha**：`git ls-remote --exit-code origin <GOOD_SHA>` 校验。
2. **回退后忘记修根因**：commit message 必须写明"后续：根因 plan 链接"。
3. **force push master 救场**：R-30 红线，无例外。哪怕回滚也走 PR。
4. **回滚后不通知**：team 内还在基于旧指针开发 → 他们的 feature 分支 rebase 时会"凭空回退"指针。
5. **macOS bash 3.2 HEREDOC**：commit message 用 `'EOF'`（单引号）防止 `$VAR` 被展开（生产事故里替换变量错位会让 message 失真）。

## 验证

```bash
# 1. 指针确实回退了
git submodule status                            # 看到 GOOD_SHA
git diff HEAD~1 HEAD --submodule=log mooc-manus # 显示从 BAD → GOOD

# 2. CI 通过
# 3. 部署后健康检查通过

# 4. 新建一个根因修复 plan / issue
ls .harness/plans/                              # 应有 hotfix-* plan
```

## Agent 行为

- 接到"立刻回滚" → **先要求**用户明确：目标 sha、影响范围、是否已通知 oncall。不直接动手。
- 默认用 PR 路径；用户要求 force push master → 拒绝（R-30 红线）。
- 指针回退方向反了（新 sha 不是旧 sha 的祖先）→ 主动提示"这是回退操作"，确认后再 commit。
- commit message 模板缺少"原因 / 影响 / 后续"任一项 → 阻止并补全。
- 回滚 PR 合并后 → 自动建议建立根因修复 plan（防止下次再被同根因炸）。
- ⚠️ 注意 R-10 第 3 条：指针回退在 commit message 中显式标记"回滚"关键词，便于审计与 hook 识别。
- 双子仓回滚 → 默认拆 commit；只有用户明确说"一个 commit 搞定"才合并。

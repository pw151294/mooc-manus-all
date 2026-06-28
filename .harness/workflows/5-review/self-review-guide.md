# 自检指南（implementer 视角）

> 实施者在请 reviewer 前先自检的三段式。每个 Task 完成时跑一遍。

## 一、完整性

回答 "这个 Task 真的做完了吗？"

- [ ] plan 中该 Task 的 **每一个 Step** 都已执行（不是"差不多"）
- [ ] DoD 中的可验证条件**逐条**核对过（命令跑过 / 文件存在 / 测试通过）
- [ ] 跨仓 Task：子仓 commit + 总仓指针升级**两边都 commit 了**
- [ ] commit message 写得清楚（reviewer 不用读 diff 也能猜到大意）

## 二、质量

回答 "这段代码 / 文档我下个月回来看还看得懂吗？"

- [ ] 命名能自解释，不依赖周围 5 行才能猜到
- [ ] 错误路径都处理了，不是 happy-path-only
- [ ] 没有 TODO / FIXME 残留（若有，必须有对应 issue / 后续 Task）
- [ ] 没有调试代码（`console.log`、`fmt.Println("HERE")`、`time.Sleep(60)`）
- [ ] 没有注释掉的旧代码（用 git history，不用注释保留）
- [ ] 引用了正确的 rule / spec / 上下文路径

## 三、纪律

回答 "我是不是顺手做了 Task 范围外的事？"

- [ ] **YAGNI**：没有"反正都改了就一起加上"的额外功能 / 配置项 / 抽象层
- [ ] **不过度防御**：没有为不会发生的情况加 6 层 try/catch
- [ ] **不重复**：没有把已存在的 util 重写一遍
- [ ] **不背离 spec**：实施过程中如果发现 spec 与现实不符，是**报告并修 spec**，不是"私自调整"
- [ ] **不绕 rule**：遇到 rule 阻碍，是**讨论是否改 rule**，不是 `--no-verify`

## 自检通过后

1. 把 commit hash 列在 Task 报告中
2. 把 self-review 三段结果（哪几条 ✓、哪几条 N/A、是否有偏差）写在报告里
3. 如果有发现 spec / plan 与现实不符的地方，单独标"现实校正"项
4. 然后才请 reviewer

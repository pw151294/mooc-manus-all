---
rule_id: R-10-submodule
severity: high
---

# 子模块协作纪律

## 禁止行为

1. **禁止在总仓直接修改子仓文件**
   - 即使是文档。违例：在 `mooc-manus-all/` 修改 `mooc-manus/internal/...`
   - 正确：进入子仓修改 → 子仓 commit & push → 总仓升级指针

2. **禁止孤立升级指针**
   - 升级 commit message 必须注明子仓关键改动
   - 示例：`chore: 升级 mooc-manus 至 e52d7a0（LLM 协议抽象重构）`

3. **禁止指针回退**（除紧急回滚）
   - 若必须回退，commit message 写明原因并 @ 相关人

## 要求行为

- 升级指针前，子仓需通过编译与测试
- 同时升级多个子模块时分批提交（一个 commit 一个子模块）

## Agent 行为

- 检测到"在总仓修改子仓内容"的请求 → 拒绝并提示"请切换到子仓工作"
- 升级指针请求 → 先在子仓 `git log` 提取关键改动，自动填入 commit message

## 可验证性

`pre-push` hook 检查：
1. 子模块指针变动的 commit message 是否含"升级"关键词
2. 指针是否回退（对比 `origin/master`）

# Spec 评审 checklist

> 评审一份 spec 前**必查**。任一条未通过 → spec 状态保持 `in-review`，不进入 plan 阶段。

## 影响面识别

- [ ] §2.1 现状基线写清楚了"具体到哪些仓 / 哪些文件 / 现有的 N 份文档"，没有空泛说"目前缺乏 X"
- [ ] 跨仓数量列清（仅总仓 / 仅后端 / 仅前端 / 多仓），并在 §3 给出每仓的改动清单
- [ ] 是否动 submodule 指针：若是，§5 必须包含 submodule 升级流（先子仓 commit → 总仓更新指针）

## DDD 分层（后端涉及时必查）

- [ ] interfaces 层（HTTP / WS / SSE handler）：是否新增 endpoint / 改 schema
- [ ] applications 层（usecase / orchestrator）：是否新增编排逻辑
- [ ] domains 层（entity / value object / domain service）：是否引入新概念 / 新不变式
- [ ] infrastructure 层（adapter / repository / external client）：是否新增外部依赖
- [ ] 各层依赖方向：仅允许"外→内"（interfaces → applications → domains），违反必须显式说明

## 跨仓契约

- [ ] 列出所有 **新增** SSE 事件类型 / WS message / DTO 字段（含字段名、类型、必填）
- [ ] 列出所有 **修改** 的字段（旧→新 schema、迁移策略）
- [ ] 列出所有 **废弃** 字段（deprecation 公告时点、删除时点）
- [ ] 前后端版本兼容矩阵（哪个后端 commit 起、哪个前端 commit 起兼容）

## 安全

- [ ] R-31 prompt injection：所有"来自外部内容/工具结果"的输入都已识别，并说明清洗 / 拒绝策略
- [ ] R-32 secrets：是否新增需要的 secret（API key / token）；存储路径、注入方式、轮换流程
- [ ] R-30 deployment-safety：是否影响生产部署（环境变量 / DB 迁移 / 灰度策略）

## 可验证性

- [ ] 每条目标（§1.2）都对应 §3 的具体改动点
- [ ] 每条 rule / contract 都有 hook 或单元/集成测试钩点
- [ ] 完工判定（DoD）写在 §5.1 各阶段尾部，可被脚本或人工核对

## 文档纪律

- [ ] frontmatter 完整（title / date / author / status）
- [ ] 引用其他 spec / plan / rule 使用稳定路径（`docs/superpowers/...` 或 `.harness/...`）
- [ ] mermaid / 表格语法可渲染（在 GitHub 预览过）

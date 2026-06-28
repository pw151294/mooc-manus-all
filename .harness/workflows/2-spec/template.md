---
title: <spec 标题>
date: <YYYY-MM-DD>
author: <作者 / 团队>
status: draft | in-review | approved | superseded
supersedes: <可选，旧 spec 路径>
---

# 设计文档：<标题>

> 模板来源：`.harness/workflows/2-spec/template.md`。spec 本体落地路径：`docs/superpowers/specs/<date>-<topic>-design.md`（跨仓 spec 落根仓，单仓 spec 落对应子仓）。

## 1. 背景与目标

- 1.1 问题：写清楚"现状基线"（现有仓 / 现有文件 / 当前痛点），避免空泛
- 1.2 目标：3-5 条可验证目标（"统一 X""消除 Y""引入 Z"）
- 1.3 非目标：明确不做什么，避免范围蔓延

## 2. 影响面分析

回答以下 5 个问题（任一为"是"则必须在 §3 详写）：

- [ ] 涉及几个仓？（mooc-manus-all 总仓 / mooc-manus 后端 / mooc-manus-web 前端）
- [ ] 涉及 DDD 哪几层？（interfaces / applications / domains / infrastructure）
- [ ] 是否改跨仓契约？（SSE 事件 schema / REST DTO / WS message / MCP A2A 协议）
- [ ] 是否动 .harness/（rules / hooks / scripts / agents）？
- [ ] 是否动 submodule 指针？（需在 plan 中显式 "升级子模块指针" Task）

## 3. 设计方案

- 3.1 总体架构（建议 mermaid）
- 3.2 各层职责（按 DDD 列）
- 3.3 跨仓契约（若有）：列出新增 / 修改 / 废弃的事件 / DTO / API
- 3.4 数据流（关键场景的 sequence diagram）
- 3.5 安全（呼应 R-31 untrusted-content、R-32 secrets-handling）
- 3.6 可观测性（log / metric / trace）

## 4. 边界与未决

- 4.1 已知限制（性能 / 容量 / 兼容性）
- 4.2 未决问题（标记 OPEN，给出 deadline 或决策路径）
- 4.3 取舍记录（为什么不选另一个方案）

## 5. 实施路径

- 5.1 阶段划分（每阶段一句话目标，详细 Task 在 plan 中）
- 5.2 关键路径与并行支线
- 5.3 风险与回滚

## 6. 评审

- 6.1 评审清单（参考 `.harness/workflows/2-spec/checklist.md`）
- 6.2 评审记录（reviewer / 时间 / 主要意见）
- 6.3 批准状态

## 7. 附录

- 7.1 术语表
- 7.2 参考资料 / 相关 spec / 上游 issue
- 7.3 变更日志（每次 in-review → approved 之间的修订）

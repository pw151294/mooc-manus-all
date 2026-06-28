---
adr_id: ADR-NNN
title: <一句话决策标题>
status: proposed | accepted | superseded | deprecated
date: <YYYY-MM-DD>
deciders: <参与人列表>
supersedes: <可选，被本 ADR 取代的旧 ADR>
superseded_by: <可选，本 ADR 被哪个 ADR 取代后填>
---

# ADR-NNN: <标题>

> ADR（Architecture Decision Record）记录"为什么做出某个架构决定"。落地路径：`.harness/retro/adr/<NNN>-<slug>.md`。

## 背景

写清楚做决定时的处境：
- 现状是什么
- 哪些约束 / 痛点 / 需求触发了这个决策
- 已经存在的相关 ADR / spec / rule

避免空泛"系统需要扩展性"——具体到流量 / 数据量 / 团队规模 / 已发生的事故。

## 决策

一段话写清楚**最终决定做什么**。形式建议：

> 我们决定 <动作>，因为 <主要理由>。

然后列：
- 范围：影响哪些仓 / 模块 / 流程
- 不在范围：明确排除什么
- 关键设计点（3-5 条）

## 后果

诚实写**正负两面**：

### 正面

- ...

### 负面 / 代价

- 技术债：
- 维护成本：
- 学习曲线：
- 兼容性影响：

### 中性 / 待观察

- 需要持续监测的指标 / 阈值

## 替代方案

至少列 2 个被放弃的替代方案，每个写：
- 思路简介
- 为什么没选（不是"我们就是选了 A"，而是说清楚 B / C 的具体劣势）

## 实施 / 跟进

- 关联 plan / spec / commit：
- 后续 review 时点：
- 失效条件（什么情况下需要 supersede 本 ADR）：

## 变更日志

- <YYYY-MM-DD> proposed by <作者>
- <YYYY-MM-DD> accepted in review
- <YYYY-MM-DD> superseded by ADR-MMM

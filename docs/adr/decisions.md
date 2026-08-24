# 决策注册表

单一入口，所有架构决策汇总。Skill 校验时先查此文件，不搜 spec/wiki/memory。

## 活跃决策

| ID | 决策 | 日期 | 状态 | 权威来源 | 替代了 |
|---|------|------|------|----------|--------|
| D-007 | 文档防腐烂：Skill + CLI + Agent event-driven | 2026-06-11 | active | project_doc_freshness_design | — |
| D-008 | 文档防腐烂 V1：CI 检测 + Auditor 修复 + PR 需人 review | 2026-06-11 | active | project_doc_freshness_design | — |

## 已归档（stable）

代码已完全实现，文档一致，无歧义风险。

| ID | 决策 | 日期 | 归档依据 |
|---|------|------|----------|
| D-001 | 内容归文件，聚合指标按需保留 Prisma | 2026-06-11 | KnowledgeEntry/Skill 表已删除，Resolution 保留，KnowledgeStore 文件存储正常 |
| D-002 | SKILL.md 是 Skill 唯一真相源 | 2026-06-07 | SkillLoader 从 SKILL.md 加载，Prisma Skill 表已删除 |
| D-003 | Agent 角色 10 个（含 DataAnalyst） | 2026-06-11 | DESIGN.md 已更新，代码确认 10 个 Agent |
| D-004 | Prisma KnowledgeEntry 删除，eval case 迁 KnowledgeStore | 2026-06-11 | schema 已删除模型，eval-case-generator 已迁移 |
| D-005 | Prisma Skill 删除，内容迁 SKILL.md | 2026-06-11 | schema 已删除模型+SkillProposal，routes 已迁移 |
| D-006 | Resolution 保留 Prisma（groupBy/_avg/count 聚合是刚需） | 2026-06-11 | Resolution 表未动，Dashboard 聚合正常 |

### V2 触发条件（不独立排期，V1 步骤完成后评估升级）

| V2 功能 | 触发条件 | 排入点 |
|---------|----------|--------|
| 叙述性声明提取 | V1 CLI 稳定 2 周，准确率 >90% | 步骤 3 后追加 |
| 自动 merge 简单 PR | V1 PR 无误修率 <5%（连续 10 个） | 步骤 6 后追加 |
| 自动触发 + 每日抽样 | V1 手动触发 >3 次/周 | 步骤 5 后追加 |
| 全部文档声明式改造 | 关键文档改造验证有效 | 步骤 1 后追加 |

## 生命周期

- **active**：刚确认，代码迁移未完成。留在注册表。
- **stable**：代码已实现，所有消费方已迁移。从注册表移除（代码即文档）。
- **archived**：被新决策替代。标记替代关系，移除。

目标大小：15-25 条活跃决策。

## 归档规则

每次新增决策时检查是否有可 stable 的：
- 代码已完全按决策实现
- 文档已和代码一致
- 无歧义风险

满足以上三条 → stable → 移除。

---
status: done
version: "1.0"
source: studio/docs/issues/2026-07-01-knowledge-base-optimization.md Phase 4
design_ref: design-analyst output 2026-07-01
---

# Phase 4 消费闭环 — 需求

## 源项目追溯

| # | 源项目 | 产出类型 | AC |
|---|--------|---------|-----|
| 1 | 4.1 Agent 搜索后记录 referencedBy | 代码改写 | AC-1 |
| 2 | 4.2 零消费条目定期审查 | 代码新增（trigger） | AC-2 |
| 3 | 4.3 知识→Skill SCHEDULE trigger | 代码新增（trigger） | AC-3 |
| 4 | 4.4 废弃 knowledge-skill-evolver.ts | 代码删除 | AC-4 |

---

## AC-1: 消费追踪管线修复

**触发条件**：AgentLoop.execute() 完成后，analyzeKnowledgeSearchFromLog() 检测到 Agent 访问了知识库文件
**预期行为**：
1. 从 searchCalls 中提取被访问的知识文件名
2. 文件名转为 entry ID（去 .md 后缀）
3. 调用 knowledgeService.recordConsumption(entryIds, context) 记录消费
4. referencedBy 字段被真实数据填充

**边界情况**：
- Agent 未搜索知识库 → consumedKnowledge 为空，不调 recordConsumption
- 文件名无法解析为 entry ID（如 _index.md）→ 跳过该条目
- recordConsumption 抛异常 → 不阻断 WorkUnit 流程（non-blocking）

**不做**：不改知识库搜索方式（仍用 grep/Read/Glob）

---

## AC-2: 零消费审查 SCHEDULE trigger

**触发条件**：每日 05:17（cron: '17 5 * * *'）
**预期行为**：
- 创建 WorkUnit（type=analysis）
- scope 指示 Agent 扫描 referencedBy 为空的条目，输出审查报告到 ~/.studio/data/knowledge-consumption-audit.md
- 报告包含：零消费条目列表、创建时间、建议（保留/归档）

**边界情况**：
- 无零消费条目 → WorkUnit scope 说明"无零消费条目，跳过"
- Agent 执行失败 → WorkUnit 标 retryable

**不做**：不自动归档（只产出报告）

---

## AC-3: knowledge-synthesis SCHEDULE trigger

**触发条件**：每周一 10:23（cron: '23 10 * * 1'）
**预期行为**：
- 创建 WorkUnit（type=analysis）
- scope 指示 Agent 执行 knowledge-synthesis-skill（~/.studio/skills/knowledge-synthesis-skill/SKILL.md）
- Agent 读取 SKILL.md → 执行语义模式检测 → 产出 Skill 提议

**边界情况**：
- knowledge-synthesis-skill 不存在 → WorkUnit 失败，记日志

**不做**：不改 SKILL.md 内容

---

## AC-4: 废弃 knowledge-skill-evolver.ts

**触发条件**：文件存在
**预期行为**：
- 删除 `knowledge-skill-evolver.ts`
- 删除对应测试文件 `knowledge-skill-evolver.test.ts`
- grep 确认无其他 import 引用

**边界情况**：
- 有未发现的 import → grep 验证后确认

**不做**：不保留 @deprecated（零调用方，直接删除）

---

## 不做项

- 不改 knowledge-synthesis-skill SKILL.md
- 不改 recordOutcome / goal-lifecycle.ts（那是 Pipeline 路径，已废弃）
- 不自动归档零消费条目（只产出报告）

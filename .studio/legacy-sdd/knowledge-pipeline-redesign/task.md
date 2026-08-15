---
status: draft
slug: knowledge-pipeline-redesign
updated: 2026-07-15
---

## Phase 1: 接线（不迁存储，先让数据流起来）

### T-1.1: AgentLoop 记录 tool:call

**文件**: `apps/api/src/modules/agents/agent-loop.ts`
- agentStep() 中每次工具调用后追加写 `~/events/studio.jsonl`
- 格式: `{type:"tool:call", tool, success, durationMs, timestamp, caller:"agent-loop"}`
- AC: grep "tool:call" studio.jsonl 数量随 Agent 执行增长

### T-1.2: 置信度门槛降低

**文件**: `apps/api/src/modules/knowledge/preference-observer.ts`
- 行 215: `confidence < 0.4` → `confidence < 0.3`
- AC: 冷启动 preference 即刻可通过 getPreferences() 获取

### T-1.3: DecisionChain 触发器放宽

**文件**: `apps/api/src/modules/knowledge/decision-chain-extractor.ts`
- extractFromMeeting() → 标记 `@deprecated`（meeting 已删除）
- extractFromExecution(): 删除 `isArchitectureChange()` 过滤 → 改为 task description 关键词预筛选
- 搜索结果含"选择/方案/决定/选型/设计"时才调 LLM
- AC: WorkUnit 完成后如有决策关键词 → DecisionChain 条目增长

### T-1.4: 接线 PreferenceObserver

**文件**: `apps/api/src/modules/channels/channel-message.service.ts`
- createHumanMessage() 后 → `preferenceObserver.updateActiveHours([{createdAt}])`
- createAgentMessage() 后 → `preferenceObserver.updateResponseStyle([{content}])`

**文件**: `apps/api/src/modules/knowledge/preference-observer.ts`
- updateFromRoutingFeedback() → 标记 `@deprecated`

### T-1.5: Channel 决策捕获

**文件**: Agent prompt template（`agent-loop.ts` 或 agent role config）
- 加 tool description: "当发现设计决策时调 recordManual(topic, options, chosen, rationale)"
- recordManual() 写 KnowledgeStore (type=decision)

## Phase 2: 生产者切 KnowledgeStore + 删 Prisma 表

> 按消费方审计结果分批迁移，由简到难。每批完成后独立提交，可回滚。

### 第一批: UserPreference (T-2.1)

**文件**: `apps/api/src/modules/knowledge/preference-observer.ts`
- 消费方: preference-observer.ts + unified-query.ts + monitor-agent.service.ts
- 单行读写，最简单
- getOrCreatePreference / update*: 改读/写 KnowledgeStore
- 更新 unified-query.ts 引用
- 更新 monitor-agent.service.ts 引用
- 删 Prisma UserPreference 表

### 第二批: DecisionChain (T-2.2)

**文件**: `apps/api/src/modules/knowledge/decision-chain-extractor.ts`
- 消费方: decision-chain-extractor.ts（自包含）
- extractFromExecution / recordManual: 改读写 KnowledgeStore
- 删 Prisma DecisionChain 表

### 第三批: InteractionPattern + BusinessRule (T-2.3, T-2.4)

**文件**: pattern-miner.ts, rule-scanner.ts
- 消费方: 各自自包含 + routes.ts + unified-query.ts
- 有 updateMany 批量操作 → 需改循环写入
- RuleScanner 同时过滤纯常量

### 第四批: DecisionAudit + UserBehaviorProfile (T-2.5, T-2.6)

**文件**: audit-subscriber.ts, auditor-agent.service.ts, knowledge-agent.service.ts, monitor-agent.service.ts
- 消费方最多，最后处理
- DecisionAudit: count 聚合需替代方案
- UserBehaviorProfile: text search 需替代方案

### T-2.7: knowledge-query.service → 切 KnowledgeStore

**文件**: `apps/api/src/modules/knowledge/knowledge-query.service.ts`
- 上游所有 producer 迁完后执行
- case preference/business_rule/decision_chain/interaction → KnowledgeStore

## Phase 3: 清理死代码

### T-3.1: 删 GoalListPage

**文件**: `apps/web/src/App.tsx` — /goals → redirect /workunits
**文件**: `apps/web/src/pages/GoalListPage.tsx` — 删除
**文件**: `apps/web/src/stores/goalStore.ts` — 删除
**文件**: `apps/web/src/stores/index.ts` — 移除 useGoalStore export
**文件**: `apps/web/src/api/index.ts` — 删除 goalApi + executionApi

### T-3.2: 修 requirementsDocCard 404

**文件**: `apps/web/src/components/channel/RequirementsDocCard.tsx`
- `/goals/${goalId}` → `/api/v1/workunits/${goalId}` 或 `/api/v1/wiki/${docId}`

### T-3.3: 清除 agent/types.ts Pipeline 类型

**文件**: `apps/api/src/modules/agents/types.ts`
- DeployParams / DeployFinding / DeployResult → 标记 @deprecated 或删除

### T-3.4: CAPABILITIES.md 清理

**文件**: `CAPABILITIES.md`
- 删除 4 条已不存在的文件引用

## 文件映射

| 文件 | Phase | 改动类型 |
|------|-------|---------|
| `apps/api/src/modules/agents/agent-loop.ts` | 1 | ✅ 加 tool:call + 决策 prompt |
| `apps/api/src/modules/knowledge/preference-observer.ts` | 1,2 | ✅ 改阈值 + 待切 KnowledgeStore |
| `apps/api/src/modules/knowledge/decision-chain-extractor.ts` | 1,2 | ✅ 放宽 trigger + 删 extractFromMeeting + 待切 KS |
| `apps/api/src/modules/channels/channel-message.service.ts` | 1 | ✅ 接线 Preference |
| `apps/web/src/App.tsx` | 3 | /goals redirect → /workunits |
| `apps/web/src/pages/GoalListPage.tsx` | 3 | 删除 |
| `apps/web/src/stores/goalStore.ts` | 3 | 删除 |
| `apps/web/src/api/index.ts` | 3 | 删 goalApi + executionApi |
| `apps/web/src/components/channel/RequirementsDocCard.tsx` | 3 | 修 /goals/:id 404 |
| `apps/api/src/modules/agents/types.ts` | 3 | 删 Deploy* 类型 |
| `CAPABILITIES.md` | 3 | 清理死引用 |
| `apps/api/src/modules/knowledge/rule-scanner.ts` | 2 | 过滤常量 + 切 KnowledgeStore |
| `apps/api/src/modules/knowledge/pattern-miner.ts` | 2 | 切 KnowledgeStore |
| `apps/api/src/modules/knowledge/knowledge-query.service.ts` | 2 | 切 KnowledgeStore |
| `apps/api/src/modules/agents/auditor-agent.service.ts` | 2 | 迁 DecisionAudit → KS |
| `apps/api/src/modules/audit/audit-subscriber.ts` | 2 | 迁 DecisionAudit → KS |
| `apps/api/src/modules/agents/knowledge-agent.service.ts` | 2 | 迁 UserBehaviorProfile → KS |
| `apps/api/src/modules/agents/monitor-agent.service.ts` | 2 | 迁 UserBehaviorProfile → KS |
| `packages/studio-prisma/prisma/schema.prisma` | 2 | 分批删 6 表 |

## 关联测试清理

| 删除目标 | 测试文件 | 操作 |
|---------|---------|------|
| GoalListPage.tsx | 无 | — |
| goalStore.ts | 无 | — |
| goalApi | api/__tests__/index.test.ts (可能引用) | 删对应测试用例 |
| executionApi | 同上 | 删对应测试用例 |
| UserPreference 表 | preference-observer.test.ts | 重写测试适配 KnowledgeStore |
| BusinessRule 表 | 无 | — |
| DecisionChain 表 | 无 | — |
| InteractionPattern 表 | 无 | — |
| UserBehaviorProfile 表 | 无 | — |
| DecisionAudit 表 | 无 | — |

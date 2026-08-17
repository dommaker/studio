---
status: draft
version: "0.2"
slug: knowledge-pipeline-redesign
title: Pipeline→Agent Network 迁移断点全面修复
created: 2026-07-15
updated: 2026-07-15 (Phase 1 done, Phase 2 consumer audit appended, Phase 3 pending)
tags:
  - knowledge
  - agent-network
  - migration
  - dead-chains
  - first-principles
---

## 问题全景

Pipeline→Agent Network 迁移(2026-06-23)后，遗留 36 处断点。其中 3 个 HIGH、9 条知识死链、24 处 Legacy 引用。

### 根因一：存储-消费错配（核心发现）

两套存储体系各自半拉：

```
Prisma 专用表（7 个）    ←→   UI 7 个具体类型 Tab
UserPreference              偏好 Tab     ← confidence<0.4 门槛不可见
BusinessRule                规则 Tab     ← RuleScanner 噪音常量
EnvironmentSnapshot         环境 Tab     ← EnvSnapper ✅ 唯一正常
DecisionChain               决策 Tab     ← extractFromMeeting 触杀死
InteractionPattern          交互 Tab     ← PatternMiner 数据源不确定
UserBehaviorProfile         行为 Tab     ← 外部管线未知
Resolution                  解法 Tab     ← seed+verify ✅

KnowledgeStore 文件系统    ←→   UI 统一视图 Tab
~/.studio/knowledge/*.md     统一视图    ← AgentLoop.recordOutcome()
                                           AgentLoop.extractFromExecution()
                                           monitor/triage/auditor.recordPattern()
                                           全部写到这里！
```

**AgentLoop 每步都在写知识**，但写进 KnowledgeStore 文件 → 只在"统一视图"一个 Tab 可见。7 个具体类型 Tab 查 Prisma 表，这些表要么空、要么噪音。

### 根因二：Pipeline 时代 producer 触发器断裂

6 条知识死链：

| # | 断链 | 可接线？ |
|---|------|---------|
| 1 | `updateActiveHours()` 无调用者 | ✅ Channel 消息时间戳 |
| 2 | `updateResponseStyle()` 无调用者 | ✅ Agent 回复消息长度 |
| 3 | `updateAutoApproveThreshold()` 无调用者 | ✅ 知识确认/拒绝事件 |
| 4 | `updateFromRoutingFeedback()` 无调用者 | ❌ Pipeline 专有，废弃 |
| 5 | PatternMiner 读 `~/events/studio.jsonl` | ⚠️ 需验证 tool:call 是否仍写入 |
| 6 | `extractFromMeeting()` 无调用者 | ❌ Meeting 已删除，废弃 |

### 根因三：跨模块 Pipeline 遗留

| # | 模块 | 严重度 | 描述 |
|---|------|--------|------|
| GAP-9 | Execution | HIGH | `executions/routes.ts` 427 行，活跃路由 `/api/v1/executions`，跟 WorkUnit 不连通 |
| GAP-16 | Frontend | HIGH | `GoalListPage.tsx` + `/goals` 路由调不存在的 `/api/v1/goals`，页面空白 |
| GAP-19 | Docs | HIGH | `CAPABILITIES.md` 引用 4 个已删除文件 |
| GAP-10 | Discord | MEDIUM | `events:goal-execution` 发布了无订阅者 |
| GAP-15 | Events | MEDIUM | 同上，事件通道孤儿 |

## AC Groups

### AC Group 1: 统一存储到 KnowledgeStore

**AC-1.1**: 7 个具体类型 Tab 改为从 KnowledgeStore 查询，不再查 Prisma 专用表
- 偏好 / 规则 / 环境 / 决策链 / 交互模式 / 行为模式 / 解法库 → 统一走 KnowledgeStore
- `knowledge-query.service.ts` 的 `query()` 方法改为 query KnowledgeStore 而非 Prisma
- Prisma 专用表保留不删（数据迁移后再清理）

**AC-1.2**: UnifiedQuery 按 type tag 拆分返回
- KnowledgeStore 条目已有 type tag（guideline/pitfall/pattern/decision/...）
- UI Tab 按 type tag 过滤显示

**AC-1.3**: RuleScanner 过滤纯常量
- `scanSourceConstants()` 只保留有同行注释或语义明确的常量
- 丢弃 `MAX_RETRY=3`、`DEFAULT_TIMEOUT=5000` 等无注释配置值
- 过滤后规则数预期从数十条降至 10-15 条

### AC Group 2: 知识死链接线

**AC-2.1**: 接线 `updateActiveHours`
- 触发点：Channel message send 时（每次发送消息）
- 接入：Channel message service → preferenceObserver.updateActiveHours()
- 不可接线：无

**AC-2.2**: 接线 `updateResponseStyle`
- 触发点：Agent 在 Channel 中回复消息时
- 接入：Agent reply → preferenceObserver.updateResponseStyle()
- 不可接线：无

**AC-2.3**: 接线 `updateAutoApproveThreshold`
- 触发点：知识确认/拒绝事件（`knowledge:confirmed` / `knowledge:rejected`）
- 接入：EventBus 发布 → preferenceObserver.updateAutoApproveThreshold(confirmed, rejected)
- 不可接线：无

**AC-2.4**: 废弃 `updateFromRoutingFeedback`
- Pipeline tier routing 已不存在
- 标记 `@deprecated`，保留空壳防止编译错误

**AC-2.5**: PatternMiner 数据源验证 + 切换
- 验证 `tool:call` 事件是否仍在 `~/events/studio.jsonl` 写入
- 如断裂 → 改为读 FileStore `events.jsonl`（WorkUnit 事件流）
- 如正常 → 无需改动

**AC-2.6**: 废弃 `extractFromMeeting`
- Meeting 模块已删除
- 标记 `@deprecated`，保留空壳

### AC Group 3: 跨模块 HIGH 断点修复

**AC-3.1**: GoalListPage → 删除或重定向
- `/goals` 路由 → 重定向到 `/workunits`
- GoalListPage.tsx → 删除
- goalApi / goalStore → 标记 @deprecated

**AC-3.2**: executions/routes.ts → 评估状态
- 确认 `/api/v1/executions` 是否仍有消费方
- 无消费方 → 标记 @deprecated
- 有消费方 → 迁移到 WorkUnit API

**AC-3.3**: CAPABILITIES.md → 清理死引用
- 删除 4 个不存在的文件引用
- 更新 pipeline-dashboard 引用为 monitoring

### AC Group 4: 不做

- 不删 Prisma 表（迁完消费方后再清理，见 AC Group 5 消费方审计）
- 不改变 KnowledgeStore 文件格式
- 不引入新知识类型

### AC Group 5: Prisma 表消费方审计 + 迁移顺序

2026-07-15 审计 6 张 Prisma 知识表。全部可迁 KnowledgeStore，无复杂查询。

| 表 | 消费方 | 操作类型 | 迁移难度 |
|----|--------|---------|---------|
| UserPreference | preference-observer.ts + unified-query.ts + monitor-agent.service.ts | findFirst + create/update | 低 |
| DecisionChain | decision-chain-extractor.ts | findMany + create | 低 |
| InteractionPattern | pattern-miner.ts + routes.ts | findMany/findFirst + create/update/updateMany | 中 |
| BusinessRule | rule-scanner.ts + unified-query.ts | findFirst/findMany + create/update/updateMany | 中 |
| DecisionAudit | audit-subscriber.ts + auditor-agent.service.ts | create + count | 中 |
| UserBehaviorProfile | knowledge-agent.service.ts + monitor-agent.service.ts + routes.ts | findMany + create/update | 高 |

迁移顺序：UserPreference → DecisionChain → InteractionPattern → BusinessRule → DecisionAudit → UserBehaviorProfile

## 声明-证据对照

| 声明 | 证据 |
|------|------|
| AgentLoop 每步都写知识到 KnowledgeStore | agent-loop.ts:347 `knowledgeService.recordOutcome()`, :359 `extractFromExecution()` |
| 7 个具体类型 Tab 查 Prisma 专用表 | knowledge-query.service.ts:31-55，每个 type → 不同 Prisma model |
| Preference.confidence<0.4 不显示 | preference-observer.ts:215 |
| RuleScanner 70% 是配置常量 | rule-scanner.ts:266 正则 `MAX_\|MIN_\|DEFAULT_\|LIMIT_\|THRESHOLD_` |
| extractFromMeeting 无调用者 | grep 全代码库 — 0 结果 |
| GoalListPage 调不存在 API | App.tsx:158 `/goals` 路由，route-registry.ts 无 `/api/v1/goals` |
| events:goal-execution 无订阅者 | discord/routes.ts:259,282,365 publish，grep 订阅 → 0 |
| CAPABILITIES.md 引用死文件 | grep init-trace.ts, trace-pipeline.service.ts, pipeline-dashboard, conversation-converter → 均不存在 |

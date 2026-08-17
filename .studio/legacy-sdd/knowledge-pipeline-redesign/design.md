---
status: draft
slug: knowledge-pipeline-redesign
updated: 2026-07-15
---

## 架构决策

### 决策 1: 纯 KnowledgeStore，不双写

原架构设计已经明确分层：

```
~/.studio/
  knowledge/       ← 知识 (.md)，可进化 Skill
    guideline-xxx.md
    pitfall-xxx.md
    decision-xxx.md
    ...
  data/            ← 数据 (.jsonl)，供分析
    trends/
    events.jsonl
```

Prisma 专用表（UserPreference / BusinessRule / DecisionChain / InteractionPattern / UserBehaviorProfile）是 Pipeline 时代产物。不兼容，不双写。直接废弃并删除。

保留两个例外：
- `EnvironmentSnapshot`：运维快照，不是"可行动的知识"。保留 Prisma 存储。
- `Resolution`：40+ 条有用数据 + 独立验证体系。保留 Prisma，远期迁移。

### 决策 2: 生产者重写而非适配

Pipeline 时代 producer 的写入目标是 Prisma → 重写到 KnowledgeStore：

```
PreferenceObserver    → 改写 KnowledgeStore (type=preference)
RuleScanner           → 改写 KnowledgeStore (type=rule)
DecisionChainExtractor → 改写 KnowledgeStore (type=decision)
PatternMiner          → 改写 KnowledgeStore (type=pattern)
```

不改适配层（适配 = 双写），直接改目标。

### 决策 3: 缺口接线

#### 3.1 tool:call 不记录 → AgentLoop 内联写

```
AgentLoop.agentStep():
  每次 tool call 后写一条 event:
  { type: "tool:call", tool, success, durationMs, timestamp }
  → ~/events/studio.jsonl  (保持兼容 PatternMiner 读路径)
  → 或 FileStore.events.jsonl (统一事件流)
```

选 `~/events/studio.jsonl` — PatternMiner 读路径不变，tool-registry.ts 也写同一个文件，事件汇合在同一处。

#### 3.2 PatternMiner 无数据 → 依赖 3.1

AgentLoop 开始写 tool:call → studio.jsonl 积累 10+ → PatternMiner 定时跑通。

PatternMiner 逻辑不变。

#### 3.3 Channel 决策 → Agent 自主调 recordManual

不建基础设施。Agent prompt 加一条：
"当在讨论中识别到设计决策（A vs B 选型）时，调用 decisionChainExtractor.recordManual() 记录"

实施方式：
- Agent prompt template 加一条 skill/tool 描述
- recordManual() 改写 KnowledgeStore (type=decision)  -> 不再写 Prisma DecisionChain 表

#### 3.4 置信度门槛 → 0.4 → 0.3

```diff
- if (!pref || pref.confidence < 0.4) return null;
+ if (!pref || pref.confidence < 0.3) return null;
```

冷启动 default confidence=0.3 → 即刻可见。

#### 3.5 DecisionChain 触发 → 放宽条件

```diff
- if (!this.isArchitectureChange(changedFiles)) return 0;
+ // 任何 WorkUnit 完成都尝试提取，LLM 判断是否有决策
```

isArchitectureChange 过滤去掉。用 task description 关键词预筛选（"选择/方案/决定/选型"）替代文件路径正则。

### 决策 4: 删除 Pipeline 死代码

| 目标 | 原因 | 操作 |
|------|------|------|
| GoalListPage.tsx | API `/api/v1/goals` 不存在 | 删除 |
| goalStore.ts | GoalListPage 专属 | 删除 |
| goalApi (api/index.ts) | 后端无路由 | 删除 |
| executionApi (api/index.ts) | 零消费方 | 删除 |
| /goals 路由 | 页面已删 | redirect /workunits |
| executions/routes.ts | ProjectDetail/PMOCard 在用 → 不删 | 保留 |
| updateFromRoutingFeedback() | Pipeline 专有 | 标记 @deprecated 空壳 |
| extractFromMeeting() | Meeting 已删 | 标记 @deprecated 空壳 |
| requirementsDocCard /goals/:id 调用 | API 不存在 | 改为 /api/v1/workunits/:id |

### 决策 5: Prisma 表删除计划（分批）

2026-07-15 审计确认：6 张表共 8 个源文件的消费方，全部可迁 KnowledgeStore。

```
第一批 [destructive]: UserPreference（1 消费方，单行）
第二批 [destructive]: DecisionChain（自包含）
第三批 [destructive]: InteractionPattern + BusinessRule（有 updateMany）
第四批 [destructive]: DecisionAudit + UserBehaviorProfile（消费方最多）
```

保留:
  EnvironmentSnapshot 表（运维数据，非知识）
  Resolution 表（40+ 条有用数据，远期单独迁移）
```

### 不做

- 不删除 Prisma schema 的 Execution 模型（ProjectDetail/PMOCard 在用）
- 不删除 ProjectDetail.tsx（GlobalModals 弹窗在用）
- 不改变 KnowledgeStore 文件格式
- 不用 LLM 判断知识质量

## 存储架构（目标态）

```
UI Tab          查询源              写入者
─────────────────────────────────────────────────
偏好      →  KnowledgeStore    ←  PreferenceObserver (改目标)
规则      →  KnowledgeStore    ←  RuleScanner (改目标)
环境      →  Prisma EnvSnapshot ←  EnvSnapper (不变)
决策      →  KnowledgeStore    ←  DecisionChainExtractor (改目标) + Agent recordManual
模式      →  KnowledgeStore    ←  PatternMiner (改目标)
解法      →  Prisma Resolution ←  ResolutionService (不变，远期迁移)
统一视图   →  KnowledgeStore    ←  AgentLoop + agent services (已有)
```

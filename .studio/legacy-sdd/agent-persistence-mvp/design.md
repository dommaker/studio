---
status: "done"
version: "1.0"
specId: AS-026
created: 2026-06-24
---

# Agent Persistence MVP — Design

## Architecture Context

**Call Chain**
```
EventBus (workunit.created) → TriggerRegistry (EVENT match) → AgentLoop.onNewWorkUnit()
  → canClaim() → tryClaim() → workUnitService.claim()
  → loadSkills() → skillLoader.listAll() + loadSingle()
  → executeWithSkills() → agentExecutor.execute()
  → submitForReview() OR unclaim()
```

**Key Existing Interfaces**
- `workUnitService.claim(workUnitId, agentId)` → `{ success, workUnit }` (乐观锁)
- `workUnitService.unclaim(workUnitId)` → reset assigneeId/status
- `eventBus.subscribe(channel, handler)` / `eventBus.publish(channel, payload)`
- `skillLoader.listAll()` → `SkillDefinition[]` (name + description 元数据)
- `skillLoader.loadSingle(name)` → `SkillDefinition` (含完整 prompt)
- `agentExecutor.execute(AgentTask)` → `Promise<ExecutionResult>`

**Danger Zones**
- TriggerScheduler.tick() 是 60s 间隔 — EVENT 条件需绕过 tick，直接用 EventBus 订阅
- workUnitService.claim() 内部已调 autoLoadSkillsForAgent — AgentLoop 需决定是否复用或自行加载
- GoalScheduler.processGoal() 有并发限制（MAX_CONCURRENT）— AgentLoop 需自行 guard

---

## AC Groups

### AC-1: RuntimeInstance 表 + CRUD API

#### 实现指南

Prisma schema 新增 RuntimeInstance 模型。复用现有 agents/ 目录结构，新建 instance service + routes。

AgentProfile.metadata 扩展 acceptedTypes/autoClaim/defaultSkills，类型定义在 agent-profile.service.ts。

#### 参考模式
- `prisma/schema.prisma` — AgentProfile 模型定义格式
- `apps/api/src/modules/agents/agent-profile.service.ts` — 现有 Agent CRUD 模式
- `apps/api/src/modules/agents/agent-profile.routes.ts` — 现有路由模式

#### Architecture Context

**Functions**
- `createInstance(roleId, sessionId?)` → RuntimeInstance
- `getInstance(id)` → RuntimeInstance | null
- `listInstances(filter?)` → RuntimeInstance[]
- `updateInstance(id, data)` → RuntimeInstance

**Types**
```typescript
interface RuntimeInstance {
  id: string
  roleId: string
  sessionId: string | null
  status: 'idle' | 'active' | 'terminated'
  currentWorkUnitId: string | null
  startedAt: Date
  terminatedAt: Date | null
  metadata: string | null  // JSON: { tokenUsed, tasksCompleted, lastHeartbeat }
}

interface AgentRoleMetadata {
  acceptedTypes: string[]      // WorkUnit types this role handles
  autoClaim: boolean           // Auto-claim matching WorkUnits
  defaultSkills: string[]      // Skill names to preload
}
```

---

### AC-2: Trigger 系统扩展

#### 实现指南

扩展现有 trigger.types.ts 类型，扩展 trigger-scheduler.ts 支持 EVENT 条件，扩展 trigger-action.ts 支持 EXECUTE + UPDATE 动作。

**关键设计决策**：EVENT 条件不在 tick() 中评估，而是在 register 时直接订阅 EventBus。SCHEDULE 条件继续用 tick()。

**Handler Registry 模式**：EXECUTE 动作通过 handler registry 分发。AgentLoop 启动时注册自己的 handler。trigger-action.ts 不硬编码 AgentLoop 引用。

#### 参考模式
- `apps/api/src/modules/triggers/trigger.types.ts` — 现有类型定义
- `apps/api/src/modules/triggers/trigger-scheduler.ts` — 现有调度器
- `packages/studio-shared/src/event-bus.ts` — EventBus subscribe/publish

#### Architecture Context

**Functions**
```typescript
// trigger-scheduler.ts 扩展
registerTrigger(trigger: TriggerConfig): void
  // SCHEDULE → 加入 tick 评估
  // EVENT → eventBus.subscribe(trigger.condition.config.event, handler)

unregisterTrigger(id: string): void
  // 清理 EventBus 订阅 + tick states

// trigger-action.ts 新增
registerExecuteHandler(target: string, handler: (context: unknown) => Promise<void>): void
executeExecuteAction(action: TriggerAction, context: unknown): Promise<void>
executeUpdateAction(action: TriggerAction, context: unknown): Promise<void>
```

**Types 扩展**
```typescript
// trigger.types.ts 扩展
interface TriggerCondition {
  type: 'SCHEDULE' | 'EVENT'
  cron?: string           // SCHEDULE 用
  event?: string          // EVENT 用：EventBus 事件名
  filter?: Record<string, unknown>  // EVENT 用：可选过滤
}

interface TriggerAction {
  type: 'CREATE' | 'EXECUTE' | 'UPDATE'
  target: string          // CREATE: 'WorkUnit', EXECUTE: handler名, UPDATE: 实体类型
  payload?: { ... }       // CREATE 用
  config?: {              // EXECUTE/UPDATE 用
    query?: Record<string, unknown>   // UPDATE: prisma where
    update?: Record<string, unknown>  // UPDATE: prisma data (支持 $event.xxx 模板)
    [key: string]: unknown
  }
}
```

**Danger Zones**
- trigger-scheduler.ts 的 `executeTrigger()` 只处理 CREATE — 需扩展 switch
- EVENT Trigger 重启后丢失 — MVP 可接受，AgentLoop.start() 重新注册
- `executeUpdateAction` 的模板替换 `$event.xxx` — 需递归处理嵌套对象

---

### AC-3: AgentLoop 核心

#### 实现指南

新建 `agent-loop.ts`，核心类。依赖 workUnitService（claim/unclaim）、skillLoader（listAll/loadSingle）、agentExecutor（execute）。

AgentLoop 不直接调 prisma，通过 service 层操作。

**Skill 匹配流程**：
1. `skillLoader.listAll()` → 获取全部 Skill 的 name + description 元数据索引
2. 对比 WorkUnit.scope + Role.description → 选相关 Skill（关键词匹配，不用 RAG）
3. `skillLoader.loadSingle(name)` → 读取完整 prompt

**注意**：workUnitService.claim() 内部已调 `autoLoadSkillsForAgent()`。AgentLoop 有两个选择：
- A: 复用 claim() 内置的 skill 加载（不重复加载）
- B: 自行加载 Skill（控制匹配逻辑）

**推荐 B**：AgentLoop 需要根据 Role.description 做语义匹配，内置的 autoLoadSkillsForAgent 不够灵活。claim() 的 autoLoad 可保留作为兜底。

#### 参考模式
- `apps/api/src/modules/goals/scheduler-integration.ts` — processGoal() 的并发控制 + dispatch
- `apps/api/src/daemon/studio-daemon.ts` — persistent session 注册模式
- `packages/studio-agent/src/services/session-manager.ts` — AgentTask/ExecutionResult 接口

#### Architecture Context

**Functions**
```typescript
class AgentLoop {
  private role: AgentProfile
  private instance: RuntimeInstance
  private processing: boolean
  private registry: TriggerScheduler  // 复用扩展后的 TriggerScheduler

  constructor(role: AgentProfile, registry: TriggerScheduler)

  async start(): Promise<void>
    // 1. createInstance(role.id) → RuntimeInstance
    // 2. registerAgentTriggers() → 注册 EVENT Trigger (workunit.created)
    // 3. scanForWork() → 初始扫描

  async onNewWorkUnit(workUnit: WorkUnit): Promise<void>
    // 被 Trigger 调用 → canClaim → tryClaim

  async scanForWork(): Promise<void>
    // 查询 unassigned + type 匹配 → tryClaim（一次一个）

  private canClaim(workUnit: WorkUnit): boolean
    // !processing + type in acceptedTypes + status === 'unassigned'

  private async tryClaim(workUnit: WorkUnit): Promise<void>
    // claim() → loadSkills() → executeWithSkills() → submitForReview()
    // catch → recordFailure() → unclaim()

  private async loadSkills(workUnit: WorkUnit): Promise<SkillDefinition[]>
    // skillLoader.listAll() → 语义匹配 → skillLoader.loadSingle()

  private async executeWithSkills(workUnit: WorkUnit, skills: SkillDefinition[]): Promise<void>
    // 构建 prompt → agentExecutor.execute({ prompt, timeout })
    // 结果 → postToDiscussionSpace()

  private async submitForReview(workUnitId: string): Promise<void>
    // workUnitService.updateStatus(workUnitId, 'in_review')

  private async recordFailure(workUnitId: string, error: Error): Promise<void>
    // workUnitService.updateStatus(workUnitId, 'unassigned') + metadata.failureLog

  private async unclaim(workUnitId: string, reason: string): Promise<void>
    // workUnitService.unclaim(workUnitId)

  private async postToDiscussionSpace(workUnitId: string, result: { summary: string }): Promise<void>
    // 发送执行结果到 WorkUnit 讨论空间
    // eventBus.publish('channel.message.created', { workUnitId, content: result.summary, authorType: 'agent' })
}
```

**Call Chain**
```
AgentLoop.start()
  → createInstance() → RuntimeInstance(idle)
  → registerAgentTriggers()
    → registry.registerTrigger({ condition: EVENT 'workunit.created', action: EXECUTE 'agent-loop' })
  → scanForWork()

EventBus 'workunit.created' → TriggerScheduler → AgentLoop.onNewWorkUnit(workUnit)
  → canClaim(workUnit) — check: !processing, type match, status=unassigned
  → tryClaim(workUnit)
    → workUnitService.claim(id, instance.id) — 乐观锁
    → loadSkills(workUnit)
      → skillLoader.listAll() → filter by scope/description
      → skillLoader.loadSingle(name) → full prompt
    → executeWithSkills(workUnit, skills)
      → agentExecutor.execute({ prompt, timeout })
      → postToDiscussionSpace(workUnit.id, result)
    → submitForReview(workUnitId)
      → workUnitService.updateStatus(id, 'in_review')
```

---

### AC-4: 默认 Trigger 注册

#### 实现指南

新建 `default-triggers.ts`，定义 4 个 Trigger 配置 + `registerDefaultTriggers()` 函数。在 API server 启动时调用。

#### Architecture Context

**Functions**
```typescript
function registerDefaultTriggers(
  registry: TriggerScheduler,
  agentLoop: AgentLoop,
): void

// 4 个默认 Trigger:
// 1. agent-discover: EVENT workunit.created → EXECUTE agent-loop
// 2. workunit-timeout: SCHEDULE */5 * * * * → UPDATE workunit (超时释放)
// 3. dependency-unlock: EVENT workunit.done → UPDATE workunit (依赖解锁)
// 4. poll-fallback: SCHEDULE */30 * * * * → EXECUTE agent-scan-workunits
```

**Danger Zones**
- agentLoop.onNewWorkUnit 需在 registerExecuteHandler 中注册 — 时序问题
- dependency-unlock 的 UPDATE query 需要 `contains` 操作符 — Prisma JSON 字段查询

---

### AC-5: Scheduler 退化

#### 实现指南

从 scheduler-integration.ts 提取两个函数到 stale-recovery.ts。标 @deprecated。Trigger 调用提取的函数。

#### Architecture Context

**Functions**
```typescript
// stale-recovery.ts — 新建
async function recoverStaleWorkUnits(): Promise<number>
  // prisma.workUnit.updateMany where status=active + timeoutAt < now
  // 返回释放数量

async function recoverOrphanedExecutions(): Promise<number>
  // 检查 worktree/.progress.json
  // 重新排队或标记失败
```

**Danger Zones**
- Scheduler.tick() 中的超时检查和提取的函数可能并发 — idempotent 设计
- recoverOrphanedExecutions 读文件系统 — 需处理 worktree 不存在场景

---

### AC-6: 端到端验证

#### 实现指南

集成测试。mock agentExecutor.execute() 返回成功/失败，验证 WorkUnit 状态流转。

---

## Code Dependency Graph

```
schema.prisma (RuntimeInstance)
    ↓
agent-instance.service.ts (CRUD)
    ↓
agent-instance.routes.ts (REST API)
    ↑
routes.ts (注册)

trigger.types.ts (类型扩展)
    ↓
trigger-action.ts (新增 EXECUTE/UPDATE)
    ↓
trigger-scheduler.ts (EVENT 支持 + handler registry)
    ↑
agent-loop.ts (注册 Trigger + claim/execute)
    ↓
    ├── workunit.service.ts (claim/unclaim)
    ├── skill-loader.ts (listAll/loadSingle)
    ├── agent-executor.ts (execute)
    └── event-bus.ts (subscribe)

default-triggers.ts (4 个默认 Trigger)
    ↑
agent-loop.ts (registerDefaultTriggers)

scheduler-integration.ts (@deprecated)
    ↓
stale-recovery.ts (提取 GC 函数)
    ↑
trigger-scheduler.ts (超时 Trigger 调用)
```

## Parallel vs Sequential

| 文件 | 依赖 | 可并行？ |
|------|------|---------|
| schema.prisma | 无 | 是 (P1) |
| agent-instance.service.ts | schema | 否 (P1 后) |
| agent-instance.routes.ts | service | 否 |
| trigger.types.ts | 无 | 是 (P1，与 schema 并行) |
| trigger-action.ts | trigger.types | 否 (P1 后) |
| trigger-scheduler.ts | trigger.types + trigger-action + event-bus | 否 |
| agent-loop.ts | 所有以上 | 否 (最后) |
| default-triggers.ts | agent-loop + trigger-scheduler | 否 |
| stale-recovery.ts | 无 (提取) | 是 (与 P1 并行) |

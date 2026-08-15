---
status: "done"
version: "1.0"
specId: AS-026
created: 2026-06-24
---

# Agent Persistence MVP — Task

## Contract Tests

### T1: RuntimeInstance CRUD (AC-1)

**文件**: `apps/api/src/modules/agents/__tests__/agent-instance.test.ts`

```typescript
describe('RuntimeInstance CRUD', () => {
  it('creates instance with roleId and returns idle status')
  it('lists instances filtered by status')
  it('gets instance by id')
  it('updates instance status from idle to active')
  it('updates instance currentWorkUnitId')
  it('returns 400 for invalid roleId')
  it('returns 400 for invalid status value')
})
```

### T2: Trigger EVENT 条件 (AC-2)

**文件**: `apps/api/src/modules/triggers/__tests__/trigger-event.test.ts`

```typescript
describe('Trigger EVENT condition', () => {
  it('registers EVENT trigger and subscribes to EventBus')
  it('fires EVENT trigger when matching event published')
  it('does not fire EVENT trigger for non-matching event')
  it('respects enabled=false on EVENT trigger')
  it('unregisters EVENT trigger and unsubscribes from EventBus')
})
```

### T3: Trigger EXECUTE 动作 (AC-2)

**文件**: `apps/api/src/modules/triggers/__tests__/trigger-execute.test.ts`

```typescript
describe('Trigger EXECUTE action', () => {
  it('registers execute handler and calls it on EXECUTE action')
  it('warns and skips when handler not registered')
  it('passes context to handler function')
  it('logs error when handler throws')
})
```

### T4: Trigger UPDATE 动作 (AC-2)

**文件**: `apps/api/src/modules/triggers/__tests__/trigger-update.test.ts`

```typescript
describe('Trigger UPDATE action', () => {
  it('executes prisma update with static query/update')
  it('resolves $event.xxx template variables in query')
  it('resolves $event.xxx template variables in update')
  it('skips fields where $event variable not in payload')
})
```

### T5: AgentLoop 核心 (AC-3)

**文件**: `apps/api/src/modules/agents/__tests__/agent-loop.test.ts`

```typescript
describe('AgentLoop', () => {
  describe('start()', () => {
    it('creates RuntimeInstance with idle status')
    it('registers EVENT trigger for workunit.created')
    it('calls scanForWork on startup')
  })

  describe('canClaim()', () => {
    it('returns true when idle + type matches + status=unassigned')
    it('returns false when processing=true')
    it('returns false when type not in acceptedTypes')
    it('returns false when status !== unassigned')
  })

  describe('onNewWorkUnit()', () => {
    it('calls tryClaim when canClaim returns true')
    it('skips when canClaim returns false')
    it('skips when already processing')
  })

  describe('tryClaim()', () => {
    it('claims WorkUnit → loads skills → executes → submits for review')
    it('handles 409 claim conflict gracefully (skip)')
    it('on execution failure: records failure + unclaims')
    it('on skill load failure: degrades to no-skill execution')
  })

  describe('loadSkills()', () => {
    it('loads skills matching WorkUnit scope via description')
    it('returns empty array when no skills match')
    it('calls skillLoader.loadSingle for each matched skill')
  })

  describe('executeWithSkills()', () => {
    it('builds prompt with skill content + scope + knowledge')
    it('calls agentExecutor.execute with constructed prompt')
    it('posts result to discussion space')
    it('throws on agentExecutor failure')
  })
})
```

### T6: 默认 Trigger 注册 (AC-4)

**文件**: `apps/api/src/modules/agents/__tests__/default-triggers.test.ts`

```typescript
describe('Default Triggers', () => {
  it('registers 4 default triggers')
  it('agent-discover fires on workunit.created')
  it('workunit-timeout fires every 5 minutes')
  it('dependency-unlock fires on workunit.done with $event.id template')
  it('poll-fallback fires every 30 seconds')
  it('does not register stale-recovery handler (workunit-timeout is UPDATE, not EXECUTE)')
})
```

### T9: default-triggers 3 Bug 修复 (AC-4)

**文件**: `apps/api/src/modules/agents/default-triggers.ts`, `apps/api/src/modules/agents/agent-loop.ts`

```typescript
describe('Bug fixes', () => {
  // Bug 1: poll-fallback handler 未注册
  // → agent-loop.ts start() 注册 agent-scan-workunits handler
  // → stop() 注销

  // Bug 2: dependency-unlock 查询条件错误
  // → dependsOn: { contains: '' } → { contains: '$event.id' }

  // Bug 3: stale-recovery handler 是死代码
  // → 删除 registerExecuteHandler('stale-recovery', ...) 和未使用的 import
})
```

### T10: AgentLoop WorkUnitService 集成 + success 检查 (AC-3)

**文件**: `apps/api/src/modules/agents/agent-loop.ts`, `apps/api/src/modules/agents/__tests__/agent-loop.test.ts`

```typescript
describe('WorkUnitService integration', () => {
  // Issue #3: AgentLoop 绕过 WorkUnitService
  // → tryClaim() 改用 workUnitService.claim() + transitionStatus()
  // → 事件正确发射（workunit.claimed, workunit.status_changed）

  // Issue #4: ExecutionResult.success 被忽略
  // → execute() 返回 ExecutionResult
  // → success=false 时 unclaim 而非 in_review

  // TriggerScheduler null store 守卫
  // → start() 加 if(this.store) 防止 null.store 崩溃
  // → index.ts 加 registry.start() 启动 tick interval
})
```

**测试**: 18 tests, agent-loop.test.ts (18/18 GREEN)

### T11: TriggerScheduler 双实例合并 (singleton)

**文件**: `apps/api/src/modules/triggers/trigger-registry.ts` (新建), `trigger.routes.ts`, `route-registry.ts`, `index.ts`

```typescript
describe('TriggerScheduler singleton', () => {
  // trigger-registry.ts — singleton factory getTriggerScheduler(store?)
  // trigger.routes.ts — 改用 singleton + 注入 store
  // route-registry.ts — 接入 trigger routes（之前死代码）
  // index.ts — getTriggerScheduler() 获取同一实例
  // Import 顺序：registerRoutes → trigger.routes → singleton(store) → index.ts → 同一实例
})
```

**测试**: 30 tests GREEN (agent-loop 18 + default-triggers 7 + trigger-scheduler 5)

### T7: Scheduler 退化 (AC-5)

**文件**: `apps/api/src/modules/goals/__tests__/stale-recovery.test.ts`

```typescript
describe('Stale Recovery', () => {
  it('recoverStaleWorkUnits releases timed-out claims')
  it('recoverStaleWorkUnits returns count of released')
  it('recoverStaleWorkUnits is idempotent')
  it('recoverOrphanedExecutions handles missing worktree')
})
```

### T8: 端到端 (AC-6)

**文件**: `apps/api/src/modules/agents/__tests__/agent-loop-e2e.test.ts`

```typescript
describe('AgentLoop E2E', () => {
  it('creates WorkUnit → auto claim → execute → in_review')
  it('multiple WorkUnits → different agents claim (no duplicate)')
  it('agent failure → unclaim → other agent can claim')
  it('review pass → WorkUnit status = done')
})
```

---

## Execution Order

```
Phase 1 (并行):
  ├── P1a: schema.prisma — RuntimeInstance 模型
  ├── P1b: trigger.types.ts — 类型扩展
  └── P1c: stale-recovery.ts — 提取 GC 函数

Phase 2 (串行，依赖 P1):
  ├── P2a: agent-instance.service.ts + routes.ts — CRUD (依赖 P1a)
  ├── P2b: trigger-action.ts — EXECUTE + UPDATE (依赖 P1b)
  └── P2c: trigger-scheduler.ts — EVENT 支持 (依赖 P1b)

Phase 3 (串行，依赖 P2):
  └── P3: agent-loop.ts — AgentLoop 核心 (依赖 P2a + P2b + P2c)

Phase 4 (串行，依赖 P3):
  ├── P4a: default-triggers.ts — 4 个默认 Trigger (依赖 P3)
  └── P4b: scheduler-integration.ts — @deprecated + 调用 stale-recovery (依赖 P1c)

Phase 5 (验证):
  └── P5: 所有测试 + 端到端验证
```

**依赖分析**:
- P1a/P1b/P1c 无互相依赖 → 并行
- P2a 依赖 P1a（schema），P2b/P2c 依赖 P1b（types）→ P2a 与 P2b/P2c 可并行
- P3 依赖所有 P2 → 必须等 P2 完成
- P4a 依赖 P3，P4b 依赖 P1c → P4a 和 P4b 可并行
- P5 依赖所有 → 最后

**总计**: 5 Phase，关键路径 P1b → P2c → P3 → P4a → P5

---

## Milestones

| # | Milestone | 验证 | AC |
|---|-----------|------|-----|
| M1 | RuntimeInstance 表 + CRUD | prisma migrate + API 测试通过 | AC-1 |
| M2 | Trigger 扩展（EVENT+EXECUTE+UPDATE）| 单元测试 100% 通过 | AC-2 |
| M3 | AgentLoop 核心 | 单元测试 100% 通过 | AC-3 |
| M4 | 默认 Trigger + Scheduler 退化 | 集成测试通过 | AC-4, AC-5 |
| M5 | 端到端 | E2E 测试通过 | AC-6 |

---

## Test Files Summary

| 测试文件 | AC | 测试数 |
|---------|-----|--------|
| `__tests__/agent-instance.test.ts` | AC-1 | 7 |
| `__tests__/trigger-event.test.ts` | AC-2 | 5 |
| `__tests__/trigger-execute.test.ts` | AC-2 | 4 |
| `__tests__/trigger-update.test.ts` | AC-2 | 4 |
| `__tests__/agent-loop.test.ts` | AC-3 | 21 |
| `__tests__/default-triggers.test.ts` | AC-4 | 7 |
| `__tests__/stale-recovery.test.ts` | AC-5 | 4 |
| `__tests__/agent-loop-e2e.test.ts` | AC-6 | 4 |
| **总计** | | **57** |

---
id: "cwyr2787t59mr372fyz"
slug: "agent-network-loop-rewrite"
title: "Agent Network Agent Loop 重写"
status: "done"
version: 1
---

## 执行顺序

```
Phase 1 (并行):
  ac-agent-runner-home    ← 独立，零破坏性
  ac-metadata-types       ← 独立，纯类型扩展

Phase 2 (串行，核心变更):
  ac-agent-loop-rewrite   ← 重写 agent-loop.ts

Phase 3 (并行，清理):
  ac-eventbus-cleanup     ← 依赖 Phase 2（新 agent-loop 不再 import workunit-events）
  ac-channel-cleanup      ← 依赖 Phase 2（新 agent-loop 不再 publish event）
  ac-trigger-cleanup      ← 依赖 Phase 2（新 agent-loop 不再注册 EVENT handler）

Phase 4 (串行):
  ac-dependson-cleanup    ← 依赖 Phase 3 ac-eventbus-cleanup（unlockDependents 已删）

Phase 5 (最后):
  ac-tests                ← 依赖所有 Phase 2-4
```

## 里程碑

| 里程碑 | 完成条件 | 涉及 AC |
|--------|---------|---------|
| M1: 基础设施就绪 | HOME 路径改好 + metadata 类型定义好 | ac-agent-runner-home, ac-metadata-types |
| M2: 新 Loop 运行 | agent-loop.ts 重写完成，tsc 通过 | ac-agent-loop-rewrite |
| M3: 旧代码清除 | EventBus/trigger/channel 清理完毕，tsc 通过，grep 零引用 | ac-eventbus-cleanup, ac-channel-cleanup, ac-trigger-cleanup |
| M4: Schema 迁移 | dependsOn 列删除，migration 成功，数据不丢失 | ac-dependson-cleanup |
| M5: 测试覆盖 | 所有测试通过，覆盖率 ≥ 80% | ac-tests |

---

## ac-agent-runner-home

**Contract Tests**

#### `packages/studio-agent/src/__tests__/agent-runner-home.test.ts`
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('agent-runner HOME path', () => {
  it('uses /tmp/agent-loop/${workUnitId} when workUnitId provided', async () => {
    // Arrange
    const task = {
      id: 'task-1',
      executionId: 'exec-1',
      agentType: 'claude' as const,
      prompt: 'test',
      parameters: { workUnitId: 'wu-123' },
    };

    // Act: call buildSpawnEnv or executeLightweight and capture HOME
    // Assert: HOME === '/tmp/agent-loop/wu-123'
    // Assert: env contains STUDIO_WORKUNIT_ID = 'wu-123'
  });

  it('falls back to /tmp/agent-loop/${executionId} when no workUnitId', async () => {
    const task = {
      id: 'task-1',
      executionId: 'exec-1',
      agentType: 'claude' as const,
      prompt: 'test',
      parameters: {},
    };

    // Assert: HOME === '/tmp/agent-loop/exec-1'
    // Assert: env does NOT contain STUDIO_WORKUNIT_ID
  });
});
```

**Test Files**
- `packages/studio-agent/src/__tests__/agent-runner.test.ts`（现有，需验证 HOME 相关用例）

---

## ac-metadata-types

**Contract Tests**

#### `apps/api/src/modules/workunit/__tests__/metadata-types.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import type { WorkUnitMetadata } from '../workunit.service';

describe('WorkUnitMetadata', () => {
  it('accepts sessionId field', () => {
    const meta: WorkUnitMetadata = { sessionId: 'sess-123' };
    expect(meta.sessionId).toBe('sess-123');
  });

  it('accepts all new Agent Loop fields', () => {
    const meta: WorkUnitMetadata = {
      sessionId: 'sess-123',
      stepCount: 5,
      startedAt: '2026-07-02T10:00:00Z',
      consecutiveStuck: 0,
      sessionResumes: 2,
    };
    expect(meta.stepCount).toBe(5);
    expect(meta.consecutiveStuck).toBe(0);
    expect(meta.sessionResumes).toBe(2);
  });

  it('all new fields are optional', () => {
    const meta: WorkUnitMetadata = {};
    expect(meta.sessionId).toBeUndefined();
    expect(meta.stepCount).toBeUndefined();
  });
});
```

**Test Files**
- `apps/api/src/modules/workunit/__tests__/workunit-schema.test.ts`（现有）

---

## ac-agent-loop-rewrite

**Contract Tests**

#### `apps/api/src/modules/agents/__tests__/agent-loop-v2.test.ts`
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    workUnit: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    channelMessage: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: vi.fn() },
}));

describe('observe()', () => {
  it('queries myActive with status in [active, blocked]', async () => {
    // Setup: prisma.workUnit.findMany mock returns active + blocked WUs
    // Assert: findMany called with where: { assigneeId, status: { in: ['active', 'blocked'] } }
  });

  it('queries unassigned with channel + type filtering, ordered by createdAt asc', async () => {
    // Assert: findMany called with where: { status: 'unassigned', channelId: { in: [...] }, type: { in: [...] } }
    // Assert: orderBy: { createdAt: 'asc' }, take: 5
  });

  it('queries newReplies: human messages with createdAt > WorkUnit.updatedAt', async () => {
    // Setup: myActive has 2 WUs
    // Assert: channelMessage.findMany called with where: { workUnitId, authorType: 'human', createdAt: { gt: wu.updatedAt } }
  });
});

describe('resolveTarget()', () => {
  it('priority 1: returns WorkUnit with human reply (including blocked)', () => {
    const obs = {
      myActive: [{ id: 'wu-1', status: 'blocked', updatedAt: new Date() }],
      unassigned: [],
      newReplies: [{ id: 'msg-1', workUnitId: 'wu-1', content: 'feedback', authorType: 'human' }],
    };
    // Assert: returns { workUnit: wu-1, newReplies: [msg-1] }
  });

  it('priority 2: returns active WorkUnit when no replies', () => {
    const obs = {
      myActive: [{ id: 'wu-1', status: 'active', updatedAt: new Date() }],
      unassigned: [],
      newReplies: [],
    };
    // Assert: returns { workUnit: wu-1 }
  });

  it('priority 3: returns earliest unassigned WorkUnit when idle', () => {
    const obs = {
      myActive: [],
      unassigned: [
        { id: 'wu-2', status: 'unassigned', createdAt: new Date('2026-07-02T11:00:00Z') },
        { id: 'wu-1', status: 'unassigned', createdAt: new Date('2026-07-02T10:00:00Z') },
      ],
      newReplies: [],
    };
    // Assert: returns { workUnit: wu-1 } (earliest createdAt, already sorted by asc)
  });

  it('returns null when no target available', () => {
    const obs = { myActive: [], unassigned: [], newReplies: [] };
    // Assert: returns null
  });
});

describe('parseAgentOutput()', () => {
  it('parses ACTION: PROGRESS:summary', () => {
    // Input: 'some output\nACTION: PROGRESS:completed step 1'
    // Assert: { action: 'progress', summary: 'completed step 1' }
  });

  it('parses ACTION: COMPLETE:summary', () => {
    // Input: 'ACTION: COMPLETE:all done'
    // Assert: { action: 'complete', summary: 'all done' }
  });

  it('parses ACTION: NEED_INPUT:question', () => {
    // Input: 'ACTION: NEED_INPUT:need clarification on API design'
    // Assert: { action: 'need_input', summary: 'need clarification on API design' }
  });

  it('falls back to progress when no ACTION pattern found', () => {
    // Input: 'just some text without action protocol'
    // Assert: { action: 'progress', summary: rawText }
  });

  it('handles empty input gracefully', () => {
    // Input: ''
    // Assert: { action: 'progress', summary: '' }
  });
});

describe('dynamicInterval()', () => {
  it('returns 3000 for progress', () => {
    // Assert: dynamicInterval({ action: 'progress', summary: '' }) === 3000
  });

  it('returns 10000 for complete', () => {
    // Assert: dynamicInterval({ action: 'complete', summary: '' }) === 10000
  });

  it('returns 30000 for need_input', () => {
    // Assert: dynamicInterval({ action: 'need_input', summary: '' }) === 30000
  });

  it('returns 15000 for default', () => {
    // Assert: dynamicInterval({ action: null as any, summary: '' }) === 15000
  });
});
```

**Test Files**
- `apps/api/src/modules/agents/__tests__/agent-loop.test.ts`（现有，需大幅更新）
- `apps/api/src/modules/agents/__tests__/agent-loop-e2e.test.ts`（现有，需适配新结构）

---

## ac-eventbus-cleanup

**Contract Tests**

#### `apps/api/src/modules/workunit/__tests__/eventbus-cleanup.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

describe('EventBus cleanup verification', () => {
  it('workunit-events.ts is deleted', () => {
    expect(existsSync('src/modules/workunit/workunit-events.ts')).toBe(false);
  });

  it('cycle-detection.ts is deleted', () => {
    expect(existsSync('src/modules/workunit/cycle-detection.ts')).toBe(false);
  });

  it('no imports of workunit-events in workunit.service.ts', () => {
    const content = execSync('grep -r "workunit-events" src/modules/workunit/ || true').toString();
    expect(content.trim()).toBe('');
  });

  it('no imports of cycle-detection in workunit.service.ts', () => {
    const content = execSync('grep -r "cycle-detection" src/modules/workunit/ || true').toString();
    expect(content.trim()).toBe('');
  });

  it('no emit function calls in workunit.service.ts', () => {
    const content = execSync('grep -E "emit(WorkUnit|workunit)" src/modules/workunit/workunit.service.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('unlockDependents method is removed', () => {
    const content = execSync('grep "unlockDependents" src/modules/workunit/workunit.service.ts || true').toString();
    expect(content.trim()).toBe('');
  });
});
```

**Test Files**
- `apps/api/src/modules/workunit/__tests__/workunit.service.test.ts`（需更新，删除 emit mock）

---

## ac-channel-cleanup

**Contract Tests**

#### `apps/api/src/modules/channels/__tests__/channel-cleanup.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

describe('Channel message events cleanup verification', () => {
  it('channel-message.events.ts is deleted', () => {
    expect(existsSync('src/modules/channels/channel-message.events.ts')).toBe(false);
  });

  it('no imports of channel-message.events in project', () => {
    const content = execSync('grep -r "channel-message.events" src/ || true').toString();
    expect(content.trim()).toBe('');
  });

  it('no eventBus.publish channel.message.created in project', () => {
    const content = execSync("grep -r \"channel.message.created\" src/ || true").toString();
    expect(content.trim()).toBe('');
  });
});
```

**Test Files**
- `apps/api/src/modules/channels/__tests__/channel-message.service.test.ts`（现有，需验证不受影响）

---

## ac-dependson-cleanup

**Contract Tests**

#### `apps/api/src/modules/workunit/__tests__/dependsOn-cleanup.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

describe('dependsOn cleanup verification', () => {
  it('schema.prisma has no dependsOn field in WorkUnit model', () => {
    const content = execSync('grep "dependsOn" prisma/schema.prisma || true').toString();
    expect(content.trim()).toBe('');
  });

  it('workunit.service.ts CreateWorkUnitInput has no dependsOn', () => {
    const content = execSync('grep "dependsOn" src/modules/workunit/workunit.service.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('workunit.routes.ts has no dependsOn parameter handling', () => {
    const content = execSync('grep "dependsOn" src/modules/workunit/workunit.routes.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('Prisma migration executes without error', () => {
    // This is a runtime check, verified during implementation
    // npx prisma migrate dev --name remove-depends-on
    // assert: exit code 0, no data loss
  });
});
```

**Test Files**
- `apps/api/src/modules/workunit/__tests__/workunit-schema.test.ts`（需更新）
- `apps/api/src/modules/workunit/__tests__/workunit.routes.test.ts`（需更新）

---

## ac-trigger-cleanup

**Contract Tests**

#### `apps/api/src/modules/triggers/__tests__/trigger-cleanup.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

describe('Trigger cleanup verification', () => {
  it('default triggers count is 6 (not 9)', () => {
    // Import getDefaultTriggerConfigs and check length === 6
  });

  it('agent-discover trigger is removed', () => {
    const content = execSync('grep "agent-discover" src/modules/agents/default-triggers.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('dependency-unlock trigger is removed', () => {
    const content = execSync('grep "dependency-unlock" src/modules/agents/default-triggers.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('poll-fallback trigger is removed', () => {
    const content = execSync('grep "poll-fallback" src/modules/agents/default-triggers.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('EVENT condition type is removed from TriggerCondition', () => {
    const content = execSync('grep "EVENT" src/modules/triggers/trigger.types.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('subscribeEvent method is removed from TriggerScheduler', () => {
    const content = execSync('grep "subscribeEvent" src/modules/triggers/trigger-scheduler.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('resolveTemplate function is removed from trigger-action', () => {
    const content = execSync('grep "resolveTemplate" src/modules/triggers/trigger-action.ts || true').toString();
    expect(content.trim()).toBe('');
  });

  it('retained triggers are intact', () => {
    // workunit-timeout, agent-timeout, knowledge-quality-audit,
    // session-knowledge-extraction, zero-consumption-audit, knowledge-synthesis
    // Assert: all 6 present in getDefaultTriggerConfigs()
  });
});
```

**Test Files**
- `apps/api/src/modules/agents/__tests__/default-triggers.test.ts`（需更新）
- `apps/api/src/modules/triggers/__tests__/trigger-scheduler.test.ts`（需更新）
- `apps/api/src/modules/triggers/__tests__/trigger-action.test.ts`（需更新）
- `apps/api/src/modules/triggers/__tests__/trigger-store.test.ts`（需更新）

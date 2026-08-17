---
id: "an-phase2-mvp2-6"
slug: "agent-network-phase2-mps2-6"
title: "Agent Network Phase 2 — MVP-2~6"
status: "done"
tier: standard
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["agent-network", "ui", "monitoring", "dogfood"]
createdAt: "2026-06-25T00:00:00Z"
updatedAt: "2026-06-25T00:00:00Z"
---

## 执行顺序

```
Phase 1 (并行):
  ├─ MVP-3: Review UI (纯前端，无后端依赖)
  └─ MVP-4: Discussion Space (EventBus fix + UI)

Phase 2:
  └─ MVP-2: AgentDashboard (新 API + UI)

Phase 3:
  └─ MVP-5: Agent 超时释放 (依赖 MVP-2 AgentDashboard)

Phase 4:
  └─ MVP-6: Monitoring Dashboard (依赖 MVP-2 monitoring 模块)
```

---

### MVP-3: Review UI

**Contract Tests**

#### apps/web/src/stores/__tests__/workunitStore.test.ts
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('workunitStore reviewRejected', () => {
  it('should pass reason to API when rejecting', async () => {
    const mockApi = { reviewRejected: vi.fn().mockResolvedValue({ data: {} }) };
    // verify reason parameter is forwarded
    await mockApi.reviewRejected('wu-1', '质量不达标');
    expect(mockApi.reviewRejected).toHaveBeenCalledWith('wu-1', '质量不达标');
  });

  it('should work without reason', async () => {
    const mockApi = { reviewRejected: vi.fn().mockResolvedValue({ data: {} }) };
    await mockApi.reviewRejected('wu-1');
    expect(mockApi.reviewRejected).toHaveBeenCalledWith('wu-1');
  });
});
```

**Test Files**
- apps/web/src/stores/__tests__/workunitStore.test.ts (新建或扩展)

---

### MVP-4: Discussion Space

**Contract Tests**

#### apps/api/src/modules/channels/__tests__/channel-message.events.test.ts
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('channel.message.created subscriber', () => {
  it('should write message to DB when event fires', async () => {
    const mockService = {
      createAgentMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      createHumanMessage: vi.fn().mockResolvedValue({ id: 'msg-2' }),
    };
    // Simulate event payload
    const payload = {
      workUnitId: 'wu-1',
      content: 'Agent output text',
      authorType: 'agent',
      authorId: 'instance-1',
    };
    // Verify service method called with correct params
    await mockService.createAgentMessage(undefined, 'agent', payload.content, { workUnitId: payload.workUnitId });
    expect(mockService.createAgentMessage).toHaveBeenCalled();
  });

  it('should ignore events without workUnitId', async () => {
    const payload = { content: 'no workunit', authorType: 'agent' };
    expect(payload.workUnitId).toBeUndefined();
    // subscriber should skip
  });

  it('should resolve channelId from WorkUnit', async () => {
    // given workUnitId → lookup WorkUnit.channelId
    // if WorkUnit has channelId → use it
    // if WorkUnit has no channelId → fallback to type='rnd' channel
  });
});
```

#### apps/web/src/components/__tests__/DiscussionPanel.test.tsx
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('DiscussionPanel', () => {
  it('should render message list', () => {
    // verify messages displayed with authorType badges
  });

  it('should call postMessage on submit', () => {
    // verify POST /workunits/:id/messages called
  });

  it('should refresh list after posting', () => {
    // verify getMessages called again after post
  });
});
```

**Test Files**
- apps/api/src/modules/channels/__tests__/channel-message.events.test.ts (新建)
- apps/web/src/components/__tests__/DiscussionPanel.test.tsx (新建)

---

### MVP-2: AgentDashboard

**Contract Tests**

#### apps/api/src/modules/monitoring/__tests__/monitoring.service.test.ts
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MonitoringService.getAgentSummary', () => {
  it('should return agents with status and currentWorkUnitId', async () => {
    // verify response structure: { agents: [...], summary: { total, idle, active, terminated } }
  });

  it('should aggregate counts correctly', async () => {
    // given 3 idle + 2 active + 1 terminated → summary matches
  });

  it('should return empty agents when none exist', async () => {
    // verify { agents: [], summary: { total: 0, idle: 0, active: 0, terminated: 0 } }
  });
});
```

#### apps/api/src/modules/monitoring/__tests__/monitoring.routes.test.ts
```typescript
import { describe, it, expect } from 'vitest';

describe('GET /api/v1/monitoring/agents', () => {
  it('should return 200 with agent list', async () => {
    // verify HTTP 200 + response shape
  });
});
```

**Test Files**
- apps/api/src/modules/monitoring/__tests__/monitoring.service.test.ts (新建)
- apps/api/src/modules/monitoring/__tests__/monitoring.routes.test.ts (新建)

---

### MVP-5: Agent 超时释放

**Contract Tests**

#### apps/api/src/modules/agents/__tests__/agent-instance.service.test.ts
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('AgentInstanceService.terminate', () => {
  it('should set status to terminated', async () => {
    // verify prisma.update called with status: 'terminated', terminatedAt: expect.any(Date)
  });

  it('should unclaim current WorkUnit when currentWorkUnitId exists', async () => {
    // verify WorkUnit update sets assigneeId: null, status: 'unassigned'
  });

  it('should not fail when currentWorkUnitId is null', async () => {
    // verify no WorkUnit update attempted
  });

  it('should throw when instance not found', async () => {
    // verify throws error
  });
});
```

#### apps/api/src/modules/agents/__tests__/agent-loop.test.ts (扩展)
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('AgentLoop heartbeat', () => {
  it('should update lastHeartbeat on scanForWork', async () => {
    // verify prisma.runtimeInstance.update called with lastHeartbeat
  });
});
```

#### apps/api/src/modules/agents/__tests__/agent-instance.routes.test.ts
```typescript
import { describe, it, expect } from 'vitest';

describe('POST /agent-instances/:id/terminate', () => {
  it('should return 200 and terminated instance', async () => {
    // verify HTTP 200 + status: 'terminated'
  });

  it('should return 404 when instance not found', async () => {
    // verify HTTP 404
  });
});
```

**Test Files**
- apps/api/src/modules/agents/__tests__/agent-instance.service.test.ts (新建或扩展)
- apps/api/src/modules/agents/__tests__/agent-loop.test.ts (扩展)
- apps/api/src/modules/agents/__tests__/agent-instance.routes.test.ts (新建或扩展)

---

### MVP-6: Monitoring Dashboard

**Contract Tests**

#### apps/api/src/modules/monitoring/__tests__/monitoring.service.test.ts (扩展)
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MonitoringService.getStats', () => {
  it('should return workunit counts by status', async () => {
    // verify { workunits: { total, unassigned, active, in_review, done, blocked, closed } }
  });

  it('should return agent counts by status', async () => {
    // verify { agents: { total, idle, active, terminated } }
  });

  it('should return recent stats', async () => {
    // verify { recent: { completedLast24h, failedLast24h } }
  });
});
```

**Test Files**
- apps/api/src/modules/monitoring/__tests__/monitoring.service.test.ts (扩展)

---

## 依赖图

```
MVP-3 ──────────────────┐
                        ├─→ MVP-2 ──→ MVP-5
MVP-4 ──────────────────┘        └─→ MVP-6
```

MVP-3 和 MVP-4 无依赖，可并行。MVP-2 依赖 monitoring 模块建立。MVP-5 依赖 MVP-2 的 AgentDashboard 页面。MVP-6 依赖 MVP-2 的 monitoring 模块。

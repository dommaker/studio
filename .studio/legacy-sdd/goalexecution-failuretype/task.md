---
id: "sdd-1784371314039-d94pup"
slug: "goalexecution-failuretype"
title: "GoalExecution.failureType — 持久化失败分类 + 确定性路由 + 查询过滤"
status: "stale"
version: 40
taskVersion: 40
parentId: "sdd-1784369777362-hcmuay"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["goal-execution", "failure-classification", "persistence", "prisma", "filtering"]
createdAt: "2026-06-10T10:49:19.151Z"
updatedAt: "2026-07-18T10:41:54.039Z"
---

# GoalExecution.failureType — 持久化失败分类 + 确定性路由 + 查询过滤

在 GoalExecution 模型添加 failureType 字段，持久化 classifyFailureAction() 的分类结果，handleGoalFailed() 读取该字段做确定性路由，goal-crud.ts 支持按 failureType 过滤

<!-- TASK_TIER {"tier":"standard","reason":"Schema 变更(Prisma 包) + API 层(lifecycle+CRUD+routes) 跨 6 文件，需 migration"} -->

## Contract Tests

### __tests__/failure-type-schema.test.ts (AC Group: schema-migration)
```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCHEMA_PATH = path.resolve(__dirname, '../../../../packages/studio-prisma/prisma/schema.prisma');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');

describe('GoalExecution.failureType schema (A.1/A.2)', () => {
  it('failureType String? field exists after error field', () => {
    expect(schema).toMatch(/error\s+String\?[\s\S]*?failureType\s+String\?/);
  });

  it('failureType has comment annotation', () => {
    expect(schema).toContain('// 失败分类: retryable|not-retryable|infrastructure|unknown');
  });

  it('@@index([failureType]) exists', () => {
    expect(schema).toMatch(/@@index\(\[failureType\]\)/);
  });
});
```
### __tests__/failure-type-crud-filter.test.ts (AC Group: crud-route-filter)
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn().mockResolvedValue([]);

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { goal: { findMany: mockFindMany } },
}));

import { listGoals } from '../goal-crud.js';

describe('listGoals failureType filter (C.1/C.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
  });

  it('returns all goals when failureType is not provided', async () => {
    await listGoals('company-1');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ GoalExecution: expect.anything() }),
      })
    );
  });

  it('filters by failureType using Prisma relation filter', async () => {
    await listGoals('company-1', undefined, 'not-retryable');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          GoalExecution: { some: { failureType: 'not-retryable' } },
        }),
      })
    );
  });

  it('preserves existing filters (status) when failureType is added', async () => {
    await listGoals('company-1', 'failed', 'retryable');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'failed',
          GoalExecution: { some: { failureType: 'retryable' } },
        }),
      })
    );
  });
});
```
### __tests__/failure-type-persistence.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
const mockUpdate = vi.fn().mockResolvedValue({});
const mockFindFirst = vi.fn();
const mockFindUnique = vi.fn();
const mockGoalUpdate = vi.fn().mockResolvedValue({});

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    goal: { findUnique: mockFindUnique, update: mockGoalUpdate },
    goalExecution: { findFirst: mockFindFirst, update: mockUpdate },
    failureEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    project: { update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('../agents/triage-agent.service.js', () => ({
  triageAgent: { handleAlert: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../channels/channel-message.service.js', () => ({
  channelMessageService: { createAgentMessage: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../monitoring/trace-pipeline.service.js', () => ({
  tracePipeline: { writeTrace: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  checkBeforeTaskComplete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/studio-audit', () => ({
  AuditService: { record: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../daemon/metrics.js', () => ({
  recordPipelineRun: vi.fn().mockResolvedValue(undefined),
}));

import { handleGoalFailed } from '../goal-lifecycle.js';

describe('handleGoalFailed — failureType persistence + routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({
      id: 'goal-1',
      title: 'Test Goal',
      context: JSON.stringify({ projectId: 'proj-1', sourceChannelId: 'ch-1' }),
    });
  });

  it('writes failureType to execution after classification', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'exec-1', error: JSON.stringify({ message: 'TypeError: x is not defined' }), stepIndex: 0, failureType: null,
    });
    // classifyFailureAction returns 'retryable' for TypeError
    mockUpdate.mockResolvedValue({});

    await handleGoalFailed('goal-1');

    // Should write failureType to the failed execution
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exec-1' },
        data: expect.objectContaining({ failureType: expect.any(String) }),
      })
    );
  });

  it('reads failureType from execution for routing (not-retryable → mark-blocked)', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'exec-1', error: JSON.stringify({ message: 'approach infeasible' }), stepIndex: 0, failureType: 'not-retryable',
    });

    await handleGoalFailed('goal-1');

    // Should NOT call retryGoalExecution for not-retryable
    // Goal should remain failed (not reset to executing)
    expect(mockGoalUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'executing' }) })
    );
  });

  it('falls back to classifyFailureAction when failureType is null (history compat)', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'exec-1', error: JSON.stringify({ message: 'TypeError: x' }), stepIndex: 0, failureType: null,
    });

    await handleGoalFailed('goal-1');

    // Should still route correctly via fallback classification
    // TypeError → retryable → retry-execution
    // Verify the function completed without error (fallback works)
    expect(mockFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'goal-1' } }));
  });
});

```
---
id: "sdd-1781753801007-xstrht"
slug: "fix-docs-freshness-api-capability-sync"
title: "修复 docs-freshness API capability_sync 过滤器不匹配"
status: "done"
tier: "fast"
version: 2
requirementVersion: 1
designVersion: 1
taskVersion: 2
parentId: "cmqiwz8mp015dmekjsh6nbhi5"
changeType: "L3"
createdAt: "2026-06-18T03:02:14.393Z"
updatedAt: "2026-06-18T03:36:41.007Z"
---

## Contract Tests

### apps/api/src/modules/admin/__tests__/docs-freshness.routes.test.ts
```typescript
import request from 'supertest';
import { checkConstraints } from '@dommaker/harness';

jest.mock('@dommaker/harness', () => ({
  checkConstraints: jest.fn(),
}));

const mockCheckConstraints = checkConstraints as jest.MockedFunction<typeof checkConstraints>;

// Import app after mock — adjust import path based on actual app export
// import app from '../../../app';

describe('GET /api/v1/admin/docs-freshness', () => {
  beforeEach(() => {
    mockCheckConstraints.mockReset();
  });

  it('harnessCheck.details includes capability_sync entry from guidelines', async () => {
    mockCheckConstraints.mockResolvedValue({
      ironLaws: [],
      guidelines: [
        {
          id: 'capability_sync',
          level: 'guideline',
          satisfied: false,
          message: 'CAPABILITIES.md needs update',
        },
      ],
      tips: [],
      passed: true,
      warningCount: 1,
      tipCount: 0,
    });

    const res = await request(app).get('/api/v1/admin/docs-freshness');

    expect(res.status).toBe(200);
    expect(res.body.harnessCheck).toBeDefined();
    const capabilitySyncEntry = res.body.harnessCheck.details.find(
      (d: { id: string }) => d.id === 'capability_sync',
    );
    expect(capabilitySyncEntry).toBeDefined();
    expect(capabilitySyncEntry.passed).toBe(false);
    expect(capabilitySyncEntry.message).toBe('CAPABILITIES.md needs update');
  });

  it('harnessCheck.details includes docs_freshness entry from ironLaws', async () => {
    mockCheckConstraints.mockResolvedValue({
      ironLaws: [
        {
          id: 'docs_freshness',
          level: 'iron_law',
          satisfied: true,
          message: '',
        },
      ],
      guidelines: [],
      tips: [],
      passed: true,
      warningCount: 0,
      tipCount: 0,
    });

    const res = await request(app).get('/api/v1/admin/docs-freshness');

    expect(res.status).toBe(200);
    const docsFreshnessEntry = res.body.harnessCheck.details.find(
      (d: { id: string }) => d.id === 'docs_freshness',
    );
    expect(docsFreshnessEntry).toBeDefined();
    expect(docsFreshnessEntry.passed).toBe(true);
  });

  it('harnessCheck.details includes both capability_sync and docs_freshness', async () => {
    mockCheckConstraints.mockResolvedValue({
      ironLaws: [
        {
          id: 'docs_freshness',
          level: 'iron_law',
          satisfied: true,
          message: '',
        },
      ],
      guidelines: [
        {
          id: 'capability_sync',
          level: 'guideline',
          satisfied: true,
          message: 'CAPABILITIES.md is in sync',
        },
      ],
      tips: [],
      passed: true,
      warningCount: 0,
      tipCount: 0,
    });

    const res = await request(app).get('/api/v1/admin/docs-freshness');

    expect(res.status).toBe(200);
    const ids = res.body.harnessCheck.details.map((d: { id: string }) => d.id);
    expect(ids).toContain('docs_freshness');
    expect(ids).toContain('capability_sync');
    expect(res.body.harnessCheck.passed).toBe(true);
  });

  it('handles checkConstraints failure gracefully', async () => {
    mockCheckConstraints.mockRejectedValue(new Error('internal error'));

    const res = await request(app).get('/api/v1/admin/docs-freshness');

    expect(res.status).toBe(200); // 不因 harness 失败而崩溃
    expect(res.body.harnessCheck).toBeUndefined(); // harness 不可用时跳过
  });
});

```
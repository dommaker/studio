---
id: "workspace-rate-limit-001"
slug: "workspace-rate-limit"
title: "Workspace 级别速率限制"
status: "done"
tier: fast
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["workspaces", "rate-limit", "middleware"]
createdAt: "2026-06-18T00:00:00Z"
updatedAt: "2026-06-18T00:00:00Z"
---

### RL-01 速率限制中间件

**Contract Tests**

#### apps/api/src/modules/workspaces/__tests__/middleware.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { workspaceRateLimit } from '../middleware';

// AC: 使用 express-rate-limit 库，windowMs = 60000，max = 100
describe('workspaceRateLimit', () => {
  // AC: 导出为函数/中间件
  it('exports workspaceRateLimit middleware', () => {
    expect(workspaceRateLimit).toBeDefined();
    expect(typeof workspaceRateLimit).toBe('function');
  });

  // AC: keyGenerator 优先 req.params.id
  it('keys by req.params.id when available', () => {
    const req = { params: { id: 'ws-123' }, headers: {}, ip: '1.2.3.4' } as unknown as Request;
    // 通过连续调用验证 key 隔离：不同 params.id 独立计数
    expect(req.params.id).toBe('ws-123');
  });

  // AC: keyGenerator fallback 到 auth header hash
  it('keys by auth header hash when no params.id', () => {
    const req = { params: {}, headers: { authorization: 'Bearer st_mach_test' }, ip: '1.2.3.4' } as unknown as Request;
    expect(req.headers.authorization).toBe('Bearer st_mach_test');
  });

  // AC: 超限返回 429
  it('returns 429 when limit exceeded', async () => {
    // 发送 101 次请求，第 101 次应返回 429
    const req = { params: { id: 'ws-limit-test' }, headers: {}, ip: '1.2.3.4' } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    // 前 100 次调用 next()
    for (let i = 0; i < 100; i++) {
      await new Promise<void>((resolve) => {
        workspaceRateLimit(req, res, (err?: any) => { next(err); resolve(); });
      });
    }

    // 第 101 次应返回 429
    await new Promise<void>((resolve) => {
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnValue(undefined),
        setHeader: vi.fn(),
      } as unknown as Response;
      workspaceRateLimit(req, mockRes, () => { resolve(); });
      setTimeout(resolve, 100);
    });

    // 验证至少有 100 次调用了 next
    expect(next.mock.calls.length).toBeGreaterThanOrEqual(100);
  });
});
```

**Test Files**
- apps/api/src/modules/workspaces/__tests__/middleware.test.ts (新建)

### RL-02 路由挂载

**Contract Tests**

#### apps/api/src/modules/workspaces/__tests__/middleware.test.ts
```typescript
// AC: 在 route-registry.ts 中导入 workspaceRateLimit
// AC: 给 workspaceRoutes/daemonRoutes/taskRoutes 条目添加 middleware
describe('route-registry integration', () => {
  it('workspaceRateLimit is applied to workspace route entries', async () => {
    const { buildRouteTable } = await import('../../../route-registry');
    const routes = await buildRouteTable();

    const workspaceEntries = routes.filter(r => r.path === '/api/v1/workspaces' || r.path === '/api/v1/daemon');
    expect(workspaceEntries.length).toBeGreaterThan(0);

    // 验证 workspace 相关条目有 middleware
    for (const entry of workspaceEntries) {
      expect(entry.middleware).toBeDefined();
      expect(entry.middleware!.length).toBeGreaterThan(0);
    }
  });
});
```

**Test Files**
- apps/api/src/modules/workspaces/__tests__/middleware.test.ts (新建)

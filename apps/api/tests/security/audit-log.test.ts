/**
 * 审计日志测试 - Audit Log Tests
 * SEC-010: 关键操作审计记录
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AuditService, AuditLogInput } from '@dommaker/studio-audit';

// ========== In-memory mock store ==========
type MockAuditLog = {
  id: string;
  userId: string | null;
  roleId: string | null;
  companyId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  details: string | null;
  changes: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  sessionId: string | null;
  requestId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const store: MockAuditLog[] = [];
let idCounter = 0;

function applyWhere(result: MockAuditLog[], where: Record<string, unknown>): MockAuditLog[] {
  if (!where) return result;
  for (const wkey of Object.keys(where)) {
    const wval = where[wkey];
    if (wval === undefined) continue;
    if (wval === null) {
      result = result.filter(l => l[wkey as keyof MockAuditLog] === null);
      continue;
    }
    if (typeof wval === 'object') {
      // Handle { contains: string } for string fields
      const v = wval as { contains?: unknown; in?: unknown[]; not?: unknown; gte?: unknown; lte?: unknown; lt?: unknown };
      if (v.contains !== undefined && typeof v.contains === 'string') {
        result = result.filter(l => {
          const field = l[wkey as keyof MockAuditLog];
          return typeof field === 'string' && field.includes(v.contains as string);
        });
        continue;
      }
      if (v.in !== undefined && Array.isArray(v.in)) {
        result = result.filter(l => v.in.includes(l[wkey as keyof MockAuditLog]));
        continue;
      }
      if (v.not !== undefined) {
        result = result.filter(l => l[wkey as keyof MockAuditLog] !== v.not);
        continue;
      }
      // Skip complex date range filters (createdAt gte/lte)
      continue;
    }
    // Primitive equality
    result = result.filter(l => l[wkey as keyof MockAuditLog] === wval);
  }
  return result;
}

const mockPrismaClient = vi.hoisted(() => ({
  auditLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }): Promise<MockAuditLog> => {
      const log: MockAuditLog = {
        id: `log-${++idCounter}`,
        userId: (data.userId as string | null | undefined) ?? null,
        roleId: (data.roleId as string | null | undefined) ?? null,
        companyId: (data.companyId as string | null | undefined) ?? null,
        ipAddress: (data.ipAddress as string | null | undefined) ?? null,
        userAgent: (data.userAgent as string | null | undefined) ?? null,
        action: data.action as string,
        resource: data.resource as string,
        resourceId: (data.resourceId as string | null | undefined) ?? null,
        details: (data.details as string | null | undefined) ?? null,
        changes: (data.changes as string | null | undefined) ?? null,
        status: (data.status as string) || 'success',
        errorCode: (data.errorCode as string | null | undefined) ?? null,
        errorMessage: (data.errorMessage as string | null | undefined) ?? null,
        sessionId: (data.sessionId as string | null | undefined) ?? null,
        requestId: (data.requestId as string | null | undefined) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.push(log);
      return log;
    }),
    createMany: vi.fn(async ({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }): Promise<{ count: number }> => {
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        store.push({
          id: `log-${++idCounter}`,
          userId: (item.userId as string | null | undefined) ?? null,
          roleId: (item.roleId as string | null | undefined) ?? null,
          companyId: (item.companyId as string | null | undefined) ?? null,
          ipAddress: (item.ipAddress as string | null | undefined) ?? null,
          userAgent: (item.userAgent as string | null | undefined) ?? null,
          action: item.action as string,
          resource: item.resource as string,
          resourceId: (item.resourceId as string | null | undefined) ?? null,
          details: (item.details as string | null | undefined) ?? null,
          changes: (item.changes as string | null | undefined) ?? null,
          status: (item.status as string) || 'success',
          errorCode: (item.errorCode as string | null | undefined) ?? null,
          errorMessage: (item.errorMessage as string | null | undefined) ?? null,
          sessionId: (item.sessionId as string | null | undefined) ?? null,
          requestId: (item.requestId as string | null | undefined) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return { count: items.length };
    }),
    findMany: vi.fn(async ({ where, skip = 0, take = 50 }: { where?: Record<string, unknown>; skip?: number; take?: number }): Promise<MockAuditLog[]> => {
      let result = applyWhere(store.slice(), where || {});
      result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return result.slice(skip, skip + take);
    }),
    count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}): Promise<number> => {
      return applyWhere(store.slice(), where || {}).length;
    }),
    groupBy: vi.fn(async ({ by, where = {} }: { by: string[]; where?: Record<string, unknown> }): Promise<Array<Record<string, unknown> & { _count: Record<string, number> }>> => {
      const key = by[0];
      let result = applyWhere(store.slice(), where);
      const groups = new Map<string, number>();
      for (const log of result) {
        const v = log[key as keyof MockAuditLog];
        if (v === null || v === undefined) continue;
        const k = String(v);
        groups.set(k, (groups.get(k) || 0) + 1);
      }
      return Array.from(groups.entries())
        .map(([k, count]) => ({ [key]: k, _count: { [key]: count } }))
        .sort((a, b) => b._count[key] - a._count[key])
        .slice(0, 10);
    }),
    deleteMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}): Promise<{ count: number }> => {
      const before = store.length;
      const ids = (where.id as { in?: string[] } | undefined)?.in;
      const cutoff = (where.createdAt as { lt?: Date } | undefined)?.lt;
      if (ids) {
        for (let i = store.length - 1; i >= 0; i--) {
          if (ids.includes(store[i].id)) store.splice(i, 1);
        }
      } else if (cutoff) {
        for (let i = store.length - 1; i >= 0; i--) {
          if (store[i].createdAt < cutoff) store.splice(i, 1);
        }
      }
      return { count: before - store.length };
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }): Promise<MockAuditLog | null> => {
      return store.find(l => l.id === where.id) || null;
    }),
  },
  $disconnect: vi.fn(async (): Promise<void> => {}),
  $queryRaw: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  PrismaClient: vi.fn(() => mockPrismaClient),
  prisma: mockPrismaClient,
  // Re-export Prisma namespace bits used by AuditService for SQL helpers.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    empty: { strings: [], values: [] },
  },
}));

const prisma = mockPrismaClient as unknown as typeof mockPrismaClient; // @dommaker/studio-prisma PrismaClient removed (Spec 4 Phase 4)
const auditService = new AuditService(prisma as never);

/** details/changes 字段存储为 JSON 字符串，读取时需反序列化 */
const parseJson = (str: string | null): Record<string, any> | null => {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
};

describe('SEC-010: 审计日志服务', () => {
  const testLogs: string[] = [];

  afterAll(async () => {
    if (testLogs.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { id: { in: testLogs } },
      });
    }
    await prisma.$disconnect();
  });

  describe('登录审计', () => {
    it('应该记录登录成功', async () => {
      const input: AuditLogInput = {
        userId: null,
        sessionId: 'test-session-1',
        ipAddress: '127.0.0.1',
        userAgent: 'Vitest',
        action: 'login',
        resource: 'session',
        resourceId: 'test-session-1',
        details: { email: 'test@example.com' },
        status: 'success',
      };

      const log = await auditService.log(input);
      testLogs.push(log.id);

      expect(log.userId).toBeNull();
      expect(log.action).toBe('login');
      expect(log.status).toBe('success');
    });

    it('应该记录登录失败', async () => {
      const input: AuditLogInput = {
        ipAddress: '127.0.0.1',
        userAgent: 'Vitest',
        action: 'login',
        resource: 'session',
        details: { email: 'wrong@example.com' },
        status: 'failure',
        errorMessage: '密码错误',
      };

      const log = await auditService.log(input);
      testLogs.push(log.id);

      expect(log.userId).toBeNull();
      expect(log.status).toBe('failure');
      expect(log.errorMessage).toBe('密码错误');
    });
  });

  describe('角色操作审计', () => {
    it('应该记录角色创建', async () => {
      const input: AuditLogInput = {
        action: 'create',
        resource: 'role',
        resourceId: 'test-role-1',
        details: { name: 'Developer', type: 'worker' },
        status: 'success',
      };

      const log = await auditService.log(input);
      testLogs.push(log.id);

      expect(log.action).toBe('create');
      expect(log.resource).toBe('role');
      expect(parseJson(log.details)).toHaveProperty('name', 'Developer');
    });

    it('应该记录角色更新（含 changes）', async () => {
      const input: AuditLogInput = {
        action: 'update',
        resource: 'role',
        resourceId: 'test-role-1',
        changes: {
          before: { name: 'Developer', type: 'worker' },
          after: { name: 'Senior Developer', type: 'worker' },
        },
        status: 'success',
      };

      const log = await auditService.log(input);
      testLogs.push(log.id);

      const parsed = parseJson(log.changes);
      expect(parsed).toHaveProperty('before');
      expect(parsed).toHaveProperty('after');
    });
  });

  describe('备份操作审计', () => {
    it('应该记录备份创建', async () => {
      const input: AuditLogInput = {
        action: 'create',
        resource: 'backup',
        resourceId: 'test-backup-1',
        details: { type: 'full', format: 'pg_dump' },
        status: 'success',
      };

      const log = await auditService.log(input);
      testLogs.push(log.id);

      expect(log.resource).toBe('backup');
      expect(parseJson(log.details)).toHaveProperty('type', 'full');
    });

    it('应该记录备份恢复', async () => {
      const input: AuditLogInput = {
        action: 'restore',
        resource: 'backup',
        resourceId: 'test-backup-1',
        details: { models: ['User', 'Role'], truncate: true },
        status: 'success',
      };

      const log = await auditService.log(input);
      testLogs.push(log.id);

      expect(log.action).toBe('restore');
    });
  });

  describe('查询功能', () => {
    beforeAll(async () => {
      const inputs: AuditLogInput[] = [
        { action: 'create', resource: 'test', details: { userId: 'query-test-1' }, status: 'success' },
        { action: 'update', resource: 'test', details: { userId: 'query-test-1' }, status: 'success' },
        { action: 'delete', resource: 'test', details: { userId: 'query-test-2' }, status: 'failure' },
      ];

      for (const input of inputs) {
        const log = await auditService.log(input);
        testLogs.push(log.id);
      }
    });

    it('应该能按 userId 查询（存储在 details JSON）', async () => {
      const result = await auditService.query({});
      const userIdLogs = result.data.filter(l => parseJson(l.details)?.userId === 'query-test-1');
      expect(userIdLogs.length).toBeGreaterThanOrEqual(2);
    });

    it('应该能按 action 查询', async () => {
      const result = await auditService.query({ action: 'delete' });
      expect(result.data.every(l => l.action === 'delete')).toBe(true);
    });

    it('应该能按 status 查询', async () => {
      const result = await auditService.query({ status: 'failure' });
      expect(result.data.every(l => l.status === 'failure')).toBe(true);
    });

    it('应该支持分页', async () => {
      const result = await auditService.query({ page: 1, limit: 2 });
      expect(result.data.length).toBeLessThanOrEqual(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });
  });

  describe('SEC-009: anonymousId 支持', () => {
    it('应该能按 anonymousId 查询', async () => {
      const anonymousId = 'anon_test12345678';
      const input: AuditLogInput = {
        action: 'view',
        resource: 'page',
        details: { anonymousId },
        status: 'success',
      };

      const log = await auditService.log(input);
      testLogs.push(log.id);

      // 查询（Prisma JSON 路径查询）
      const result = await auditService.query({ anonymousId });
      expect(result.data.length).toBeGreaterThanOrEqual(1);
      expect(parseJson(result.data[0].details)).toHaveProperty('anonymousId', anonymousId);
    });
  });

  describe('统计功能', () => {
    it('应该能获取统计信息', async () => {
      const stats = await auditService.getStats();

      expect(stats).toHaveProperty('totalLogs');
      expect(stats).toHaveProperty('successCount');
      expect(stats).toHaveProperty('failureCount');
      expect(stats).toHaveProperty('topActions');
      expect(stats).toHaveProperty('topResources');
      expect(stats.totalLogs).toBeGreaterThanOrEqual(0);
    });
  });
});

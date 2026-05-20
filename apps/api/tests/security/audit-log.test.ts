/**
 * 审计日志测试 - Audit Log Tests
 * SEC-010: 关键操作审计记录
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AuditService, AuditLogInput } from '@dommaker/studio-audit';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);

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

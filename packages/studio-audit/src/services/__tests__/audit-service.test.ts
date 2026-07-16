// @ts-nocheck
/**
 * AuditService 测试
 * 
 * 覆盖 7 个核心方法：
 * - log
 * - logBatch
 * - query
 * - getById
 * - getStats
 * - cleanup
 * - export
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditService, AuditActions, AuditResources } from '../audit-service';

// Mock Prisma Client
const mockPrisma = {
  auditLog: {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn(),
  },
  $queryRaw: vi.fn(),
};

describe('AuditService', () => {
  let service: AuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AuditService(mockPrisma as any);
  });

  // ============================================
  // AC-001: AuditActions 常量
  // ============================================
  describe('AuditActions', () => {
    it('包含常用操作类型', () => {
      expect(AuditActions.CREATE).toBe('create');
      expect(AuditActions.UPDATE).toBe('update');
      expect(AuditActions.DELETE).toBe('delete');
      expect(AuditActions.EXECUTE).toBe('execute');
    });
  });

  // ============================================
  // AC-002: AuditResources 常量
  // ============================================
  describe('AuditResources', () => {
    it('包含常用资源类型', () => {
      expect(AuditResources.ROLE).toBe('role');
      expect(AuditResources.COMPANY).toBe('company');
    });
  });

  // ============================================
  // AC-003: log
  // ============================================
  describe('log', () => {
    it('正常记录审计日志', async () => {
      mockPrisma.auditLog.create.mockResolvedValue({
        id: 'audit-123',
        action: 'create',
        resource: 'task',
      });

      const result = await service.log({
        action: 'create',
        resource: 'task',
        userId: 'user-1',
      });

      expect(result.id).toContain('audit');
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    it('记录失败操作', async () => {
      mockPrisma.auditLog.create.mockResolvedValue({
        id: 'audit-123',
        status: 'failure',
        errorMessage: 'Something went wrong',
      });

      const result = await service.log({
        action: 'create',
        resource: 'task',
        status: 'failure',
        errorMessage: 'Something went wrong',
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failure' }),
        })
      );
    });

    it('记录变更详情', async () => {
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-123' });

      await service.log({
        action: 'update',
        resource: 'role',
        changes: {
          before: { level: 1 },
          after: { level: 2 },
          fields: ['level'],
        },
      });

      // changes 字段存储为 JSON string（B0-011: String? 字段统一序列化）
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            changes: JSON.stringify({
              before: { level: 1 },
              after: { level: 2 },
              fields: ['level'],
            }),
            details: null,
          }),
        })
      );
    });
  });

  // ============================================
  // AC-004: logBatch
  // ============================================
  describe('logBatch', () => {
    it('批量记录日志', async () => {
      mockPrisma.auditLog.createMany.mockResolvedValue({ count: 3 });

      const result = await service.logBatch([
        { action: 'create', resource: 'capability' },
        { action: 'update', resource: 'role' },
        { action: 'delete', resource: 'task' },
      ]);

      expect(result).toBe(3);
      expect(mockPrisma.auditLog.createMany).toHaveBeenCalled();
    });
  });

  // ============================================
  // AC-005: query
  // ============================================
  describe('query', () => {
    it('查询审计日志', async () => {
      const mockLogs = [
        { id: 'audit-1', action: 'create' },
        { id: 'audit-2', action: 'update' },
      ];

      mockPrisma.auditLog.findMany.mockResolvedValue(mockLogs);
      mockPrisma.auditLog.count.mockResolvedValue(2);

      const result = await service.query({});

      expect(result.data.length).toBe(2);
      expect(result.total).toBe(2);
    });

    it('按用户查询', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);

      await service.query({ userId: 'user-1' });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } })
      );
    });

    it('按时间范围查询', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);

      const startTime = new Date('2026-01-01');
      const endTime = new Date('2026-04-01');

      await service.query({ startTime, endTime });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdAt: { gte: startTime, lte: endTime } },
        })
      );
    });

    it('分页查询', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(100);

      const result = await service.query({ page: 2, limit: 20 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(20);
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 })
      );
    });
  });

  // ============================================
  // AC-006: getById
  // ============================================
  describe('getById', () => {
    it('获取单条日志', async () => {
      mockPrisma.auditLog.findUnique.mockResolvedValue({
        id: 'audit-1',
        action: 'create',
      });

      const result = await service.getById('audit-1');

      expect(result?.id).toBe('audit-1');
    });

    it('日志不存在返回 null', async () => {
      mockPrisma.auditLog.findUnique.mockResolvedValue(null);

      const result = await service.getById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ============================================
  // AC-007: getStats
  // ============================================
  describe('getStats', () => {
    it('获取统计信息', async () => {
      mockPrisma.auditLog.count.mockResolvedValue(100);
      mockPrisma.auditLog.groupBy.mockResolvedValue([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getStats();

      expect(result.totalLogs).toBe(100);
    });

    it('统计成功和失败数', async () => {
      mockPrisma.auditLog.count
        .mockResolvedValueOnce(100)  // total
        .mockResolvedValueOnce(80)   // success
        .mockResolvedValueOnce(20);  // failure
      mockPrisma.auditLog.groupBy.mockResolvedValue([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getStats();

      expect(result.successCount).toBe(80);
      expect(result.failureCount).toBe(20);
    });
  });

  // ============================================
  // AC-008: cleanup
  // ============================================
  describe('cleanup', () => {
    it('清理过期日志', async () => {
      mockPrisma.auditLog.deleteMany.mockResolvedValue({ count: 50 });

      const result = await service.cleanup(90);

      expect(result).toBe(50);
      expect(mockPrisma.auditLog.deleteMany).toHaveBeenCalled();
    });

    it('自定义保留天数', async () => {
      mockPrisma.auditLog.deleteMany.mockResolvedValue({ count: 100 });

      await service.cleanup(30);

      expect(mockPrisma.auditLog.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.any(Object),
          }),
        })
      );
    });
  });

  // ============================================
  // AC-009: export
  // ============================================
  describe('export', () => {
    it('导出审计日志', async () => {
      const mockLogs = [
        { id: 'audit-1' },
        { id: 'audit-2' },
      ];

      mockPrisma.auditLog.findMany.mockResolvedValue(mockLogs);
      mockPrisma.auditLog.count.mockResolvedValue(2);

      const result = await service.export({ companyId: 'company-1' });

      expect(result.length).toBe(2);
    });
  });
});
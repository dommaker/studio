// @ts-nocheck
/**
 * NotificationService 测试
 * 
 * 覆盖 5 个核心方法：
 * - create
 * - getUserNotifications
 * - markAsRead
 * - markAllAsRead
 * - getUnreadCount
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../notification-service';

// Mock Prisma Client
const mockPrisma = {
  notification: {
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
};

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new NotificationService(mockPrisma as any);
  });

  // ============================================
  // AC-001: create
  // ============================================
  describe('create', () => {
    it('正常创建通知', async () => {
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif_123',
        userId: 'user-1',
        type: 'review_request',
        title: 'Test',
        content: 'Test content',
      });

      const result = await service.create({
        userId: 'user-1',
        type: 'review_request',
        title: 'Test',
        content: 'Test content',
      });

      expect(result.id).toContain('notif');
      expect(result.userId).toBe('user-1');
      expect(mockPrisma.notification.create).toHaveBeenCalled();
    });

    it('创建带链接的通知', async () => {
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif_123',
        link: 'https://example.com',
      });

      const result = await service.create({
        userId: 'user-1',
        type: 'system',
        title: 'Link test',
        content: 'Click link',
        link: 'https://example.com',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ link: 'https://example.com' }),
        })
      );
    });
  });

  // ============================================
  // AC-002: getUserNotifications
  // ============================================
  describe('getUserNotifications', () => {
    it('获取用户通知列表', async () => {
      const mockNotifications = [
        { id: 'notif-1', userId: 'user-1', read: false },
        { id: 'notif-2', userId: 'user-1', read: true },
      ];

      mockPrisma.notification.findMany.mockResolvedValue(mockNotifications);

      const result = await service.getUserNotifications('user-1');

      expect(result.length).toBe(2);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } })
      );
    });

    it('只获取未读通知', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      await service.getUserNotifications('user-1', { unreadOnly: true });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', read: false } })
      );
    });

    it('限制返回数量', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      await service.getUserNotifications('user-1', { limit: 10 });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 })
      );
    });
  });

  // ============================================
  // AC-003: markAsRead
  // ============================================
  describe('markAsRead', () => {
    it('标记已读', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

      await service.markAsRead('notif-1', 'user-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'notif-1', userId: 'user-1' },
        data: { read: true, readAt: expect.any(Date) },
      });
    });
  });

  // ============================================
  // AC-004: markAllAsRead
  // ============================================
  describe('markAllAsRead', () => {
    it('标记全部已读', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });

      await service.markAllAsRead('user-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', read: false },
        data: { read: true, readAt: expect.any(Date) },
      });
    });
  });

  // ============================================
  // AC-005: getUnreadCount
  // ============================================
  describe('getUnreadCount', () => {
    it('获取未读数量', async () => {
      mockPrisma.notification.count.mockResolvedValue(3);

      const result = await service.getUnreadCount('user-1');

      expect(result).toBe(3);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', read: false },
      });
    });
  });
});
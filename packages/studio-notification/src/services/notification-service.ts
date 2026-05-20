/**
 * 通知服务
 */

import { PrismaClient, prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

export interface CreateNotificationInput {
  userId: string;
  type: 'review_request' | 'review_approved' | 'review_rejected' | 'system';
  title: string;
  content: string;
  link?: string;
}

export class NotificationService {
  constructor(private prisma: PrismaClient) {}

  /**
   * 创建通知
   */
  async create(input: CreateNotificationInput) {
    const notification = await this.prisma.notification.create({
      data: {
        id: this.generateId(),
        userId: input.userId,
        type: input.type,
        title: input.title,
        content: input.content,
        link: input.link,
      },
    });
    
    logger.info(`Notification created: ${notification.id}, userId=${input.userId}, type=${input.type}`);
    
    return notification;
  }
  
  /**
   * 获取用户通知列表
   */
  async getUserNotifications(userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
    const where: any = { userId };
    
    if (options?.unreadOnly) {
      where.read = false;
    }
    
    return this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 50,
    });
  }
  
  /**
   * 标记已读
   */
  async markAsRead(notificationId: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { 
        read: true, 
        readAt: new Date() 
      },
    });
  }
  
  /**
   * 标记全部已读
   */
  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { 
        read: true, 
        readAt: new Date() 
      },
    });
  }
  
  /**
   * 获取未读数量
   */
  async getUnreadCount(userId: string) {
    return this.prisma.notification.count({
      where: { userId, read: false },
    });
  }
  
  /**
   * 生成 ID
   */
  private generateId(): string {
    return `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

// 单例实例
export const notificationService = new NotificationService(prisma);
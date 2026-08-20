/**
 * 通知服务
 */

import { FileStore, logger, generateId as sharedGenerateId } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

export interface CreateNotificationInput {
  userId: string;
  type: 'review_request' | 'review_approved' | 'review_rejected' | 'system' | 'auditor_suggestion';
  title: string;
  content: string;
  link?: string;
}

const NOTIFICATIONS_JSONL = studioPath('logs', 'notifications.jsonl');

interface NotificationRow {
  id: string;
  userId?: string;
  type?: string;
  title?: string;
  content?: string;
  link?: string;
  createdAt?: string;
  deleted?: boolean;
  deletedAt?: string;
}

export class NotificationService {
  constructor(private fileStore: FileStore) {}

  /**
   * 创建通知
   */
  async create(input: CreateNotificationInput) {
    const entry: NotificationRow = {
      id: this.generateId(),
      userId: input.userId,
      type: input.type,
      title: input.title,
      content: input.content,
      link: input.link,
      createdAt: new Date().toISOString(),
    };
    await this.fileStore.appendJsonl(NOTIFICATIONS_JSONL, entry);
    logger.info(`Notification created: ${entry.id}, userId=${input.userId}, type=${input.type}`);
    return entry;
  }

  /**
   * 获取用户通知列表
   */
  async getUserNotifications(userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
    const rows = await this.fileStore.readJsonl<NotificationRow>(NOTIFICATIONS_JSONL);

    // Group rows by id to build latest state per notification
    const byId = new Map<string, NotificationRow[]>();
    for (const row of rows) {
      const existing = byId.get(row.id) || [];
      existing.push(row);
      byId.set(row.id, existing);
    }

    const results: Array<{
      id: string;
      userId: string;
      type: string;
      title: string;
      content: string;
      link: string | null;
      createdAt: Date;
      read: boolean;
      readAt: Date | null;
    }> = [];

    for (const [, entries] of byId) {
      // Latest non-deleted entry carries the notification data
      const nonDeleted = entries.filter(e => !e.deleted);
      if (nonDeleted.length === 0) continue;

      const lastData = nonDeleted[nonDeleted.length - 1];
      if (lastData.userId !== userId) continue;

      const hasTombstone = entries.some(e => e.deleted === true);
      const tombstone = entries.find(e => e.deleted === true);

      results.push({
        id: lastData.id,
        userId: lastData.userId!,
        type: lastData.type!,
        title: lastData.title!,
        content: lastData.content!,
        link: lastData.link || null,
        createdAt: new Date(lastData.createdAt!),
        read: hasTombstone,
        readAt: hasTombstone && tombstone?.deletedAt ? new Date(tombstone.deletedAt) : null,
      });
    }

    // Sort by createdAt desc
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (options?.unreadOnly) {
      return results.filter(r => !r.read).slice(0, options?.limit || 50);
    }

    return results.slice(0, options?.limit || 50);
  }

  /**
   * 标记已读 — 归属校验通过后追加 tombstone 行
   * #274: 校验通知活跃归属为 userId，跨用户/不存在的 id 不写入
   */
  async markAsRead(notificationId: string, userId: string) {
    const rows = await this.fileStore.readJsonl<NotificationRow>(NOTIFICATIONS_JSONL);

    const entries = rows.filter(r => r.id === notificationId);
    const nonDeleted = entries.filter(e => !e.deleted);
    if (nonDeleted.length === 0) return;
    const lastData = nonDeleted[nonDeleted.length - 1];
    if (lastData.userId !== userId) return;

    await this.fileStore.appendJsonl(NOTIFICATIONS_JSONL, {
      id: notificationId,
      deleted: true,
      deletedAt: new Date().toISOString(),
    });
  }

  /**
   * 标记全部已读
   */
  async markAllAsRead(userId: string) {
    const rows = await this.fileStore.readJsonl<NotificationRow>(NOTIFICATIONS_JSONL);

    // Resolve active notifications for user
    const byId = new Map<string, NotificationRow[]>();
    for (const row of rows) {
      const existing = byId.get(row.id) || [];
      existing.push(row);
      byId.set(row.id, existing);
    }

    const activeIds: string[] = [];
    for (const [id, entries] of byId) {
      const nonDeleted = entries.filter(e => !e.deleted);
      if (nonDeleted.length === 0) continue;
      const lastData = nonDeleted[nonDeleted.length - 1];
      if (lastData.userId === userId) {
        activeIds.push(id);
      }
    }

    for (const id of activeIds) {
      await this.fileStore.appendJsonl(NOTIFICATIONS_JSONL, {
        id,
        deleted: true,
        deletedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * 获取未读数量
   */
  async getUnreadCount(userId: string): Promise<number> {
    const rows = await this.fileStore.readJsonl<NotificationRow>(NOTIFICATIONS_JSONL);

    const byId = new Map<string, NotificationRow[]>();
    for (const row of rows) {
      const existing = byId.get(row.id) || [];
      existing.push(row);
      byId.set(row.id, existing);
    }

    let count = 0;
    for (const [, entries] of byId) {
      const nonDeleted = entries.filter(e => !e.deleted);
      if (nonDeleted.length === 0) continue;
      const lastData = nonDeleted[nonDeleted.length - 1];
      if (lastData.userId !== userId) continue;
      // #274 修复：有 tombstone 即已读，不计入未读数（此前漏判，恒计全部）
      if (entries.some(e => e.deleted === true)) continue;
      count++;
    }
    return count;
  }

  /**
   * 生成 ID
   */
  private generateId(): string {
    return sharedGenerateId('notif');
  }
}

// 单例实例
export const notificationService = new NotificationService(new FileStore());

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

/**
 * notifications.jsonl 折叠产物：一个 id 的当前通知态（#360 收敛，语义与原三份手写 fold 逐条一致）。
 * 墓碑 = `{ id, deleted: true, deletedAt }` 稀疏行，语义是「已读标记」而非删除：
 * 已读通知保留可见；全墓碑（孤儿墓碑行）的 id 不可见。
 */
interface FoldedNotification {
  /** 最新非 deleted 行（数据载体：userId/type/title/content 均取自它） */
  data: NotificationRow;
  /** 组内存在 deleted 行即已读 */
  read: boolean;
  /** 首个 deleted 行的 deletedAt（多次追加墓碑时取首个 = 实际首次已读时刻） */
  readAt: Date | null;
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
   * append-only 行折叠（#360）：按 id 分组，最新非 deleted 行作数据载体，
   * 首个 deleted 行作已读标记。getUserNotifications / markAsRead /
   * markAllAsRead / getUnreadCount 共用本口径，杜绝 #274 式漏判墓碑的分叉复写。
   */
  private foldRows(rows: NotificationRow[]): Map<string, FoldedNotification> {
    const byId = new Map<string, NotificationRow[]>();
    for (const row of rows) {
      const existing = byId.get(row.id) || [];
      existing.push(row);
      byId.set(row.id, existing);
    }

    const folded = new Map<string, FoldedNotification>();
    for (const [id, entries] of byId) {
      const nonDeleted = entries.filter(e => !e.deleted);
      if (nonDeleted.length === 0) continue; // 全墓碑（孤儿墓碑行）不可见
      const tombstone = entries.find(e => e.deleted === true);
      folded.set(id, {
        data: nonDeleted[nonDeleted.length - 1],
        read: tombstone !== undefined,
        readAt: tombstone?.deletedAt ? new Date(tombstone.deletedAt) : null,
      });
    }
    return folded;
  }

  /**
   * 获取用户通知列表
   */
  async getUserNotifications(userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
    const rows = await this.fileStore.readJsonl<NotificationRow>(NOTIFICATIONS_JSONL);
    const folded = this.foldRows(rows);

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

    for (const entry of folded.values()) {
      if (entry.data.userId !== userId) continue;

      results.push({
        id: entry.data.id,
        userId: entry.data.userId!,
        type: entry.data.type!,
        title: entry.data.title!,
        content: entry.data.content!,
        link: entry.data.link || null,
        createdAt: new Date(entry.data.createdAt!),
        read: entry.read,
        readAt: entry.readAt,
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
    const entry = this.foldRows(rows).get(notificationId);
    if (!entry || entry.data.userId !== userId) return;

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
    const activeIds = [...this.foldRows(rows).values()]
      .filter(entry => entry.data.userId === userId)
      .map(entry => entry.data.id);

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
    let count = 0;
    for (const entry of this.foldRows(rows).values()) {
      if (entry.data.userId !== userId) continue;
      // #274 修复：有 tombstone 即已读，不计入未读数（此前漏判，恒计全部）
      if (entry.read) continue;
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

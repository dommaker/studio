/**
 * 通知服务：JSONL 为真源，PERF-05 当前态投影承担 list/unread/已读归属校验。
 */

import { FileStore, generateId as sharedGenerateId } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import fs from 'node:fs';
import { createLazyService } from '../../utils/services.js';
import { getStore } from '../../core/store.js';
import { logger } from '@dommaker/studio-shared/node';
import { NotificationProjection, type NotificationRow, type RecipientProjection } from './notification-projection.js';
import type { NotificationItem as NotificationItemWire } from '@dommaker/studio-contract';

/** 全用户 id 列表（auditor 先例：data/users/*.json 文件名，截顶 10；目录缺失返回空） */
async function listUserIds(): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(studioPath('data', 'users'), { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .slice(0, 10)
      .map(f => f.name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export interface CreateNotificationInput {
  userId: string;
  type: 'review_request' | 'review_approved' | 'review_rejected' | 'system' | 'auditor_suggestion'
    | 'wu_milestone' | 'monitor_alert' | 'incident' | 'gate_reminder';
  title: string;
  content: string;
  link?: string;
  wuId?: string;
  channelId?: string;
}

const NOTIFICATIONS_JSONL = studioPath('logs', 'notifications.jsonl');

export interface NotificationItem {
  id: string;
  userId: string;
  type: string;
  title: string;
  content: string;
  link: string | null;
  wuId: string | null;
  channelId: string | null;
  createdAt: Date;
  read: boolean;
  readAt: Date | null;
}

/** NotificationService 内存型 → contract wire：Date → ISO string/null。 */
export function toNotificationWire(item: NotificationItem): NotificationItemWire {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    readAt: item.readAt?.toISOString() ?? null,
  };
}

export class NotificationService {
  private readonly projection: NotificationProjection;
  private readonly recipientFlights = new Map<string, Promise<RecipientProjection>>();

  constructor(private fileStore: FileStore) {
    this.projection = new NotificationProjection(fileStore, NOTIFICATIONS_JSONL);
  }

  async create(input: CreateNotificationInput): Promise<NotificationRow> {
    const entry: NotificationRow = {
      id: this.generateId(),
      userId: input.userId,
      type: input.type,
      title: input.title,
      content: input.content,
      link: input.link,
      wuId: input.wuId,
      channelId: input.channelId,
      createdAt: new Date().toISOString(),
    };
    await this.fileStore.withLock(this.projection.lockPath, async () => {
      await this.fileStore.appendJsonl(NOTIFICATIONS_JSONL, entry);
      await this.projection.sync();
    });
    logger.info(`Notification created: ${entry.id}, userId=${input.userId}, type=${input.type}`);
    return entry;
  }

  async createForAllUsers(input: Omit<CreateNotificationInput, 'userId'>): Promise<number> {
    const userIds = await listUserIds();
    for (const uid of userIds) await this.create({ ...input, userId: uid });
    return userIds.length;
  }

  /** 同接收者并发读共享一次锁内增量同步；对象映射和分页仍在各调用方独立执行。 */
  private loadRecipient(userId: string): Promise<RecipientProjection> {
    const existing = this.recipientFlights.get(userId);
    if (existing) return existing;
    const flight = this.fileStore.withLock(this.projection.lockPath, async () => {
      const manifest = await this.projection.sync();
      return this.projection.readRecipient(userId, manifest);
    });
    this.recipientFlights.set(userId, flight);
    return flight.finally(() => {
      if (this.recipientFlights.get(userId) === flight) this.recipientFlights.delete(userId);
    });
  }

  /** list + unreadCount 共用一次增量同步，但只读取目标接收者 view。 */
  async getUserNotificationView(userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
    const recipient = await this.loadRecipient(userId);
    const notifications: NotificationItem[] = [];
    for (const entry of Object.values(recipient.items)) {
      const data = entry.data!;
      notifications.push({
        id: data.id,
        userId,
        type: data.type!,
        title: data.title!,
        content: data.content!,
        link: data.link || null,
        wuId: data.wuId || null,
        channelId: data.channelId || null,
        createdAt: new Date(data.createdAt!),
        read: entry.read,
        readAt: entry.readAt ? new Date(entry.readAt) : null,
      });
    }
    notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const visible = options?.unreadOnly ? notifications.filter(row => !row.read) : notifications;
    return { notifications: visible.slice(0, options?.limit || 50), unreadCount: recipient.unreadCount };
  }

  async getUserNotifications(userId: string, options?: { unreadOnly?: boolean; limit?: number }): Promise<NotificationItem[]> {
    return (await this.getUserNotificationView(userId, options)).notifications;
  }

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    await this.markManyAsRead([notificationId], userId);
  }

  /** 一次投影同步、一次归属过滤、单句柄批量 append；他人/不存在/已读 id 不写墓碑。 */
  async markManyAsRead(notificationIds: string[], userId: string): Promise<void> {
    await this.fileStore.withLock(this.projection.lockPath, async () => {
      await this.projection.sync();
      const requested = new Set(notificationIds);
      const recipient = await this.projection.readRecipient(userId);
      const ids = Object.entries(recipient.items)
        .filter(([id, entry]) => requested.has(id) && !entry.read)
        .map(([id]) => id);
      if (ids.length === 0) return;
      const deletedAt = new Date().toISOString();
      await this.fileStore.appendJsonlBatch(NOTIFICATIONS_JSONL, ids.map(id => ({ id, deleted: true, deletedAt })));
      await this.projection.sync();
    });
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.fileStore.withLock(this.projection.lockPath, async () => {
      await this.projection.sync();
      const recipient = await this.projection.readRecipient(userId);
      const ids = Object.values(recipient.items)
        .filter(entry => !entry.read)
        .map(entry => entry.data!.id);
      if (ids.length === 0) return;
      const deletedAt = new Date().toISOString();
      await this.fileStore.appendJsonlBatch(NOTIFICATIONS_JSONL, ids.map(id => ({ id, deleted: true, deletedAt })));
      await this.projection.sync();
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.fileStore.withLock(this.projection.lockPath, async () => {
      await this.projection.sync();
      return this.projection.readUnreadCount(userId);
    });
  }

  private generateId(): string {
    return sharedGenerateId('notif');
  }
}

/** 进程级单例：首次调用时才取 getStore()；测试自行 new NotificationService(显式 store)。 */
export const getNotificationService = createLazyService(() => new NotificationService(getStore()));

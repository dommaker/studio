/**
 * notifications 域契约测试：通知行复用同源 + 四端点请求/响应壳。
 * 正本 = packages/studio-notification NotificationService + modules/notifications/routes.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  notificationItemSchema,
  unreadCountResultSchema,
  notificationReadResultSchema,
  listNotificationsQuerySchema,
  notificationIdParamsSchema,
  notificationListResponseSchema,
  unreadCountResponseSchema,
  notificationReadResponseSchema,
} from '../notifications.js';
import { actionCenterNotificationSchema } from '../action-center.js';
import * as contractIndex from '../index.js';

const notificationRow = {
  id: 'n-1',
  userId: 'user-a',
  type: 'monitor_alert',
  title: 'T',
  content: 'C',
  link: null,
  wuId: 'wu-1',
  channelId: null,
  createdAt: '2026-09-09T01:00:00.000Z',
  read: false,
  readAt: null,
};

describe('notificationItemSchema', () => {
  it('与 action-center 通知行同源（同一 schema，不重复声明）', () => {
    expect(notificationItemSchema).toBe(actionCenterNotificationSchema);
    expect(notificationItemSchema.parse(notificationRow)).toEqual(notificationRow);
    // createdAt/readAt wire 为 ISO 串或 null（Date 经 JSON 序列化）
    expect(notificationItemSchema.parse({ ...notificationRow, read: true, readAt: '2026-09-09T02:00:00.000Z' }).read).toBe(true);
  });
});

describe('端点请求/响应', () => {
  it('GET / 列表壳（裸数组 → { data: [] }）；unreadOnly 可选', () => {
    expect(notificationListResponseSchema.parse({ data: [notificationRow] }).data).toHaveLength(1);
    expect(listNotificationsQuerySchema.parse({})).toEqual({});
    expect(listNotificationsQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe('true');
  });

  it('GET /unread-count → { data: { count } }', () => {
    expect(unreadCountResultSchema.parse({ count: 3 })).toEqual({ count: 3 });
    expect(unreadCountResponseSchema.parse({ data: { count: 3 } }).data.count).toBe(3);
  });

  it('POST /:id/read 与 /read-all → { data: { success } }；params id 非空', () => {
    expect(notificationReadResultSchema.parse({ success: true })).toEqual({ success: true });
    expect(notificationReadResponseSchema.parse({ data: { success: true } }).data.success).toBe(true);
    expect(notificationIdParamsSchema.parse({ id: 'n-1' }).id).toBe('n-1');
    expect(() => notificationIdParamsSchema.parse({ id: '' })).toThrow();
  });
});

describe('index.ts 出口', () => {
  it('notifications 域 schema 经 index 导出', () => {
    expect(contractIndex.notificationItemSchema).toBeDefined();
    expect(contractIndex.notificationListResponseSchema).toBeDefined();
    expect(contractIndex.unreadCountResponseSchema).toBeDefined();
  });
});

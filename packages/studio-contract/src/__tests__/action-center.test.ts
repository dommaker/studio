/**
 * action-center 域契约测试：StateItem parity + payload/响应壳边界。
 * 正本 = action-center.service.ts（ActionCenterPayload）+
 * NotificationService.getUserNotifications 返回行。
 */

import { describe, it, expect } from 'vitest';
import {
  actionCenterStateItemSchema,
  type ActionCenterStateItem,
  actionCenterNotificationSchema,
  actionCenterPayloadSchema,
  actionCenterResponseSchema,
} from '../action-center.js';
import * as contractIndex from '../index.js';

const stateItemRow: ActionCenterStateItem = {
  kind: 'reply',
  wuId: 'wu-1',
  scope: '登录功能',
  channelId: 'ch-1',
  waitingQuestion: '选哪个方案？',
  messageId: 'msg-1',
  since: '2026-09-09T01:00:00.000Z',
};

const notificationRow = {
  id: 'n-1',
  userId: 'local',
  type: 'incident',
  title: 'T',
  content: 'severity: critical\nx',
  link: '/channels/ch-1?highlight=msg-1',
  wuId: null,
  channelId: 'ch-1',
  createdAt: '2026-09-09T01:00:00.000Z',
  read: false,
  readAt: null,
};

describe('actionCenterStateItemSchema', () => {
  it('kind 词表 = reply/review/confirm', () => {
    for (const k of ['reply', 'review', 'confirm']) {
      expect(actionCenterStateItemSchema.parse({ ...stateItemRow, kind: k }).kind).toBe(k);
    }
    expect(() => actionCenterStateItemSchema.parse({ ...stateItemRow, kind: 'bogus' })).toThrow();
  });

  it('parity：ActionCenterStateItem fixture 通过校验；必填字段删除即拒', () => {
    expect(actionCenterStateItemSchema.parse(stateItemRow)).toEqual(stateItemRow);
    // channelId null 合法（无频道 WU）；waitingQuestion/messageId 可缺省（fail-closed 语义）
    expect(actionCenterStateItemSchema.parse({
      kind: 'confirm', wuId: 'wu-2', scope: 's', channelId: null, since: 't',
    }).channelId).toBeNull();
    expect(() => actionCenterStateItemSchema.parse({ ...stateItemRow, wuId: undefined })).toThrow();
    expect(() => actionCenterStateItemSchema.parse({ ...stateItemRow, since: undefined })).toThrow();
    expect(() => actionCenterStateItemSchema.parse({ ...stateItemRow, channelId: undefined })).toThrow();
  });
});

describe('actionCenterNotificationSchema / payload', () => {
  it('通知行形状（createdAt/readAt wire 为 ISO 串或 null）', () => {
    expect(actionCenterNotificationSchema.parse(notificationRow)).toEqual(notificationRow);
    expect(() => actionCenterNotificationSchema.parse({ ...notificationRow, read: undefined })).toThrow();
  });

  it('payload 三段：stateItems + notifications + unreadCount', () => {
    const payload = { stateItems: [stateItemRow], notifications: [notificationRow], unreadCount: 1 };
    expect(actionCenterPayloadSchema.parse(payload)).toEqual(payload);
    expect(actionCenterResponseSchema.parse({ data: payload }).data.unreadCount).toBe(1);
    expect(() => actionCenterPayloadSchema.parse({ stateItems: [], notifications: [] })).toThrow();
  });
});

describe('index.ts 出口', () => {
  it('action-center 域 schema 经 index 导出', () => {
    expect(contractIndex.actionCenterStateItemSchema).toBeDefined();
    expect(contractIndex.actionCenterResponseSchema).toBeDefined();
  });
});

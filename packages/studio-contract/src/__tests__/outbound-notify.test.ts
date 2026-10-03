/**
 * outbound-notify 域契约测试：NotifyMessage type 词表 + 请求边界 + 响应壳。
 * 正本 = apps/api/src/modules/outbound-notify/routes.ts + notify.service.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  notifyMessageTypeSchema,
  notifySendBodySchema,
  notifySendResultSchema,
  notifySendResponseSchema,
} from '../outbound-notify.js';
import * as contractIndex from '../index.js';

describe('notifyMessageTypeSchema', () => {
  it('词表 = NotifyMessage.type 十值联合', () => {
    for (const t of [
      'task-failed', 'timeout', 'crash', 'zombie', 'human-needed',
      'meeting-started', 'meeting-message', 'meeting-completed', 'meeting-cancelled',
      'user-intervention-needed',
    ]) {
      expect(notifyMessageTypeSchema.parse(t)).toBe(t);
    }
    expect(() => notifyMessageTypeSchema.parse('bogus-type')).toThrow();
  });
});

describe('notifySendBodySchema', () => {
  it('type/title/content 必填（原手写 400 收进 zod）；taskId/meetingId/priority 可选', () => {
    const body = { type: 'task-failed', title: 'T', content: 'C' };
    expect(notifySendBodySchema.parse(body)).toEqual(body);
    expect(notifySendBodySchema.parse({ ...body, priority: 'high', taskId: 't1' }).priority).toBe('high');
    expect(() => notifySendBodySchema.parse({ title: 'T', content: 'C' })).toThrow();
    expect(() => notifySendBodySchema.parse({ type: 'task-failed', content: 'C' })).toThrow();
    expect(() => notifySendBodySchema.parse({ type: 'task-failed', title: 'T' })).toThrow();
    // priority 收进词表（原非法值透传，迁移后 400）
    expect(() => notifySendBodySchema.parse({ ...body, priority: 'urgent' })).toThrow();
  });
});

describe('响应壳', () => {
  it('POST /send → { data: { success, message } }', () => {
    const result = { success: true, message: 'Notification sent' };
    expect(notifySendResultSchema.parse(result)).toEqual(result);
    expect(notifySendResponseSchema.parse({ data: result }).data.success).toBe(true);
  });
});

describe('index.ts 出口', () => {
  it('outbound-notify 域 schema 经 index 导出', () => {
    expect(contractIndex.notifySendBodySchema).toBeDefined();
    expect(contractIndex.notifySendResponseSchema).toBeDefined();
  });
});

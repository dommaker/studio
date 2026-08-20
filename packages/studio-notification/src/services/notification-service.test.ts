/**
 * NotificationService tests — #274 写路径归属校验
 * markAsRead 必须校验通知归属：跨用户标记不得生效（此前 tombstone 只按 id 追加，
 * 任何登录用户可把他人通知标已读）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { tmpRoot } = vi.hoisted(() => ({
  tmpRoot: { value: '' },
}));

// NOTIFICATIONS_JSONL 在被测模块加载时求值，临时目录必须先于加载创建
vi.mock('@dommaker/studio-shared/studio-dir', async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'notif-svc-test-'));
  tmpRoot.value = root;
  return { studioPath: (...segs: string[]) => nodePath.join(root, ...segs) };
});

import { NotificationService } from './notification-service';
import { FileStore } from '@dommaker/studio-shared';

let service: NotificationService;

beforeEach(() => {
  // 清空上一用例数据（目录保留：路径常量在模块加载时已固定）
  const jsonl = path.join(tmpRoot.value, 'logs', 'notifications.jsonl');
  fs.rmSync(jsonl, { force: true });
  service = new NotificationService(new FileStore());
});

async function seed() {
  const a = await service.create({ userId: 'user-a', type: 'system', title: 'A1', content: 'a1' });
  const b = await service.create({ userId: 'user-b', type: 'system', title: 'B1', content: 'b1' });
  return { a, b };
}

describe('#274 归属校验', () => {
  it('markAsRead：本人通知 → 生效（read=true）', async () => {
    const { a } = await seed();
    await service.markAsRead(a.id, 'user-a');
    const list = await service.getUserNotifications('user-a');
    expect(list.find(n => n.id === a.id)?.read).toBe(true);
  });

  it('markAsRead：他人通知 id → 不生效（归属校验）', async () => {
    const { a } = await seed();
    await service.markAsRead(a.id, 'user-b');
    const list = await service.getUserNotifications('user-a');
    expect(list.find(n => n.id === a.id)?.read).toBe(false);
    expect(await service.getUnreadCount('user-a')).toBe(1);
  });

  it('markAsRead：不存在的通知 id → 不写入 tombstone', async () => {
    await seed();
    const before = await service.getUserNotifications('user-a');
    await service.markAsRead('notif-nonexistent', 'user-a');
    const after = await service.getUserNotifications('user-a');
    expect(after).toEqual(before);
  });

  it('markAllAsRead：只影响本人通知，他人未读不动', async () => {
    await seed();
    await service.markAllAsRead('user-a');
    expect(await service.getUnreadCount('user-a')).toBe(0);
    expect(await service.getUnreadCount('user-b')).toBe(1);
  });
});

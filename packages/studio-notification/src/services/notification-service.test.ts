/**
 * NotificationService tests — #274 写路径归属校验
 * markAsRead 必须校验通知归属：跨用户标记不得生效（此前 tombstone 只按 id 追加，
 * 任何登录用户可把他人通知标已读）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { tmpRoot } = vi.hoisted(() => ({
  tmpRoot: { value: '' },
}));

afterAll(() => {
  if (tmpRoot.value) fs.rmSync(tmpRoot.value, { recursive: true, force: true });
});

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

describe('#468 行动中心扩展', () => {
  it('create：新类型 wu_milestone/monitor_alert/incident 可写入并回读', async () => {
    await service.create({ userId: 'user-a', type: 'wu_milestone', title: 'M', content: 'm' });
    await service.create({ userId: 'user-a', type: 'monitor_alert', title: 'A', content: 'a' });
    await service.create({ userId: 'user-a', type: 'incident', title: 'I', content: 'i' });
    const types = (await service.getUserNotifications('user-a')).map(n => n.type).sort();
    expect(types).toEqual(['incident', 'monitor_alert', 'wu_milestone']);
  });

  it('create：wuId/channelId 结构化字段随数据行持久化并在查询中透出', async () => {
    const n = await service.create({
      userId: 'user-a', type: 'wu_milestone', title: 'M', content: 'm',
      wuId: 'wu-1', channelId: 'ch-1',
    });
    const list = await service.getUserNotifications('user-a');
    const hit = list.find(x => x.id === n.id);
    expect(hit?.wuId).toBe('wu-1');
    expect(hit?.channelId).toBe('ch-1');
  });

  it('create：无 wuId/channelId 时查询透出 null', async () => {
    const { a } = await seed();
    const hit = (await service.getUserNotifications('user-a')).find(x => x.id === a.id);
    expect(hit?.wuId).toBeNull();
    expect(hit?.channelId).toBeNull();
  });

  it('createForAllUsers：遍历 users 目录每个用户各写一条（auditor 先例收敛）', async () => {
    const usersDir = path.join(tmpRoot.value, 'data', 'users');
    fs.mkdirSync(usersDir, { recursive: true });
    fs.writeFileSync(path.join(usersDir, 'user-a.json'), '{}');
    fs.writeFileSync(path.join(usersDir, 'user-b.json'), '{}');
    fs.writeFileSync(path.join(usersDir, 'not-a-user.txt'), '');

    await service.createForAllUsers({ type: 'incident', title: 'T', content: 'c' });

    expect(await service.getUnreadCount('user-a')).toBe(1);
    expect(await service.getUnreadCount('user-b')).toBe(1);
    expect(await service.getUnreadCount('not-a-user')).toBe(0);
  });

  it('createForAllUsers：users 目录不存在时不抛错、不写入', async () => {
    fs.rmSync(path.join(tmpRoot.value, 'data', 'users'), { recursive: true, force: true });
    await expect(
      service.createForAllUsers({ type: 'incident', title: 'T', content: 'c' }),
    ).resolves.toBe(0);
  });
});

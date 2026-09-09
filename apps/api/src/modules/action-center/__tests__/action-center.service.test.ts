// ActionCenterService 派生口径（#468）——服务层直测（HTTP 层见 routes.test.ts）
// 覆盖：三种 kind 同池共存、waitingSince 缺失回退 updatedAt、通知面按 userId 隔离。
import { describe, it, expect } from 'vitest';
import { FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';
import { WorkUnitService } from '../../workunit/workunit.service.js';
import { ActionCenterService } from '../action-center.service.js';

describe('ActionCenterService（#468）', () => {
  it('waitingSince 缺失时 since 回退 updatedAt', async () => {
    const fileStore = new FileStore();
    const wuService = new WorkUnitService(fileStore);
    await wuService.create({
      type: 'task', scope: '无 waitingSince 的挂起', status: 'blocked',
      metadata: { waitingForInput: true },
    });

    const { stateItems } = await new ActionCenterService(fileStore).getActionCenter('local');

    expect(stateItems).toHaveLength(1);
    expect(stateItems[0].kind).toBe('reply');
    expect(stateItems[0].waitingQuestion).toBeUndefined();
    expect(Number.isNaN(Date.parse(stateItems[0].since))).toBe(false);
  });

  it('通知面按 userId 隔离（他人通知不进本人 unreadCount）', async () => {
    const fileStore = new FileStore();
    const notifService = new NotificationService(fileStore);
    await notifService.create({ userId: 'someone-else', type: 'system', title: 'T', content: 'c' });

    const { notifications, unreadCount } = await new ActionCenterService(fileStore).getActionCenter('local');

    expect(notifications).toHaveLength(0);
    expect(unreadCount).toBe(0);
  });
});

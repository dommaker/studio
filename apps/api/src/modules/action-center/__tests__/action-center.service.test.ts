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

  // D-2 项1：reply 深链锚点——messageId = 该 WU 频道线程最新一条非人类消息
  // （与频道页 NEED_INPUT chip「当前提问消息」同口径；fail-closed：缺条件则字段缺省）
  // 注意：本文件共享同一隔离数据根（setup-isolated-data 文件级），断言按 wuId 定位不数全表
  describe('reply messageId 深链锚点（D-2）', () => {
    const msg = (id: string, channelId: string, wuId: string | null, authorType: string, createdAt: string) => ({
      id, channelId, authorType, agentName: authorType === 'human' ? null : 'Coder',
      content: '需要输入: 选哪个方案？', replyToId: null, meta: '{}', workUnitId: wuId, createdAt,
    });

    it('reply 项带 messageId = 该 WU 最新非人类消息（人类插话/他 WU 消息不抢锚点）', async () => {
      const fileStore = new FileStore();
      const wuService = new WorkUnitService(fileStore);
      const wu = await wuService.create({
        type: 'task', scope: '挂起单', channelId: 'ch-d2-1', status: 'blocked',
        metadata: { waitingForInput: true, waitingQuestion: '选哪个方案？' },
      });
      await fileStore.appendMessage('ch-d2-1', msg('m-old', 'ch-d2-1', wu.id, 'agent', '2026-09-09T08:00:00Z'));
      await fileStore.appendMessage('ch-d2-1', msg('m-question', 'ch-d2-1', wu.id, 'agent', '2026-09-09T09:00:00Z'));
      // 人类插话更晚但不作锚点；他 WU 的消息也不算
      await fileStore.appendMessage('ch-d2-1', msg('m-human', 'ch-d2-1', wu.id, 'human', '2026-09-09T10:00:00Z'));
      await fileStore.appendMessage('ch-d2-1', msg('m-other-wu', 'ch-d2-1', 'wu-other', 'agent', '2026-09-09T11:00:00Z'));

      const { stateItems } = await new ActionCenterService(fileStore).getActionCenter('local');

      const item = stateItems.find(i => i.wuId === wu.id);
      expect(item?.kind).toBe('reply');
      expect(item?.messageId).toBe('m-question');
    });

    it('fail-closed：频道内无该 WU 消息 → messageId 缺省（其余字段不受影响）', async () => {
      const fileStore = new FileStore();
      const wuService = new WorkUnitService(fileStore);
      const wu = await wuService.create({
        type: 'task', scope: '无消息挂起单', channelId: 'ch-d2-2', status: 'blocked',
        metadata: { waitingForInput: true },
      });

      const { stateItems } = await new ActionCenterService(fileStore).getActionCenter('local');

      const item = stateItems.find(i => i.wuId === wu.id);
      expect(item?.kind).toBe('reply');
      expect(item?.messageId).toBeUndefined();
    });

    it('fail-closed：无 channelId → messageId 缺省', async () => {
      const fileStore = new FileStore();
      const wuService = new WorkUnitService(fileStore);
      const wu = await wuService.create({
        type: 'task', scope: '无频道挂起单', status: 'blocked',
        metadata: { waitingForInput: true },
      });

      const { stateItems } = await new ActionCenterService(fileStore).getActionCenter('local');

      const item = stateItems.find(i => i.wuId === wu.id);
      expect(item?.channelId).toBeNull();
      expect(item?.messageId).toBeUndefined();
    });

    it('review/confirm 项不带 messageId（字段为 reply 专用，additive）', async () => {
      const fileStore = new FileStore();
      const wuService = new WorkUnitService(fileStore);
      const reviewWu = await wuService.create({ type: 'analysis', scope: '待验收单', channelId: 'ch-d2-3', status: 'in_review' });
      const confirmWu = await wuService.create({ type: 'task', scope: '待确认单', channelId: 'ch-d2-3', status: 'pending' });

      const { stateItems } = await new ActionCenterService(fileStore).getActionCenter('local');

      const review = stateItems.find(i => i.wuId === reviewWu.id);
      const confirm = stateItems.find(i => i.wuId === confirmWu.id);
      expect(review?.kind).toBe('review');
      expect(confirm?.kind).toBe('confirm');
      expect(review?.messageId).toBeUndefined();
      expect(confirm?.messageId).toBeUndefined();
    });
  });
});

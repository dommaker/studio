// ActionCenterService 派生口径（#468）——服务层直测（HTTP 层见 routes.test.ts）
// 覆盖：三种 kind 同池共存、waitingSince 缺失回退 updatedAt、通知面按 userId 隔离。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '../../notifications/index.js';
import { WorkUnitService } from '../../workunit/workunit-review.js';
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

  it('PERF-07：只做 blocked/in_review/pending 过滤读穿，不做全量或 per-WU 聚合读取', async () => {
    const fileStore = new FileStore();
    const wuService = new WorkUnitService(fileStore);
    const blocked = await wuService.create({ type: 'task', scope: '挂起', status: 'blocked', metadata: { waitingForInput: true } });
    const review = await wuService.create({ type: 'analysis', scope: '验收', status: 'in_review' });
    const pending = await wuService.create({ type: 'task', scope: '确认', status: 'pending' });
    const getIndex = vi.spyOn(fileStore, 'getIndex');
    const listCurrentSnapshots = vi.spyOn(fileStore, 'listCurrentSnapshots');

    const { stateItems } = await new ActionCenterService(fileStore).getActionCenter('local');

    expect(getIndex.mock.calls).toEqual([
      [{ statuses: ['blocked', 'in_review', 'pending'] }],
    ]);
    expect(listCurrentSnapshots).not.toHaveBeenCalled();
    expect(stateItems.filter(item => [blocked.id, review.id, pending.id].includes(item.wuId)).map(item => item.kind).sort()).toEqual(['confirm', 'reply', 'review']);
  });

  it('PERF-07：并发 Action Center 共享过滤读穿，派生互不影响', async () => {
    const fileStore = new FileStore();
    const wuService = new WorkUnitService(fileStore);
    const blocked = await wuService.create({ type: 'task', scope: '挂起', status: 'blocked', metadata: { waitingForInput: true } });
    const review = await wuService.create({ type: 'analysis', scope: '验收', status: 'in_review' });
    const pending = await wuService.create({ type: 'task', scope: '确认', status: 'pending' });
    const getIndex = vi.spyOn(fileStore, 'getIndex');
    const listCurrentSnapshots = vi.spyOn(fileStore, 'listCurrentSnapshots');
    const originalRead = fs.promises.readFile.bind(fs.promises);
    const originalStat = fs.promises.stat.bind(fs.promises);
    let indexReads = 0;
    let indexStats = 0;
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike | fs.promises.FileHandle, options?: unknown) => {
      if (String(file).endsWith('workunits/index.json')) indexReads++;
      return originalRead(file as fs.PathLike, options as { encoding?: BufferEncoding | null });
    }) as typeof fs.promises.readFile);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, options?: unknown) => {
      if (String(file).endsWith('workunits/index.json')) indexStats++;
      return originalStat(file, options as never);
    }) as typeof fs.promises.stat);
    const service = new ActionCenterService(fileStore);

    const results = await Promise.all(Array.from({ length: 10 }, () => service.getActionCenter('local')));

    expect(getIndex).toHaveBeenCalledTimes(10);
    expect(getIndex.mock.calls.every(([filter]) => filter && Object.keys(filter).length === 1 && 'statuses' in filter)).toBe(true);
    expect(indexStats).toBe(10);
    expect(indexReads).toBe(1);
    expect(listCurrentSnapshots).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result.stateItems.filter(item => [blocked.id, review.id, pending.id].includes(item.wuId)).map(item => item.kind).sort()).toEqual(['confirm', 'reply', 'review']);
    }
  });

  it('PERF-05：通知 list+unreadCount 取同一份 view，不分开 fold', async () => {
    const fileStore = new FileStore();
    const notificationService = {
      getUserNotificationView: vi.fn().mockResolvedValue({ notifications: [], unreadCount: 0 }),
      getUserNotifications: vi.fn(),
      getUnreadCount: vi.fn(),
    };
    await new ActionCenterService(fileStore, notificationService as never).getActionCenter('local');
    expect(notificationService.getUserNotificationView).toHaveBeenCalledWith('local', { limit: 50 });
    expect(notificationService.getUserNotifications).not.toHaveBeenCalled();
    expect(notificationService.getUnreadCount).not.toHaveBeenCalled();
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

    it('B2：锚点改 readMessagesTail 谓词倒扫 limit 1，不再全热文件 queryMessages 串行扫', async () => {
      const fileStore = new FileStore();
      const wuService = new WorkUnitService(fileStore);
      const wu = await wuService.create({
        type: 'task', scope: '挂起单', channelId: 'ch-d2-tail', status: 'blocked',
        metadata: { waitingForInput: true, waitingQuestion: '选哪个方案？' },
      });
      await fileStore.appendMessage('ch-d2-tail', msg('m-tail-q', 'ch-d2-tail', wu.id, 'agent', '2026-09-09T09:00:00Z'));
      const tailSpy = vi.spyOn(fileStore, 'readMessagesTail');
      const querySpy = vi.spyOn(fileStore, 'queryMessages');

      const { stateItems } = await new ActionCenterService(fileStore).getActionCenter('local');

      const item = stateItems.find(i => i.wuId === wu.id);
      expect(item?.messageId).toBe('m-tail-q');
      expect(tailSpy).toHaveBeenCalledWith('ch-d2-tail', expect.objectContaining({ limit: 1 }));
      expect(querySpy).not.toHaveBeenCalled();
    });

    it('PERF-07：同一 channel version 复用提问锚点，版本推进后重扫', async () => {
      const fileStore = new FileStore();
      const wuService = new WorkUnitService(fileStore);
      const wu = await wuService.create({
        type: 'task', scope: '挂起单', channelId: 'ch-d2-cache', status: 'blocked',
        metadata: { waitingForInput: true, waitingQuestion: '选哪个方案？' },
      });
      await fileStore.appendMessage('ch-d2-cache', msg('m-cache-q', 'ch-d2-cache', wu.id, 'agent', '2026-09-09T09:00:00Z'));
      const service = new ActionCenterService(fileStore);
      const tailSpy = vi.spyOn(fileStore, 'readMessagesTail');

      await service.getActionCenter('local');
      await service.getActionCenter('local');
      const targetCalls = () => tailSpy.mock.calls.filter(([channelId]) => channelId === 'ch-d2-cache').length;
      expect(targetCalls()).toBe(1);

      await fileStore.appendMessage('ch-d2-cache', msg('m-cache-new', 'ch-d2-cache', null, 'human', '2026-09-09T10:00:00Z'));
      await service.getActionCenter('local');
      expect(targetCalls()).toBe(2);
    });

    it('PERF-07：waitingMessageCache 有界且完结清理，不影响全部 stateItems', async () => {
      const fileStore = new FileStore();
      const wuService = new WorkUnitService(fileStore);
      const service = new ActionCenterService(fileStore);
      const created = [];
      for (let i = 0; i < 70; i++) {
        created.push(await wuService.create({
          type: 'task', scope: `cache-${i}`, channelId: 'ch-lru', status: 'blocked',
          metadata: { waitingForInput: true, waitingQuestion: `q-${i}` },
        }));
      }

      const first = await service.getActionCenter('local');
      const cache = (service as unknown as { waitingMessageCache: Map<string, unknown> }).waitingMessageCache;
      expect(cache.size).toBeLessThanOrEqual(64);
      expect(created.every(wu => first.stateItems.some(item => item.wuId === wu.id))).toBe(true);

      for (const wu of created.slice(0, 69)) await wuService.close(wu.id, { reason: 'perf cache cleanup', closedBy: 'human-command' });
      await service.getActionCenter('local');
      for (const wu of created.slice(0, 69)) expect(cache.has(`${wu.id}:ch-lru`)).toBe(false);
      expect(cache.has(`${created[69].id}:ch-lru`)).toBe(true);
    });
  });
});

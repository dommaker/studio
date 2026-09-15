// #495: 决策12 默认角色派单合并窗口（方案 a，票内预授权 2026-09-11）
// 短时间窗内同频道连续无 @ 消息合并进在途 WU 线程（继续对话 = 继续任务），
// 不再每条闲聊建一张新 WU；窗口外 / WU 已终态 / @mention 仍正常建单。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { routeMessage, getMergeWindowMs } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;
let workUnitService: WorkUnitService;

async function findWu(id: string) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

async function countWu(channelId: string): Promise<number> {
  return (await fileStore.getIndex()).filter(s => s.channelId === channelId).length;
}

function parseMeta(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
}

describe('#495: 决策12 派单合并窗口（方案 a）', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-routing-merge-test-'));
    fileStore = new FileStore(tmpDir);
    channelId = `test-merge-${Date.now()}`;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    workUnitService = new WorkUnitService(fileStore);
    await fileStore.createChannel({
      id: channelId, name: `#test-merge`, type: 'rnd',
      defaultProfileId: 'default-agent-1',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    channelMessageService.setFileStore(fileStore);
  });

  afterEach(() => {
    delete process.env.STUDIO_CHANNEL_MERGE_WINDOW_MINUTES;
  });

  it('窗口内第二条无 @ 消息 → 合并进在途 WU，不建新单', async () => {
    const first = await routeMessage(channelId, '帮我看下这个报错', undefined, { fs: fileStore });
    const wuCount = await countWu(channelId);
    expect(wuCount).toBe(1);

    const second = await routeMessage(channelId, '日志在这里', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(1); // 没有第二张单
    expect(second.workUnitId).toBe(first.workUnitId);
    // 合并消息挂在在途 WU 的派发线程下（anchor = 首条派发消息）
    expect(second.replyToId).toBe(first.id);
    // 内容注入 pendingReplies（unassigned WU 首轮 step 即注入 prompt）
    const wu = await findWu(first.workUnitId!);
    expect(parseMeta(wu!.metadata).pendingReplies).toEqual(['日志在这里']);
  });

  it('连发 3 条闲聊 → 仍只 1 张 WU（滑动窗口：合并消息刷新窗口锚点）', async () => {
    const first = await routeMessage(channelId, '第一条', undefined, { fs: fileStore });
    await routeMessage(channelId, '第二条', undefined, { fs: fileStore });
    const third = await routeMessage(channelId, '第三条', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(1);
    expect(third.workUnitId).toBe(first.workUnitId);
    const wu = await findWu(first.workUnitId!);
    expect(parseMeta(wu!.metadata).pendingReplies).toEqual(['第二条', '第三条']);
  });

  it('在途 WU 为 blocked（挂起等输入）→ 窗口内合并 = 复活 + 回复注入', async () => {
    // 直接造一张挂起 WU + 窗口内的人类消息（模拟刚发生的派单线程回复场景）
    const wu = await workUnitService.create({
      scope: '卡住的任务', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
    });
    await workUnitService.transitionStatus(wu.id, 'blocked');
    await workUnitService.update(wu.id, {
      metadata: { waitingForInput: true, waitingQuestion: '继续吗？', waitingSince: new Date().toISOString() },
    });
    const lastHuman: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '刚才的指令', replyToId: null, meta: '{}', workUnitId: wu.id,
      createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, lastHuman);

    const merged = await routeMessage(channelId, '继续，用方案 B', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(1);
    expect(merged.workUnitId).toBe(wu.id);
    const after = await findWu(wu.id);
    expect(after!.status).toBe('active');
    expect(parseMeta(after!.metadata).pendingReplies).toEqual(['继续，用方案 B']);
  });

  it('窗口外（上轮人类消息超过阈值）→ 正常新建 WU', async () => {
    const wu = await workUnitService.create({
      scope: '旧任务', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
    });
    // 上轮消息在 10 分钟前（默认窗口 5 分钟之外）
    const stale: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '十分钟前的消息', replyToId: null, meta: '{}', workUnitId: wu.id,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    await fileStore.appendMessage(channelId, stale);

    const result = await routeMessage(channelId, '新话题：帮我部署一下', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(2);
    expect(result.workUnitId).not.toBe(wu.id);
    expect(result.workUnitId).toBeTruthy();
  });

  it('最近 WU 已终态（done）→ 不合并，新建 WU', async () => {
    const wu = await workUnitService.create({
      scope: '已完成任务', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
    });
    await workUnitService.transitionStatus(wu.id, 'in_review');
    await workUnitService.transitionStatus(wu.id, 'done');
    const lastHuman: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '刚派发的消息', replyToId: null, meta: '{}', workUnitId: wu.id,
      createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, lastHuman);

    const result = await routeMessage(channelId, '新任务来了', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(2);
    expect(result.workUnitId).not.toBe(wu.id);
  });

  it('@mention 路径行为不变：窗口内 @ 消息仍建新 WU', async () => {
    await routeMessage(channelId, '先聊一句', undefined, { fs: fileStore });
    expect(await countWu(channelId)).toBe(1);

    const result = await routeMessage(channelId, '@Somebody 显式派单', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(2);
    const wu = await findWu(result.workUnitId!);
    expect(parseMeta(wu!.metadata).creationMode).toBe('mention');
  });

  it('未配置默认角色的频道不受影响（维持纯存储）', async () => {
    await fileStore.updateChannel(channelId, { defaultProfileId: null });

    const result = await routeMessage(channelId, '纯闲聊', undefined, { fs: fileStore });

    expect(result.workUnitId).toBeNull();
    expect(await countWu(channelId)).toBe(0);
  });

  it('在途 WU metadata 为畸形 JSON → 合并不抛错，照章并入（parseWuMetadata 容错口径）', async () => {
    const wu = await workUnitService.create({
      scope: '畸形元数据任务', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
    });
    // 直接把快照 metadata 写成坏 JSON（绕过 service 序列化），模拟脏数据
    const snap = await findWu(wu.id);
    await fileStore.upsertSnapshot({ ...snap!, metadata: '{corrupted-json' });
    const lastHuman: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '刚才的指令', replyToId: null, meta: '{}', workUnitId: wu.id,
      createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, lastHuman);

    const merged = await routeMessage(channelId, '继续补充', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(1);
    expect(merged.workUnitId).toBe(wu.id);
  });

  it('窗口阈值可由 STUDIO_CHANNEL_MERGE_WINDOW_MINUTES 覆盖', async () => {
    process.env.STUDIO_CHANNEL_MERGE_WINDOW_MINUTES = '30';
    expect(getMergeWindowMs()).toBe(30 * 60_000);
    delete process.env.STUDIO_CHANNEL_MERGE_WINDOW_MINUTES;
    expect(getMergeWindowMs()).toBe(5 * 60_000); // 默认 5 分钟
    process.env.STUDIO_CHANNEL_MERGE_WINDOW_MINUTES = 'abc';
    expect(getMergeWindowMs()).toBe(5 * 60_000); // 非法值回落默认
  });
});

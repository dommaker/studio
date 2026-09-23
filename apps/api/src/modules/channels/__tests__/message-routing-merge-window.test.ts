// #632: 合并窗口解耦（决策已坍缩：退役 defaultProfileId，合并窗口移到所有无地址消息主路径）
// + 歧义守卫（窗口内 ≥2 个不同在途 WU → fail-closed 纯存储）
// + 发送前显式意图（intent: new-task 建未指派单 / plain 纯存储 / 缺省自动合并判定）。
// 前身 = #495 决策12 派单合并窗口测试（合并窗口嵌在 defaultProfileId 分支内）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { routeMessage, getMergeWindowMs, resolveMergeTarget } from '../message-routing.js';
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

/** 造一张在途 WU + 窗口内一条携带它的人类消息（模拟刚发生的派发/回复落点） */
async function seedInFlightWuWithMessage(
  scope: string,
  opts: { status?: string; minutesAgo?: number; anchor?: boolean } = {},
) {
  const wu = await workUnitService.create({
    scope, channelId, type: 'task', status: opts.status ?? 'active', assigneeId: 'instance-1',
  });
  const human: ChannelMessageData = {
    id: uuidv4(), channelId, authorType: 'human', agentName: null,
    content: `关于「${scope}」的消息`, replyToId: null, meta: '{}', workUnitId: wu.id,
    createdAt: new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString(),
  };
  await fileStore.appendMessage(channelId, human);
  return wu;
}

describe('#632: 合并窗口解耦 + 歧义守卫 + 显式意图', () => {
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
    // #632：无需任何频道配置——合并窗口对所有无 @ 无 replyTo 消息生效
    await fileStore.createChannel({
      id: channelId, name: `#test-merge`, type: 'rnd',
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

  it('无配置频道：窗口内唯一在途 WU → 无 @ 消息并入该 WU 线程，不建新单', async () => {
    const wu = await seedInFlightWuWithMessage('帮我看下这个报错', { status: 'unassigned' });
    await workUnitService.update(wu.id, { metadata: {} });

    const merged = await routeMessage(channelId, '日志在这里', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(1);
    expect(merged.workUnitId).toBe(wu.id);
    expect(parseMeta((await findWu(wu.id))!.metadata).pendingReplies).toEqual(['日志在这里']);
  });

  it('连发 3 条 → 仍只 1 张 WU（滑动窗口：合并消息刷新窗口锚点）', async () => {
    const wu = await seedInFlightWuWithMessage('第一条', { status: 'unassigned' });

    await routeMessage(channelId, '第二条', undefined, { fs: fileStore });
    const third = await routeMessage(channelId, '第三条', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(1);
    expect(third.workUnitId).toBe(wu.id);
    expect(parseMeta((await findWu(wu.id))!.metadata).pendingReplies).toEqual(['第二条', '第三条']);
  });

  it('在途 WU 为 blocked（挂起等输入）→ 窗口内合并 = 复活 + 回复注入', async () => {
    const wu = await seedInFlightWuWithMessage('卡住的任务');
    await workUnitService.transitionStatus(wu.id, 'blocked');
    await workUnitService.update(wu.id, {
      metadata: { waitingForInput: true, waitingQuestion: '继续吗？', waitingSince: new Date().toISOString() },
    });

    const merged = await routeMessage(channelId, '继续，用方案 B', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(1);
    expect(merged.workUnitId).toBe(wu.id);
    const after = await findWu(wu.id);
    expect(after!.status).toBe('active');
    expect(parseMeta(after!.metadata).pendingReplies).toEqual(['继续，用方案 B']);
  });

  it('窗口外（上轮人类消息超过阈值）→ 纯存储（#632：不再有任何自动建单路径）', async () => {
    await seedInFlightWuWithMessage('旧任务', { minutesAgo: 10 });

    const result = await routeMessage(channelId, '新话题：帮我部署一下', undefined, { fs: fileStore });

    expect(result.workUnitId).toBeNull();
    expect(await countWu(channelId)).toBe(1); // 只有种子 WU，没有新单
  });

  it('最近 WU 已终态（done）→ 不并入，纯存储', async () => {
    const wu = await seedInFlightWuWithMessage('已完成任务');
    await workUnitService.transitionStatus(wu.id, 'in_review');
    await workUnitService.transitionStatus(wu.id, 'done');

    const result = await routeMessage(channelId, '新任务来了', undefined, { fs: fileStore });

    expect(result.workUnitId).toBeNull();
    expect(await countWu(channelId)).toBe(1);
  });

  it('歧义守卫：窗口内最近人类消息涉及 ≥2 个不同在途 WU → 纯存储，不并入任一', async () => {
    const wuA = await seedInFlightWuWithMessage('任务 A');
    const wuB = await seedInFlightWuWithMessage('任务 B');

    const result = await routeMessage(channelId, '这条说不清是给谁的', undefined, { fs: fileStore });

    expect(result.workUnitId).toBeNull();
    expect(await countWu(channelId)).toBe(2); // 两张种子单原样，不建第三张
    expect(parseMeta((await findWu(wuA.id))!.metadata).pendingReplies).toBeUndefined();
    expect(parseMeta((await findWu(wuB.id))!.metadata).pendingReplies).toBeUndefined();
  });

  it('歧义守卫不计窗口外/终态 WU：一在途一终态 → 并入在途那张', async () => {
    const done = await seedInFlightWuWithMessage('已完成的任务');
    await workUnitService.transitionStatus(done.id, 'in_review');
    await workUnitService.transitionStatus(done.id, 'done');
    const live = await seedInFlightWuWithMessage('在途的任务');

    const result = await routeMessage(channelId, '补充一点', undefined, { fs: fileStore });

    expect(result.workUnitId).toBe(live.id);
  });

  it('@mention 路径行为不变：窗口内 @ 消息仍建新 WU', async () => {
    await seedInFlightWuWithMessage('先聊一句', { status: 'unassigned' });

    const result = await routeMessage(channelId, '@Somebody 显式派单', undefined, { fs: fileStore });

    expect(await countWu(channelId)).toBe(2);
    expect(parseMeta((await findWu(result.workUnitId!))!.metadata).creationMode).toBe('mention');
  });

  it('intent=new-task：即便有唯一合并目标也建未指派 WU（creationMode=channel-new-task，涌现认领）', async () => {
    const wu = await seedInFlightWuWithMessage('在途任务', { status: 'unassigned' });

    const result = await routeMessage(channelId, '这是一件新事', undefined, { fs: fileStore, intent: 'new-task' });

    expect(await countWu(channelId)).toBe(2);
    expect(result.workUnitId).not.toBe(wu.id);
    const created = await findWu(result.workUnitId!);
    expect(created!.status).toBe('unassigned');
    expect(created!.assigneeId).toBeNull();
    const meta = parseMeta(created!.metadata);
    expect(meta.creationMode).toBe('channel-new-task');
    expect(meta.anchorMessageId).toBe(result.id); // 认领播报线程锚点（#494 同口径）
  });

  it('intent=plain：即便有唯一合并目标也纯存储', async () => {
    const wu = await seedInFlightWuWithMessage('在途任务', { status: 'unassigned' });

    const result = await routeMessage(channelId, '纯闲聊不用动任务', undefined, { fs: fileStore, intent: 'plain' });

    expect(result.workUnitId).toBeNull();
    expect(await countWu(channelId)).toBe(1);
    expect(parseMeta((await findWu(wu.id))!.metadata).pendingReplies).toBeUndefined();
  });

  it('resolveMergeTarget 返回三态：唯一目标带 anchorMessageId / 歧义 / 无目标', async () => {
    // 无目标
    expect((await resolveMergeTarget(channelId, fileStore, workUnitService)).kind).toBe('none');

    // 唯一目标（anchorMessageId 来自 WU metadata）
    const wu = await seedInFlightWuWithMessage('唯一任务');
    await workUnitService.update(wu.id, { metadata: { anchorMessageId: 'anchor-1' } });
    const unique = await resolveMergeTarget(channelId, fileStore, workUnitService);
    expect(unique).toEqual({ kind: 'unique', target: { id: wu.id, anchorMessageId: 'anchor-1' } });

    // 歧义
    await seedInFlightWuWithMessage('第二件事');
    expect((await resolveMergeTarget(channelId, fileStore, workUnitService)).kind).toBe('ambiguous');
  });

  it('在途 WU metadata 为畸形 JSON → 合并不抛错，照章并入（parseWuMetadata 容错口径）', async () => {
    const wu = await seedInFlightWuWithMessage('畸形元数据任务');
    const snap = await findWu(wu.id);
    await fileStore.upsertSnapshot({ ...snap!, metadata: '{corrupted-json' });

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

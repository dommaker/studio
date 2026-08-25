// wu-messenger 契约测试：WU 频道系统消息统一出口（postWuSystemMessage）
// 覆盖：里程碑 meta 形状（pmoId 解析命中/未命中/非里程碑）、meta 合并覆盖、
//       anchor 选择（最早根消息，AC-C2 迁移自 agent-loop-v2.test.ts）、显式 replyToId 跳过 anchor、
//       空 content / 无 channelId 守卫、eventBus + SSE 发布、agentName 默认/覆盖。
// 约定与 waiting-input.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService；
// pmo-branch-resolver mock（wu-messenger 内 lazy import，同一模块绝对路径被 vi.mock 拦截）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, eventBus, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../workunit.service.js';

const { mockResolvePmoProjectId } = vi.hoisted(() => ({
  mockResolvePmoProjectId: vi.fn(),
}));

vi.mock('../../requirements/pmo-branch-resolver', () => ({
  resolvePmoBranchForWU: vi.fn().mockResolvedValue(null),
  resolvePmoProjectIdForWU: mockResolvePmoProjectId,
}));

import { postWuSystemMessage } from '../wu-messenger.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolvePmoProjectId.mockResolvedValue(null);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-messenger-test-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-msg-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#msg-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createWu(metadata?: Record<string, unknown>): Promise<WorkUnitData> {
  return wuService.create({
    scope: '实现登录功能', channelId, type: 'task',
    status: 'active', assigneeId: 'instance-1',
    ...(metadata ? { metadata } : {}),
  });
}

/** 追加一条消息（anchor/回复 fixture） */
async function appendMsg(
  wuId: string,
  opts: { content: string; replyToId?: string | null; createdAt: string },
): Promise<ChannelMessageData> {
  const msg: ChannelMessageData = {
    id: uuidv4(), channelId,
    authorType: 'human', agentName: null,
    content: opts.content, replyToId: opts.replyToId ?? null,
    meta: '{}', workUnitId: wuId, createdAt: opts.createdAt,
  };
  await fileStore.appendMessage(channelId, msg);
  return msg;
}

async function storedMessages(wuId: string): Promise<ChannelMessageData[]> {
  return fileStore.queryMessages(channelId, { workUnitId: wuId });
}

describe('postWuSystemMessage 守卫', () => {
  it('空 content → null，不落消息', async () => {
    const wu = await createWu();

    const result = await postWuSystemMessage(wu, '   ', { fileStore });

    expect(result).toBeNull();
    expect(await storedMessages(wu.id)).toHaveLength(0);
  });

  it('wu.channelId 缺失 → null，不落消息', async () => {
    const wu = await wuService.create({ scope: '无频道任务', type: 'task' });

    const result = await postWuSystemMessage(wu, 'hello', { fileStore });

    expect(result).toBeNull();
  });
});

describe('postWuSystemMessage 消息形态', () => {
  it('默认 agentName=Studio，返回 MessageRecord（content 已 trim）', async () => {
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '  系统通知  ', { fileStore });

    expect(record).not.toBeNull();
    expect(record!.authorType).toBe('agent');
    expect(record!.agentName).toBe('Studio');
    expect(record!.content).toBe('系统通知');
    expect(record!.workUnitId).toBe(wu.id);
    const stored = await storedMessages(wu.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].agentName).toBe('Studio');
  });

  it('agentName 可覆盖（agent-loop 回帖传 role.name）', async () => {
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '进度汇报', { fileStore, agentName: 'dev-agent' });

    expect(record!.agentName).toBe('dev-agent');
  });

  it('eventBus + SSE 均发布 channel.message_sent（频道页实时可见 / NotificationBell）', async () => {
    // SSE 与进程内事件同走 eventBus（#324），单一 spy 按 channel 断言
    const busSpy = vi.spyOn(eventBus, 'publish');
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '实时可见', { fileStore });

    expect(busSpy).toHaveBeenCalledWith('channel.message_sent', expect.objectContaining({
      channelId,
      message: expect.objectContaining({ id: record!.id }),
    }));
    const sseCall = busSpy.mock.calls.find(c =>
      c[0] === 'events' && (c[1] as { event_type?: string }).event_type === 'channel.message_sent');
    expect(sseCall).toBeDefined();
    const envelope = sseCall![1] as { event_type: string; data: { channelId: string } };
    expect(envelope.event_type).toBe('channel.message_sent');
    expect(envelope.data.channelId).toBe(channelId);
    busSpy.mockRestore();
  });
});

describe('anchor 线程锚点（AC-C2 迁移）', () => {
  it('挂到该 WU 线程的首条根消息（回复不作为 anchor）', async () => {
    const wu = await createWu();
    const root = await appendMsg(wu.id, { content: 'anchor message', createdAt: '2026-08-01T00:00:00Z' });
    await appendMsg(wu.id, { content: 'thread reply', replyToId: root.id, createdAt: '2026-08-01T00:01:00Z' });

    const record = await postWuSystemMessage(wu, '跟进', { fileStore });

    expect(record!.replyToId).toBe(root.id);
  });

  it('多条根消息取最早一条', async () => {
    const wu = await createWu();
    const later = await appendMsg(wu.id, { content: 'later root', createdAt: '2026-08-01T00:02:00Z' });
    const earlier = await appendMsg(wu.id, { content: 'earlier root', createdAt: '2026-08-01T00:01:00Z' });

    const record = await postWuSystemMessage(wu, '跟进', { fileStore });

    expect(record!.replyToId).toBe(earlier.id);
    expect(record!.replyToId).not.toBe(later.id);
  });

  it('WU 无任何消息 → replyToId 为 null，仍正常发帖', async () => {
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '无线程消息', { fileStore });

    expect(record).not.toBeNull();
    expect(record!.replyToId).toBeNull();
  });

  it('显式 replyToId → 跳过 anchor 查找，直接用给定值', async () => {
    const wu = await createWu();
    await appendMsg(wu.id, { content: 'root', createdAt: '2026-08-01T00:00:00Z' });

    const record = await postWuSystemMessage(wu, '挂在派发消息上', { fileStore, replyToId: 'explicit-msg-id' });

    expect(record!.replyToId).toBe('explicit-msg-id');
  });
});

describe('里程碑 meta（2026-07 PMO-flow UX §6-3/§10）', () => {
  it('milestone: true + pmoId 解析命中 → meta 带 pmoId + atHuman', async () => {
    mockResolvePmoProjectId.mockResolvedValue('proj-1');
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '转人工', { fileStore, milestone: true });

    expect(record!.meta).toEqual({ pmoId: 'proj-1', atHuman: true });
    // pmoId 解析入参：reqId + 原始 metadata 串 + 调用方 fileStore
    expect(mockResolvePmoProjectId).toHaveBeenCalledWith(
      { reqId: wu.reqId ?? null, metadata: wu.metadata },
      fileStore,
    );
  });

  it('milestone: true + pmoId 解析不到 → meta 不携带 pmoId（atHuman 仍在）', async () => {
    mockResolvePmoProjectId.mockResolvedValue(null);
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '转人工', { fileStore, milestone: true });

    const meta = record!.meta as Record<string, unknown>;
    expect(meta.atHuman).toBe(true);
    expect('pmoId' in meta).toBe(false);
  });

  it('milestone: true + 解析抛错 → best-effort 回落 { atHuman: true }，不阻断发帖', async () => {
    mockResolvePmoProjectId.mockRejectedValue(new Error('store gone'));
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '转人工', { fileStore, milestone: true });

    expect(record).not.toBeNull();
    expect(record!.meta).toEqual({ atHuman: true });
  });

  it('非里程碑（默认）→ 不带 meta（落库为 {}）', async () => {
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '普通系统消息', { fileStore });

    expect(record!.meta).toEqual({});
    expect(mockResolvePmoProjectId).not.toHaveBeenCalled();
    const stored = await storedMessages(wu.id);
    expect(stored[0].meta).toBe('{}');
  });

  it('opts.meta 合并覆盖里程碑 meta（可覆盖 pmoId / atHuman）', async () => {
    mockResolvePmoProjectId.mockResolvedValue('proj-1');
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '自定义', {
      fileStore,
      milestone: true,
      meta: { pmoId: 'proj-override', cardType: 'notice' },
    });

    expect(record!.meta).toEqual({ pmoId: 'proj-override', atHuman: true, cardType: 'notice' });
  });

  it('非里程碑 + opts.meta → meta 原样携带', async () => {
    const wu = await createWu();

    const record = await postWuSystemMessage(wu, '带卡消息', { fileStore, meta: { cardType: 'x' } });

    expect(record!.meta).toEqual({ cardType: 'x' });
  });
});

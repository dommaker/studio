// #688：wu-dispatch.ts 接口级测试——两条建单路径（@mention 派单 / intent=new-task 显式建单）
// 自 message-routing.ts 内联块拆出。装配约定与 message-routing.test.ts 一致：
// 真实 FileStore（tmpdir）+ channelMessageService singleton 注入。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { dispatchMentionMessage, dispatchNewTaskMessage, type WuDispatchDeps } from '../wu-dispatch.js';
import { getChannelMessageService } from '../channel-message.service.js';
import { WorkUnitService } from '../../workunit/workunit-review.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;
let workUnitService: WorkUnitService;

function createTestAgent(store: FileStore, name: string, overrides?: Partial<AgentProfileData>): Promise<void> {
  const now = new Date().toISOString();
  return store.createProfile({
    id: `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: `test agent ${name}`,
    channels: '[]',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function makeDeps(reportDroppedRefs?: (message: unknown) => Promise<void>): WuDispatchDeps {
  return {
    fs: fileStore,
    wuService: workUnitService,
    reportDroppedRefs: reportDroppedRefs ?? (async () => {}),
  };
}

async function findWuById(id: string) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

describe('wu-dispatch：@mention 派单', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-dispatch-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    workUnitService = new WorkUnitService(fileStore);
    channelId = `test-dispatch-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: `#test-dispatch`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    getChannelMessageService().setFileStore(fileStore);
  });

  it('命中成员 → 建单指名 + anchorMessageId 锚定派发消息 + 消息回填 workUnitId', async () => {
    await createTestAgent(fileStore, 'developer');
    const agent = (await fileStore.listProfiles()).find(p => p.name === 'developer')!;
    // 显式频道成员 + defaultPath 归属（#699 起空 members 不再匹配全量 active）
    await fileStore.updateChannel(channelId, { defaultPath: tmpDir, members: JSON.stringify([agent.id]) });
    const message = await dispatchMentionMessage(channelId, '@developer 看下这个', 'developer', {}, makeDeps());

    expect(message.workUnitId).toBeTruthy();
    const wu = await findWuById(message.workUnitId!);
    expect(wu).toBeTruthy();
    expect(wu!.status).toBe('unassigned');
    expect(wu!.assigneeId).toContain('test-developer');
    const meta = JSON.parse(wu!.metadata ?? '{}');
    expect(meta.creationMode).toBe('mention');
    expect(meta.matched).toBe(true);
    expect(meta.mentionName).toBe('developer');
    // #494：anchorMessageId 显式锚定派发消息；返回值即回填后的派发消息
    expect(meta.anchorMessageId).toBe(message.id);
    expect(wu!.scope).toBe('看下这个');
  });

  it('未匹配 mention → 未指派 + matched:false + 频道系统提示（#464）', async () => {
    const message = await dispatchMentionMessage(channelId, '@nobody 干活', 'nobody', {}, makeDeps());

    const wu = await findWuById(message.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
    const meta = JSON.parse(wu!.metadata ?? '{}');
    expect(meta.matched).toBe(false);
    // #464 线程说明（挂在派发消息线程的 Studio 系统消息）
    const { messages } = await fileStore.readMessagesTail(channelId, {
      limit: 10,
      match: m => m.authorType === 'agent',
    });
    expect(messages.some(m => m.content.includes('未找到角色 @nobody') && m.replyToId === message.id)).toBe(true);
  });

  it('无归属 → parked（blocked + waitingForInput ownership）+ 挂起提问（B3a/#464 milestone）', async () => {
    await createTestAgent(fileStore, 'developer');
    const message = await dispatchMentionMessage(channelId, '@developer 做个东西', 'developer', {}, makeDeps());

    const wu = await findWuById(message.workUnitId!);
    expect(wu!.status).toBe('blocked');
    const meta = JSON.parse(wu!.metadata ?? '{}');
    expect(meta.waitingForInput).toBe(true);
    expect(meta.waitingReason).toBe('ownership');
    expect(meta.ownershipSource).toBe('none');
    const { messages } = await fileStore.readMessagesTail(channelId, {
      limit: 10,
      match: m => m.authorType === 'agent',
    });
    expect(messages.some(m => m.content.includes('正在等待你的回复') && m.replyToId === message.id)).toBe(true);
  });

  it('traceId 透传落 WU metadata（#519）', async () => {
    await createTestAgent(fileStore, 'developer');
    const message = await dispatchMentionMessage(
      channelId, '@developer 带 trace', 'developer', { traceId: 'trace-abc' }, makeDeps(),
    );
    const wu = await findWuById(message.workUnitId!);
    expect(JSON.parse(wu!.metadata ?? '{}').traceId).toBe('trace-abc');
  });

  it('reportDroppedRefs 以回填后的派发消息为入参被调用', async () => {
    await createTestAgent(fileStore, 'developer');
    const seen: string[] = [];
    await dispatchMentionMessage(channelId, '@developer 引用剔除', 'developer', {}, makeDeps(async m => {
      seen.push((m as { id: string }).id);
    }));
    expect(seen).toHaveLength(1);
  });
});

describe('wu-dispatch：intent=new-task 显式建单', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-dispatch-newtask-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    workUnitService = new WorkUnitService(fileStore);
    channelId = `test-newtask-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: `#test-newtask`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    getChannelMessageService().setFileStore(fileStore);
  });

  it('建未指派 WU 走涌现认领（creationMode=channel-new-task，scope=原文，不做归属解析）', async () => {
    const message = await dispatchNewTaskMessage(channelId, '全新任务内容', {}, makeDeps());

    expect(message.workUnitId).toBeTruthy();
    const wu = await findWuById(message.workUnitId!);
    expect(wu!.status).toBe('unassigned');
    expect(wu!.assigneeId).toBeNull();
    expect(wu!.scope).toBe('全新任务内容');
    const meta = JSON.parse(wu!.metadata ?? '{}');
    expect(meta.creationMode).toBe('channel-new-task');
    expect(meta.anchorMessageId).toBe(message.id);
    expect(meta.ownershipSource).toBeUndefined();
  });

  it('traceId 透传落 WU metadata（#519，与 mention 路径同口径）', async () => {
    const message = await dispatchNewTaskMessage(channelId, '带 trace 的新任务', { traceId: 'trace-xyz' }, makeDeps());
    const wu = await findWuById(message.workUnitId!);
    expect(JSON.parse(wu!.metadata ?? '{}').traceId).toBe('trace-xyz');
  });
});

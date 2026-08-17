// #175（#55 决议，2026-08 落地）：认领/步失败频道发声
// 决策点：
// 1. 每次认领（含超时释放后的再认领）→ WU 线程普通消息「『角色名』已认领任务，开始执行」，
//    与 timeout-release 的「已释放回池」配对成完整叙事
// 2. 每次步失败 → 普通消息「『角色名』执行失败（第 N 次）：原因截断」；重试不单独发声
//   （下次成功的 progress 自然翻篇）；连续第 3 次走既有 blocked 里程碑收尾，不额外发声
// 3. 两类消息按系统通知对待：不过 §4.2 发言层新鲜度检查、不带里程碑 meta（atHuman）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService/wu-messenger；CLI 执行与 knowledge-service mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-175',
  name: 'ann-agent',
  description: '#175 test agent',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

interface LoopPrivates {
  claimAndAnnounce(workUnit: unknown): Promise<boolean>;
  recordResult(target: unknown, result: unknown): Promise<void>;
  instance: unknown;
}

describe('#175: 认领/步失败频道发声（#55 决议）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-175-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-175-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#175-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
    // 不 start()：claimAndAnnounce/recordResult 不依赖运行中的 loop；仅补 instance（claim 需要 instanceId）
    (agentLoop as unknown as LoopPrivates).instance = { id: 'instance-175' };
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const loop = () => agentLoop as unknown as LoopPrivates;

  async function channelMessages(wuId: string): Promise<ChannelMessageData[]> {
    return fileStore.queryMessages(channelId, { workUnitId: wuId });
  }

  function metaOf(msg: ChannelMessageData): Record<string, unknown> {
    const raw = (msg as unknown as { meta?: unknown }).meta;
    return typeof raw === 'string' ? JSON.parse(raw) : ((raw as Record<string, unknown>) ?? {});
  }

  async function createUnassignedWorkUnit() {
    return wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });
  }

  async function createActiveWorkUnit(metadata?: WorkUnitMetadata) {
    return wuService.create({
      scope: '实现某个功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-175',
      ...(metadata ? { metadata } : {}),
    });
  }

  // ─── 决策 1：认领发声 ───

  it('认领成功 → WU 线程发「『角色名』已认领任务」普通系统消息（无里程碑 meta）', async () => {
    const wu = await createUnassignedWorkUnit();

    const ok = await loop().claimAndAnnounce(wu);

    expect(ok).toBe(true);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    expect(after.assigneeId).toBe('instance-175');

    const msgs = await channelMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('『ann-agent』已认领任务，开始执行');
    expect(msgs[0].authorType).toBe('agent');
    expect(msgs[0].agentName).toBe('ann-agent');
    expect(metaOf(msgs[0]).atHuman).toBeUndefined(); // 普通消息，非里程碑
  });

  it('认领竞争失败（已被他人领走）→ 返回 false 且不发声', async () => {
    const wu = await createUnassignedWorkUnit();
    await wuService.claim(wu.id, 'instance-other'); // 他人先领走

    const ok = await loop().claimAndAnnounce(wu); // 传入的仍是 unassigned 快照

    expect(ok).toBe(false);
    expect(await channelMessages(wu.id)).toHaveLength(0);
  });

  it('超时释放后再认领 → 再次发声（与 timeout-release 释放消息配对）', async () => {
    const wu = await createUnassignedWorkUnit();

    await loop().claimAndAnnounce(wu);
    await wuService.unclaim(wu.id); // 模拟 timeout-release 释放回池
    const released = (await wuService.getById(wu.id))!;
    expect(released.status).toBe('unassigned');

    const ok = await loop().claimAndAnnounce(released);

    expect(ok).toBe(true);
    const msgs = await channelMessages(wu.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('『ann-agent』已认领任务，开始执行');
  });

  // ─── 决策 2：步失败发声 ───

  it('步失败发「执行失败（第 N 次）：原因」；第 1/2 次各一条，状态保持 active 待重试', async () => {
    const wu = await createActiveWorkUnit();
    const failed = { action: 'failed', summary: 'CLI 执行失败: boom' };

    await loop().recordResult({ workUnit: wu }, failed);
    await loop().recordResult({ workUnit: wu }, failed);

    expect((await wuService.getById(wu.id))!.status).toBe('active');
    const msgs = await channelMessages(wu.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('『ann-agent』执行失败（第 1 次）：CLI 执行失败: boom');
    expect(msgs[1].content).toBe('『ann-agent』执行失败（第 2 次）：CLI 执行失败: boom');
    expect(metaOf(msgs[0]).atHuman).toBeUndefined(); // 普通消息，不带里程碑标
    expect(metaOf(msgs[1]).atHuman).toBeUndefined();
  });

  it('重试不单独发声：失败后 progress 翻篇只发 progress 简报', async () => {
    const wu = await createActiveWorkUnit();

    await loop().recordResult({ workUnit: wu }, { action: 'failed', summary: 'CLI 执行失败: boom' });
    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '恢复推进' });

    const msgs = await channelMessages(wu.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('恢复推进'); // 无独立「重试」消息
  });

  it('连续第 3 次失败 → 仅 blocked 里程碑收尾，不额外发「执行失败」', async () => {
    const wu = await createActiveWorkUnit();
    const failed = { action: 'failed', summary: 'CLI 执行失败: provider quota exhausted' };

    await loop().recordResult({ workUnit: wu }, failed);
    await loop().recordResult({ workUnit: wu }, failed);
    await loop().recordResult({ workUnit: wu }, failed);

    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
    const msgs = await channelMessages(wu.id);
    expect(msgs).toHaveLength(3); // 失败×2 + blocked 里程碑×1
    expect(msgs.filter(m => m.content.includes('执行失败（第'))).toHaveLength(2);
    expect(msgs.some(m => m.content.includes('第 3 次'))).toBe(false);
    expect(msgs[2].content).toContain('连续 3 步无进展');
    expect(metaOf(msgs[2]).atHuman).toBe(true); // blocked 走里程碑标
  });

  it('失败原因截断：超长 summary 截 200 字符', async () => {
    const wu = await createActiveWorkUnit();
    const long = `CLI 执行失败: ${'x'.repeat(500)}`;

    await loop().recordResult({ workUnit: wu }, { action: 'failed', summary: long });

    const msgs = await channelMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe(`『ann-agent』执行失败（第 1 次）：${long.slice(0, 200)}`);
  });

  it('失败消息按系统通知对待：房间有外部新消息时仍照发（不过 §4.2 新鲜度闸）', async () => {
    const wu = await createActiveWorkUnit();
    // step 期间房间来了一条人类消息——对结果回帖构成新鲜度拦截条件；
    // failed 结果不携带 channelVersion（agentStep 口径），失败通知不参与新鲜度判定
    const humanMsg: ChannelMessageData = {
      id: `m-${Date.now()}`, channelId,
      authorType: 'human', agentName: null,
      content: '人类插话', replyToId: null, workUnitId: wu.id,
      meta: '{}', createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, humanMsg);

    await loop().recordResult({ workUnit: wu }, { action: 'failed', summary: 'CLI 执行失败: boom' });

    const msgs = await channelMessages(wu.id);
    const failureMsgs = msgs.filter(m => m.authorType === 'agent');
    expect(failureMsgs).toHaveLength(1);
    expect(failureMsgs[0].content).toContain('执行失败（第 1 次）');
  });
});

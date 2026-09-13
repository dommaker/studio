/**
 * #466: workunit.service.create() 路由展开（吞并 AC-6.3 defaultPipeline 展开）
 *
 * D10 不变：只展开第一跳，后续靠 agent DELEGATE；子 WU type = profile.acceptedTypes[0] 缺省 'task'。
 * 变化：配置源从 channel.defaultPipeline（name 数组）改为 channel.routing.implement（profile id）。
 * 路由回退（票体）：配置了但角色 inactive / 被移出频道 → 不展开（父单留池涌现）+ 频道出声提醒。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, stringifyChannels } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

describe('#466: WorkUnit create() routing.implement expansion', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let service: WorkUnitService;

  const executorProfileId = 'p-exec-wu';
  const reviewerProfileId = 'p-rev-wu';

  async function seedChannel(id: string, opts: { members?: string[]; routing?: Record<string, string | null> } = {}) {
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id, name: `#${id}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: stringifyChannels(opts.members ?? []),
      ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
      createdAt: now, updatedAt: now,
    });
  }

  async function childrenOf(parentId: string) {
    const all = await fileStore.getIndex();
    return all.filter(s => s.parentId === parentId);
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-routing-test-'));
    fileStore = new FileStore(tmpDir);
    service = new WorkUnitService(fileStore);

    const now = new Date().toISOString();
    // executor 带显式职能域；reviewer 不带 —— 覆盖缺省回退
    for (const p of [
      { id: executorProfileId, name: 'executor', acceptedTypes: ['implement'] },
      { id: reviewerProfileId, name: 'reviewer' },
      { id: 'p-inactive-wu', name: 'inactive-agent' },
    ]) {
      await fileStore.createProfile({
        id: p.id, name: p.name, description: null,
        channels: '[]', status: p.id === 'p-inactive-wu' ? 'inactive' : 'active',
        createdAt: now, updatedAt: now,
        ...('acceptedTypes' in p ? { acceptedTypes: p.acceptedTypes } : {}),
      });
    }

    // 路由频道：implement → executor（成员）
    await seedChannel('ch-routing', { members: [executorProfileId, reviewerProfileId], routing: { implement: executorProfileId } });
    // 无路由频道
    await seedChannel('ch-no-routing');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('type=feature + routing.implement -> 创建链头子 WU（assigneeId=路由角色）', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'implement feature X',
      channelId: 'ch-routing',
      status: 'unassigned',
    });

    const children = await childrenOf(parent.id);
    expect(children.length).toBe(1);

    const child = children[0];
    expect(child.type).toBe('implement');         // 决策 10: 阶段名 = profile.acceptedTypes[0]
    expect(child.assigneeId).toBe(executorProfileId);
    expect(child.status).toBe('unassigned');
    expect(child.channelId).toBe('ch-routing');
  });

  it('profile 无 acceptedTypes → 子 WU type 回退为 task', async () => {
    await seedChannel('ch-routing-fallback', { members: [reviewerProfileId], routing: { implement: reviewerProfileId } });

    const parent = await service.create({
      type: 'feature',
      scope: 'fallback feature',
      channelId: 'ch-routing-fallback',
      status: 'unassigned',
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(1);
    expect(children[0].type).toBe('task');
    expect(children[0].assigneeId).toBe(reviewerProfileId);
  });

  it('type=feature + 无路由 -> 不展开', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'feature without routing',
      channelId: 'ch-no-routing',
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(0);
  });

  it('routing 只配置 plan/review（无 implement）-> 不展开', async () => {
    await seedChannel('ch-plan-only', { members: [executorProfileId], routing: { plan: executorProfileId } });
    const parent = await service.create({
      type: 'feature',
      scope: 'feature plan-only routing',
      channelId: 'ch-plan-only',
      status: 'unassigned',
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(0);
  });

  it('路由角色 inactive → 不展开 + 频道出声提醒', async () => {
    await seedChannel('ch-inactive', { members: ['p-inactive-wu'], routing: { implement: 'p-inactive-wu' } });
    const parent = await service.create({
      type: 'feature',
      scope: 'feature inactive routing',
      channelId: 'ch-inactive',
      status: 'unassigned',
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(0);
    const msgs = await fileStore.queryMessages('ch-inactive', {});
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('inactive-agent');
  });

  it('路由角色被移出频道 → 不展开 + 频道出声提醒', async () => {
    await seedChannel('ch-notmember', { members: [reviewerProfileId], routing: { implement: executorProfileId } });
    const parent = await service.create({
      type: 'feature',
      scope: 'feature not-member routing',
      channelId: 'ch-notmember',
      status: 'unassigned',
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(0);
    const msgs = await fileStore.queryMessages('ch-notmember', {});
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('executor');
  });

  it('#464：未配置 implement 路由 → 不展开 + 频道提示（与「配错」可区分）', async () => {
    await seedChannel('ch-unconfigured', { members: [executorProfileId] });
    const parent = await service.create({
      type: 'feature',
      scope: 'feature unconfigured routing',
      channelId: 'ch-unconfigured',
      status: 'unassigned',
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(0);
    const msgs = await fileStore.queryMessages('ch-unconfigured', {});
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('未配置');
  });

  it('#525：未配置提示过 1h 冷却闸——同频道连续建两个 feature 父 WU 只出声一次', async () => {
    await seedChannel('ch-nc-cooldown', { members: [executorProfileId] });
    const first = await service.create({
      type: 'feature',
      scope: 'feature nc cooldown one',
      channelId: 'ch-nc-cooldown',
      status: 'unassigned',
    });
    const second = await service.create({
      type: 'feature',
      scope: 'feature nc cooldown two',
      channelId: 'ch-nc-cooldown',
      status: 'unassigned',
    });
    expect(await childrenOf(first.id)).toHaveLength(0);
    expect(await childrenOf(second.id)).toHaveLength(0);
    const msgs = await fileStore.queryMessages('ch-nc-cooldown', {});
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('未配置');
  });

  it('#525：未配置冷却按频道隔离——另一频道首次仍出声', async () => {
    await seedChannel('ch-nc-cooldown-b', { members: [executorProfileId] });
    await service.create({
      type: 'feature',
      scope: 'feature nc cooldown other channel',
      channelId: 'ch-nc-cooldown-b',
      status: 'unassigned',
    });
    const msgs = await fileStore.queryMessages('ch-nc-cooldown-b', {});
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('未配置');
  });

  it('#464：pending 确认（→unassigned）后无路由 → 频道提示「未配置」', async () => {
    await seedChannel('ch-confirm-noroute', { members: [executorProfileId] });
    const parent = await service.create({
      type: 'feature',
      scope: 'confirm then no route',
      channelId: 'ch-confirm-noroute',
    });
    expect(parent.status).toBe('pending');
    await service.transitionStatus(parent.id, 'unassigned');
    const msgs = await fileStore.queryMessages('ch-confirm-noroute', {});
    // pending 待确认卡（#464 create 出声）+ 确认后未配置路由提示
    expect(msgs.some(m => m.content.includes('未配置'))).toBe(true);
  });

  it('type=task + routing -> 不展开（仅 feature 展开）', async () => {
    const parent = await service.create({
      type: 'task',
      scope: 'task not feature',
      channelId: 'ch-routing',
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(0);
  });

  it('type=feature + 无 channelId -> 不展开', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'feature no channel',
      channelId: null,
    });
    const children = await childrenOf(parent.id);
    expect(children.length).toBe(0);
  });

  it('child WU inherits collab metadata (rootId=parent.id, depth=1)', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'feature collab check',
      channelId: 'ch-routing',
      status: 'unassigned',
    });
    const children = await childrenOf(parent.id);
    const child = children[0];
    expect(child).toBeDefined();
    const meta = child!.metadata ? JSON.parse(child!.metadata) : {};
    expect(meta.collab).toBeDefined();
    expect(meta.collab.rootId).toBe(parent.id);
    expect(meta.collab.depth).toBe(1);
    expect(meta.collab.chain).toContain(executorProfileId);
  });
});

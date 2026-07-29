/**
 * ReviewDispatcher 单测（AC-4.1 ~ AC-4.5 + F4 reviewer 解锚）
 *
 * 覆盖：
 *  - F4: in_review + 频道有其他成员 -> 创建未指派子 WU（assigneeId=null），
 *    metadata.excludeAssignee=实现者 profile id（指名未认领 / 已认领 instance id 两种形态）
 *  - F4 决策 5: 频道内除实现者外无成员 -> 自评兜底（不排除 + selfReview=true + 频道提醒）
 *  - F4: 频道 members 未回填（历史频道）-> 保守按自评兜底
 *  - 已有未完结 review 子 WU -> 跳过（同父唯一性）
 *  - child done + approved -> 父 reviewPassed
 *  - child done + rejected -> 父 reviewRejected
 *  - child done + 无 reviewReport -> 父保持 in_review + 频道转人工（P0 修复，不再默认拒绝）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus, stringifyChannels, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';
import { ReviewDispatcher } from '../review-dispatcher.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let dispatcher: ReviewDispatcher;

const reviewerProfile: AgentProfileData = {
  id: 'reviewer-1',
  name: 'Reviewer',
  description: 'code reviewer 角色',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

const executorProfile: AgentProfileData = {
  id: 'executor-1',
  name: 'Executor',
  description: '执行角色',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

function metaOf(raw: string | null): WorkUnitMetadata {
  return raw ? JSON.parse(raw) as WorkUnitMetadata : {};
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatcher-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  dispatcher = new ReviewDispatcher(fileStore, wuService);

  // Clean eventBus subscribers between tests
  eventBus.unsubscribeAll?.('workunit.status_changed');

  await fileStore.createProfile(reviewerProfile);
  await fileStore.createProfile(executorProfile);
  await fileStore.createChannel({
    id: 'ch-test',
    name: '#test',
    type: 'rnd',
    defaultWorkspaceId: null,
    defaultPath: null,
    discordChannelId: null,
    discordWebhookUrl: null,
    members: stringifyChannels([reviewerProfile.id, executorProfile.id]),
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  });

  dispatcher.subscribeToEvents();
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createParentAndReview(scope: string, assigneeId: string | null) {
  const parent = await wuService.create({
    scope,
    type: 'feature',
    channelId: 'ch-test',
    assigneeId,
    status: 'active',
  });
  await wuService.transitionStatus(parent.id, 'in_review');
  await new Promise(r => setTimeout(r, 100));
  const snapshots = await fileStore.getIndex();
  return { parent, child: snapshots.find(s => s.parentId === parent.id && s.type === 'review') };
}

describe('ReviewDispatcher (AC-4.1 ~ AC-4.5 + F4)', () => {
  it('AC-4.1 + F4: in_review + 有其他成员 -> 未指派子 WU，excludeAssignee=实现者 profile id', async () => {
    // assigneeId 为 profile id（指名未认领形态）
    const { child } = await createParentAndReview('实现功能 A', executorProfile.id);
    expect(child).toBeDefined();
    expect(child!.assigneeId).toBeNull();
    expect(child!.status).toBe('unassigned');
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBe(executorProfile.id);
    expect(meta.selfReview).toBeUndefined();
  });

  it('F4: assigneeId 为 instance id（已认领形态）-> 经 instance.state.roleId 解析排除实现者', async () => {
    await fileStore.createState('inst-exec-1', {
      id: 'inst-exec-1',
      roleId: executorProfile.id,
      status: 'idle',
      startedAt: '2026-07-01T00:00:00Z',
      terminatedAt: null,
      lastHeartbeat: null,
      metadata: null,
    });

    const { child } = await createParentAndReview('实现功能 A2', 'inst-exec-1');
    expect(child).toBeDefined();
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBe(executorProfile.id);
  });

  it('F4 决策 5: 频道内除实现者外无成员 -> 自评兜底（不排除 + selfReview + 频道提醒）', async () => {
    // Channel with only executor (无其他可评审成员)
    await fileStore.updateChannel('ch-test', {
      members: stringifyChannels([executorProfile.id]),
    });

    const { parent, child } = await createParentAndReview('实现功能 B', executorProfile.id);
    expect(child).toBeDefined(); // 不再静默跳过
    expect(child!.assigneeId).toBeNull();
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBeUndefined();
    expect(meta.selfReview).toBe(true);

    const messages = await fileStore.queryMessages('ch-test', { workUnitId: parent.id });
    const sysMsg = messages.find(m => m.authorType === 'agent' && m.agentName === 'Studio');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toContain('自评');
  });

  it('F4: 频道 members 未回填（历史频道）-> 保守按自评兜底', async () => {
    await fileStore.updateChannel('ch-test', { members: '[]' });

    const { child } = await createParentAndReview('实现功能 B2', executorProfile.id);
    expect(child).toBeDefined();
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBeUndefined();
    expect(meta.selfReview).toBe(true);
  });

  it('AC-4.3: 已有未完结 review 子 WU -> 跳过（同父唯一性）', async () => {
    const parent = await wuService.create({
      scope: '实现功能 C',
      type: 'feature',
      channelId: 'ch-test',
      status: 'active',
    });

    // Manually create an existing review child
    await wuService.create({
      scope: '已有审查',
      type: 'review',
      parentId: parent.id,
      assigneeId: reviewerProfile.id,
      channelId: 'ch-test',
      status: 'active',
    });

    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const reviewChildren = snapshots.filter(s => s.parentId === parent.id && s.type === 'review');
    expect(reviewChildren).toHaveLength(1); // 不创建第二个
  });

  it('AC-4.5: child done + approved -> 父 reviewPassed', async () => {
    const { parent, child } = await createParentAndReview('实现功能 D', executorProfile.id);
    expect(child).toBeDefined();

    // Simulate reviewer workflow: claim -> active -> in_review -> write report -> done
    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta = metaOf(child!.metadata);
    childMeta.reviewReport = { approved: true, reason: '代码质量良好' };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('done');
  });

  it('AC-4.5: child done + rejected -> 父 reviewRejected', async () => {
    const { parent, child } = await createParentAndReview('实现功能 E', executorProfile.id);
    expect(child).toBeDefined();

    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta = metaOf(child!.metadata);
    childMeta.reviewReport = { approved: false, reason: '缺少错误处理' };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    expect(['active', 'blocked']).toContain(updatedParent!.status);
  });

  it('AC-4.5 + P0 修复: child done + 无 reviewReport -> 父保持 in_review，频道转人工（不再默认拒绝）', async () => {
    const { parent, child } = await createParentAndReview('实现功能 F', executorProfile.id);
    expect(child).toBeDefined();

    // Don't set reviewReport - just transition through to done
    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    // P0 修复：解析失败不再默认 reviewRejected（误杀）——父 WU 保持 in_review，
    // 频道发系统消息转人工裁决
    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('in_review');

    const messages = await fileStore.queryMessages('ch-test', { workUnitId: parent.id });
    const sysMsg = messages.find(m => m.authorType === 'agent' && m.agentName === 'Studio' && m.content.includes('转人工'));
    expect(sysMsg).toBeDefined();
  });
});

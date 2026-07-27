/**
 * ReviewDispatcher 单测（AC-4.1 ~ AC-4.5）
 *
 * 覆盖：
 *  - in_review + 有 reviewer -> 创建子 WU（type=review, parentId, assigneeId=reviewer）
 *  - in_review + 无 reviewer -> 跳过
 *  - 已有未完结 review 子 WU -> 跳过（同父唯一性）
 *  - child done + approved -> 父 reviewPassed
 *  - child done + rejected -> 父 reviewRejected
 *  - child done + 无 reviewReport -> 父保持 in_review + 频道转人工（P0 修复，不再默认拒绝）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('ReviewDispatcher (AC-4.1 ~ AC-4.5)', () => {
  it('AC-4.1: in_review + 有 reviewer -> 创建 type=review 子 WU', async () => {
    const parent = await wuService.create({
      scope: '实现功能 A',
      type: 'feature',
      channelId: 'ch-test',
      assigneeId: 'instance-exec',
      status: 'active',
    });

    // Simulate parent entering in_review
    await wuService.transitionStatus(parent.id, 'in_review');
    // Wait for async event handler
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const reviewChild = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
    expect(reviewChild).toBeDefined();
    expect(reviewChild!.assigneeId).toBe(reviewerProfile.id);
    expect(reviewChild!.status).toBe('unassigned');
  });

  it('AC-4.2: in_review + 无 reviewer 角色 -> 跳过，不创建子 WU', async () => {
    // Channel with only executor (no reviewer)
    await fileStore.updateChannel('ch-test', {
      members: stringifyChannels([executorProfile.id]),
    });

    const parent = await wuService.create({
      scope: '实现功能 B',
      type: 'feature',
      channelId: 'ch-test',
      status: 'active',
    });

    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const reviewChild = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
    expect(reviewChild).toBeUndefined();
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
    const parent = await wuService.create({
      scope: '实现功能 D',
      type: 'feature',
      channelId: 'ch-test',
      status: 'active',
    });
    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    // Find the created review child
    const snapshots = await fileStore.getIndex();
    const child = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
    expect(child).toBeDefined();

    // Simulate reviewer workflow: claim -> active -> in_review -> write report -> done
    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta: WorkUnitMetadata = child!.metadata ? JSON.parse(child!.metadata) : {};
    childMeta.reviewReport = { approved: true, reason: '代码质量良好' };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('done');
  });

  it('AC-4.5: child done + rejected -> 父 reviewRejected', async () => {
    const parent = await wuService.create({
      scope: '实现功能 E',
      type: 'feature',
      channelId: 'ch-test',
      status: 'active',
    });
    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const child = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
    expect(child).toBeDefined();

    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta: WorkUnitMetadata = child!.metadata ? JSON.parse(child!.metadata) : {};
    childMeta.reviewReport = { approved: false, reason: '缺少错误处理' };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    expect(['active', 'blocked']).toContain(updatedParent!.status);
  });

  it('AC-4.5 + P0 修复: child done + 无 reviewReport -> 父保持 in_review，频道转人工（不再默认拒绝）', async () => {
    const parent = await wuService.create({
      scope: '实现功能 F',
      type: 'feature',
      channelId: 'ch-test',
      status: 'active',
    });
    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const child = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
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
    const sysMsg = messages.find(m => m.authorType === 'agent' && m.agentName === 'Studio');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toContain('转人工');
  });
});

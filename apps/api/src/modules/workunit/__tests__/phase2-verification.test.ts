/**
 * Phase 2 Verification Scenarios — agent-network-migration.md §6
 *
 * 验证 Agent Network 核心机制端到端：
 * 1. 正常流程：message → WorkUnit → claim → in_review → approve → done
 * 2. Review 失败：in_review → reject → active → in_review → done
 * 3. Claim 竞争：乐观锁保证只有一个成功
 * 4. 子 WorkUnit：父子关系 + 状态聚合
 * 5. 依赖解锁：blocked → active when deps done
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';
import { channelMessageService } from '../../channels/channel-message.service.js';

describe('Phase 2 Verification Scenarios', () => {
  let service: WorkUnitService;
  let testChannelId: string;
  const testIds: string[] = [];
  const messageIds: string[] = [];
  let fileStore: FileStore;
  let tmpDir: string;

  beforeAll(async () => {
    // Isolated temp dir for FileStore
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-verify-'));
    fileStore = new FileStore(tmpDir);
    service = new WorkUnitService(fileStore);
    channelMessageService.setFileStore(fileStore);

    // Create channel in FileStore (for message ops)
    const channelName = `#phase2-verify-${Date.now()}`;
    testChannelId = `phase2-ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fileStore.createChannel({
      id: testChannelId,
      name: channelName,
      type: 'rnd',
      defaultWorkspaceId: null,
      defaultPath: null,
      discordChannelId: null,
      discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await fileStore.deleteChannel(testChannelId).catch(() => {});
    await Promise.all(testIds.map(id => service.delete(id).catch(() => {})));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Normal flow (message → WorkUnit → claim → done) ──

  it('Scenario 1: message → WorkUnit → claim → discussion → in_review → approve → done', async () => {
    // Human sends message
    const msg = await channelMessageService.createHumanMessage(
      testChannelId, '需要优化登录页面的加载速度',
    );
    messageIds.push(msg.id);

    // Convert message to WorkUnit
    const wu = await service.createFromMessage(msg.id);
    testIds.push(wu.id);
    // #126：消息转 WU（默认 type=task）落 pending（待确认门）；createFromMessage 不透传 status，
    // 确认（pending → unassigned）后才可被认领
    expect(wu.status).toBe('pending');
    await service.transitionStatus(wu.id, 'unassigned');

    // Verify message linked
    const linked = await fileStore.getMessageById(msg.id);
    expect(linked).not.toBeNull();
    expect(linked!.message.workUnitId).toBe(wu.id);

    // Agent claims
    const claimed = await service.claim(wu.id, 'agent-optimizer');
    expect(claimed.status).toBe('active');
    expect(claimed.assigneeId).toBe('agent-optimizer');

    // Agent updates progress in discussion space
    const progressMsg = await channelMessageService.createAgentMessage(
      testChannelId, 'Optimizer', '正在分析页面加载瓶颈...', { workUnitId: wu.id },
    );
    messageIds.push(progressMsg.id);

    // Agent submits for review
    const inReview = await service.transitionStatus(wu.id, 'in_review');
    expect(inReview.status).toBe('in_review');

    // Human approves
    const done = await service.reviewPassed(wu.id);
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();

    // Discussion space has both messages
    const discussion = await channelMessageService.listByWorkUnitId(wu.id);
    expect(discussion.total).toBeGreaterThanOrEqual(2);
  });

  // ── Scenario 2: Review failure → retry → success ──

  it('Scenario 2: in_review → reject → active → in_review → approve → done', async () => {
    const wu = await service.create({ scope: 'Review retry test', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
    testIds.push(wu.id);

    await service.claim(wu.id, 'agent-dev');

    // First review attempt — rejected
    await service.transitionStatus(wu.id, 'in_review');
    const rejected = await service.reviewRejected(wu.id);
    expect(rejected.status).toBe('active');
    const meta1 = JSON.parse(rejected.metadata ?? '{}');
    expect(meta1._consecutiveReviewRejections).toBe(1);

    // Agent fixes and resubmits
    await service.transitionStatus(wu.id, 'in_review');
    const done = await service.reviewPassed(wu.id);
    expect(done.status).toBe('done');
    const meta2 = JSON.parse(done.metadata ?? '{}');
    expect(meta2._consecutiveReviewRejections).toBeUndefined(); // reset on pass
  });

  it('Scenario 2 edge: 3 consecutive rejections → auto-block', async () => {
    const wu = await service.create({ scope: 'Triple reject test', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
    testIds.push(wu.id);
    await service.claim(wu.id, 'agent-stuck');

    for (let i = 0; i < 3; i++) {
      await service.transitionStatus(wu.id, 'in_review');
      await service.reviewRejected(wu.id);
      // After rejection, status is active (or blocked on 3rd)
      if (i < 2) {
        const current = await service.getById(wu.id);
        expect(current!.status).toBe('active');
      }
    }

    const blocked = await service.getById(wu.id);
    expect(blocked!.status).toBe('blocked');
  });

  // ── Scenario 3: Claim competition ──

  it('Scenario 3: optimistic lock — only one agent claims', async () => {
    const wu = await service.create({ scope: 'Claim race', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
    testIds.push(wu.id);

    const results = await Promise.allSettled([
      service.claim(wu.id, 'agent-fast'),
      service.claim(wu.id, 'agent-slow'),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  // ── Scenario 5: Sub-WorkUnit + parent aggregation ──

  it('Scenario 5: parent-child decomposition + aggregation', async () => {
    // Parent: "Implement auth"
    // #126：task 默认落 pending（不可认领/迁移），父子全部显式置 unassigned 保持原有用例语义
    const parent = await service.create({ scope: 'Implement auth system', status: 'unassigned' });
    testIds.push(parent.id);

    // Children: decomposition
    const analysis = await service.create({ scope: 'Auth requirement analysis', parentId: parent.id, status: 'unassigned' });
    const impl = await service.create({ scope: 'Auth implementation', parentId: parent.id, status: 'unassigned' });
    const review = await service.create({ scope: 'Auth review', parentId: parent.id, status: 'unassigned' });
    testIds.push(analysis.id, impl.id, review.id);

    // Wait for fire-and-forget aggregateParentStatus to settle.
    // transitionStatus triggers async aggregateParentStatus (no await) whose upsertSnapshot
    // is an unlocked read-modify-write; without flushing, concurrent writes corrupt index.json.
    const flushAsync = () => new Promise(r => setTimeout(r, 50));

    // Children complete sequentially
    await service.transitionStatus(analysis.id, 'active');
    await flushAsync();
    await service.transitionStatus(analysis.id, 'in_review');
    await service.transitionStatus(analysis.id, 'done');
    await flushAsync();

    // impl unblocks (manually — unlockDependents removed in Agent Loop rewrite)
    await service.transitionStatus(impl.id, 'active');
    await flushAsync();
    const implAfter = await service.getById(impl.id);
    expect(implAfter!.status).toBe('active');

    await service.transitionStatus(impl.id, 'in_review');
    await service.transitionStatus(impl.id, 'done');
    await flushAsync();

    // review unblocks
    await service.transitionStatus(review.id, 'active');
    await flushAsync();
    const reviewAfter = await service.getById(review.id);
    expect(reviewAfter!.status).toBe('active');

    await service.transitionStatus(review.id, 'in_review');
    await service.transitionStatus(review.id, 'done');
    await flushAsync();

    // Parent aggregation: all children done → in_review
    await service.aggregateParentStatus(review.id);
    const parentAfter = await service.getById(parent.id);
    expect(parentAfter!.status).toBe('in_review');
  });

  it('Scenario 5 edge: 1 closed + rest done → parent in_review', async () => {
    const parent = await service.create({ scope: 'Mixed completion', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
    const c1 = await service.create({ scope: 'Done child', parentId: parent.id, status: 'done' });
    const c2 = await service.create({ scope: 'Closed child', parentId: parent.id, status: 'closed' });
    testIds.push(parent.id, c1.id, c2.id);

    await service.aggregateParentStatus(c1.id);
    const updated = await service.getById(parent.id);
    expect(updated!.status).toBe('in_review');
  });
});

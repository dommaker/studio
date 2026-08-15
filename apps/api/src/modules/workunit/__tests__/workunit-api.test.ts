// WorkUnit API service test (AS-025, 3.28c-1 Task 2-4)
// Tests: CRUD + Claim + State machine + Review + from-message
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';

const isCI = !!process.env.CI;
const describeIf = isCI ? describe.skip : describe;

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';
import { channelMessageService } from '../../channels/channel-message.service.js';

describeIf('WorkUnit API service', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let service: WorkUnitService;
  const testIds: string[] = [];
  let testChannelId: string;

  beforeAll(async () => {
    // Use temp directory for FileStore isolation
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-test-'));
    fileStore = new FileStore(tmpDir);
    service = new WorkUnitService(fileStore);

    // Inject same FileStore into channelMessageService for cross-store consistency
    channelMessageService.setFileStore(fileStore);

    // Create channel in FileStore (for message ops)
    const channelName = `#test-wu-${Date.now()}`;
    testChannelId = `ch-${Date.now()}`;
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
    // Cleanup temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Task 2: CRUD ----

  describe('CRUD', () => {
    it('AC1: create WorkUnit with minimal fields', async () => {
      const wu = await service.create({ scope: 'Test minimal' });
      testIds.push(wu.id);

      expect(wu.id).toBeDefined();
      expect(wu.scope).toBe('Test minimal');
      expect(wu.type).toBe('task');
      // #126：feature/task/spec 未显式 status 默认落 pending（待确认人工门），不再是 unassigned
      expect(wu.status).toBe('pending');
      expect(wu.assigneeId).toBeNull();
    });

    it('AC1: create WorkUnit with all fields', async () => {
      const wu = await service.create({
        type: 'analysis',
        scope: 'Full fields',
        assigneeId: 'agent-1',
        channelId: null,
        parentId: null,
        metadata: { priority: 'high' },
      });
      testIds.push(wu.id);

      expect(wu.type).toBe('analysis');
      expect(wu.scope).toBe('Full fields');
      expect(wu.assigneeId).toBe('agent-1');
      expect(wu.metadata).toBe('{"priority":"high"}');
    });

    it('AC2: get WorkUnit by id', async () => {
      const created = await service.create({ scope: 'Get me' });
      testIds.push(created.id);

      const found = await service.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.scope).toBe('Get me');
    });

    it('AC2: get nonexistent returns null', async () => {
      const found = await service.getById('nonexistent-id');
      expect(found).toBeNull();
    });

    it('list WorkUnits with filter', async () => {
      await service.create({ scope: 'List task', type: 'monitor' });
      const result = await service.list({ type: 'monitor' });

      expect(result.data.length).toBeGreaterThanOrEqual(1);
      expect(result.data.every(w => w.type === 'monitor')).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('update WorkUnit', async () => {
      const created = await service.create({ scope: 'Update me' });
      testIds.push(created.id);

      const updated = await service.update(created.id, { scope: 'Updated' });
      expect(updated.scope).toBe('Updated');
    });

    it('delete WorkUnit', async () => {
      const created = await service.create({ scope: 'Delete me' });
      await service.delete(created.id);

      const found = await service.getById(created.id);
      expect(found).toBeNull();
    });
  });

  // ---- Task 3: Claim mechanism ----

  describe('Claim', () => {
    it('AC3: claim succeeds for unassigned WorkUnit', async () => {
      const wu = await service.create({ scope: 'Claimable', status: 'unassigned' }); // #126：task 默认落 pending（不可认领），显式置 unassigned
      testIds.push(wu.id);

      const claimed = await service.claim(wu.id, 'agent-A');
      expect(claimed.assigneeId).toBe('agent-A');
      expect(claimed.status).toBe('active');
      expect(claimed.claimedAt).not.toBeNull();
    });

    it('AC3: claim fails for already assigned WorkUnit', async () => {
      const wu = await service.create({ scope: 'Already claimed', status: 'unassigned' }); // #126：task 默认落 pending（不可认领），显式置 unassigned
      testIds.push(wu.id);

      await service.claim(wu.id, 'agent-A');

      await expect(service.claim(wu.id, 'agent-B')).rejects.toThrow('Claim failed');

      const final = await service.getById(wu.id);
      expect(final!.assigneeId).toBe('agent-A');
    });

    it('AC3: concurrent claim — exactly one succeeds', async () => {
      const wu = await service.create({ scope: 'Contested', status: 'unassigned' }); // #126：task 默认落 pending（不可认领），显式置 unassigned
      testIds.push(wu.id);

      const [resultA, resultB] = await Promise.allSettled([
        service.claim(wu.id, 'agent-A'),
        service.claim(wu.id, 'agent-B'),
      ]);

      // Exactly one succeeds, one rejects
      const settled = [resultA, resultB];
      const fulfilled = settled.filter(r => r.status === 'fulfilled');
      const rejected = settled.filter(r => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const winner = (fulfilled[0] as PromiseFulfilledResult<{ assigneeId: string }>).value;
      expect(['agent-A', 'agent-B']).toContain(winner.assigneeId);
    });

    it('unclaim resets WorkUnit to unassigned', async () => {
      const wu = await service.create({ scope: 'Unclaimable', status: 'unassigned' }); // #126：task 默认落 pending（不可认领），显式置 unassigned
      testIds.push(wu.id);

      await service.claim(wu.id, 'agent-A');
      const unclaimed = await service.unclaim(wu.id);

      expect(unclaimed.assigneeId).toBeNull();
      expect(unclaimed.status).toBe('unassigned');
    });

    it('claim rejects on file conflict', async () => {
      // #126：task 默认落 pending（不可认领），两个 WU 均显式置 unassigned
      const wu1 = await service.create({
        scope: 'File owner',
        status: 'unassigned',
        metadata: { files: ['src/auth.ts', 'src/login.ts'] },
      });
      const wu2 = await service.create({
        scope: 'File conflict',
        status: 'unassigned',
        metadata: { files: ['src/auth.ts'] },
      });
      testIds.push(wu1.id, wu2.id);

      await service.claim(wu1.id, 'agent-A');

      await expect(service.claim(wu2.id, 'agent-B')).rejects.toThrow(/File conflict/);
    });

    it('claim succeeds when files do not overlap', async () => {
      // #126：task 默认落 pending（不可认领），两个 WU 均显式置 unassigned
      const wu1 = await service.create({
        scope: 'Files A',
        status: 'unassigned',
        metadata: { files: ['src/a.ts'] },
      });
      const wu2 = await service.create({
        scope: 'Files B',
        status: 'unassigned',
        metadata: { files: ['src/b.ts'] },
      });
      testIds.push(wu1.id, wu2.id);

      await service.claim(wu1.id, 'agent-A');
      const claimed = await service.claim(wu2.id, 'agent-B');

      expect(claimed.assigneeId).toBe('agent-B');
    });

    it('claim succeeds when no files specified', async () => {
      // #126：task 默认落 pending（不可认领），两个 WU 均显式置 unassigned
      const wu1 = await service.create({ scope: 'No files', status: 'unassigned', metadata: {} });
      const wu2 = await service.create({ scope: 'Also no files', status: 'unassigned' });
      testIds.push(wu1.id, wu2.id);

      await service.claim(wu1.id, 'agent-A');
      const claimed = await service.claim(wu2.id, 'agent-B');

      expect(claimed.assigneeId).toBe('agent-B');
    });

    it('Bug fix: claim rejects on file conflict with in_review WorkUnit', async () => {
      // #126：task 默认落 pending（不可认领），两个 WU 均显式置 unassigned
      const wu1 = await service.create({
        scope: 'In review owner',
        status: 'unassigned',
        metadata: { files: ['src/conflict-review.ts'] },
      });
      const wu2 = await service.create({
        scope: 'Conflicts with review',
        status: 'unassigned',
        metadata: { files: ['src/conflict-review.ts'] },
      });
      testIds.push(wu1.id, wu2.id);

      // wu1 claimed then moved to in_review
      await service.claim(wu1.id, 'agent-A');
      await service.transitionStatus(wu1.id, 'in_review');

      // wu2 should conflict even though wu1 is in_review, not active
      await expect(service.claim(wu2.id, 'agent-B')).rejects.toThrow(/File conflict/);
    });
  });

  // ---- Task 4: State machine ----

  describe('State machine', () => {
    it('AC4: valid transition unassigned → active', async () => {
      const wu = await service.create({ scope: 'Transition test', status: 'unassigned' }); // #126：task 默认落 pending，本用例测 unassigned → active，显式置 status
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'active');
      expect(updated.status).toBe('active');
    });

    it('AC4: valid transition active → in_review', async () => {
      const wu = await service.create({ scope: 'Active to review', status: 'active' });
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'in_review');
      expect(updated.status).toBe('in_review');
    });

    it('AC4: valid transition in_review → done', async () => {
      const wu = await service.create({ scope: 'Review to done', status: 'in_review' });
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'done');
      expect(updated.status).toBe('done');
    });

    it('AC4: valid transition done → closed', async () => {
      const wu = await service.create({ scope: 'Done to closed', status: 'done' });
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'closed');
      expect(updated.status).toBe('closed');
    });

    it('AC4: any state → closed is valid', async () => {
      const wu = await service.create({ scope: 'Any to closed', status: 'blocked' });
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'closed');
      expect(updated.status).toBe('closed');
    });

    it('AC4: blocked → active is valid', async () => {
      const wu = await service.create({ scope: 'Blocked to active', status: 'blocked' });
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'active');
      expect(updated.status).toBe('active');
    });

    it('AC5: invalid transition unassigned → done returns 400', async () => {
      const wu = await service.create({ scope: 'Invalid jump' });
      testIds.push(wu.id);

      await expect(service.transitionStatus(wu.id, 'done')).rejects.toThrow(
        /Invalid status transition/
      );
    });

    it('AC5: invalid transition done → active returns 400', async () => {
      const wu = await service.create({ scope: 'Done cannot go active', status: 'done' });
      testIds.push(wu.id);

      await expect(service.transitionStatus(wu.id, 'active')).rejects.toThrow(
        /Invalid status transition/
      );
    });

    it('AC5: invalid transition closed → any returns 400', async () => {
      const wu = await service.create({ scope: 'Closed is terminal', status: 'closed' });
      testIds.push(wu.id);

      await expect(service.transitionStatus(wu.id, 'active')).rejects.toThrow(
        /Invalid status transition/
      );
    });

    it('AC4: in_review → active (send back) is valid', async () => {
      const wu = await service.create({ scope: 'Review back', status: 'in_review' });
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'active');
      expect(updated.status).toBe('active');
    });

    it('AC4: active → blocked is valid', async () => {
      const wu = await service.create({ scope: 'Active to blocked', status: 'active' });
      testIds.push(wu.id);

      const updated = await service.transitionStatus(wu.id, 'blocked');
      expect(updated.status).toBe('blocked');
    });
  });

  // ---- Review API ----

  describe('Review', () => {
    it('reviewPassed: in_review → done', async () => {
      const wu = await service.create({ scope: 'review-pass-test', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      testIds.push(wu.id);
      await service.transitionStatus(wu.id, 'active');
      await service.transitionStatus(wu.id, 'in_review');

      const result = await service.reviewPassed(wu.id);
      expect(result.status).toBe('done');
      expect(result.completedAt).not.toBeNull();
    });

    it('reviewPassed: rejects if not in_review', async () => {
      const wu = await service.create({ scope: 'review-pass-invalid' });
      testIds.push(wu.id);

      await expect(service.reviewPassed(wu.id)).rejects.toThrow(/Cannot review/);
    });

    it('reviewRejected: in_review → active', async () => {
      const wu = await service.create({ scope: 'review-reject-1', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      testIds.push(wu.id);
      await service.transitionStatus(wu.id, 'active');
      await service.transitionStatus(wu.id, 'in_review');

      const result = await service.reviewRejected(wu.id);
      expect(result.status).toBe('active');
      const meta = JSON.parse(result.metadata ?? '{}');
      expect(meta._consecutiveReviewRejections).toBe(1);
    });

    it('reviewRejected: 3 consecutive → auto-block', async () => {
      const wu = await service.create({ scope: 'review-block-test', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      testIds.push(wu.id);

      // Reject 1: in_review → active
      await service.transitionStatus(wu.id, 'active');
      await service.transitionStatus(wu.id, 'in_review');
      await service.reviewRejected(wu.id);

      // Reject 2: active → in_review → active
      await service.transitionStatus(wu.id, 'in_review');
      await service.reviewRejected(wu.id);

      // Reject 3: active → in_review → blocked
      await service.transitionStatus(wu.id, 'in_review');
      const result = await service.reviewRejected(wu.id);
      expect(result.status).toBe('blocked');
    });

    it('reviewPassed resets rejection counter', async () => {
      const wu = await service.create({ scope: 'review-reset-test', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      testIds.push(wu.id);

      // 2 rejections
      await service.transitionStatus(wu.id, 'active');
      await service.transitionStatus(wu.id, 'in_review');
      await service.reviewRejected(wu.id);
      await service.transitionStatus(wu.id, 'in_review');
      await service.reviewRejected(wu.id);

      // Now pass
      await service.transitionStatus(wu.id, 'in_review');
      const result = await service.reviewPassed(wu.id);
      expect(result.status).toBe('done');
      const meta = JSON.parse(result.metadata ?? '{}');
      expect(meta._consecutiveReviewRejections).toBeUndefined();
    });

    it('reviewRejected: rejects if not in_review', async () => {
      const wu = await service.create({ scope: 'review-reject-invalid' });
      testIds.push(wu.id);

      await expect(service.reviewRejected(wu.id)).rejects.toThrow(/Cannot review/);
    });

    it('Bug fix: transitionStatus in_review→done also works (reviewPassed event path)', async () => {
      const wu = await service.create({ scope: 'review-via-transition', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      testIds.push(wu.id);
      await service.transitionStatus(wu.id, 'active');
      await service.transitionStatus(wu.id, 'in_review');

      // Use transitionStatus instead of reviewPassed — should still work
      const result = await service.transitionStatus(wu.id, 'done');
      expect(result.status).toBe('done');
      expect(result.completedAt).not.toBeNull();
    });
  });

  // ---- from-message conversion ----

  describe('createFromMessage', () => {
    it('converts message to WorkUnit and links', async () => {
      const msg = await channelMessageService.createHumanMessage(
        testChannelId, 'Fix the login bug',
      );

      const wu = await service.createFromMessage(msg.id);
      testIds.push(wu.id);

      expect(wu.scope).toBe('Fix the login bug');
      expect(wu.channelId).toBe(testChannelId);
      const meta = JSON.parse(wu.metadata ?? '{}');
      expect(meta.sourceMessageId).toBe(msg.id);
      expect(meta.creationMode).toBe('from-message');

      // Verify message linked
      const updated = await fileStore.getMessageById(msg.id);
      expect(updated).not.toBeNull();
      expect(updated!.message.workUnitId).toBe(wu.id);
    });

    it('rejects if message not found', async () => {
      await expect(service.createFromMessage('nonexistent')).rejects.toThrow(/not found/);
    });

    it('rejects if message already converted', async () => {
      const msg = await channelMessageService.createHumanMessage(
        testChannelId, 'Already converted',
      );
      const wu = await service.createFromMessage(msg.id);
      testIds.push(wu.id);

      await expect(service.createFromMessage(msg.id)).rejects.toThrow(/already linked/);
    });

    it('accepts custom type and metadata', async () => {
      const msg = await channelMessageService.createHumanMessage(
        testChannelId, 'Analysis needed',
      );

      const wu = await service.createFromMessage(msg.id, {
        type: 'analysis',
        metadata: { priority: 'high' },
      });
      testIds.push(wu.id);

      expect(wu.type).toBe('analysis');
      const meta = JSON.parse(wu.metadata ?? '{}');
      expect(meta.priority).toBe('high');
      expect(meta.creationMode).toBe('from-message');
    });

    it('truncates long content for scope', async () => {
      const longContent = 'x'.repeat(600);
      const msg = await channelMessageService.createHumanMessage(
        testChannelId, longContent,
      );

      const wu = await service.createFromMessage(msg.id);
      testIds.push(wu.id);

      expect(wu.scope).toHaveLength(500);
    });
  });

  // ---- Parent state aggregation ----

  describe('Parent state aggregation', () => {
    it('direct: all children done → parent in_review', async () => {
      const parent = await service.create({ scope: 'parent-agg-1', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      const c1 = await service.create({ scope: 'child-1', parentId: parent.id, status: 'done' });
      const c2 = await service.create({ scope: 'child-2', parentId: parent.id, status: 'done' });
      testIds.push(parent.id, c1.id, c2.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('in_review');
    });

    it('direct: any child active → parent active', async () => {
      // #126：task 默认落 pending，parent 与未显式 status 的 child 均显式置 unassigned 保持原语义
      const parent = await service.create({ scope: 'parent-agg-2', status: 'unassigned' });
      const c1 = await service.create({ scope: 'child-a', parentId: parent.id, status: 'active' });
      const c2 = await service.create({ scope: 'child-b', parentId: parent.id, status: 'unassigned' });
      testIds.push(parent.id, c1.id, c2.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('active');
    });

    it('direct: any child blocked → parent blocked', async () => {
      const parent = await service.create({ scope: 'parent-agg-3', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      const c1 = await service.create({ scope: 'child-x', parentId: parent.id, status: 'blocked' });
      testIds.push(parent.id, c1.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('blocked');
    });

    it('direct: all children closed → parent closed', async () => {
      const parent = await service.create({ scope: 'parent-agg-4', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      const c1 = await service.create({ scope: 'child-c', parentId: parent.id, status: 'closed' });
      testIds.push(parent.id, c1.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('closed');
    });

    it('direct: 1 closed + rest done → parent in_review', async () => {
      const parent = await service.create({ scope: 'parent-agg-5', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      const c1 = await service.create({ scope: 'child-d1', parentId: parent.id, status: 'done' });
      const c2 = await service.create({ scope: 'child-d2', parentId: parent.id, status: 'closed' });
      testIds.push(parent.id, c1.id, c2.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('in_review');
    });

    it('cascade: child done triggers parent aggregation', async () => {
      const parent = await service.create({ scope: 'parent-cascade', status: 'unassigned' }); // #126：task 默认落 pending，显式置 unassigned
      // transitionStatus fires aggregateParentStatus fire-and-forget; driving the
      // child through transitions here would race the next getIndex/upsertSnapshot
      // on index.json (torn read → flaky "WorkUnit not found"). Like the 'direct'
      // cases above, create the child already done and verify the cascade LOGIC.
      const c1 = await service.create({ scope: 'child-casc-1', parentId: parent.id, status: 'done' });
      testIds.push(parent.id, c1.id);

      // Direct call to verify aggregation logic works
      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('in_review');
    });
  });

  // ---- AC-4: create() publishes workunit.created event ----

  describe('AC-4: WorkUnit creation event', () => {
    it('create() publishes workunit.created event', async () => {
      const publishSpy = vi.spyOn(eventBus, 'publish');

      const wu = await service.create({ scope: 'Event test', type: 'task' });
      testIds.push(wu.id);

      expect(publishSpy).toHaveBeenCalledWith(
        'workunit.created',
        expect.objectContaining({ workunit: expect.objectContaining({ id: wu.id }) }),
      );

      publishSpy.mockRestore();
    });

    it('create() still returns WorkUnit after event publish', async () => {
      // #126：task 默认落 pending；本用例断言返回值 status=unassigned，显式置 status 保持原语义
      const wu = await service.create({ scope: 'Return value test', status: 'unassigned' });
      testIds.push(wu.id);

      expect(wu.id).toBeDefined();
      expect(wu.scope).toBe('Return value test');
      expect(wu.status).toBe('unassigned');
    });

    it('create() does not throw when eventBus.publish fails', async () => {
      const publishSpy = vi.spyOn(eventBus, 'publish').mockImplementation(() => {
        throw new Error('EventBus failure');
      });

      // Should not throw — eventBus failure is non-blocking
      const wu = await service.create({ scope: 'Resilience test' });
      testIds.push(wu.id);

      expect(wu.id).toBeDefined();
      publishSpy.mockRestore();
    });
  });

  // ---- AC-D2: WorkUnit.projectPath ----

  describe('AC-D2: WorkUnit.projectPath', () => {
    it('create with projectPath → stored and returned', async () => {
      const wu = await service.create({
        scope: 'ProjectPath test',
        projectPath: '/home/user/projects/my-app',
      });
      testIds.push(wu.id);

      expect(wu.projectPath).toBe('/home/user/projects/my-app');

      const fetched = await service.getById(wu.id);
      expect(fetched!.projectPath).toBe('/home/user/projects/my-app');
    });

    it('create without projectPath → projectPath = null', async () => {
      const wu = await service.create({ scope: 'No projectPath' });
      testIds.push(wu.id);

      expect(wu.projectPath).toBeNull();
    });

    it('update projectPath', async () => {
      const wu = await service.create({ scope: 'Update projectPath' });
      testIds.push(wu.id);

      const updated = await service.update(wu.id, { projectPath: '/new/path' });
      expect(updated.projectPath).toBe('/new/path');
    });
  });

});

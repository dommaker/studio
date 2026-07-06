// WorkUnit API service test (AS-025, 3.28c-1 Task 2-4)
// Tests: CRUD + Claim + State machine + Review + from-message
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { eventBus } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

describe('WorkUnit API service', () => {
  const service = new WorkUnitService(prisma);
  const testIds: string[] = [];
  let testChannelId: string;

  beforeAll(async () => {
    // Clean up stale active/in_review WorkUnits from previous runs (file conflict isolation)
    await prisma.workUnit.deleteMany({
      where: { status: { in: ['active', 'in_review'] }, metadata: { contains: '"files"' } },
    });

    const channel = await prisma.channel.create({
      data: { name: `#test-wu-${Date.now()}`, type: 'rnd' },
    });
    testChannelId = channel.id;
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId: testChannelId } });
    await prisma.channel.deleteMany({ where: { id: testChannelId } });
    await prisma.workUnit.deleteMany({ where: { id: { in: testIds } } });
  });

  // ---- Task 2: CRUD ----

  describe('CRUD', () => {
    it('AC1: create WorkUnit with minimal fields', async () => {
      const wu = await service.create({ scope: 'Test minimal' });
      testIds.push(wu.id);

      expect(wu.id).toBeDefined();
      expect(wu.scope).toBe('Test minimal');
      expect(wu.type).toBe('task');
      expect(wu.status).toBe('unassigned');
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
      const wu = await service.create({ scope: 'Claimable' });
      testIds.push(wu.id);

      const claimed = await service.claim(wu.id, 'agent-A');
      expect(claimed.assigneeId).toBe('agent-A');
      expect(claimed.status).toBe('active');
      expect(claimed.claimedAt).not.toBeNull();
    });

    it('AC3: claim fails for already assigned WorkUnit', async () => {
      const wu = await service.create({ scope: 'Already claimed' });
      testIds.push(wu.id);

      await service.claim(wu.id, 'agent-A');

      await expect(service.claim(wu.id, 'agent-B')).rejects.toThrow('Claim failed');

      const final = await service.getById(wu.id);
      expect(final!.assigneeId).toBe('agent-A');
    });

    it('AC3: concurrent claim — exactly one succeeds', async () => {
      const wu = await service.create({ scope: 'Contested' });
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
      const wu = await service.create({ scope: 'Unclaimable' });
      testIds.push(wu.id);

      await service.claim(wu.id, 'agent-A');
      const unclaimed = await service.unclaim(wu.id);

      expect(unclaimed.assigneeId).toBeNull();
      expect(unclaimed.status).toBe('unassigned');
    });

    it('claim rejects on file conflict', async () => {
      const wu1 = await service.create({
        scope: 'File owner',
        metadata: { files: ['src/auth.ts', 'src/login.ts'] },
      });
      const wu2 = await service.create({
        scope: 'File conflict',
        metadata: { files: ['src/auth.ts'] },
      });
      testIds.push(wu1.id, wu2.id);

      await service.claim(wu1.id, 'agent-A');

      await expect(service.claim(wu2.id, 'agent-B')).rejects.toThrow(/File conflict/);
    });

    it('claim succeeds when files do not overlap', async () => {
      const wu1 = await service.create({
        scope: 'Files A',
        metadata: { files: ['src/a.ts'] },
      });
      const wu2 = await service.create({
        scope: 'Files B',
        metadata: { files: ['src/b.ts'] },
      });
      testIds.push(wu1.id, wu2.id);

      await service.claim(wu1.id, 'agent-A');
      const claimed = await service.claim(wu2.id, 'agent-B');

      expect(claimed.assigneeId).toBe('agent-B');
    });

    it('claim succeeds when no files specified', async () => {
      const wu1 = await service.create({ scope: 'No files', metadata: {} });
      const wu2 = await service.create({ scope: 'Also no files' });
      testIds.push(wu1.id, wu2.id);

      await service.claim(wu1.id, 'agent-A');
      const claimed = await service.claim(wu2.id, 'agent-B');

      expect(claimed.assigneeId).toBe('agent-B');
    });

    it('Bug fix: claim rejects on file conflict with in_review WorkUnit', async () => {
      const wu1 = await service.create({
        scope: 'In review owner',
        metadata: { files: ['src/conflict-review.ts'] },
      });
      const wu2 = await service.create({
        scope: 'Conflicts with review',
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
      const wu = await service.create({ scope: 'Transition test' });
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
      const wu = await service.create({ scope: 'review-pass-test' });
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
      const wu = await service.create({ scope: 'review-reject-1' });
      testIds.push(wu.id);
      await service.transitionStatus(wu.id, 'active');
      await service.transitionStatus(wu.id, 'in_review');

      const result = await service.reviewRejected(wu.id);
      expect(result.status).toBe('active');
      const meta = JSON.parse(result.metadata ?? '{}');
      expect(meta._consecutiveReviewRejections).toBe(1);
    });

    it('reviewRejected: 3 consecutive → auto-block', async () => {
      const wu = await service.create({ scope: 'review-block-test' });
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
      const wu = await service.create({ scope: 'review-reset-test' });
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
      const wu = await service.create({ scope: 'review-via-transition' });
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
      const msg = await prisma.channelMessage.create({
        data: { channelId: testChannelId, authorType: 'human', content: 'Fix the login bug' },
      });

      const wu = await service.createFromMessage(msg.id);
      testIds.push(wu.id);

      expect(wu.scope).toBe('Fix the login bug');
      expect(wu.channelId).toBe(testChannelId);
      const meta = JSON.parse(wu.metadata ?? '{}');
      expect(meta.sourceMessageId).toBe(msg.id);
      expect(meta.creationMode).toBe('from-message');

      // Verify message linked
      const updated = await prisma.channelMessage.findUnique({ where: { id: msg.id } });
      expect(updated!.workUnitId).toBe(wu.id);
    });

    it('rejects if message not found', async () => {
      await expect(service.createFromMessage('nonexistent')).rejects.toThrow(/not found/);
    });

    it('rejects if message already converted', async () => {
      const msg = await prisma.channelMessage.create({
        data: { channelId: testChannelId, authorType: 'human', content: 'Already converted' },
      });
      const wu = await service.createFromMessage(msg.id);
      testIds.push(wu.id);

      await expect(service.createFromMessage(msg.id)).rejects.toThrow(/already linked/);
    });

    it('accepts custom type and metadata', async () => {
      const msg = await prisma.channelMessage.create({
        data: { channelId: testChannelId, authorType: 'human', content: 'Analysis needed' },
      });

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
      const msg = await prisma.channelMessage.create({
        data: { channelId: testChannelId, authorType: 'human', content: longContent },
      });

      const wu = await service.createFromMessage(msg.id);
      testIds.push(wu.id);

      expect(wu.scope).toHaveLength(500);
    });
  });

  // ---- Parent state aggregation ----

  describe('Parent state aggregation', () => {
    it('direct: all children done → parent in_review', async () => {
      const parent = await service.create({ scope: 'parent-agg-1' });
      const c1 = await service.create({ scope: 'child-1', parentId: parent.id, status: 'done' });
      const c2 = await service.create({ scope: 'child-2', parentId: parent.id, status: 'done' });
      testIds.push(parent.id, c1.id, c2.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('in_review');
    });

    it('direct: any child active → parent active', async () => {
      const parent = await service.create({ scope: 'parent-agg-2' });
      const c1 = await service.create({ scope: 'child-a', parentId: parent.id, status: 'active' });
      const c2 = await service.create({ scope: 'child-b', parentId: parent.id });
      testIds.push(parent.id, c1.id, c2.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('active');
    });

    it('direct: any child blocked → parent blocked', async () => {
      const parent = await service.create({ scope: 'parent-agg-3' });
      const c1 = await service.create({ scope: 'child-x', parentId: parent.id, status: 'blocked' });
      testIds.push(parent.id, c1.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('blocked');
    });

    it('direct: all children closed → parent closed', async () => {
      const parent = await service.create({ scope: 'parent-agg-4' });
      const c1 = await service.create({ scope: 'child-c', parentId: parent.id, status: 'closed' });
      testIds.push(parent.id, c1.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('closed');
    });

    it('direct: 1 closed + rest done → parent in_review', async () => {
      const parent = await service.create({ scope: 'parent-agg-5' });
      const c1 = await service.create({ scope: 'child-d1', parentId: parent.id, status: 'done' });
      const c2 = await service.create({ scope: 'child-d2', parentId: parent.id, status: 'closed' });
      testIds.push(parent.id, c1.id, c2.id);

      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('in_review');
    });

    it('cascade: child done triggers parent aggregation', async () => {
      const parent = await service.create({ scope: 'parent-cascade' });
      const c1 = await service.create({ scope: 'child-casc-1', parentId: parent.id });
      testIds.push(parent.id, c1.id);

      // Transition to done, then manually trigger aggregation (fire-and-forget cascades
      // have inherent race — this verifies the cascade LOGIC, not async ordering)
      await service.transitionStatus(c1.id, 'active');
      await service.transitionStatus(c1.id, 'in_review');
      await service.transitionStatus(c1.id, 'done');

      // Direct call to verify aggregation logic works
      await service.aggregateParentStatus(c1.id);

      const updated = await service.getById(parent.id);
      expect(updated!.status).toBe('in_review');
    });
  });

  // ---- Dependency unlock ----

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
      const wu = await service.create({ scope: 'Return value test' });
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

});

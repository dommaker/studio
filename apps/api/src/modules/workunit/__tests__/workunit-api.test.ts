// WorkUnit API service test (AS-025, 3.28c-1 Task 2-4)
// Tests: CRUD + Claim + State machine
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { WorkUnitService } from '../workunit.service.js';

describe('WorkUnit API service', () => {
  const service = new WorkUnitService(prisma);
  const testIds: string[] = [];

  afterAll(async () => {
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
        dependsOn: ['dep-1'],
        metadata: { priority: 'high' },
      });
      testIds.push(wu.id);

      expect(wu.type).toBe('analysis');
      expect(wu.scope).toBe('Full fields');
      expect(wu.assigneeId).toBe('agent-1');
      expect(wu.dependsOn).toBe('["dep-1"]');
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
});

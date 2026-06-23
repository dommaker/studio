// WorkUnit data model test (AS-025, 3.28c-1)
// RED phase — WorkUnit model does not exist yet
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';

describe('WorkUnit data model', () => {
  const testWorkUnitIds: string[] = [];

  afterAll(async () => {
    await prisma.workUnit.deleteMany({ where: { id: { in: testWorkUnitIds } } });
  });

  it('creates WorkUnit with minimal fields (defaults)', async () => {
    const wu = await prisma.workUnit.create({
      data: { scope: 'Test minimal WorkUnit' },
    });
    testWorkUnitIds.push(wu.id);

    expect(wu.id).toBeDefined();
    expect(wu.scope).toBe('Test minimal WorkUnit');
    expect(wu.type).toBe('task'); // default
    expect(wu.status).toBe('unassigned'); // default
    expect(wu.assigneeId).toBeNull();
    expect(wu.channelId).toBeNull();
    expect(wu.parentId).toBeNull();
    expect(wu.dependsOn).toBe('[]'); // JSON default
    expect(wu.metadata).toBeNull();
  });

  it('creates WorkUnit with all fields', async () => {
    const wu = await prisma.workUnit.create({
      data: {
        type: 'analysis',
        scope: 'System health check',
        assigneeId: 'agent-1',
        status: 'active',
        channelId: null,
        parentId: null,
        dependsOn: '["wu-1","wu-2"]',
        metadata: '{"priority":"high"}',
      },
    });
    testWorkUnitIds.push(wu.id);

    expect(wu.type).toBe('analysis');
    expect(wu.scope).toBe('System health check');
    expect(wu.assigneeId).toBe('agent-1');
    expect(wu.status).toBe('active');
    expect(wu.dependsOn).toBe('["wu-1","wu-2"]');
    expect(wu.metadata).toBe('{"priority":"high"}');
  });

  it('queries WorkUnit by status', async () => {
    // Create 2 unassigned
    const wu1 = await prisma.workUnit.create({ data: { scope: 'Task 1' } });
    const wu2 = await prisma.workUnit.create({ data: { scope: 'Task 2' } });
    testWorkUnitIds.push(wu1.id, wu2.id);

    const unassigned = await prisma.workUnit.findMany({
      where: { status: 'unassigned' },
    });

    expect(unassigned.length).toBeGreaterThanOrEqual(2);
    expect(unassigned.some(w => w.id === wu1.id)).toBe(true);
    expect(unassigned.some(w => w.id === wu2.id)).toBe(true);
  });

  it('queries WorkUnit by type', async () => {
    const analysis = await prisma.workUnit.create({
      data: { type: 'analysis', scope: 'Analyze this' },
    });
    testWorkUnitIds.push(analysis.id);

    const results = await prisma.workUnit.findMany({
      where: { type: 'analysis' },
    });

    expect(results.some(w => w.id === analysis.id)).toBe(true);
  });

  it('supports hierarchy (parentId)', async () => {
    const parent = await prisma.workUnit.create({
      data: { scope: 'Parent task' },
    });
    const child = await prisma.workUnit.create({
      data: { scope: 'Child task', parentId: parent.id },
    });
    testWorkUnitIds.push(parent.id, child.id);

    expect(child.parentId).toBe(parent.id);

    const children = await prisma.workUnit.findMany({
      where: { parentId: parent.id },
    });
    expect(children.some(c => c.id === child.id)).toBe(true);
  });

  it('Claim: UPDATE SET assigneeId WHERE NULL succeeds', async () => {
    const wu = await prisma.workUnit.create({
      data: { scope: 'Claimable task', status: 'unassigned' },
    });
    testWorkUnitIds.push(wu.id);

    // Agent A claims
    const claimed = await prisma.workUnit.updateMany({
      where: { id: wu.id, assigneeId: null },
      data: { assigneeId: 'agent-A', status: 'active' },
    });

    expect(claimed.count).toBe(1);

    // Verify state
    const updated = await prisma.workUnit.findUnique({ where: { id: wu.id } });
    expect(updated?.assigneeId).toBe('agent-A');
    expect(updated?.status).toBe('active');
  });

  it('Claim: concurrent UPDATE SET assigneeId WHERE NULL — only one succeeds', async () => {
    const wu = await prisma.workUnit.create({
      data: { scope: 'Contested task', status: 'unassigned' },
    });
    testWorkUnitIds.push(wu.id);

    // Agent A and Agent B both try to claim simultaneously
    const [resultA, resultB] = await Promise.all([
      prisma.workUnit.updateMany({
        where: { id: wu.id, assigneeId: null },
        data: { assigneeId: 'agent-A', status: 'active' },
      }),
      prisma.workUnit.updateMany({
        where: { id: wu.id, assigneeId: null },
        data: { assigneeId: 'agent-B', status: 'active' },
      }),
    ]);

    // Exactly one should succeed
    expect(resultA.count + resultB.count).toBe(1);

    // Verify final state
    const final = await prisma.workUnit.findUnique({ where: { id: wu.id } });
    expect(['agent-A', 'agent-B']).toContain(final?.assigneeId);
    expect(final?.status).toBe('active');
  });

  it('supports all WorkUnit types', async () => {
    const types = ['task', 'monitor', 'analysis', 'discussion'];
    const ids: string[] = [];

    for (const type of types) {
      const wu = await prisma.workUnit.create({
        data: { type, scope: `Type test: ${type}` },
      });
      ids.push(wu.id);
      expect(wu.type).toBe(type);
    }

    testWorkUnitIds.push(...ids);
  });

  it('supports all WorkUnit statuses', async () => {
    const statuses = ['unassigned', 'active', 'in_review', 'done', 'closed', 'blocked'];
    const ids: string[] = [];

    for (const status of statuses) {
      const wu = await prisma.workUnit.create({
        data: { scope: `Status test: ${status}`, status },
      });
      ids.push(wu.id);
      expect(wu.status).toBe(status);
    }

    testWorkUnitIds.push(...ids);
  });
});

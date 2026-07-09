/**
 * AgentProfile CRUD 测试 — AS-025 Phase 2
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { prisma } from '../../../core/database.js';
import { AgentProfileService } from '../agent-profile.service.js';

describe('AgentProfile CRUD', () => {
  const service = new AgentProfileService(prisma);
  const testIds: string[] = [];

  beforeAll(async () => {
    // Clean stale data from previous runs (test DB persists across runs)
    await prisma.agentProfile.deleteMany({
      where: { name: { startsWith: 'test-' } },
    });
  });

  afterAll(async () => {
    await prisma.agentProfile.deleteMany({ where: { id: { in: testIds } } });
  });

  it('create with minimal fields', async () => {
    const profile = await service.create({ name: 'test-pm' });
    testIds.push(profile.id);

    expect(profile.id).toBeDefined();
    expect(profile.name).toBe('test-pm');
    expect(profile.description).toBeNull();
    expect(profile.channels).toBe('[]');
    expect(profile.status).toBe('active');
  });

  it('create with all fields', async () => {
    const profile = await service.create({
      name: 'test-engineer',
      description: 'Writes code',
      channels: ['ch-1', 'ch-2'],
    });
    testIds.push(profile.id);

    expect(profile.name).toBe('test-engineer');
    expect(profile.description).toBe('Writes code');
    expect(profile.channels).toBe('["ch-1","ch-2"]');
  });

  it('create duplicate name throws', async () => {
    await service.create({ name: 'test-dup' });
    await expect(service.create({ name: 'test-dup' })).rejects.toThrow();
  });

  it('get by id', async () => {
    const created = await service.create({ name: 'test-get' });
    testIds.push(created.id);

    const found = await service.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('test-get');
  });

  it('get nonexistent returns null', async () => {
    const found = await service.getById('nonexistent');
    expect(found).toBeNull();
  });

  it('list with filter', async () => {
    await service.create({ name: 'test-list-active', status: 'active' });
    await service.create({ name: 'test-list-inactive', status: 'inactive' });

    const active = await service.list({ status: 'active' });
    expect(active.data.every(p => p.status === 'active')).toBe(true);
  });

  it('update', async () => {
    const created = await service.create({ name: 'test-update' });
    testIds.push(created.id);

    const updated = await service.update(created.id, {
      description: 'Updated description',
      channels: ['ch-new'],
    });

    expect(updated.description).toBe('Updated description');
    expect(updated.channels).toBe('["ch-new"]');
  });

  it('delete', async () => {
    const created = await service.create({ name: 'test-delete' });
    await service.delete(created.id);

    const found = await service.getById(created.id);
    expect(found).toBeNull();
  });
});

// ── AC-A2: listAgents online status + channelId filter ──

describe('AC-A2: listAgents online status + channelId filter', () => {
  const service = new AgentProfileService(prisma);
  const testIds: string[] = [];
  const runtimeIds: string[] = [];

  beforeEach(async () => {
    // Clean up test data
    await prisma.runtimeInstance.deleteMany({ where: { roleId: { in: testIds } } });
    await prisma.agentProfile.deleteMany({ where: { id: { in: testIds } } });
    testIds.length = 0;
    runtimeIds.length = 0;
  });

  afterAll(async () => {
    await prisma.runtimeInstance.deleteMany({ where: { roleId: { in: testIds } } });
    await prisma.agentProfile.deleteMany({ where: { id: { in: testIds } } });
  });

  it('list() returns results with isOnline field', async () => {
    const profile = await service.create({ name: 'online-test-1' });
    testIds.push(profile.id);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found).toBeDefined();
    expect(found).toHaveProperty('isOnline');
  });

  it('isOnline=true when RuntimeInstance status=active exists', async () => {
    const profile = await service.create({ name: 'online-test-2' });
    testIds.push(profile.id);
    const ri = await prisma.runtimeInstance.create({
      data: { roleId: profile.id, status: 'active' },
    });
    runtimeIds.push(ri.id);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found!.isOnline).toBe(true);
  });

  it('isOnline=false when no RuntimeInstance exists', async () => {
    const profile = await service.create({ name: 'online-test-3' });
    testIds.push(profile.id);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found!.isOnline).toBe(false);
  });

  it('isOnline=false when RuntimeInstance status=idle', async () => {
    const profile = await service.create({ name: 'online-test-4' });
    testIds.push(profile.id);
    const ri = await prisma.runtimeInstance.create({
      data: { roleId: profile.id, status: 'idle' },
    });
    runtimeIds.push(ri.id);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found!.isOnline).toBe(false);
  });

  it('list({ channelId }) filters agents by Channel.members', async () => {
    const agent1 = await service.create({ name: 'channel-agent-1' });
    const agent2 = await service.create({ name: 'channel-agent-2', channels: [] });
    testIds.push(agent1.id, agent2.id);

    // Set Channel.members to include agent1 (canonical source)
    const ch1 = await prisma.channel.create({
      data: { name: `#test-ac-a2-${Date.now()}`, members: JSON.stringify([agent1.id]) },
    });

    const result = await service.list({ channelId: ch1.id });
    const ids = result.data.map(p => p.id);
    expect(ids).toContain(agent1.id);
    expect(ids).not.toContain(agent2.id);

    await prisma.channel.delete({ where: { id: ch1.id } });
  });

  it('list({ channelId }) returns all active agents when Channel.members=[]', async () => {
    const ch2 = await prisma.channel.create({
      data: { name: `#test-ac-a2-empty-${Date.now()}`, members: '[]' },
    });
    const agent3 = await service.create({ name: 'channel-agent-3' });
    testIds.push(agent3.id);

    const result = await service.list({ channelId: ch2.id });
    // Empty members → returns all active agents (fallback)
    expect(result.data.length).toBeGreaterThanOrEqual(1);

    await prisma.channel.delete({ where: { id: ch2.id } });
  });
});

/**
 * AgentProfile CRUD 测试 — AS-025 Phase 2
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../../core/database.js';
import { AgentProfileService } from '../agent-profile.service.js';

describe('AgentProfile CRUD', () => {
  const service = new AgentProfileService(prisma);
  const testIds: string[] = [];

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

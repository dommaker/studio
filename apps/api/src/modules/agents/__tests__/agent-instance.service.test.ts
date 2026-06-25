// AC-1: RuntimeInstance CRUD tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, mockFindUnique, mockFindMany, mockUpdate, mockCount } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockFindMany: vi.fn().mockResolvedValue([]),
  mockUpdate: vi.fn(),
  mockCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    runtimeInstance: {
      create: mockCreate,
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      update: mockUpdate,
      count: mockCount,
    },
    agentProfile: {
      findUnique: vi.fn(),
    },
    workUnit: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

import { AgentInstanceService } from '../agent-instance.service';

describe('AgentInstanceService', () => {
  let service: AgentInstanceService;

  const mockInstance = {
    id: 'inst-1',
    roleId: 'role-1',
    sessionId: null,
    status: 'idle',
    currentWorkUnitId: null,
    startedAt: new Date(),
    terminatedAt: null,
    metadata: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AgentInstanceService();
  });

  describe('create()', () => {
    it('creates instance with roleId and returns idle status', async () => {
      mockCreate.mockResolvedValue(mockInstance);

      const result = await service.create({ roleId: 'role-1' });

      expect(result.status).toBe('idle');
      expect(result.roleId).toBe('role-1');
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ roleId: 'role-1', status: 'idle' }),
      });
    });

    it('returns 400 for invalid roleId', async () => {
      const err = new Error('Foreign key constraint');
      (err as any).code = 'P2003';
      mockCreate.mockRejectedValue(err);

      await expect(service.create({ roleId: 'nonexistent' })).rejects.toThrow();
    });
  });

  describe('getById()', () => {
    it('gets instance by id', async () => {
      mockFindUnique.mockResolvedValue(mockInstance);

      const result = await service.getById('inst-1');

      expect(result).toEqual(mockInstance);
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'inst-1' } });
    });

    it('returns null for nonexistent id', async () => {
      mockFindUnique.mockResolvedValue(null);

      const result = await service.getById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('list()', () => {
    it('lists instances filtered by status', async () => {
      mockFindMany.mockResolvedValue([mockInstance]);
      mockCount.mockResolvedValue(1);

      const result = await service.list({ status: 'idle' });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'idle' } }),
      );
    });

    it('lists all instances when no filter', async () => {
      mockFindMany.mockResolvedValue([mockInstance]);
      mockCount.mockResolvedValue(1);

      const result = await service.list();

      expect(result.data).toHaveLength(1);
    });
  });

  describe('update()', () => {
    it('updates instance status from idle to active', async () => {
      mockFindUnique.mockResolvedValue(mockInstance);
      mockUpdate.mockResolvedValue({ ...mockInstance, status: 'active' });

      const result = await service.update('inst-1', { status: 'active' });

      expect(result.status).toBe('active');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: expect.objectContaining({ status: 'active' }),
      });
    });

    it('updates instance currentWorkUnitId', async () => {
      mockFindUnique.mockResolvedValue(mockInstance);
      mockUpdate.mockResolvedValue({ ...mockInstance, currentWorkUnitId: 'wu-1' });

      const result = await service.update('inst-1', { currentWorkUnitId: 'wu-1' });

      expect(result.currentWorkUnitId).toBe('wu-1');
    });

    it('returns 400 for invalid status value', async () => {
      mockFindUnique.mockResolvedValue(mockInstance);

      await expect(service.update('inst-1', { status: 'invalid' })).rejects.toThrow();
    });
  });

  describe('terminate()', () => {
    it('should set status to terminated', async () => {
      mockFindUnique.mockResolvedValue({ ...mockInstance, currentWorkUnitId: null });
      mockUpdate.mockResolvedValue({ ...mockInstance, status: 'terminated', terminatedAt: new Date() });

      const result = await service.terminate('inst-1');

      expect(result.status).toBe('terminated');
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: expect.objectContaining({ status: 'terminated', currentWorkUnitId: null }),
      });
    });

    it('should unclaim current WorkUnit when currentWorkUnitId exists', async () => {
      const instanceWithWu = { ...mockInstance, currentWorkUnitId: 'wu-1' };
      mockFindUnique.mockResolvedValue(instanceWithWu);
      mockUpdate.mockResolvedValue({ ...instanceWithWu, status: 'terminated' });

      await service.terminate('inst-1');

      const { prisma } = await import('@dommaker/studio-prisma');
      expect(prisma.workUnit.update).toHaveBeenCalledWith({
        where: { id: 'wu-1' },
        data: { assigneeId: null, status: 'unassigned' },
      });
    });

    it('should throw when instance not found', async () => {
      mockFindUnique.mockResolvedValue(null);

      await expect(service.terminate('nonexistent')).rejects.toThrow('Instance not found');
    });
  });
});

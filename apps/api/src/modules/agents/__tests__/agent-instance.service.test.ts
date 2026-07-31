// AC-1: RuntimeInstance CRUD tests
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type RuntimeStateData } from '@dommaker/studio-shared';

import { AgentInstanceService } from '../agent-instance.service';
import { WorkUnitService } from '../../workunit/workunit.service.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-instance-test-'));
}

describe('AgentInstanceService', () => {
  let service: AgentInstanceService;
  let fileStore: FileStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    fileStore = new FileStore(tmpDir);
    service = new AgentInstanceService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const now = new Date().toISOString();
  const mockState: RuntimeStateData = {
    id: 'inst-1',
    roleId: 'role-1',
    sessionId: null,
    status: 'idle',
    currentWorkUnitId: null,
    startedAt: now,
    terminatedAt: null,
    lastHeartbeat: null,
    metadata: null,
  };

  describe('create()', () => {
    it('creates instance with roleId and returns idle status', async () => {
      const result = await service.create({ roleId: 'role-1' });

      expect(result.status).toBe('idle');
      expect(result.roleId).toBe('role-1');
      expect(result.id).toBeDefined();

      // 验证持久化到 FileStore
      const stored = await fileStore.getState(result.id);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('idle');
    });

    it('returns 400 for invalid roleId — no foreign key constraint with FileStore', async () => {
      // FileStore 没有外键约束，创建不会抛错
      const result = await service.create({ roleId: 'nonexistent' });
      expect(result.roleId).toBe('nonexistent');
    });
  });

  describe('getById()', () => {
    it('gets instance by id', async () => {
      await fileStore.createState('inst-1', mockState);

      const result = await service.getById('inst-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('inst-1');
      expect(result!.status).toBe('idle');
    });

    it('returns null for nonexistent id', async () => {
      const result = await service.getById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('list()', () => {
    it('lists instances filtered by status', async () => {
      await fileStore.createState('inst-1', { ...mockState, id: 'inst-1', status: 'idle' });
      await fileStore.createState('inst-2', { ...mockState, id: 'inst-2', status: 'active' });

      const result = await service.list({ status: 'idle' });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].id).toBe('inst-1');
    });

    it('lists all instances when no filter', async () => {
      await fileStore.createState('inst-1', { ...mockState, id: 'inst-1' });
      await fileStore.createState('inst-2', { ...mockState, id: 'inst-2' });

      const result = await service.list();

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('supports pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await fileStore.createState(`inst-${i}`, { ...mockState, id: `inst-${i}`, startedAt: new Date(Date.now() + i).toISOString() });
      }

      const page1 = await service.list({ page: 1, limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page3 = await service.list({ page: 3, limit: 2 });
      expect(page3.data).toHaveLength(1);
      expect(page3.total).toBe(5);
    });
  });

  describe('update()', () => {
    it('updates instance status from idle to active', async () => {
      await fileStore.createState('inst-1', mockState);

      const result = await service.update('inst-1', { status: 'active' });

      expect(result.status).toBe('active');

      const stored = await fileStore.getState('inst-1');
      expect(stored!.status).toBe('active');
    });

    it('updates instance currentWorkUnitId', async () => {
      await fileStore.createState('inst-1', mockState);

      const result = await service.update('inst-1', { currentWorkUnitId: 'wu-1' });

      expect(result.currentWorkUnitId).toBe('wu-1');
    });

    it('returns 400 for invalid status value', async () => {
      await fileStore.createState('inst-1', mockState);

      await expect(service.update('inst-1', { status: 'invalid' })).rejects.toThrow('Invalid status');
    });
  });

  describe('terminate()', () => {
    it('should set status to terminated', async () => {
      await fileStore.createState('inst-1', { ...mockState, currentWorkUnitId: null });

      const result = await service.terminate('inst-1');

      expect(result.status).toBe('terminated');
      expect(result.terminatedAt).not.toBeNull();
    });

    it('should unclaim current WorkUnit and block it for manual release when currentWorkUnitId exists', async () => {
      // Set up a WorkUnit snapshot in FileStore
      const now = new Date().toISOString();
      await fileStore.upsertSnapshot({
        id: 'wu-1', parentId: null, type: 'task', scope: 'test',
        assigneeId: 'inst-1', status: 'active', failureType: null, retryCount: 0,
        timeoutAt: null, channelId: null, projectPath: null, metadata: null,
        createdAt: now, updatedAt: now, claimedAt: now, completedAt: null,
      });
      await fileStore.createState('inst-1', { ...mockState, currentWorkUnitId: 'wu-1' });

      const result = await service.terminate('inst-1');

      // 实例 terminated + currentWorkUnitId 清空
      expect(result.status).toBe('terminated');
      expect(result.currentWorkUnitId).toBeNull();

      // 2026-07 §4 语义修正：WU 不再回 unassigned（活 loop ≤15s 会重新认领），
      // 而是置 blocked 转人工 + assigneeId/claimedAt 清空 + metadata.manualRelease 留痕
      const snapshots = await fileStore.getIndex();
      const wu = snapshots.find(s => s.id === 'wu-1');
      expect(wu).toBeDefined();
      expect(wu!.assigneeId).toBeNull();
      expect(wu!.claimedAt).toBeNull();
      expect(wu!.status).toBe('blocked');
      const meta = JSON.parse(wu!.metadata!) as { manualRelease?: boolean; manualReleaseReason?: string };
      expect(meta.manualRelease).toBe(true);
      expect(meta.manualReleaseReason).toBe('terminate instance inst-1');

      // loop 不认领 blocked WU（claim 只认 unassigned）——释放不会回弹
      const wuService = new WorkUnitService(fileStore);
      await expect(wuService.claim('wu-1', 'other-instance')).rejects.toThrow();
    });

    it('should terminate successfully even when currentWorkUnitId is dangling (best-effort)', async () => {
      // currentWorkUnitId 指向不存在的 WU —— unclaim/block 失败不阻断实例终止
      await fileStore.createState('inst-1', { ...mockState, currentWorkUnitId: 'wu-ghost' });

      const result = await service.terminate('inst-1');

      expect(result.status).toBe('terminated');
      expect(result.currentWorkUnitId).toBeNull();
    });

    it('should throw when instance not found', async () => {
      await expect(service.terminate('nonexistent')).rejects.toThrow('Instance not found');
    });
  });
});

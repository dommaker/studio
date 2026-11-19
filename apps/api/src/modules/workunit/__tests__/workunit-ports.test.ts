/** ARCH-02：WorkUnit 跨域效果只经端口，注册/复位与未装配失败语义可回归。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit-review.js';
import {
  registerWorkUnitPorts,
  resetWorkUnitPorts,
  workUnitPort,
  type WorkUnitPorts,
} from '../workunit-ports.js';

const snapshot: WorkUnitSnapshot = {
  id: 'wu-1', parentId: null, type: 'task', scope: 'port test', assigneeId: null,
  status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
  channelId: null, projectPath: null, workspaceId: null, reqId: 'req-1',
  assigneeRoleId: null, metadata: null, createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', claimedAt: null, completedAt: null,
};

afterEach(() => resetWorkUnitPorts());

describe('WorkUnitPorts', () => {
  it('project-read 由装配实现执行 projectId 过滤，WorkUnit 不直接加载 Requirements/PMO', async () => {
    const selectProjectSnapshots = vi.fn().mockResolvedValue([snapshot]);
    registerWorkUnitPorts({
      projectRead: { selectProjectSnapshots } as unknown as WorkUnitPorts['projectRead'],
    });
    const fileStore = { getIndex: vi.fn().mockResolvedValue([snapshot]) } as unknown as FileStore;
    const service = new WorkUnitService(fileStore);

    const result = await service.list({ projectId: 'pmo-1' });

    expect(selectProjectSnapshots).toHaveBeenCalledWith('pmo-1', fileStore, [snapshot]);
    expect(result.data.map(wu => wu.id)).toEqual(['wu-1']);
    expect(result.total).toBe(1);
  });

  it('必需端口未装配时 fail-fast，不复用动态 import 兜底', async () => {
    resetWorkUnitPorts();
    await expect(workUnitPort('verification')).rejects.toThrow('WorkUnit verification port 未注册');
  });
});

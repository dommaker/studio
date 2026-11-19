/** ARCH-04：Requirements 缺省读路径经已装配 ProjectReadPort，不回退 PMO 动态 import。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectReadPort,
  registerProjectReadPort,
  resetProjectReadPort,
  type ProjectReadData,
} from '../project-read-port.js';
import { resolvePmoBranchForWU } from '../pmo-branch-resolver.js';

const project: ProjectReadData = {
  id: 'proj-1',
  pmoNumber: 'PMO-7',
  reqAlias: 'REQ-0007',
  title: 'Ported project',
  description: null,
  requirementsDocId: null,
  status: 'active',
  channelId: 'ch-1',
  createdAt: '2026-10-28T00:00:00.000Z',
  isChore: false,
  gitBranch: 'PMO-7',
  gitRepo: '/repo/project',
  deliveryPolicy: 'branch-only',
  deliveries: [],
};

afterEach(() => resetProjectReadPort());

describe('ProjectReadPort', () => {
  it('未装配时 fail-fast，不隐蔽加载 PMO', async () => {
    resetProjectReadPort();
    await expect(projectReadPort()).rejects.toThrow('ProjectReadPort 未注册');
  });

  it('分支解析缺省路径只调用端口中的项目读取与纯投影', async () => {
    const get = vi.fn(async () => project);
    registerProjectReadPort({
      get,
      getByReqAlias: async () => null,
      getByPmoNumber: async () => null,
      findChoreProject: async () => null,
      list: async () => [],
      resolveDeliveries: value => value.deliveries?.length ? value.deliveries : [{
        gitRepo: value.gitRepo, branch: value.gitBranch, status: 'pending',
      }],
      resolveDeliveryPolicy: value => value.deliveryPolicy ?? 'branch-only',
      matchWuToLeg: () => false,
    });

    await expect(resolvePmoBranchForWU({ metadata: JSON.stringify({ pmoId: project.id }) }))
      .resolves.toEqual({ projectId: project.id, branch: project.pmoNumber, deliveryPolicy: 'branch-only' });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(project.id);
  });
});

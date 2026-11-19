import { describe, expect, it, vi } from 'vitest';
import {
  getWorkUnitTreeTokens,
  listClaimableWorkUnits,
  submitPlanRuling,
  WorkUnitApplicationError,
} from '../workunit-application.js';
import { validWorkUnit } from './route-fixtures.js';

const fileStore = { getIndex: vi.fn() } as any;

describe('WorkUnit application use cases（ARCH-06）', () => {
  it('领域错误只携带 code/message，不携带 HTTP status', () => {
    const error = new WorkUnitApplicationError('NOT_FOUND', 'missing');

    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'missing' });
    expect(error).not.toHaveProperty('status');
  });

  it('list 只在页内含 unassigned 时读取依赖索引并派生 claimable', async () => {
    const ready = validWorkUnit({ id: 'ready', status: 'unassigned' });
    const active = validWorkUnit({ id: 'active', status: 'active' });
    fileStore.getIndex.mockResolvedValue([{ id: 'ready', status: 'unassigned' }]);

    const result = await listClaimableWorkUnits(
      { page: 1, limit: 20 },
      { service: { list: vi.fn().mockResolvedValue({ data: [ready, active], total: 2 }) } as any, fileStore },
    );

    expect(result.data.map(wu => [wu.id, wu.claimable])).toEqual([['ready', true], ['active', false]]);
    expect(fileStore.getIndex).toHaveBeenCalledTimes(1);

    fileStore.getIndex.mockClear();
    await listClaimableWorkUnits({}, {
      service: { list: vi.fn().mockResolvedValue({ data: [active], total: 1 }) } as any,
      fileStore,
    });
    expect(fileStore.getIndex).not.toHaveBeenCalled();
  });

  it('tree-token 使用 collab.rootId，并对 read port 结果做契约校验', async () => {
    const aggregateTreeTokens = vi.fn().mockResolvedValue({ rootId: 'root', nodes: [], rootTotal: 0, budgetRemaining: 10 });
    const result = await getWorkUnitTreeTokens('child', {
      service: { getById: vi.fn().mockResolvedValue(validWorkUnit({ id: 'child', metadata: JSON.stringify({ collab: { rootId: 'root' } }) })) } as any,
      fileStore,
      read: { aggregateTreeTokens },
    });

    expect(aggregateTreeTokens).toHaveBeenCalledWith('root', fileStore);
    expect(result.rootId).toBe('root');
  });

  it('ruling 在 validate/apply 前统一执行存在、blocked、待裁守卫', async () => {
    const review = {
      validateRulingItems: vi.fn().mockReturnValue([{ question: 'q', action: 'accept', conclusion: 'c' }]),
      applyPlanRuling: vi.fn().mockResolvedValue(validWorkUnit({ status: 'active' })),
      isPlanRulingError: vi.fn().mockReturnValue(false),
    };
    const service = { getById: vi.fn().mockResolvedValue(validWorkUnit({ status: 'active', metadata: JSON.stringify({ planRulings: [{ question: 'q' }] }) })) };

    await expect(submitPlanRuling('wu-1', [{ question: 'q', action: 'accept', conclusion: 'c' }], {
      service: service as any, fileStore, review: review as any,
    })).rejects.toMatchObject<Partial<WorkUnitApplicationError>>({ code: 'NOT_BLOCKED' });
    expect(review.validateRulingItems).not.toHaveBeenCalled();
    expect(review.applyPlanRuling).not.toHaveBeenCalled();

    service.getById.mockResolvedValue(validWorkUnit({ status: 'blocked', metadata: JSON.stringify({ planRulings: [{ question: 'q' }] }) }));
    await submitPlanRuling('wu-1', [{ question: 'q', action: 'accept', conclusion: 'c' }], {
      service: service as any, fileStore, review: review as any,
    });
    expect(review.validateRulingItems).toHaveBeenCalledOnce();
    expect(review.applyPlanRuling).toHaveBeenCalledWith('wu-1', [{ question: 'q', action: 'accept', conclusion: 'c' }], fileStore);
  });
});

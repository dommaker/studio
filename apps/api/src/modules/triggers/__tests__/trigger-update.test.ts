// AC-2: UPDATE action tests
// #538（ADR 2026-09-15 决策 6）：禁改 status（执行守卫）；其余字段走 patchSnapshot 白名单，
// metadata 走 updateMetadata 合并——原「可写 status」断言随语义变更反转（非删测试）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeUpdateAction } from '../trigger-action';
import type { TriggerAction } from '../trigger.types';

// Mock FileStore so trigger-action module uses a controlled instance
const mockFileStore = vi.hoisted(() => ({
  getIndex: vi.fn(),
  upsertSnapshot: vi.fn(),
  appendEvent: vi.fn(),
  removeSnapshot: vi.fn(),
  claimWorkUnit: vi.fn(),
  // #170：写路径改走锁内成对原语
  commitSnapshot: vi.fn(),
  // #538：metadata 增量合并写
  updateMetadata: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    FileStore: vi.fn(function () { return mockFileStore; }),
  };
});

function seedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-wu-1',
    parentId: null,
    type: 'task',
    scope: 'update-test',
    assigneeId: 'agent-1',
    status: 'active',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe('Trigger UPDATE action', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('禁改 status：执行守卫拒绝且零写入（ADR 决策 6，原「可写 status」断言反转）', async () => {
    mockFileStore.getIndex.mockResolvedValue([seedSnapshot()]);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: 'test-wu-1' },
        update: { status: 'unassigned', assigneeId: null },
      },
    };

    await expect(executeUpdateAction(action, {})).rejects.toThrow(/status/);
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
    expect(mockFileStore.updateMetadata).not.toHaveBeenCalled();
  });

  it('白名单字段经 service.update 落盘；白名单外字段丢弃不进快照', async () => {
    mockFileStore.getIndex.mockResolvedValue([seedSnapshot()]);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: 'test-wu-1' },
        update: { scope: '改后标题', assigneeId: null, hack: 'not-a-field' },
      },
    };

    await executeUpdateAction(action, {});

    // #170：更新经锁内成对写落盘（appendEvent + upsertSnapshot 同锁）
    expect(mockFileStore.commitSnapshot).toHaveBeenCalledTimes(1);
    const updatedSnapshot = mockFileStore.commitSnapshot.mock.calls[0][1];
    expect(updatedSnapshot.scope).toBe('改后标题');
    expect(updatedSnapshot.assigneeId).toBeNull();
    expect(updatedSnapshot.status).toBe('active'); // 未被触碰
    expect((updatedSnapshot as Record<string, unknown>).hack).toBeUndefined();
  });

  it('metadata 走 updateMetadata 增量合并（不整写覆盖既有键）', async () => {
    mockFileStore.getIndex.mockResolvedValue([seedSnapshot({ metadata: '{"a":1}' })]);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: 'test-wu-1' },
        update: { metadata: { b: 2 } },
      },
    };

    await executeUpdateAction(action, {});

    expect(mockFileStore.updateMetadata).toHaveBeenCalledTimes(1);
    const [wuId, mutator] = mockFileStore.updateMetadata.mock.calls[0];
    expect(wuId).toBe('test-wu-1');
    // mutator 基于锁内最新 metadata 合并：既有键保留，新键并入
    expect(mutator({ a: 1 })).toEqual({ a: 1, b: 2 });
    // 无白名单字段 → 不走整快照写
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
  });
});

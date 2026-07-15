// AC-2: UPDATE action tests
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
    FileStore: vi.fn(() => mockFileStore),
  };
});

describe('Trigger UPDATE action', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes FileStore update with static query/update', async () => {
    const wuId = 'test-wu-1';

    // Seed the mock FileStore with a WorkUnit snapshot
    mockFileStore.getIndex.mockResolvedValue([
      {
        id: wuId,
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
      },
    ]);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: wuId },
        update: { status: 'unassigned', assigneeId: null },
      },
    };

    await executeUpdateAction(action, {});

    // Verify the update was applied via upsertSnapshot
    expect(mockFileStore.appendEvent).toHaveBeenCalled();
    expect(mockFileStore.upsertSnapshot).toHaveBeenCalled();

    const updatedSnapshot = mockFileStore.upsertSnapshot.mock.calls[0][0];
    expect(updatedSnapshot.status).toBe('unassigned');
    expect(updatedSnapshot.assigneeId).toBeNull();
  });
});

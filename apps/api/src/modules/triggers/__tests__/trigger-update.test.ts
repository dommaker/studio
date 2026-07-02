// AC-2: UPDATE action tests
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { executeUpdateAction } from '../trigger-action';
import type { TriggerAction } from '../trigger.types';

// Mock logger
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
  };
});

describe('Trigger UPDATE action', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.workUnit.deleteMany({ where: { id: { in: createdIds } } });
    }
  });

  it('executes prisma update with static query/update', async () => {
    // Create a WorkUnit to update
    const wu = await prisma.workUnit.create({
      data: {
        type: 'task',
        scope: 'update-test',
        status: 'active',
      },
    });
    createdIds.push(wu.id);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: wu.id },
        update: { status: 'unassigned', assigneeId: null },
      },
    };

    await executeUpdateAction(action, {});

    const updated = await prisma.workUnit.findUnique({ where: { id: wu.id } });
    expect(updated!.status).toBe('unassigned');
    expect(updated!.assigneeId).toBeNull();
  });
});

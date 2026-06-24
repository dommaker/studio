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

  it('resolves $event.xxx template variables in query', async () => {
    const wu = await prisma.workUnit.create({
      data: {
        type: 'task',
        scope: 'template-test',
        status: 'blocked',
      },
    });
    createdIds.push(wu.id);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: '$event.workUnitId' },
        update: { status: 'unassigned' },
      },
    };

    await executeUpdateAction(action, { workUnitId: wu.id });

    const updated = await prisma.workUnit.findUnique({ where: { id: wu.id } });
    expect(updated!.status).toBe('unassigned');
  });

  it('resolves $event.xxx template variables in update', async () => {
    const wu = await prisma.workUnit.create({
      data: {
        type: 'task',
        scope: 'update-template-test',
        status: 'active',
        assigneeId: 'old-agent',
      },
    });
    createdIds.push(wu.id);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: wu.id },
        update: { assigneeId: '$event.newAssignee' },
      },
    };

    await executeUpdateAction(action, { newAssignee: 'new-agent' });

    const updated = await prisma.workUnit.findUnique({ where: { id: wu.id } });
    expect(updated!.assigneeId).toBe('new-agent');
  });

  it('skips fields where $event variable not in payload', async () => {
    const wu = await prisma.workUnit.create({
      data: {
        type: 'task',
        scope: 'skip-template-test',
        status: 'active',
        assigneeId: 'keep-me',
      },
    });
    createdIds.push(wu.id);

    const action: TriggerAction = {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { id: wu.id },
        update: { assigneeId: '$event.nonExistentField' },
      },
    };

    await executeUpdateAction(action, { otherField: 'value' });

    // assigneeId should be unchanged because $event.nonExistentField is not in payload
    const updated = await prisma.workUnit.findUnique({ where: { id: wu.id } });
    expect(updated!.assigneeId).toBe('keep-me');
  });
});

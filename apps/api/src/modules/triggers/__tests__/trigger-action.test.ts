// Trigger Action Tests (3.28c-4) — RED phase
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { executeCreateAction } from '../trigger-action';
import type { TriggerAction } from '../trigger.types';

describe('TriggerAction — CREATE WorkUnit', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.workUnit.deleteMany({ where: { id: { in: createdIds } } });
    }
  });

  it('creates a WorkUnit from trigger action', async () => {
    const action: TriggerAction = {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'System health check',
      },
    };

    const result = await executeCreateAction(action, 'daily-health-check');
    createdIds.push(result.id);

    expect(result.id).toBeDefined();
    expect(result.type).toBe('analysis');
    expect(result.scope).toBe('System health check');
    expect(result.status).toBe('unassigned');
  });

  it('sets channelId when provided', async () => {
    // Create a channel first
    const channel = await prisma.channel.create({
      data: { name: '#trigger-test-channel' },
    });

    const action: TriggerAction = {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'task',
        scope: 'Channel-bound task',
        channelId: channel.id,
      },
    };

    const result = await executeCreateAction(action, 'test-trigger');
    createdIds.push(result.id);

    expect(result.channelId).toBe(channel.id);

    // Cleanup channel
    await prisma.channel.delete({ where: { id: channel.id } });
  });

  it('stores trigger id in metadata', async () => {
    const action: TriggerAction = {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'monitor',
        scope: 'Monitored task',
      },
    };

    const result = await executeCreateAction(action, 'my-trigger-id');
    createdIds.push(result.id);

    expect(result.metadata).toBeDefined();
    const meta = JSON.parse(result.metadata!);
    expect(meta.triggerId).toBe('my-trigger-id');
    expect(meta.triggerSource).toBe('trigger-registry');
  });

  it('rejects unsupported action type', async () => {
    const action = {
      type: 'INVALID',
      target: 'WorkUnit',
      payload: { type: 'task', scope: 'x' },
    } as TriggerAction;

    await expect(executeCreateAction(action, 'test')).rejects.toThrow(/Unknown action type/);
  });
});

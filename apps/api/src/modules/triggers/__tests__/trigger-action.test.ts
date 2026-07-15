// Trigger Action Tests (3.28c-4) — RED phase
import { describe, it, expect, afterAll } from 'vitest';
import { executeCreateAction } from '../trigger-action';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/workunit.service.js';
import type { TriggerAction } from '../trigger.types';

describe('TriggerAction — CREATE WorkUnit', () => {
  const createdIds: string[] = [];
  const workUnitService = new WorkUnitService();

  afterAll(async () => {
    for (const id of createdIds) {
      await workUnitService.delete(id).catch(() => {});
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
    // Create a channel first in FileStore
    const channelId = `trigger-test-ch-${Date.now()}`;
    const fileStore = new FileStore();
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: channelId, name: '#trigger-test-channel', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', createdAt: now, updatedAt: now,
    });

    const action: TriggerAction = {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'task',
        scope: 'Channel-bound task',
        channelId,
      },
    };

    const result = await executeCreateAction(action, 'test-trigger');
    createdIds.push(result.id);

    expect(result.channelId).toBe(channelId);
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

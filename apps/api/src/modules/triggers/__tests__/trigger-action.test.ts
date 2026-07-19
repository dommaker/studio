// Trigger Action Tests (3.28c-4) — RED phase
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeCreateAction, setTriggerActionFileStore } from '../trigger-action';
import { FileStore } from '@dommaker/studio-shared';
import type { TriggerAction } from '../trigger.types';

describe('TriggerAction — CREATE WorkUnit', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeAll(() => {
    // Temp FileStore — 不触碰默认 ~/.studio/data（本机可能有运行中的 server 并发写）
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-action-test-'));
    fileStore = new FileStore(tmpDir);
    // trigger-action 模块级单例同样注入 tmp store
    setTriggerActionFileStore(fileStore);
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

    expect(result.id).toBeDefined();
    expect(result.type).toBe('analysis');
    expect(result.scope).toBe('System health check');
    expect(result.status).toBe('unassigned');
  });

  it('sets channelId when provided', async () => {
    // Create a channel first in FileStore
    const channelId = `trigger-test-ch-${Date.now()}`;
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

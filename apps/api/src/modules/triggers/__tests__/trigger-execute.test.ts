// AC-2: EXECUTE action tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeExecuteAction,
  registerExecuteHandler,
  unregisterExecuteHandler,
} from '../trigger-action';
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

describe('Trigger EXECUTE action', () => {
  beforeEach(() => {
    // Clean up handlers between tests
    unregisterExecuteHandler('test-handler');
    unregisterExecuteHandler('failing-handler');
  });

  it('registers execute handler and calls it on EXECUTE action', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerExecuteHandler('test-handler', handler);

    const action: TriggerAction = {
      type: 'EXECUTE',
      target: 'test-handler',
    };

    await executeExecuteAction(action, { data: 'test' });

    expect(handler).toHaveBeenCalledWith({ data: 'test' });
  });

  it('warns and skips when handler not registered', async () => {
    const { logger } = await import('@dommaker/studio-shared');
    const action: TriggerAction = {
      type: 'EXECUTE',
      target: 'non-existent-handler',
    };

    // Should not throw
    await expect(executeExecuteAction(action, {})).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No handler registered for execute target: non-existent-handler'),
    );
  });

  it('passes context to handler function', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerExecuteHandler('test-handler', handler);

    const context = { workUnitId: 'wu-1', type: 'task', scope: 'test' };
    const action: TriggerAction = {
      type: 'EXECUTE',
      target: 'test-handler',
    };

    await executeExecuteAction(action, context);

    expect(handler).toHaveBeenCalledWith(context);
  });

  it('logs error when handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('handler failed'));
    registerExecuteHandler('failing-handler', handler);

    const action: TriggerAction = {
      type: 'EXECUTE',
      target: 'failing-handler',
    };

    await expect(executeExecuteAction(action, {})).rejects.toThrow('handler failed');
  });
});

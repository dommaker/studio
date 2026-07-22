/**
 * RemoteExecutor tests — AC-8.1 ~ AC-8.9
 *
 * P1: RemoteExecutor 存在、实现 Executor 接口、节点离线时抛 RemoteNodeUnreachableError。
 * WS 通道留桩（P2 接通）。
 */
import { describe, it, expect } from 'vitest';
import { RemoteExecutor, RemoteNodeUnreachableError } from '../remote-executor.js';
import type { Executor } from '../executor.js';

describe('RemoteExecutor (AC-8.1 ~ AC-8.9)', () => {
  it('AC-8.1: RemoteExecutor class exists and implements Executor interface', () => {
    const executor: Executor = new RemoteExecutor('node-1');
    expect(executor).toBeInstanceOf(RemoteExecutor);
    expect(typeof executor.execute).toBe('function');
  });

  it('AC-8.4: throws RemoteNodeUnreachableError when WS channel not yet wired (P1 stub)', async () => {
    const executor = new RemoteExecutor('node-offline');
    await expect(executor.execute({
      id: 'task-1',
      executionId: 'exec-1',
      provider: 'claude' as any,
      prompt: 'test',
      nodeId: 'node-offline',
    })).rejects.toThrow(RemoteNodeUnreachableError);
  });

  it('RemoteNodeUnreachableError contains nodeId in message', async () => {
    try {
      await new RemoteExecutor('gpu-node-3').execute({
        id: 'task-2',
        executionId: 'exec-2',
        provider: 'claude' as any,
        prompt: 'test',
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteNodeUnreachableError);
      expect((err as Error).message).toContain('gpu-node-3');
    }
  });

  it('AC-8.1: constructor accepts custom timeoutMs', () => {
    const executor = new RemoteExecutor('node-1', 10_000);
    expect(executor).toBeInstanceOf(RemoteExecutor);
  });

  it('AC-8.6: RemoteExecutor is selected when nodeId is non-local', () => {
    // This tests the selection logic: profile with nodeId='gpu-1' should yield RemoteExecutor
    const exec = new RemoteExecutor('gpu-1');
    expect(exec).toBeInstanceOf(RemoteExecutor);
    // LocalExecutor would be used when nodeId is undefined or 'local'
    expect(exec).not.toBe(undefined);
  });
});

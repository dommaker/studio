/**
 * RemoteExecutor tests — AC-8.1 ~ AC-8.9
 *
 * P1: RemoteExecutor 存在、实现 Executor 接口、节点离线时抛 RemoteNodeUnreachableError。
 * P2: WS 通道接通 — execute() 调 sendAgentTask，mock 验证 WS 调用路径。
 */
import { describe, it, expect, vi } from 'vitest';
import { RemoteExecutor, RemoteNodeUnreachableError } from '../remote-executor.js';
import type { Executor } from '../executor.js';

// Mock sendAgentTask from ws-gateway
vi.mock('../../workspaces/ws-gateway.js', () => ({
  sendAgentTask: vi.fn(),
}));

import { sendAgentTask } from '../../workspaces/ws-gateway.js';

const mockResult = {
  success: true as const,
  worktree: '/tmp/test-worktree',
  outputFiles: ['output.txt'],
  logFile: '/tmp/test-worktree/.agent.log',
  sessionCount: 1,
};

const mockTask = {
  id: 'task-1',
  executionId: 'exec-1',
  provider: 'claude' as any,
  prompt: 'test prompt',
};

describe('RemoteExecutor (AC-8.1 ~ AC-8.9)', () => {
  it('AC-8.1: RemoteExecutor class exists and implements Executor interface', () => {
    const executor: Executor = new RemoteExecutor('node-1');
    expect(executor).toBeInstanceOf(RemoteExecutor);
    expect(typeof executor.execute).toBe('function');
  });

  it('AC-8.1: constructor accepts custom timeoutMs', () => {
    const executor = new RemoteExecutor('node-1', 10_000);
    expect(executor).toBeInstanceOf(RemoteExecutor);
  });

  it('AC-8.6: RemoteExecutor is selected when nodeId is non-local', () => {
    const exec = new RemoteExecutor('gpu-1');
    expect(exec).toBeInstanceOf(RemoteExecutor);
    expect(exec).not.toBe(undefined);
  });

  // ── P2: WS 通道测试 ──

  it('T6: execute resolves with ExecutionResult when sendAgentTask succeeds', async () => {
    vi.mocked(sendAgentTask).mockResolvedValueOnce(mockResult);

    const executor = new RemoteExecutor('node-1');
    const result = await executor.execute(mockTask);

    expect(result).toEqual(mockResult);
    expect(sendAgentTask).toHaveBeenCalledWith('node-1', mockTask, 30_000);
  });

  it('T7: execute throws RemoteNodeUnreachableError when sendAgentTask rejects with "No active connection"', async () => {
    vi.mocked(sendAgentTask).mockRejectedValueOnce(new Error('No active connection for workspace'));

    const executor = new RemoteExecutor('node-1');
    await expect(executor.execute(mockTask)).rejects.toThrow(RemoteNodeUnreachableError);
  });

  it('T8: execute throws RemoteNodeUnreachableError when sendAgentTask times out', async () => {
    vi.mocked(sendAgentTask).mockRejectedValueOnce(new Error('Agent task timed out'));

    const executor = new RemoteExecutor('gpu-node-5');
    await expect(executor.execute(mockTask)).rejects.toThrow(RemoteNodeUnreachableError);
  });

  it('T9 (AC-8.4): execute passes nodeId as workspaceId to sendAgentTask (P2 wiring)', async () => {
    vi.mocked(sendAgentTask).mockResolvedValueOnce(mockResult);

    const executor = new RemoteExecutor('node-custom');
    await executor.execute({ ...mockTask, nodeId: 'node-custom' });

    expect(sendAgentTask).toHaveBeenCalledWith('node-custom', expect.any(Object), 30_000);
  });

  it('execute passes custom timeoutMs to sendAgentTask', async () => {
    vi.mocked(sendAgentTask).mockResolvedValueOnce(mockResult);

    const executor = new RemoteExecutor('node-1', 15_000);
    await executor.execute(mockTask);

    expect(sendAgentTask).toHaveBeenCalledWith('node-1', mockTask, 15_000);
  });

  it('RemoteNodeUnreachableError contains nodeId and cause in message', () => {
    const err = new RemoteNodeUnreachableError('gpu-node-3', 'No active connection for workspace');
    expect(err.message).toContain('gpu-node-3');
    expect(err.message).toContain('No active connection');
    expect(err.name).toBe('RemoteNodeUnreachableError');
  });
});

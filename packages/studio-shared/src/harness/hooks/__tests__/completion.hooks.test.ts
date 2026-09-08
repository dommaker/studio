/**
 * completion.hooks 测试（#425 配套切换）
 *
 * 审查失败路径写 FailureRecorder 时，logFile 必须取 harness 公开常量
 * DEFAULT_FAILURE_LOG_FILE，不得再硬编码字面量（口径归一，harness#76）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { afterReview } from '../completion.hooks.js';

const createFailureRecorderMock = vi.fn();

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return {
    ...actual,
    createFailureRecorder: (...args: unknown[]) => createFailureRecorderMock(...args),
  };
});

describe('afterReview 失败路径', () => {
  beforeEach(() => {
    createFailureRecorderMock.mockReset();
    createFailureRecorderMock.mockReturnValue({ record: vi.fn() });
  });

  it('FailureRecorder 的 logFile 取 harness DEFAULT_FAILURE_LOG_FILE 常量', async () => {
    const { DEFAULT_FAILURE_LOG_FILE } = await import('@dommaker/harness');
    await afterReview({ approved: false, score: 2, issueCount: 3, cycle: 1 });
    expect(createFailureRecorderMock).toHaveBeenCalledWith({ logFile: DEFAULT_FAILURE_LOG_FILE });
  });

  it('审查通过路径不创建 FailureRecorder', async () => {
    await afterReview({ approved: true, score: 9, cycle: 1 });
    expect(createFailureRecorderMock).not.toHaveBeenCalled();
  });
});

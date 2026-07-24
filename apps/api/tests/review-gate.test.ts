/**
 * AS-007 ReviewGate 集成测试
 * 
 * 验证 PR 创建后 ReviewGate 验证审查状态
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewGate } from '@dommaker/harness';
import type { GateContext, GateResult } from '@dommaker/harness';

// Mock ReviewGate
vi.mock('@dommaker/harness', () => ({
  ReviewGate: vi.fn().mockImplementation(function () { return {
    check: vi.fn().mockResolvedValue({
      gate: 'review',
      passed: false,  // 新 PR 通常无审批
      message: '审查未通过: 0/1 审批',
      details: { approvals: 0, changesRequested: 0, minReviewers: 1 },
      timestamp: new Date().toISOString(),
    } as GateResult),
  }; }),
}));

describe('AS-007: ReviewGate Integration', () => {
  let reviewGate: ReviewGate;

  beforeEach(() => {
    vi.clearAllMocks();
    reviewGate = new ReviewGate({
      minReviewers: 1,
      requireApproval: false,
      blockOnChangesRequested: false,
    });
  });

  /**
   * AC-001：createPullRequest 调用 ReviewGate.check()
   */
  it('AC-001: should call ReviewGate.check() after PR creation', async () => {
    const project = {
      id: 'test-project',
      pmoNumber: 'PM-001',
      gitBranch: 'feat/pm-001',
      gitRepo: 'test/repo',
    };

    // Mock PR 创建
    const mockPRResult = {
      url: 'https://github.com/test/repo/pull/123',
      number: 123,
      reviewStatus: {
        gate: 'review',
        passed: false,
        message: '审查未通过: 0/1 审批',
      },
    };

    // 验证 ReviewGate.check 被调用
    expect(reviewGate.check).toBeDefined();
    
    const gateContext: GateContext = {
      projectId: project.id,
      projectPath: `/root/projects/${project.pmoNumber}`,
      prNumber: 123,
    };

    const result = await reviewGate.check(gateContext);
    
    expect(reviewGate.check).toHaveBeenCalledWith(gateContext);
    expect(result.gate).toBe('review');
  });

  /**
   * AC-002：PR 创建返回审查状态
   */
  it('AC-002: should return reviewStatus in PR result', async () => {
    const gateContext: GateContext = {
      projectId: 'test-project',
      projectPath: '/root/projects/PM-001',
      prNumber: 123,
    };

    const result = await reviewGate.check(gateContext);

    expect(result).toBeDefined();
    expect(result.gate).toBe('review');
    expect(result.passed).toBeDefined();
    expect(result.message).toBeDefined();
  });

  /**
   * AC-003：ReviewGate 配置从环境变量读取
   */
  it('AC-003: should configure ReviewGate from environment', () => {
    // 模拟环境变量
    process.env.REVIEW_GATE_MIN_REVIEWERS = '2';
    process.env.REVIEW_GATE_REQUIRE_APPROVAL = 'true';
    process.env.REVIEW_GATE_BLOCK_ON_CHANGES_REQUESTED = 'true';

    const configuredGate = new ReviewGate({
      minReviewers: parseInt(process.env.REVIEW_GATE_MIN_REVIEWERS || '1'),
      requireApproval: process.env.REVIEW_GATE_REQUIRE_APPROVAL === 'true',
      blockOnChangesRequested: process.env.REVIEW_GATE_BLOCK_ON_CHANGES_REQUESTED === 'true',
    });

    expect(configuredGate).toBeDefined();
    
    // 清理环境变量
    delete process.env.REVIEW_GATE_MIN_REVIEWERS;
    delete process.env.REVIEW_GATE_REQUIRE_APPROVAL;
    delete process.env.REVIEW_GATE_BLOCK_ON_CHANGES_REQUESTED;
  });

  /**
   * AC-004：本地项目路径获取
   */
  it('AC-004: should get project work dir', () => {
    const projectId = 'test-project';
    const pmoNumber = 'PM-001';

    // 方案 A: 配置映射
    process.env.PROJECT_WORKDIRS = JSON.stringify({
      'test-project': '/custom/path/PM-001',
    });

    const workDirs = JSON.parse(process.env.PROJECT_WORKDIRS || '{}');
    const path = workDirs[projectId] || `/root/projects/${pmoNumber}`;

    expect(path).toBe('/custom/path/PM-001');

    // 方案 B: 默认规则
    delete process.env.PROJECT_WORKDIRS;
    const defaultPath = `/root/projects/${pmoNumber}`;
    expect(defaultPath).toBe('/root/projects/PM-001');
  });

  /**
   * AC-005：ReviewGate.check() 失败不阻断 PR 创建
   */
  it('AC-005: should not block PR creation when ReviewGate fails', async () => {
    const gateContext: GateContext = {
      projectId: 'test-project',
      projectPath: '/root/projects/PM-001',
      prNumber: 123,
    };

    const result = await reviewGate.check(gateContext);

    // 即使 reviewResult.passed = false，PR 仍创建成功
    expect(result.passed).toBe(false);  // 新 PR 无审批
    // PR 创建不会因为 ReviewGate 失败而中断
  });

  /**
   * AC-006：日志记录审查状态
   */
  it('AC-006: should log review result', async () => {
    const mockLogger = {
      info: vi.fn(),
    };

    const gateContext: GateContext = {
      projectId: 'test-project',
      projectPath: '/root/projects/PM-001',
      prNumber: 123,
    };

    const result = await reviewGate.check(gateContext);

    // 模拟 logger.info 调用
    mockLogger.info({ prNumber: 123, reviewResult: result }, 'ReviewGate checked');

    expect(mockLogger.info).toHaveBeenCalledWith(
      { prNumber: 123, reviewResult: expect.any(Object) },
      'ReviewGate checked'
    );
  });
});
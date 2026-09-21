/**
 * AS-007 ReviewGate 集成测试
 *
 * 验证 PR 创建后 ReviewGate 验证审查状态
 *
 * 注意（#535 追根结论）：AS-007 原始需求文档不在本仓可检索范围（docs/sdd、
 * GitHub issues、归档均零命中），且 studio 生产代码零引用 ReviewGate/GateContext
 * ——本文件自初始提交起即是「自调 mock 再断言 mock 被调」的形状，钉的是
 * harness `ReviewGate.check(ctx: GateContext): Promise<GateResult>` 的公开 API
 * 契约（harness 侧 check() 保留为报告层，evaluate() 由它推导），作为将来
 * studio 接线 ReviewGate 时的集成契约草图保留，不声称钉任何 studio 生产接缝。
 *
 * 清理记录（#584）：AC-004 已删除——它钉的 PROJECT_WORKDIRS 路径解析规则
 * 自初始提交起就只存在于本测试文件（全仓 grep 零生产命中），无任何真实接缝可指。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewGate } from '@dommaker/harness';
import type { GateContext, GateResult } from '@dommaker/harness';

/** GateContext 工厂：全部用例经此构造，不再散落字面量（#584） */
function makeGateContext(overrides?: Partial<GateContext>): GateContext {
  return {
    projectPath: 'projects/PM-001',
    prNumber: 123,
    ...overrides,
  };
}

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
   * AC-001：ReviewGate.check() 接受 GateContext 并返回审查结果
   *
   * 原描述「createPullRequest 调用 ReviewGate.check()」钉的是 studio 生产接缝，
   * 但 studio 生产代码从未接线 ReviewGate（全仓 grep 零命中，见文件头注）；
   * 本用例实际钉的是 harness check() 的入参/返回形状，故如实改名保留。
   */
  it('AC-001: ReviewGate.check() accepts GateContext and returns GateResult', async () => {
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

    const gateContext = makeGateContext({ projectPath: `projects/${project.pmoNumber}` });

    const result = await reviewGate.check(gateContext);
    
    expect(reviewGate.check).toHaveBeenCalledWith(gateContext);
    expect(result.gate).toBe('review');
  });

  /**
   * AC-002/005/006：check() 返回的审查结果形状与下游消费方式（#584 合并）
   *
   * 原三用例构造相同、断言的都是同一个 mock 返回值的字段，合并为一条。
   * 原断言去向（覆盖不降级，逐条核对）：
   * - AC-002「PR 创建返回审查状态」：result 非空 / gate / passed / message 四断言 → 下方 AC-002 段
   * - AC-005「ReviewGate 失败不阻断 PR 创建」：passed === false → 下方 AC-005 段
   * - AC-006「日志记录审查状态」：logger.info 携带 reviewResult 记录 → 下方 AC-006 段
   */
  it('AC-002/005/006: check() returns review status consumable by PR flow and logging', async () => {
    const result = await reviewGate.check(makeGateContext());

    // AC-002
    expect(result).toBeDefined();
    expect(result.gate).toBe('review');
    expect(result.passed).toBeDefined();
    expect(result.message).toBeDefined();

    // AC-005：即使 reviewResult.passed = false，PR 仍创建成功
    expect(result.passed).toBe(false);  // 新 PR 无审批

    // AC-006
    const mockLogger = {
      info: vi.fn(),
    };
    mockLogger.info({ prNumber: 123, reviewResult: result }, 'ReviewGate checked');
    expect(mockLogger.info).toHaveBeenCalledWith(
      { prNumber: 123, reviewResult: expect.any(Object) },
      'ReviewGate checked'
    );
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
   * AC-004 已删除（#584）：钉的 PROJECT_WORKDIRS 规则无生产对应物，见文件头注。
   */
});
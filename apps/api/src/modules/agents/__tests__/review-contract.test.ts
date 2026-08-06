// review-contract：verdict 契约单测（legacy ↔ canonical 映射矩阵 + 规范裁决规则）
// - approvedToVerdict / verdictToApproved：pass⇔true、reject⇔false、needs-info 无 legacy 等价 → null
// - deriveVerdictFromLegacyReport：error 级 issue 覆盖 overallApproved=true（原 FIX #8 收编）；
//   warning/info 不阻断；issues 缺失 / overallApproved 非布尔安全落到 reject
// - isReviewVerdict 守卫：三态通过，其余一律 false
import { describe, it, expect } from 'vitest';
import {
  approvedToVerdict,
  verdictToApproved,
  hasBlockingIssues,
  deriveVerdictFromLegacyReport,
  isReviewVerdict,
} from '../review-contract.js';

describe('review-contract: legacy ↔ canonical 映射', () => {
  it('approvedToVerdict: true→pass / false→reject', () => {
    expect(approvedToVerdict(true)).toBe('pass');
    expect(approvedToVerdict(false)).toBe('reject');
  });

  it('verdictToApproved: pass→true / reject→false / needs-info→null（无 legacy 等价物）', () => {
    expect(verdictToApproved('pass')).toBe(true);
    expect(verdictToApproved('reject')).toBe(false);
    expect(verdictToApproved('needs-info')).toBeNull();
  });

  it('isReviewVerdict: 三态通过，其余一律 false', () => {
    expect(isReviewVerdict('pass')).toBe(true);
    expect(isReviewVerdict('reject')).toBe(true);
    expect(isReviewVerdict('needs-info')).toBe(true);
    expect(isReviewVerdict('approved')).toBe(false);
    expect(isReviewVerdict('')).toBe(false);
    expect(isReviewVerdict(null)).toBe(false);
    expect(isReviewVerdict(undefined)).toBe(false);
    expect(isReviewVerdict(1)).toBe(false);
  });
});

describe('review-contract: hasBlockingIssues', () => {
  it('error 级 issue ⇒ 阻断', () => {
    expect(hasBlockingIssues([{ severity: 'error' }])).toBe(true);
    expect(hasBlockingIssues([{ severity: 'info' }, { severity: 'error' }])).toBe(true);
  });

  it('warning/info 不阻断；issues 缺失不阻断', () => {
    expect(hasBlockingIssues([{ severity: 'warning' }, { severity: 'info' }])).toBe(false);
    expect(hasBlockingIssues([])).toBe(false);
    expect(hasBlockingIssues(undefined)).toBe(false);
  });
});

describe('review-contract: deriveVerdictFromLegacyReport（规范裁决，原 FIX #8）', () => {
  it('无 error issue + overallApproved=true → pass', () => {
    expect(deriveVerdictFromLegacyReport({ overallApproved: true }, [])).toBe('pass');
    expect(deriveVerdictFromLegacyReport({ overallApproved: true }, [{ severity: 'warning' }])).toBe('pass');
  });

  it('无 error issue + overallApproved=false → reject', () => {
    expect(deriveVerdictFromLegacyReport({ overallApproved: false }, [])).toBe('reject');
  });

  it('error 级 issue 覆盖 overallApproved=true 的误报 → reject（FIX #8 语义）', () => {
    expect(deriveVerdictFromLegacyReport({ overallApproved: true }, [{ severity: 'error' }])).toBe('reject');
    expect(deriveVerdictFromLegacyReport({ overallApproved: false }, [{ severity: 'error' }])).toBe('reject');
  });

  it('failed AC 折算的 error issue 同样阻断（调用方并入 issues 后）', () => {
    const merged = [
      { severity: 'warning' },
      { severity: 'error' }, // acResults passed=false 折算
    ];
    expect(deriveVerdictFromLegacyReport({ overallApproved: true }, merged)).toBe('reject');
  });

  it('malformed 容忍：issues 缺失 / overallApproved 非 true 一律安全落到 reject 或不误放 pass', () => {
    expect(deriveVerdictFromLegacyReport({ overallApproved: true }, undefined)).toBe('pass');
    expect(deriveVerdictFromLegacyReport({}, [])).toBe('reject');
    expect(deriveVerdictFromLegacyReport({ overallApproved: 'yes' }, [])).toBe('reject');
    expect(deriveVerdictFromLegacyReport({ overallApproved: undefined }, undefined)).toBe('reject');
  });

  it('legacy 报告永不产生 needs-info', () => {
    const verdicts = [
      deriveVerdictFromLegacyReport({ overallApproved: true }, []),
      deriveVerdictFromLegacyReport({ overallApproved: false }, [{ severity: 'error' }]),
      deriveVerdictFromLegacyReport({}, undefined),
    ];
    expect(verdicts).not.toContain('needs-info');
  });
});

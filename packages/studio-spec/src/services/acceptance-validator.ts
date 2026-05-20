/**
 * 验收层验证器
 * 
 * 检查项：
 * - AC ID 唯一性
 * - AC 可测试性（有 test 字段）
 * - AC 描述可验证（无模糊表述）
 */

import type {
  SpecContent,
  AcceptanceValidationResult,
  CheckResult,
} from '../types/validation.types.js';

// 模糊表述关键词（不可验证）
const VAGUE_KEYWORDS = [
  'should work well',
  'good user experience',
  '看起来',
  '感觉',
  '好像',
  '应该可以',
  '方便',
  '简单',
  'easy',
  'nice',
  'smooth',
  'better',
];

export class AcceptanceValidator {
  /**
   * 验证 Spec 验收层
   */
  async validate(spec: SpecContent, testDir?: string): Promise<AcceptanceValidationResult> {
    const checks: CheckResult[] = [];
    const untestableCriteria: string[] = [];
    const duplicateIds: string[] = [];

    if (!spec.acceptance_criteria || spec.acceptance_criteria.length === 0) {
      // 无 AC 定义，视为不通过
      return {
        valid: false,
        checks: [{
          checkId: 'acceptance-no-criteria',
          description: '无验收标准定义',
          passed: false,
          message: 'Spec 未定义 acceptance_criteria',
        }],
        untestableCriteria: [],
        duplicateIds: [],
      };
    }

    // 检查 AC ID 唯一性
    const seenIds = new Set<string>();
    for (const ac of spec.acceptance_criteria) {
      const isDuplicate = seenIds.has(ac.id);
      checks.push({
        checkId: `acceptance-id-${ac.id}`,
        description: `检查 AC ID 唯一性`,
        passed: !isDuplicate,
        message: isDuplicate ? undefined : `AC ID 重复: ${ac.id}`,
        location: isDuplicate ? undefined : `acceptance_criteria.${ac.id}.id`,
      });

      if (isDuplicate) {
        duplicateIds.push(ac.id);
      }
      seenIds.add(ac.id);
    }

    // 检查每个 AC
    for (const ac of spec.acceptance_criteria) {
      // 检查 test 字段存在
      const hasTest = ac.test !== undefined && ac.test.length > 0;
      checks.push({
        checkId: `acceptance-test-${ac.id}`,
        description: `检查 AC 有 test 字段`,
        passed: hasTest,
        message: hasTest ? undefined : `AC 缺失 test 字段: ${ac.id}`,
        location: hasTest ? undefined : `acceptance_criteria.${ac.id}.test`,
      });

      if (!hasTest) {
        untestableCriteria.push(ac.id);
      }

      // 检查描述可验证
      const isVague = this.isDescriptionVague(ac.description);
      checks.push({
        checkId: `acceptance-desc-${ac.id}`,
        description: `检查 AC 描述可验证`,
        passed: !isVague,
        message: isVague ? `AC 描述模糊: "${ac.description}"` : undefined,
        location: isVague ? `acceptance_criteria.${ac.id}.description` : undefined,
      });

      if (isVague) {
        untestableCriteria.push(ac.id);
      }
    }

    const valid = duplicateIds.length === 0 && untestableCriteria.length === 0;

    return {
      valid,
      checks,
      untestableCriteria,
      duplicateIds,
    };
  }

  /**
   * 检查描述是否模糊
   */
  private isDescriptionVague(description: string): boolean {
    const lowerDesc = description.toLowerCase();
    
    for (const keyword of VAGUE_KEYWORDS) {
      if (lowerDesc.includes(keyword.toLowerCase())) {
        return true;
      }
    }

    // 检查描述过短（< 10 字符）
    if (description.length < 10) {
      return true;
    }

    return false;
  }
}
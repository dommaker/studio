/**
 * knowledge-form-gate — 知识形态门禁（knowledge / data / skill / rule 判定）。
 *
 * 从 knowledge-service.ts 抽出（工单 29，纯搬运不改逻辑）。
 * 代码层判断，不调 LLM。遵循 no_model_for_deterministic。
 */

export interface FormValidationResult {
  valid: boolean;
  form: 'knowledge' | 'data' | 'skill' | 'rule';
  reason?: string;
}

/**
 * 判断条目是否属于知识形态。
 * 代码层判断，不调 LLM。遵循 no_model_for_deterministic。
 */
export function validateKnowledgeForm(entry: {
  type: string;
  content: string;
  tags: string[];
}): FormValidationResult {
  // 规则形态检测：短指令式（优先于空检查，因为规则本身就短）
  const rulePatterns = [/^禁止/, /^必须/, /^不得/];
  if (rulePatterns.some(p => p.test(entry.content.trim())) && entry.content.length < 100) {
    return { valid: false, form: 'rule', reason: 'short imperative directive' };
  }

  // 空内容或太短
  if (!entry.content || entry.content.trim().length < 20) {
    return { valid: false, form: 'data', reason: 'content too short' };
  }

  // 数据形态检测：含具体数值/百分比/日期
  const dataPatterns = [
    /\d+%/,
    /\d{4}-\d{2}-\d{2}/,
    /premium:\s*\d+/,
    /analyst_accuracy/,
  ];
  if (entry.type === 'process' && dataPatterns.some(p => p.test(entry.content))) {
    return { valid: false, form: 'data', reason: 'contains statistical data' };
  }
  if (entry.tags.includes('trend') || entry.tags.includes('analyst_accuracy')) {
    return { valid: false, form: 'data', reason: 'data-type tag' };
  }

  // Skill 形态检测：多步骤流程
  const skillPatterns = [
    /step\s*\d/i,
    /步骤\s*\d/,
    /^\d+\.\s+.+\n\d+\.\s+.+\n\d+\./m,
  ];
  if (skillPatterns.some(p => p.test(entry.content)) && entry.content.length > 500) {
    return { valid: false, form: 'skill', reason: 'multi-step process detected' };
  }

  // 默认：知识形态
  return { valid: true, form: 'knowledge' };
}

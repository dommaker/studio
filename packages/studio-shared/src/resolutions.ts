/**
 * RKB 已知解法查询 — 共享匹配核心（#361 双实现收一）。
 *
 * 此前 studio-agent（session 错误 → prompt 注入）与 apps/api knowledge
 * （API 匹配 + 消费事件）各有一份逐字相同的实现，「regex 匹配失败回退子串包含」
 * 的分支与成熟度过滤完全一致，坍缩到本模块。studio-agent 侧那份的唯一调用方随
 * #562 多 session 循环删除（#587 摘除），现唯一生产消费方是 apps/api resolution.service。
 *
 * 消费方各自保留差异项：文档扫描与 fix 提取口径、promptSnippet 格式化、
 * errorClass 收窄——本模块只收真正的共同逻辑。
 * 注意：formatRkbHint 是那份已删实现的输出格式，#587 后暂无生产调用方（待另票裁决）。
 */

/** RKB 成熟度闸门：verified/canonical 才可注入/展示（pending/draft 不参与） */
export function isActionableMaturity(maturity: unknown): boolean {
  return maturity === 'verified' || maturity === 'canonical';
}

/**
 * 错误消息 → 已知解法匹配。pattern 按 regex(i) 尝试；非法 regex 回退小写子串包含。
 * 两条旧实现逐字相同的核心段，含 pattern 为空串时 RegExp('') 恒真的历史行为。
 */
export function matchResolutionPatterns<T extends { pattern: string }>(
  candidates: T[],
  errorMessage: string,
): T[] {
  const matched: T[] = [];
  const lowerMsg = errorMessage.toLowerCase();
  for (const row of candidates) {
    let isMatch = false;
    try {
      if (new RegExp(row.pattern, 'i').test(errorMessage)) isMatch = true;
    } catch {
      if (lowerMsg.includes(row.pattern.toLowerCase())) isMatch = true;
    }
    if (isMatch) matched.push(row);
  }
  return matched;
}

/**
 * RKB hint 格式化（runner 注入口径）：markdown 列表，供下一轮 prompt 注入。
 */
export function formatRkbHint(matched: Array<{ title: string; fix: string }>): string {
  return '## 已知解法 (RKB)\n以下解法曾在类似错误上验证有效：\n'
    + matched.map(r => `- **${r.title}**: ${r.fix}`).join('\n');
}

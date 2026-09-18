/**
 * parseDecisionConclusion 单测（#463：decision WU 输出的 `## 结论摘要` 段解析 →
 * metadata.decisionSuggestion，确认弹窗预填 + 收口闸 2 契约产物锚点的数据源）。
 */
import { describe, it, expect } from 'vitest';
import { parseDecisionConclusion } from '../loop/agent-loop-parsers.js';

describe('parseDecisionConclusion', () => {
  it('提取 `## 结论摘要` 段正文（到下一个 ## 段为止）', () => {
    const text = [
      '前序分析过程……',
      '## 结论摘要',
      '选方案 A，理由是 X。',
      '第二行补充。',
      '## 其他段',
      '不应进入结论',
      'ACTION: COMPLETE: done',
    ].join('\n');
    expect(parseDecisionConclusion(text)).toBe('选方案 A，理由是 X。\n第二行补充。');
  });

  it('段末遇 ACTION: 行截断', () => {
    const text = '## 结论摘要\n结论 B。\nACTION: COMPLETE: done';
    expect(parseDecisionConclusion(text)).toBe('结论 B。');
  });

  it('无摘要段 / 段体为空 / 空输入 → null', () => {
    expect(parseDecisionConclusion('只是普通输出\nACTION: COMPLETE: done')).toBeNull();
    expect(parseDecisionConclusion('## 结论摘要\n\n## 下一节\nx')).toBeNull();
    expect(parseDecisionConclusion('')).toBeNull();
  });
});

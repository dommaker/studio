/**
 * RKB 匹配核心（#361 双实现收一）单测
 *
 * matchResolutionPatterns 的 regex 失败回退子串分支此前在
 * studio-agent/runner-output 与 apps/api/resolution.service 两处逐字重复。
 */
import { describe, test, expect } from 'vitest';
import { isActionableMaturity, matchResolutionPatterns, formatRkbHint } from '../resolutions';

describe('isActionableMaturity', () => {
  test('verified/canonical 可用，pending/draft/缺省不可', () => {
    expect(isActionableMaturity('verified')).toBe(true);
    expect(isActionableMaturity('canonical')).toBe(true);
    expect(isActionableMaturity('pending')).toBe(false);
    expect(isActionableMaturity('draft')).toBe(false);
    expect(isActionableMaturity(undefined)).toBe(false);
  });
});

describe('matchResolutionPatterns', () => {
  const rows = [
    { id: 'a', pattern: 'boom error' },
    { id: 'b', pattern: '[' },            // 非法 regex → 回退子串包含
    { id: 'c', pattern: 'unrelated' },
  ];

  test('regex(i) 命中（大小写不敏感）', () => {
    const matched = matchResolutionPatterns(rows, 'A BOOM ERROR happened');
    expect(matched.map(r => r.id)).toEqual(['a']);
  });

  test('非法 regex 回退小写子串包含（原双实现的逐字相同分支）', () => {
    const matched = matchResolutionPatterns(rows, 'panic at [kernel]');
    // 'a' 不子串命中（'boom error' 不是子串）；'b' 走回退命中字面 `[`
    expect(matched.map(r => r.id)).toEqual(['b']);
  });

  test('空串 pattern：RegExp("") 恒真（保留历史行为）', () => {
    const matched = matchResolutionPatterns([{ id: 'z', pattern: '' }], 'anything');
    expect(matched).toHaveLength(1);
  });

  test('无匹配 → 空数组', () => {
    expect(matchResolutionPatterns(rows, 'totally different failure')).toEqual([]);
  });
});

describe('formatRkbHint', () => {
  test('markdown 列表口径与旧 runner 输出一致', () => {
    const hint = formatRkbHint([
      { title: 'Boom', fix: 'apply the fix' },
      { title: 'Calm', fix: 'breathe' },
    ]);
    expect(hint).toContain('已知解法 (RKB)');
    expect(hint).toContain('- **Boom**: apply the fix');
    expect(hint).toContain('- **Calm**: breathe');
  });
});

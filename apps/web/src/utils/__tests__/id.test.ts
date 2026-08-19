// shortWuId（#241/#242）：长 id 截短显示规则
import { describe, it, expect } from 'vitest';
import { shortWuId } from '../id';

describe('shortWuId', () => {
  it('长 id（UUID 形态）→ 前 8 位 + …', () => {
    expect(shortWuId('160eeee8-aaaa-bbbb-cccc-dddddddddddd')).toBe('160eeee8…');
  });

  it('短 id（WU-N 形态，≤12 字符）→ 原样', () => {
    expect(shortWuId('WU-1018')).toBe('WU-1018');
    expect(shortWuId('123456789012')).toBe('123456789012');
  });
});

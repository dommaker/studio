// parseMeta 单元测试 — #264 meta object 单型（后端 REST/SSE 出口恒 object）
// 组件/页面级覆盖见 ChannelMessageItem.test.tsx、ChannelDetailPage*.test.tsx
import { describe, it, expect } from 'vitest';
import { parseMeta } from '../messageMeta';

describe('parseMeta — #264 object 单型', () => {
  it('object 直接取用（线上 REST/SSE 出口形态），字段原样可读', () => {
    const meta = { cardType: 'knowledge_proposal', status: 'ready', cardData: { entries: [{ id: 'k-1' }] }, pmoId: 'proj-1' };
    const parsed = parseMeta(meta);
    expect(parsed.cardType).toBe('knowledge_proposal');
    expect(parsed.cardData).toEqual({ entries: [{ id: 'k-1' }] });
    expect(parsed.pmoId).toBe('proj-1');
  });

  it('undefined / null 回退 {}', () => {
    expect(parseMeta(undefined)).toEqual({});
    expect(parseMeta(null)).toEqual({});
  });
});

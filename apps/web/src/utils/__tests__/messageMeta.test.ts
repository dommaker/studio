// parseMeta 单元测试 — #264 meta object×string 双型兼容
// 组件/页面级覆盖见 ChannelMessageItem.test.tsx、ChannelDetailPage*.test.tsx
import { describe, it, expect } from 'vitest';
import { parseMeta } from '../messageMeta';

describe('parseMeta — #264 双型兼容', () => {
  it('object 直接取用（线上 REST/SSE 出口形态），字段原样可读', () => {
    const meta = { cardType: 'knowledge_proposal', status: 'ready', cardData: { entries: [{ id: 'k-1' }] }, pmoId: 'proj-1' };
    const parsed = parseMeta(meta);
    expect(parsed.cardType).toBe('knowledge_proposal');
    expect(parsed.cardData).toEqual({ entries: [{ id: 'k-1' }] });
    expect(parsed.pmoId).toBe('proj-1');
  });

  it('string 则 JSON.parse（存量/夹具形态），行为与修复前一致', () => {
    const parsed = parseMeta(JSON.stringify({ cardType: 'memory_proposal', status: 'ready' }));
    expect(parsed.cardType).toBe('memory_proposal');
    expect(parsed.status).toBe('ready');
  });

  it('非法 JSON string 回退 {}（静默吞错防御保留）', () => {
    expect(parseMeta('{broken')).toEqual({});
  });

  it('undefined / null / 空 string 回退 {}', () => {
    expect(parseMeta(undefined)).toEqual({});
    expect(parseMeta(null)).toEqual({});
    expect(parseMeta('')).toEqual({});
  });
});

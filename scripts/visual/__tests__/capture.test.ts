import { describe, it, expect } from 'vitest';
import { firstId } from '../capture';

describe('firstId（列表 API 响应逐路径探测取第一条 id）', () => {
  it('命中 {data: [...]} 形态', () => {
    expect(firstId({ success: true, data: [{ id: 'ch_1' }] }, 'data')).toBe('ch_1');
  });

  it('命中 {data: {workunits: [...]}} 形态', () => {
    expect(firstId({ data: { workunits: [{ id: 'wu_1' }] } }, 'data.workunits', 'data')).toBe('wu_1');
  });

  it('空列表 / 形态不符 → undefined', () => {
    expect(firstId({ data: [] }, 'data')).toBeUndefined();
    expect(firstId({ data: { workunits: [] } }, 'data.workunits', 'data')).toBeUndefined();
    expect(firstId({}, 'data')).toBeUndefined();
  });
});

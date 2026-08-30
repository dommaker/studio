import { describe, it, expect } from 'vitest';
import { firstId, parseWidths } from '../capture';

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

describe('parseWidths（--widths 覆盖默认宽度档，#395 窄屏走查）', () => {
  it('未传参 → 默认 1920/1440/1280', () => {
    expect(parseWidths(undefined)).toEqual([1920, 1440, 1280]);
  });

  it('逗号分隔窄屏档 1024/768/640/375', () => {
    expect(parseWidths('1024,768,640,375')).toEqual([1024, 768, 640, 375]);
  });

  it('未登记高度的档位 → 抛错', () => {
    expect(() => parseWidths('1024,999')).toThrow(/999/);
    expect(() => parseWidths('abc')).toThrow();
  });
});

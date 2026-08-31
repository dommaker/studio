import { describe, it, expect } from 'vitest';
import { firstId, parseWidths, parseTier, fillPath } from '../capture';

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

describe('parseTier（#400：--tier B 走 B 档未认证页）', () => {
  it('未传参 → A 档（认证页）', () => {
    expect(parseTier(undefined)).toBe('A');
  });

  it('--tier B → B 档', () => {
    expect(parseTier('B')).toBe('B');
  });

  it('未知档 → 抛错', () => {
    expect(() => parseTier('C')).toThrow(/C/);
  });
});

describe('fillPath（带参路径替换，libraryDocId 含 / 与 : 需 encodeURIComponent）', () => {
  it('无参页原样返回', () => {
    expect(fillPath({ name: 'channels', path: '/channels' }, {})).toBe('/channels');
  });

  it('普通 id 直接替换', () => {
    expect(fillPath({ name: 'channel-detail', path: '/channels/:channelId', param: 'channelId' }, { channelId: 'ch_1' })).toBe('/channels/ch_1');
  });

  it('含 / 与 : 的 id → encodeURIComponent（react-router 会 decode 回原文）', () => {
    const target = { name: 'library-doc', path: '/library/:libraryDocId', param: 'libraryDocId' } as const;
    expect(fillPath(target, { libraryDocId: 'proj_1:research/a.md' })).toBe('/library/proj_1%3Aresearch%2Fa.md');
  });
});

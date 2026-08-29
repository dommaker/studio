import { describe, it, expect } from 'vitest';
import { parseShotName } from '../diff';

describe('parseShotName', () => {
  it('拆 <page>-<width>.png（页面名可含连字符）', () => {
    expect(parseShotName('channels-1920.png')).toEqual({ page: 'channels', width: 1920 });
    expect(parseShotName('channel-detail-1440.png')).toEqual({ page: 'channel-detail', width: 1440 });
    expect(parseShotName('knowledge-select-open-1280.png')).toEqual({ page: 'knowledge-select-open', width: 1280 });
  });

  it('不符形态抛错', () => {
    expect(() => parseShotName('channels.png')).toThrow();
  });
});

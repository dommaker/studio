import { describe, it, expect } from 'vitest';
import { parseShotName, parseArgs } from '../diff';

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

describe('parseArgs', () => {
  it('无 --out：两个位置参数原样就位', () => {
    expect(parseArgs(['runA', 'runB'])).toEqual({ runA: 'runA', runB: 'runB', out: undefined });
  });

  it('带 --out：选项与值剔除，位置参数不错位', () => {
    expect(parseArgs(['runA', 'runB', '--out', '/tmp/x'])).toEqual({ runA: 'runA', runB: 'runB', out: '/tmp/x' });
    expect(parseArgs(['--out', '/tmp/x', 'runA', 'runB'])).toEqual({ runA: 'runA', runB: 'runB', out: '/tmp/x' });
  });

  it('缺位置参数 → 缺省字段 undefined', () => {
    expect(parseArgs([]).runA).toBeUndefined();
    expect(parseArgs(['only'])).toEqual({ runA: 'only', runB: undefined, out: undefined });
  });
});

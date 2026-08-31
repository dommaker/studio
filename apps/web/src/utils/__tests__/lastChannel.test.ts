// #393 频道首页重定向：最近访问频道记忆 + 落点决策纯函数
import { describe, it, expect, beforeEach } from 'vitest';
import {
  LAST_CHANNEL_KEY,
  loadLastChannelId,
  saveLastChannelId,
  resolveChannelHome,
} from '../lastChannel';

const CHANNELS = [
  { id: 'ch-dec', type: 'decision' },
  { id: 'ch-rnd', type: 'rnd' },
  { id: 'ch-sys', type: 'system' },
];

describe('lastChannel 存取', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('save 后 load 取回同值', () => {
    saveLastChannelId('ch-rnd');
    expect(window.localStorage.getItem(LAST_CHANNEL_KEY)).toBe('ch-rnd');
    expect(loadLastChannelId()).toBe('ch-rnd');
  });

  it('未写入时 load 返回 null', () => {
    expect(loadLastChannelId()).toBeNull();
  });
});

describe('resolveChannelHome — 重定向落点', () => {
  it('最近访问频道仍在列表 → 该频道', () => {
    expect(resolveChannelHome(CHANNELS, 'ch-sys')).toBe('/channels/ch-sys');
  });

  it('最近访问频道已不在列表（stale）→ 回落 rnd 默认频道', () => {
    expect(resolveChannelHome(CHANNELS, 'ch-deleted')).toBe('/channels/ch-rnd');
  });

  it('无历史 → rnd 默认频道（B2-010 既有约定）', () => {
    expect(resolveChannelHome(CHANNELS, null)).toBe('/channels/ch-rnd');
  });

  it('无 rnd 频道 → 列表首个', () => {
    const noRnd = [{ id: 'ch-dec', type: 'decision' }, { id: 'ch-sys', type: 'system' }];
    expect(resolveChannelHome(noRnd, null)).toBe('/channels/ch-dec');
  });

  it('零频道 → null（调用方渲染空态）', () => {
    expect(resolveChannelHome([], null)).toBeNull();
    expect(resolveChannelHome([], 'ch-1')).toBeNull();
  });
});

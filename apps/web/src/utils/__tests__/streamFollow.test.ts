// streamFollow 单元测试 — #289 频道滚动：跟随底部判定抽纯函数
// 交互行为层（台账记账/ResizeObserver/回到底部浮钮）由 e2e/channel-e2e.spec.ts 覆盖（jsdom 无布局）
import { describe, it, expect } from 'vitest';
import {
  FOLLOW_THRESHOLD_PX,
  distanceFromBottom,
  isPinnedToBottom,
  isReaderScroll,
  shouldFollowBottom,
} from '../streamFollow';

describe('distanceFromBottom', () => {
  it('贴底时为 0', () => {
    expect(distanceFromBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 80 })).toBe(0);
  });

  it('向上滚离底部时为正', () => {
    expect(distanceFromBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 80 })).toBe(420);
  });
});

describe('isPinnedToBottom', () => {
  it('距底 ≤ 阈值判定钉底', () => {
    const atEdge = { scrollTop: 1000 - 80 - FOLLOW_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 80 };
    expect(isPinnedToBottom(atEdge)).toBe(true);
  });

  it('距底 > 阈值判定未钉底', () => {
    const beyond = { scrollTop: 1000 - 80 - FOLLOW_THRESHOLD_PX - 1, scrollHeight: 1000, clientHeight: 80 };
    expect(isPinnedToBottom(beyond)).toBe(false);
  });

  it('支持自定义阈值', () => {
    const s = { scrollTop: 870, scrollHeight: 1000, clientHeight: 80 }; // 距底 50
    expect(isPinnedToBottom(s, 24)).toBe(false);
    expect(isPinnedToBottom(s, 80)).toBe(true);
  });
});

describe('isReaderScroll — observed-top 台账归属判定', () => {
  it('台账为空（尚未有程序写入）时任何滚动都算读者滚动', () => {
    expect(isReaderScroll(123, null)).toBe(true);
  });

  it('实际位置落在台账上（程序滚动落地）不算读者滚动', () => {
    expect(isReaderScroll(500, 500)).toBe(false);
  });

  it('1px 容差内的偏差（浏览器取整）不算读者滚动', () => {
    expect(isReaderScroll(500.6, 500)).toBe(false);
  });

  it('偏离台账超容差才算读者滚动', () => {
    expect(isReaderScroll(480, 500)).toBe(true);
  });
});

describe('shouldFollowBottom — 新消息到达时的跟随判定', () => {
  it('钉底中跟随', () => {
    expect(shouldFollowBottom(true, false)).toBe(true);
  });

  it('未钉底且最后一条非人类发送：不跟随（不把阅读中的用户拽走）', () => {
    expect(shouldFollowBottom(false, false)).toBe(false);
  });

  it('未钉底但最后一条是自己发的：强制跟随', () => {
    expect(shouldFollowBottom(false, true)).toBe(true);
  });
});

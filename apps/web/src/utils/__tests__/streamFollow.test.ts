// streamFollow 单元测试 — #289 频道滚动：跟随底部判定抽纯函数
// 交互行为层（台账记账/ResizeObserver/回到底部浮钮）由 e2e/channel-e2e.spec.ts 覆盖（jsdom 无布局）
import { describe, it, expect } from 'vitest';
import {
  FOLLOW_THRESHOLD_PX,
  distanceFromBottom,
  isPinnedToBottom,
  isReaderScroll,
  shouldFollowBottom,
  captureFirstVisibleAnchor,
  anchorScrollDelta,
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

describe('FOLLOW_THRESHOLD_PX — #290（清单 #27）阈值收紧', () => {
  it('收紧到 24px 量级', () => {
    expect(FOLLOW_THRESHOLD_PX).toBe(24);
  });

  it('向上翻 80px 以内阅读上文不再判钉底', () => {
    const s = { scrollTop: 1000 - 80 - 50, scrollHeight: 1000, clientHeight: 80 }; // 距底 50
    expect(isPinnedToBottom(s)).toBe(false);
  });
});

describe('captureFirstVisibleAnchor — #290（清单 #22）行锚点捕获', () => {
  const rows = [
    { mid: 'm1', top: -120, bottom: -20 },  // 完全在视口上方
    { mid: 'm2', top: -10, bottom: 60 },    // 首条可见（部分露出）
    { mid: 'm3', top: 62, bottom: 150 },
  ];

  it('取首条底部越过视口顶的行（部分露出也算可见）', () => {
    expect(captureFirstVisibleAnchor(rows)).toEqual({ mid: 'm2', top: -10 });
  });

  it('支持自定义视口顶（读者已向下滚动时）', () => {
    expect(captureFirstVisibleAnchor(rows, 70)).toEqual({ mid: 'm3', top: 62 });
  });

  it('空列表返回 null', () => {
    expect(captureFirstVisibleAnchor([])).toBeNull();
  });

  it('全部行都在视口上方时返回 null', () => {
    expect(captureFirstVisibleAnchor(rows, 999)).toBeNull();
  });
});

describe('anchorScrollDelta — #290（清单 #22）位移补偿量', () => {
  it('prepend 后锚行下移 300px → scrollTop 补偿 +300', () => {
    expect(anchorScrollDelta(-10, 290)).toBe(300);
  });

  it('锚行位置不变 → 补偿 0', () => {
    expect(anchorScrollDelta(42, 42)).toBe(0);
  });

  it('锚行上移（加载期间内容收缩）→ 负补偿', () => {
    expect(anchorScrollDelta(100, 60)).toBe(-40);
  });
});

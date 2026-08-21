// 频道消息流滚动跟随判定（#289，借鉴 dsh observed-top 台账方案，
// 见 .studio/research/2026-08-19-dsh-web-interaction.md §5）
// jsdom 无布局不可测 scrollTop，故判定逻辑全部抽为纯函数在此单测；
// 组件侧只负责记账（observedTopRef）与调用。

/** 钉底阈值：距底 ≤ 该值视为「还在底部」。阈值收紧（24px 量级）属 P3 #27，不在 #289。 */
export const FOLLOW_THRESHOLD_PX = 80;

export interface StreamScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 距底距离（px），贴底为 0 */
export function distanceFromBottom(s: StreamScrollSnapshot): number {
  return s.scrollHeight - s.scrollTop - s.clientHeight;
}

/** 是否钉在底部（跟随新消息的几何判定） */
export function isPinnedToBottom(s: StreamScrollSnapshot, thresholdPx: number = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(s) <= thresholdPx;
}

/**
 * 读者滚动归属判定：程序写 scrollTop 必记 observed-top 台账，
 * scroll 事件里实际位置偏离台账（>1px 容差，吃浏览器取整）才算读者滚的。
 * observedTop 为 null（尚未有程序写入）时保守视为读者滚动。
 */
export function isReaderScroll(actualTop: number, observedTop: number | null, tolerancePx = 1): boolean {
  if (observedTop === null) return true;
  return Math.abs(actualTop - observedTop) > tolerancePx;
}

/** 新消息到达时是否跟随到底：钉底中，或最后一条是自己发的（发送动作强制回底） */
export function shouldFollowBottom(pinned: boolean, lastAuthorIsHuman: boolean): boolean {
  return pinned || lastAuthorIsHuman;
}
